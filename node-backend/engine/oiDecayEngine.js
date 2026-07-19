// OI / premium-decay engine — the push-based replacement for the 1Hz REST poll.
//
// Old flow (per second, per component, per browser tab):
//   browser -> POST /api/feed/oi-premium-decay -> full Upstox option-chain REST
//   fetch -> sum LTP+OI of the selected contracts -> one point back.
// That paid an upstream round-trip for every point and threw away ~98% of the
// payload it fetched.
//
// New flow:
//   chain fetched ONCE to learn which instrument keys make up the topic ->
//   subscribe those keys on the existing Upstox WebSocket adapter -> ticks
//   update an in-memory latest-value map -> a single fixed 1Hz timer folds
//   those into one point per topic and fans it out to every subscriber.
//
// The key property is that cost is now O(distinct topics), not O(subscribers).
// Ten tabs watching the same symbol/expiry/strikes share one subscription, one
// computation and one ring buffer.
//
// Ticks arrive in bursts of hundreds; folding on every tick would be wasted
// work since the chart only renders one point per second. So ticks do the
// cheap thing (write latest value) and the timer does the fold.

import { onTick, clientSubscribe, clientUnsubscribe, getAdapter } from '../ws/feedManager.js';
import { MODE_QUOTE } from '../ws/baseAdapter.js';
import { getChain } from './chainCache.js';
import { SeriesRing } from './ringBuffer.js';

const BROKER = 'upstox';
const COLUMNS = ['time', 'callOi', 'putOi', 'callPremium', 'putPremium', 'spot'];
const CAPACITY = Number(process.env.ENGINE_CAPACITY || 900); // ~15 min at 1Hz
const COMPUTE_MS = Number(process.env.ENGINE_COMPUTE_MS || 1000);

// A polling REST client has no close event to release a topic, so it takes a
// LEASE instead: each poll extends it, and the reaper tears the topic down once
// it lapses. Long enough to survive a slow client or a brief tab stall.
const LEASE_MS = Number(process.env.ENGINE_LEASE_MS || 15_000);

const topics = new Map(); // topicId -> Topic
const keyIndex = new Map(); // instrumentKey -> Set<topicId>   (tick routing)

let tickUnsub = null;
let timer = null;

// ── identity ────────────────────────────────────────────────────────────────

