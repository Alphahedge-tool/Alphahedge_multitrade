// OI / Premium Decay data.
// Flow: Upstox option chain -> collect every CE/PE instrument key -> request
// S1 candles in batches of 10 -> aggregate call/put close (premium) and OI.

import { route, readJSON, ApiError } from '../server.js';
import { getFeedAccount } from '../lib/feedRegistry.js';
import { getSession as getUpstoxSession } from '../brokers/upstox.js';
import { getChain } from '../engine/chainCache.js';
import { poll as enginePoll } from '../engine/oiDecayEngine.js';

const CHART_URL = 'https://service.upstox.com/chart/open/v3/candles';
const RETRYABLE = new Set([429, 464, 500, 502, 503, 504]);

// Candles per page are capped at 500 upstream, and one S1 candle is one second,
// so a page spans a known, fixed amount of wall time. That is what makes the
// page boundaries computable instead of discovered.
const INTERVAL_MS = { S1: 1000 };

// Simultaneous in-flight chart requests. The old code peaked at 10 (one per
// contract in a batch) while each contract paged serially; this holds a similar
// upstream footprint but spends it on pages instead of waiting on them.
const CONCURRENCY = Number(process.env.CANDLE_CONCURRENCY || 20);

// Settled pages are cached, budgeted by candle count (~80 bytes each, so the
// default is roughly 25 MB) with least-recently-used eviction.
const MAX_CACHED_CANDLES = Number(process.env.CANDLE_CACHE_MAX || 300_000);
const SETTLE_MS = 60_000;

function toISODate(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const match = raw.toUpperCase().match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!match) return raw;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${match[3]}-${String(months.indexOf(match[2]) + 1).padStart(2, '0')}-${match[1]}`;
}

function upstoxFeedSession() {
  const feed = getFeedAccount('upstox');
  const session = feed?.userId ? getUpstoxSession(feed.userId) : null;
  if (!session?.accessToken) throw new ApiError('Select and connect an Upstox Feed Master account first', 400);
  return session;
}

async function loadChain(body) {
  const session = upstoxFeedSession();
  // Cached + single-flighted: the 1Hz snapshot poll and every concurrent tab
  // share one upstream chain fetch per TTL window.
  const chain = await getChain({
    symbol: body.symbol,
    expiryISO: toISODate(body.expiry),
    accessToken: session.accessToken,
    exchange: body.exchange,
    spotToken: body.spotToken,
  });
  if (chain.source !== 'ok') throw new ApiError(`Upstox option chain unavailable: ${chain.source}`, 502);
  const contracts = [];
  for (const [strike, row] of Object.entries(chain.byStrike)) {
    if (row.call?.instrumentKey) contracts.push({ key: row.call.instrumentKey, side: 'call', strike: Number(strike), current: row.call });
    if (row.put?.instrumentKey) contracts.push({ key: row.put.instrumentKey, side: 'put', strike: Number(strike), current: row.put });
  }
  if (!contracts.length) throw new ApiError('Upstox returned no option instrument keys for this expiry', 404);
  return { chain, contracts };
}

async function fetchCandlePage(contract, from, limit) {
  const query = new URLSearchParams({
    instrumentKey: contract.key,
    interval: 'S1',
    from: String(from),
    limit: String(limit),
  });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${CHART_URL}?${query}`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        const error = new Error(`Upstox chart HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const json = await response.json();
      return {
        candles: Array.isArray(json?.data?.candles) ? json.data.candles : [],
        prevTimestamp: Number(json?.data?.meta?.prevTimestamp) || null,
      };
    } catch (error) {
      lastError = error;
      if (!RETRYABLE.has(error?.status) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 150 * (2 ** attempt)));
    }
  }
  throw lastError || new Error('Upstox chart request failed');
}

// pageCursors computes every page boundary up front.
//
// The old implementation chased `prevTimestamp`: each request's starting point
// came out of the previous request's response, so a full session was ~45 STRICTLY
// SERIAL round-trips per contract (22,500 one-second candles / 500 per page),
// and spot history ran as another 45 after those. That serialization — not the
// payload — was the multi-second page load.
//
// But at a fixed interval, a page of `limit` candles spans exactly
// limit * intervalMs. The boundaries are arithmetic, so no response is needed to
// know where the next page starts and every page can be fetched at once.
//
// On an illiquid contract a page reaches FURTHER back than its slice (fewer
// candles exist than the limit), which makes neighbouring slices redundant, not
// missing. Redundant pages collapse in the dedupe below; gaps cannot open up.
function pageCursors(start, end, limit, interval = 'S1') {
  const step = INTERVAL_MS[interval] || 1000;
  // A page anchored at C returns candles at C, C-step, ... C-(limit-1)*step, so
  // it COVERS (limit-1)*step of wall time while the next anchor sits a full
  // limit*step below it. Conflating the two drops the oldest candle of the
  // range, so stride and coverage are tracked separately.
  const stride = limit * step;
  const coverage = (limit - 1) * step;
  const cursors = [];
  for (let cursor = end; ; cursor -= stride) {
    cursors.push(cursor);
    if (cursor - coverage <= start) break;
  }
  return cursors;
}

// A page whose whole span is in the past can never change, so it is worth
// keeping; the page containing "now" is not. Budgeted by candle count rather
// than entry count, because entry sizes vary by three orders of magnitude
// between a liquid ATM strike and a dead wing.
const pageCache = new Map(); // `key|cursor|limit` -> candles[]
let cachedCandles = 0;

function cacheGet(cacheKey) {
  const hit = pageCache.get(cacheKey);
  if (!hit) return null;
  // Refresh recency for the FIFO-with-reinsertion eviction below.
  pageCache.delete(cacheKey);
  pageCache.set(cacheKey, hit);
  return hit;
}

function cachePut(cacheKey, candles, cursor) {
  if (cursor > Date.now() - SETTLE_MS) return; // still moving; not cacheable
  pageCache.set(cacheKey, candles);
  cachedCandles += candles.length;
  while (cachedCandles > MAX_CACHED_CANDLES && pageCache.size) {
    const oldest = pageCache.keys().next().value;
    cachedCandles -= pageCache.get(oldest).length;
    pageCache.delete(oldest);
  }
}

async function fetchPageCached(key, cursor, limit) {
  const cacheKey = `${key}|${cursor}|${limit}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;
  const page = await fetchCandlePage({ key }, cursor, limit);
  cachePut(cacheKey, page.candles, cursor);
  return page.candles;
}

