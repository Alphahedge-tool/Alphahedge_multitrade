// Global instrument master store — the "symtoken" layer.
//
// Holds one normalized instrument list PER BROKER, each row carrying both the
// canonical symbol and that broker's own identifiers, so the frontend can send
// ONE canonical symbol and the backend routes it to the correct broker token.
//
// Row shape (per broker):
//   { symbol, brsymbol, name, exchange, brexchange, token, expiry, strike,
//     optionType, lotsize, ticksize, segment, instrumentType }
//   symbol   = canonical (NIFTY30JAN2521500CE)   ← the routing key
//   brsymbol = the broker's own trading symbol
//   token    = the broker's instrument token / ref_id / instrument_key
//
// Storage: in-memory maps for O(1) lookup, cached to JSON on disk so a restart
// reuses a fresh master instead of re-downloading. One file per broker.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Cache dir: node-backend/master/cache/{broker}.json
const CACHE_DIR = process.env.MASTER_CACHE_DIR || path.resolve(HERE, 'cache');
const TTL_MS = 20 * 60 * 60 * 1000; // 20h — masters change daily

// Per broker: { rows: [...], byKey: Map("SYMBOL|EXCHANGE" -> row), loadedAt }
const brokers = new Map();

function keyOf(symbol, exchange) {
  return `${String(symbol).toUpperCase()}|${String(exchange || '').toUpperCase()}`;
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheFile(broker) {
  return path.join(CACHE_DIR, `${broker}.json`);
}

// setMaster installs a broker's normalized rows, builds the lookup index, and
// caches to disk. Called by each broker's loader.
export function setMaster(broker, rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (r.symbol) byKey.set(keyOf(r.symbol, r.exchange), r);
  }
  const entry = { rows, byKey, loadedAt: Date.now() };
  brokers.set(broker, entry);

  try {
    ensureCacheDir();
    fs.writeFileSync(cacheFile(broker), JSON.stringify({ loadedAt: entry.loadedAt, rows }));
  } catch {
    /* cache write is best-effort */
  }
  return rows.length;
}

// loadFromCache restores a broker's master from disk if present and fresh.
export function loadFromCache(broker) {
  try {
    const raw = fs.readFileSync(cacheFile(broker), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.rows || Date.now() - (parsed.loadedAt || 0) > TTL_MS) return false;
    const byKey = new Map();
    for (const r of parsed.rows) if (r.symbol) byKey.set(keyOf(r.symbol, r.exchange), r);
    brokers.set(broker, { rows: parsed.rows, byKey, loadedAt: parsed.loadedAt });
    return true;
  } catch {
    return false;
  }
}

export function isFresh(broker) {
  const e = brokers.get(broker);
  return Boolean(e && Date.now() - e.loadedAt <= TTL_MS);
}

// resolve returns the broker's row for a canonical symbol + exchange, or null.
// This is the routing brain: canonical symbol -> that broker's token.
export function resolve(broker, symbol, exchange) {
  const e = brokers.get(broker);
  if (!e) return null;
  return e.byKey.get(keyOf(symbol, exchange)) || null;
}

// getToken is the common shorthand: canonical symbol -> broker token (+ meta).
export function getToken(broker, symbol, exchange) {
  const row = resolve(broker, symbol, exchange);
  if (!row) return null;
  return { token: row.token, brsymbol: row.brsymbol, brexchange: row.brexchange, lotsize: row.lotsize, row };
}

// search does a substring match on canonical symbol / name for a broker (for
// autocomplete). Cheap linear scan capped by `limit`.
export function search(broker, query, limit = 50) {
  const e = brokers.get(broker);
  if (!e) return [];
  const q = String(query || '').toUpperCase();
  if (!q) return [];
  const out = [];
  for (const r of e.rows) {
    if (r.symbol?.includes(q) || r.name?.toUpperCase().includes(q)) {
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// status summarizes what's loaded, for /api/master/status.
export function status() {
  const out = {};
  for (const [broker, e] of brokers) {
    out[broker] = { rows: e.rows.length, loadedAt: new Date(e.loadedAt).toISOString(), fresh: isFresh(broker) };
  }
  return out;
}

export function brokerList() {
  return [...brokers.keys()];
}
