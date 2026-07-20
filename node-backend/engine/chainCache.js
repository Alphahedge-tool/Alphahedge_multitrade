// Option-chain cache — a single-flight + short-TTL layer in front of
// fetchUpstoxChain().
//
// Why this exists: the OI/premium-decay page polls a snapshot once a second,
// and each poll re-fetched the WHOLE Upstox option chain (every strike, both
// sides, full greeks) to read LTP+OI for a couple of contracts. With N browser
// tabs open that was N chain fetches per second for identical data.
//
// Two independent problems, two mechanisms:
//   • TTL         — a chain fetched 200ms ago is still good; serve it again.
//   • single-flight — concurrent callers that MISS the TTL must not each open
//     their own upstream request. The first one fetches; the rest await it.
//
// Single-flight is the more important half: without it, N tabs whose polls land
// in the same TTL window still produce N upstream calls.
//
// Failures are never cached (a 502 must not stick for a full TTL), but they ARE
// still single-flighted, so an outage produces one upstream call per window
// instead of one per caller.

import { fetchUpstoxChain } from '../master/optionChain.js';

// Below the 1s poll interval, so a polling client still sees ~1s-fresh data
// while any burst within the window collapses to one upstream call.
const TTL_MS = Number(process.env.CHAIN_CACHE_TTL_MS || 900);

// Entries idle longer than this are dropped on the next sweep. Expiries roll,
// symbols get switched — without this the map would retain every chain ever
// requested for the life of the process.
const MAX_IDLE_MS = 5 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;

const cache = new Map(); // key -> { value, fetchedAt, lastUsedAt }
const inflight = new Map(); // key -> Promise

let lastSweep = Date.now();

function cacheKey({ symbol, expiryISO, exchange, spotToken }) {
  return [
    String(symbol || '').toUpperCase(),
    String(expiryISO || ''),
    String(exchange || '').toUpperCase(),
    String(spotToken || ''),
  ].join('|');
}

// The access token is deliberately NOT part of the key: the chain is public
// market data and identical for every account, so re-logging-in or switching
// Feed Master accounts should not cold-start the cache. It is still passed
// through to the fetch, which needs it for authorization.
function sweep(now) {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [key, entry] of cache) {
    if (now - entry.lastUsedAt > MAX_IDLE_MS) cache.delete(key);
  }
}

/**
 * getChain returns fetchUpstoxChain()'s result, served from cache when fresh.
 * Same arguments, same shape — a drop-in replacement.
 *
 * @param {object} params
 * @param {boolean} [params.force] Bypass the TTL (still single-flighted, so a
 *   forced refresh joins an in-flight fetch rather than racing it).
 */
export async function getChain(params) {
  const { force = false, ...args } = params;
  const key = cacheKey(args);
  const now = Date.now();
  sweep(now);

  const entry = cache.get(key);
  if (!force && entry && now - entry.fetchedAt < TTL_MS) {
    entry.lastUsedAt = now;
    return entry.value;
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const value = await fetchUpstoxChain(args);
    // Only a good chain is worth caching. A bad one is returned to this
    // caller (and anyone who joined the flight) but not remembered, so the
    // next poll retries immediately instead of serving the error for a TTL.
    if (value?.source === 'ok') {
      const at = Date.now();
      cache.set(key, { value, fetchedAt: at, lastUsedAt: at });
    }
    return value;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    // Always clear, including on rejection — a thrown fetch must not leave a
    // poisoned promise that every future caller awaits.
    inflight.delete(key);
  }
}

// Test/diagnostic surface.
export function chainCacheStats() {
  return { entries: cache.size, inflight: inflight.size, ttlMs: TTL_MS };
}

export function clearChainCache() {
  cache.clear();
  inflight.clear();
}