// runPool executes tasks with bounded concurrency. Unbounded Promise.all over
// every (contract x page) pair would open hundreds of sockets at once and earn
// a 429; serial execution is what we are here to remove. A worker pool gives
// the parallelism without the burst.
async function runPool(tasks, concurrency) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    for (let i = next++; i < tasks.length; i = next++) await tasks[i]();
  });
  await Promise.all(workers);
}

// fetchAllRanges pulls the full range for every instrument key in ONE pool —
// option contracts and the underlying together, so spot history no longer waits
// for the contracts to finish.
async function fetchAllRanges(keys, start, end, limit) {
  const cursors = pageCursors(start, end, limit);
  const collected = new Map(keys.map((key) => [key, []]));
  const errors = {};

  const tasks = [];
  for (const key of keys) {
    for (const cursor of cursors) {
      tasks.push(async () => {
        try {
          collected.get(key).push(...await fetchPageCached(key, cursor, limit));
        } catch (error) {
          // One bad page no longer discards the whole contract — the rest of
          // its pages still count. Recorded so the response can report it.
          errors[key] = error.message || 'Chart request failed';
        }
      });
    }
  }
  await runPool(tasks, CONCURRENCY);

  const results = new Map();
  for (const [key, all] of collected) {
    const unique = new Map();
    for (const candle of all) {
      const time = Number(candle?.[0]);
      if (time >= start && time <= end) unique.set(time, candle);
    }
    results.set(key, [...unique.values()].sort((a, b) => Number(a[0]) - Number(b[0])));
  }
  return { results, errors };
}

function aggregateHistory(contracts, candlesByKey, spotCandles = []) {
  const events = [];
  for (const contract of contracts) {
    for (const candle of candlesByKey.get(contract.key) || []) {
      if (!Array.isArray(candle) || !Number.isFinite(Number(candle[0]))) continue;
      events.push({
        time: Math.floor(Number(candle[0]) / 1000) * 1000,
        key: contract.key,
        side: contract.side,
        premium: Number(candle[4]) || 0,
        oi: Number(candle[6]) || 0,
      });
    }
  }
  events.sort((a, b) => a.time - b.time);

  const latest = new Map();
  const points = [];
  let index = 0;
  while (index < events.length) {
    const time = events[index].time;
    while (index < events.length && events[index].time === time) {
      latest.set(events[index].key, events[index]);
      index++;
    }
    let callOi = 0, putOi = 0, callPremium = 0, putPremium = 0;
    for (const value of latest.values()) {
      if (value.side === 'call') { callOi += value.oi; callPremium += value.premium; }
      else { putOi += value.oi; putPremium += value.premium; }
    }
    points.push({ time, callOi, putOi, callPremium, putPremium });
  }
  const spotRows = [...spotCandles].sort((a, b) => Number(a[0]) - Number(b[0]));
  let spotIndex = 0, spot = null;
  for (const point of points) {
    while (spotIndex < spotRows.length && Number(spotRows[spotIndex][0]) <= point.time) {
      spot = Number(spotRows[spotIndex][4]) || spot;
      spotIndex++;
    }
    point.spot = spot;
  }
  return points;
}