export function topicId({ symbol, expiryISO, strikes }) {
  const list = [...new Set((strikes || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  return `oidecay:${String(symbol).toUpperCase()}:${expiryISO}:${list.join(',')}`;
}

// An Upstox instrument key is "SEGMENT|token". The adapter passes a token
// containing '|' through untouched, so the key doubles as the token and comes
// back on the tick as tick.token — no mapping table needed.
function instrumentFor(instrumentKey, symbol = '') {
  const i = String(instrumentKey).indexOf('|');
  return {
    exchange: i < 0 ? 'NSE' : String(instrumentKey).slice(0, i),
    token: String(instrumentKey),
    symbol,
  };
}

// ── tick ingestion ──────────────────────────────────────────────────────────

function handleTick(tick) {
  if (tick?.broker !== BROKER) return;
  const ids = keyIndex.get(tick.token);
  if (!ids) return;

  const ltp = Number(tick.ltp);
  const oi = Number(tick.oi);
  for (const id of ids) {
    const topic = topics.get(id);
    if (!topic) continue;

    if (tick.token === topic.spotKey) {
      if (Number.isFinite(ltp) && ltp > 0) topic.spot = ltp;
      continue;
    }
    const slot = topic.latest.get(tick.token);
    if (!slot) continue;
    // Partial frames (LTP-only) legitimately carry no OI. The adapter already
    // merges each tick over the previous one, but guard anyway so a missing
    // field can never zero out a good value.
    if (Number.isFinite(ltp) && ltp > 0) slot.ltp = ltp;
    if (Number.isFinite(oi) && oi > 0) slot.oi = oi;
    slot.ts = tick.ts || Date.now();
    topic.ticks++;
  }
}

function ensureRunning() {
  if (!tickUnsub) tickUnsub = onTick(handleTick);
  if (!timer) {
    timer = setInterval(tickAllTopics, COMPUTE_MS);
    // Never let the engine's timer be the reason the process stays alive.
    timer.unref?.();
  }
}

function stopIfIdle() {
  if (topics.size) return;
  if (tickUnsub) { tickUnsub(); tickUnsub = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

// ── derivation ──────────────────────────────────────────────────────────────

// fold sums the latest LTP and OI across a topic's contracts, split call/put.
// Returns null until at least one contract has a value, so the series never
// opens with a misleading all-zero point.
function fold(topic) {
  let callOi = 0, putOi = 0, callPremium = 0, putPremium = 0, seen = 0;
  for (const [key, meta] of topic.contracts) {
    const cur = topic.latest.get(key);
    if (!cur || (cur.ltp == null && cur.oi == null)) continue;
    seen++;
    if (meta.side === 'call') {
      callOi += cur.oi || 0;
      callPremium += cur.ltp || 0;
    } else {
      putOi += cur.oi || 0;
      putPremium += cur.ltp || 0;
    }
  }
  if (!seen) return null;
  return {
    time: Date.now(),
    callOi,
    putOi,
    callPremium,
    putPremium,
    spot: topic.spot,
    contributing: seen,
  };
}

function tickAllTopics() {
  const now = Date.now();
  for (const topic of [...topics.values()]) {
    // Reap topics nobody holds: no live subscriber and any poll lease lapsed.
    if (topic.refCount <= 0 && topic.leaseUntil < now) {
      destroyTopic(topic);
      continue;
    }
    let point;
    try {
      point = fold(topic);
    } catch (err) {
      console.error(`[engine] fold failed for ${topic.id}: ${err.message}`);
      continue;
    }
    if (!point) continue;
    topic.ring.push(point);
    topic.lastPoint = point;
    for (const fn of topic.subscribers) {
      try {
        fn(point, topic);
      } catch {
        /* one bad subscriber must not stall the engine */
      }
    }
  }
}

// ── topic lifecycle ─────────────────────────────────────────────────────────

async function createTopic({ id, symbol, expiryISO, strikes, accessToken, exchange, spotToken }) {
  const chain = await getChain({ symbol, expiryISO, accessToken, exchange, spotToken });
  if (chain.source !== 'ok') {
    const err = new Error(`Upstox option chain unavailable: ${chain.source}`);
    err.status = 502;
    throw err;
  }

  const wanted = new Set((strikes || []).map(Number).filter(Number.isFinite));
  const contracts = new Map(); // instrumentKey -> { side, strike }
  const latest = new Map(); // instrumentKey -> { ltp, oi, ts }

  for (const [rawStrike, row] of Object.entries(chain.byStrike)) {
    const strike = Number(rawStrike);
    if (wanted.size && !wanted.has(strike)) continue;
    for (const side of ['call', 'put']) {
      const leg = row[side];
      if (!leg?.instrumentKey) continue;
      contracts.set(leg.instrumentKey, { side, strike });
      // Seed from the chain's REST values so the first computed point is
      // correct immediately instead of waiting a full tick cycle.
      latest.set(leg.instrumentKey, {
        ltp: Number.isFinite(Number(leg.ltp)) ? Number(leg.ltp) : null,
        oi: Number.isFinite(Number(leg.oi)) ? Number(leg.oi) : null,
        ts: Date.now(),
      });
    }
  }
  if (!contracts.size) {
    const err = new Error('No CE/PE contracts found for the selected strikes');
    err.status = 404;
    throw err;
  }

  const topic = {
    id,
    symbol,
    expiryISO,
    strikes: [...wanted].sort((a, b) => a - b),
    contracts,
    latest,
    spotKey: chain.underlyingKey || null,
    spot: Number.isFinite(Number(chain.spot)) ? Number(chain.spot) : null,
    ring: new SeriesRing(COLUMNS, CAPACITY),
    subscribers: new Set(),
    refCount: 0,
    leaseUntil: 0,
    ticks: 0,
    createdAt: Date.now(),
    lastPoint: null,
  };

  // Subscribe the contracts (+ the underlying for spot) on the live feed.
  // MODE_QUOTE maps to Upstox's 'full' feed, which is what carries OI.
  const instruments = [...contracts.keys()].map((k) => instrumentFor(k, symbol));
  if (topic.spotKey) instruments.push(instrumentFor(topic.spotKey, symbol));

  let snapshot = [];
  try {
    snapshot = clientSubscribe(BROKER, instruments, MODE_QUOTE) || [];
  } catch (err) {
    // Feed not running (no Upstox account in Feed Master). The caller decides
    // whether to fall back to the REST path.
    const wrapped = new Error(`Live feed unavailable: ${err.message}`);
    wrapped.status = 503;
    wrapped.code = 'FEED_DOWN';
    throw wrapped;
  }
  topic.instruments = instruments;

  // Replay whatever the adapter already had cached for these keys.
  for (const tick of snapshot) {
    if (tick.token === topic.spotKey) {
      if (Number(tick.ltp) > 0) topic.spot = Number(tick.ltp);
      continue;
    }
    const slot = latest.get(tick.token);
    if (!slot) continue;
    if (Number(tick.ltp) > 0) slot.ltp = Number(tick.ltp);
    if (Number(tick.oi) > 0) slot.oi = Number(tick.oi);
  }

  topics.set(id, topic);
  for (const key of contracts.keys()) {
    if (!keyIndex.has(key)) keyIndex.set(key, new Set());
    keyIndex.get(key).add(id);
  }
  if (topic.spotKey) {
    if (!keyIndex.has(topic.spotKey)) keyIndex.set(topic.spotKey, new Set());
    keyIndex.get(topic.spotKey).add(id);
  }

  ensureRunning();
  return topic;
}

/**
 * subscribe attaches a listener to a topic, creating and wiring the topic on
 * first use. Returns { topic, unsubscribe }.
 *
 * Concurrent first-subscribers are single-flighted through creating so two
 * tabs opening at once cannot build the topic twice.
 */
const creating = new Map(); // topicId -> Promise<Topic>

// ensureTopic returns the live topic, building it once even if several callers
// race to be first.
async function ensureTopic(params) {
  const id = topicId(params);
  const existing = topics.get(id);
  if (existing) return existing;

  let pending = creating.get(id);
  if (!pending) {
    pending = createTopic({ ...params, id }).finally(() => creating.delete(id));
    creating.set(id, pending);
  }
  return pending;
}

export async function subscribe(params, listener) {
  const topic = await ensureTopic(params);

  topic.refCount++;
  if (typeof listener === 'function') topic.subscribers.add(listener);

  let released = false;
  return {
    topic,
    unsubscribe() {
      if (released) return; // idempotent: a double-close must not over-release
      released = true;
      if (typeof listener === 'function') topic.subscribers.delete(listener);
      topic.refCount--;
      // A polling client may still hold a lease on this topic; the reaper in
      // the compute loop tears it down once that lapses too.
      if (topic.refCount <= 0 && topic.leaseUntil < Date.now()) destroyTopic(topic);
    },
  };
}

/**
 * poll is the REST-shaped door into the engine: it guarantees the topic exists
 * and is subscribed to the live feed, extends the caller's lease, and returns
 * the newest computed point.
 *
 * This is what lets the existing 1Hz endpoint stop fetching upstream — the
 * first poll builds the topic, every later poll is a memory read.
 *
 * Returns null when the topic exists but no contract has reported a value yet;
 * the caller should fall back rather than publish an empty point.
 */
export async function poll(params) {
  const topic = await ensureTopic(params);
  topic.leaseUntil = Date.now() + LEASE_MS;
  // Fold on demand rather than handing back the timer's last point: a poll
  // arriving between compute ticks should still see the freshest ticks.
  const point = fold(topic);
  if (point) {
    topic.lastPoint = point;
    return { point, topic };
  }
  return topic.lastPoint ? { point: topic.lastPoint, topic } : null;
}

function destroyTopic(topic) {
  if (!topics.delete(topic.id)) return;
  for (const key of topic.contracts.keys()) {
    const set = keyIndex.get(key);
    if (!set) continue;
    set.delete(topic.id);
    if (!set.size) keyIndex.delete(key);
  }
  if (topic.spotKey) {
    const set = keyIndex.get(topic.spotKey);
    if (set) {
      set.delete(topic.id);
      if (!set.size) keyIndex.delete(topic.spotKey);
    }
  }
  try {
    clientUnsubscribe(BROKER, topic.instruments || []);
  } catch {
    /* feed may already be down; refcounts are released either way */
  }
  stopIfIdle();
}

// ── introspection ───────────────────────────────────────────────────────────

export function engineStatus() {
  const adapter = getAdapter(BROKER);
  return {
    running: Boolean(timer),
    feedConnected: Boolean(adapter?.connected),
    computeMs: COMPUTE_MS,
    capacity: CAPACITY,
    indexedKeys: keyIndex.size,
    topics: [...topics.values()].map((t) => ({
      id: t.id,
      symbol: t.symbol,
      expiry: t.expiryISO,
      strikes: t.strikes,
      contracts: t.contracts.size,
      subscribers: t.subscribers.size,
      refCount: t.refCount,
      points: t.ring.size,
      ticks: t.ticks,
      spot: t.spot,
      ageMs: Date.now() - t.createdAt,
    })),
  };
}

export function getTopic(id) {
  return topics.get(id) || null;
}

// Test seam: force-tear everything down.
export function resetEngine() {
  for (const topic of [...topics.values()]) destroyTopic(topic);
  topics.clear();
  keyIndex.clear();
  creating.clear();
  stopIfIdle();
}

// Test seam: run one compute cycle synchronously instead of waiting for the timer.
export function computeNow() {
  tickAllTopics();
}

export { COLUMNS, CAPACITY, COMPUTE_MS };
