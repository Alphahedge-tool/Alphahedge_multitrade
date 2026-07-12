// OI / Premium Decay data.
// Flow: Upstox option chain -> collect every CE/PE instrument key -> request
// S1 candles in batches of 10 -> aggregate call/put close (premium) and OI.

import { route, readJSON, ApiError } from '../server.js';
import { getFeedAccount } from '../lib/feedRegistry.js';
import { getSession as getUpstoxSession } from '../brokers/upstox.js';
import { fetchUpstoxChain } from '../master/optionChain.js';

const CHART_URL = 'https://service.upstox.com/chart/open/v3/candles';
const BATCH_SIZE = 10;
const RETRYABLE = new Set([429, 464, 500, 502, 503, 504]);

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
  const chain = await fetchUpstoxChain({
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

async function fetchCandleRange(contract, start, end, limit) {
  const all = [];
  let cursor = end;
  let pages = 0;
  const seenCursors = new Set();
  while (cursor >= start && pages < 60 && !seenCursors.has(cursor)) {
    seenCursors.add(cursor);
    const page = await fetchCandlePage(contract, cursor, limit);
    pages++;
    all.push(...page.candles);
    const oldest = page.candles.reduce((value, candle) => Math.min(value, Number(candle?.[0]) || Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
    if (oldest <= start || !page.prevTimestamp) break;
    cursor = page.prevTimestamp;
  }
  const unique = new Map();
  for (const candle of all) {
    const time = Number(candle?.[0]);
    if (time >= start && time <= end) unique.set(time, candle);
  }
  return [...unique.values()].sort((a, b) => Number(a[0]) - Number(b[0]));
}

async function fetchInBatches(contracts, start, end, limit) {
  const results = new Map();
  const errors = {};
  for (let offset = 0; offset < contracts.length; offset += BATCH_SIZE) {
    const batch = contracts.slice(offset, offset + BATCH_SIZE);
    await Promise.all(batch.map(async (contract) => {
      try {
        results.set(contract.key, await fetchCandleRange(contract, start, end, limit));
      } catch (error) {
        errors[contract.key] = error.message || 'Chart request failed';
      }
    }));
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

route('POST', '/api/feed/oi-premium-decay', async (req) => {
  const body = await readJSON(req);
  if (!body.symbol || !body.expiry) throw new ApiError('symbol and expiry are required', 400);
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
  const { results, errors } = await fetchInBatches(contracts, start, end, limit);
  let spotCandles = [];
  if (chain.underlyingKey) {
    try {
      spotCandles = await fetchCandleRange({ key: chain.underlyingKey }, start, end, limit);
    } catch { /* option aggregates are still useful when spot history fails */ }
  }
  return {
    status: true,
    source: 'upstox-s1',
    interval: 'S1',
    batchSize: BATCH_SIZE,
    start,
    end,
    contracts: contracts.length,
    selectedStrikes: requestedStrikes.size ? [...requestedStrikes].sort((a, b) => a - b) : availableStrikes,
    successfulContracts: results.size,
    failedContracts: Object.keys(errors).length,
    errors,
    spot: chain.spot ?? null,
    points: aggregateHistory(contracts, results, spotCandles),
  };
});