// snapshotFromEngine serves a live point from the push engine, which holds the
// selected contracts subscribed on the Upstox WebSocket. Costs no upstream
// request. Returns null when the engine can't serve (live feed down, or no
// contract has reported yet) so the caller can fall back to the REST chain.
async function snapshotFromEngine(body) {
  const session = upstoxFeedSession();
  let served;
  try {
    served = await enginePoll({
      symbol: body.symbol,
      expiryISO: toISODate(body.expiry),
      strikes: Array.isArray(body.strikes) ? body.strikes : [],
      accessToken: session.accessToken,
      exchange: body.exchange,
      spotToken: body.spotToken,
    });
  } catch (error) {
    // No Upstox account in Feed Master / adapter not running: degrade to REST
    // rather than failing the request.
    if (error?.code === 'FEED_DOWN') return null;
    throw error;
  }
  if (!served) return null;
  const { point, topic } = served;
  return {
    status: true,
    source: 'engine-live',
    point: {
      time: point.time,
      callOi: point.callOi,
      putOi: point.putOi,
      callPremium: point.callPremium,
      putPremium: point.putPremium,
      spot: point.spot ?? null,
    },
    contracts: topic.contracts.size,
    spot: point.spot ?? topic.spot ?? null,
  };
}

route('POST', '/api/feed/oi-premium-decay', async (req) => {
  const body = await readJSON(req);
  if (!body.symbol || !body.expiry) throw new ApiError('symbol and expiry are required', 400);

  // Live snapshot polls take the engine path first — a memory read instead of
  // a full option-chain fetch. Anything it can't serve falls through below.
  if (body.snapshot === true) {
    const served = await snapshotFromEngine(body);
    if (served) return served;
  }

  const loaded = await loadChain(body);
  const { chain } = loaded;
  const availableStrikes = [...new Set(loaded.contracts.map((contract) => contract.strike))].sort((a, b) => a - b);
  if (body.chainOnly === true) {
    return { status: true, source: 'upstox-option-chain', strikes: availableStrikes, spot: chain.spot ?? null, contracts: loaded.contracts.length };
  }
  const requestedStrikes = new Set((Array.isArray(body.strikes) ? body.strikes : []).map(Number).filter(Number.isFinite));
  const contracts = requestedStrikes.size
    ? loaded.contracts.filter((contract) => requestedStrikes.has(contract.strike))
    : loaded.contracts;
  if (!contracts.length) throw new ApiError('No CE/PE contracts found for the selected strikes', 404);

  if (body.snapshot === true) {
    const point = { time: Date.now(), callOi: 0, putOi: 0, callPremium: 0, putPremium: 0 };
    for (const contract of contracts) {
      if (contract.side === 'call') {
        point.callOi += Number(contract.current.oi) || 0;
        point.callPremium += Number(contract.current.ltp) || 0;
      } else {
        point.putOi += Number(contract.current.oi) || 0;
        point.putPremium += Number(contract.current.ltp) || 0;
      }
    }
    return { status: true, source: 'upstox-option-chain', point, contracts: contracts.length, spot: chain.spot ?? null };
  }

  const limit = Math.min(Math.max(Number(body.limit) || 500, 1), 500);
  const end = Number(body.end) || Number(body.from) || Date.now();
  const start = Number(body.start) || (end - 500 * 1000);
  if (start >= end) throw new ApiError('start must be earlier than end', 400);
  // Contracts and the underlying go through one pool together, so spot history
  // is no longer a second serial chain tacked on after the contracts finish.
  const contractKeys = [...new Set(contracts.map((contract) => contract.key))];
  const keys = chain.underlyingKey ? [...contractKeys, chain.underlyingKey] : contractKeys;
  const { results, errors } = await fetchAllRanges(keys, start, end, limit);
  // Option aggregates are still useful when spot history fails.
  const spotCandles = chain.underlyingKey ? results.get(chain.underlyingKey) || [] : [];

  return {
    status: true,
    source: 'upstox-s1',
    interval: 'S1',
    concurrency: CONCURRENCY,
    pagesPerContract: pageCursors(start, end, limit).length,
    start,
    end,
    contracts: contracts.length,
    selectedStrikes: requestedStrikes.size ? [...requestedStrikes].sort((a, b) => a - b) : availableStrikes,
    successfulContracts: contractKeys.filter((key) => (results.get(key) || []).length).length,
    failedContracts: contractKeys.filter((key) => errors[key]).length,
    errors,
    spot: chain.spot ?? null,
    points: aggregateHistory(contracts, results, spotCandles),
  };
});
