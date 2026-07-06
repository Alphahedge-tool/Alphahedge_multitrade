// Feed manager — the Node port of openalgo's websocket_proxy broker_factory +
// connection_manager. One adapter per broker, created from whatever account is
// registered in the feed registry (Feed Master login), fanning normalized ticks
// out to every connected /ws/feed client.
//
// Lifecycle: Feed Master logs a broker in -> routes call setFeedAccount() ->
// the registry change hook fires -> startBroker() (re)creates that broker's
// adapter and connects its upstream WebSocket immediately. Logging in a new
// account of the same broker replaces the adapter.

import { getFeedAccount, feedStatus, onFeedChange } from '../lib/feedRegistry.js';
import { getSession as getUpstoxSession } from '../brokers/upstox.js';
import { createAngelAdapter } from './adapters/angel.js';
import { createUpstoxAdapter } from './adapters/upstox.js';
import { createKotakAdapter } from './adapters/kotak.js';
import { createNubraAdapter } from './adapters/nubra.js';
import { MODE_QUOTE, subKey } from './baseAdapter.js';

const adapters = new Map(); // broker -> adapter
const tickListeners = new Set(); // cb(tick)
const statusListeners = new Set(); // cb(statusEvent)
const refCounts = new Map(); // "broker|EXCH|token" -> count (across ws clients)

// createAdapter is the broker factory. Each creator pulls its auth from the
// feed registry entry the login route stored.
function createAdapter(broker, entry) {
  switch (broker) {
    case 'angel':
      return createAngelAdapter(entry);
    case 'upstox': {
      const session = entry.userId ? getUpstoxSession(entry.userId) : null;
      if (!session?.accessToken) throw new Error('No Upstox session for feed account');
      return createUpstoxAdapter(entry, session);
    }
    case 'kotak':
      return createKotakAdapter(entry);
    case 'nubra':
      return createNubraAdapter(entry);
    default:
      throw new Error(`No WebSocket adapter for broker "${broker}"`);
  }
}

export function startBroker(broker) {
  broker = String(broker || '').toLowerCase();
  const entry = getFeedAccount(broker);
  if (!entry) throw new Error(`No ${broker} account in the feed — log one in via Feed Master`);

  const old = adapters.get(broker);
  const oldSubs = old ? old.allSubs() : [];
  if (old) {
    try {
      old.stop();
    } catch {
      /* ignore */
    }
  }

  const adapter = createAdapter(broker, entry);
  adapter.onTick((tick) => {
    for (const cb of tickListeners) {
      try {
        cb(tick);
      } catch {
        /* ignore */
      }
    }
  });
  adapter.onStatus((ev) => {
    for (const cb of statusListeners) {
      try {
        cb(ev);
      } catch {
        /* ignore */
      }
    }
  });
  adapters.set(broker, adapter);
  adapter.start();
  // Carry active subscriptions across a re-login so clients don't notice.
  for (const sub of oldSubs) adapter.subscribe([sub], sub.mode);
  console.log(`[ws-feed] ${broker} adapter started (account ${adapter.account || 'n/a'})`);
  return adapter.status();
}

export function stopBroker(broker) {
  broker = String(broker || '').toLowerCase();
  const adapter = adapters.get(broker);
  if (!adapter) return false;
  adapters.delete(broker);
  try {
    adapter.stop();
  } catch {
    /* ignore */
  }
  console.log(`[ws-feed] ${broker} adapter stopped`);
  return true;
}

// startAll starts adapters for every broker currently registered in the feed.
export function startAll() {
  const out = {};
  for (const broker of Object.keys(feedStatus())) {
    try {
      out[broker] = startBroker(broker);
    } catch (err) {
      out[broker] = { broker, error: err.message };
    }
  }
  return out;
}

export function getAdapter(broker) {
  return adapters.get(String(broker || '').toLowerCase()) || null;
}

export function managerStatus() {
  const brokers = {};
  // Every broker in the feed registry shows up, with adapter state if running.
  for (const [broker, info] of Object.entries(feedStatus())) {
    const adapter = adapters.get(broker);
    brokers[broker] = adapter ? { ...adapter.status(), feedAccount: info.account } : { broker, running: false, connected: false, feedAccount: info.account };
  }
  for (const [broker, adapter] of adapters) {
    if (!brokers[broker]) brokers[broker] = adapter.status();
  }
  return brokers;
}

export function onTick(cb) {
  tickListeners.add(cb);
  return () => tickListeners.delete(cb);
}

export function onStatus(cb) {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

// ── client subscription refcounting ─────────────────────────────────────────
// Multiple /ws/feed clients can subscribe the same instrument; the upstream
// broker subscription is released only when the LAST client lets go.

function countKey(broker, inst) {
  return `${broker}|${subKey(String(inst.exchange || '').toUpperCase(), String(inst.token))}`;
}

export function clientSubscribe(broker, instruments, mode = MODE_QUOTE) {
  broker = String(broker || '').toLowerCase();
  const adapter = adapters.get(broker);
  if (!adapter) throw new Error(`${broker} feed is not running — log the account in via Feed Master`);
  const fresh = [];
  for (const inst of instruments || []) {
    if (!inst?.token) continue;
    const key = countKey(broker, inst);
    const count = (refCounts.get(key) || 0) + 1;
    refCounts.set(key, count);
    fresh.push(inst); // adapter dedupes; re-subscribing is harmless
  }
  if (fresh.length) adapter.subscribe(fresh, mode);
  return adapter.snapshotFor(fresh);
}

export function clientUnsubscribe(broker, instruments) {
  broker = String(broker || '').toLowerCase();
  const adapter = adapters.get(broker);
  const release = [];
  for (const inst of instruments || []) {
    if (!inst?.token) continue;
    const key = countKey(broker, inst);
    const count = (refCounts.get(key) || 0) - 1;
    if (count <= 0) {
      refCounts.delete(key);
      release.push(inst);
    } else {
      refCounts.set(key, count);
    }
  }
  if (adapter && release.length) adapter.unsubscribe(release);
}

// installAutoStart hooks the feed registry so a Feed Master login immediately
// (re)starts that broker's upstream WebSocket — the "start the websocket of
// the brokers logged into the master feed" behavior.
export function installAutoStart() {
  onFeedChange((broker, entry) => {
    try {
      if (entry) startBroker(broker);
      else stopBroker(broker);
    } catch (err) {
      console.log(`[ws-feed] auto-start ${broker} failed: ${err.message}`);
    }
  });
}
