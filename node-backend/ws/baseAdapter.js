// Base broker WebSocket adapter — the Node port of openalgo's
// websocket_proxy/base_adapter.py. Every broker adapter (angel, upstox, kotak,
// nubra) extends this and speaks its broker's native wire protocol upstream,
// while publishing NORMALIZED ticks downstream so consumers never care which
// broker a price came from.
//
// Normalized tick shape (fields absent when the broker doesn't send them):
//   {
//     type: 'tick', broker, exchange, token, symbol?, mode,   // identity
//     ltp, open, high, low, close, prevClose,                 // prices
//     volume, oi, changePercent,                              // stats
//     bid, ask, bidQty, askQty,                               // top of book
//     depth: { buy: [{price,quantity,orders}x5], sell: [...] }, // mode 3
//     ts                                                      // exchange ms
//   }
//
// Modes follow openalgo: 1 = LTP, 2 = Quote, 3 = Depth/Full.

export const MODE_LTP = 1;
export const MODE_QUOTE = 2;
export const MODE_DEPTH = 3;

export function modeName(mode) {
  return mode === MODE_DEPTH ? 'depth' : mode === MODE_LTP ? 'ltp' : 'quote';
}

export class BaseAdapter {
  constructor(broker) {
    this.broker = broker;
    this.running = false; // start() called and not stopped
    this.connected = false; // upstream socket currently open
    this.account = ''; // display-only (client code / user id)
    this.lastError = '';
    this.subs = new Map(); // "EXCHANGE|token" -> { exchange, token, symbol, mode }
    this.lastTicks = new Map(); // "EXCHANGE|token" -> last normalized tick (snapshot for new clients)
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this._tickHandlers = new Set();
    this._statusHandlers = new Set();
  }

  // ── downstream fan-out ────────────────────────────────────────────────────
  onTick(cb) {
    this._tickHandlers.add(cb);
    return () => this._tickHandlers.delete(cb);
  }

  onStatus(cb) {
    this._statusHandlers.add(cb);
    return () => this._statusHandlers.delete(cb);
  }

  publish(tick) {
    tick.type = 'tick';
    tick.broker = this.broker;
    if (!tick.ts) tick.ts = Date.now();
    const key = subKey(tick.exchange, tick.token);
    // Merge over the previous tick so partial updates (LTP-only frames) don't
    // erase OHLC/depth a client already saw in the snapshot.
    const prev = this.lastTicks.get(key);
    const merged = prev ? { ...prev, ...tick } : tick;
    this.lastTicks.set(key, merged);
    for (const cb of this._tickHandlers) {
      try {
        cb(merged);
      } catch {
        /* one bad consumer must not kill the feed */
      }
    }
  }

  setStatus(connected, message) {
    this.connected = connected;
    if (!connected && message) this.lastError = message;
    const ev = { type: 'feed_status', broker: this.broker, connected, message: message || '' };
    for (const cb of this._statusHandlers) {
      try {
        cb(ev);
      } catch {
        /* ignore */
      }
    }
  }

  // ── subscription bookkeeping (shared by all adapters) ────────────────────
  // trackSubs normalizes + records instruments, returning only the NEW ones so
  // adapters send incremental subscribe frames. Re-subscribing an existing key
  // with a higher mode upgrades it (quote -> depth).
  trackSubs(instruments, mode) {
    const added = [];
    for (const inst of instruments || []) {
      if (!inst || !inst.token) continue;
      const exchange = String(inst.exchange || '').toUpperCase();
      const token = String(inst.token);
      const key = subKey(exchange, token);
      const existing = this.subs.get(key);
      if (existing) {
        if (mode > existing.mode) {
          existing.mode = mode;
          added.push(existing); // mode upgrade needs a re-subscribe upstream
        }
        continue;
      }
      const entry = { exchange, token, symbol: inst.symbol || '', mode };
      this.subs.set(key, entry);
      added.push(entry);
    }
    return added;
  }

  dropSubs(instruments) {
    const removed = [];
    for (const inst of instruments || []) {
      if (!inst || !inst.token) continue;
      const key = subKey(String(inst.exchange || '').toUpperCase(), String(inst.token));
      const entry = this.subs.get(key);
      if (entry) {
        this.subs.delete(key);
        this.lastTicks.delete(key);
        removed.push(entry);
      }
    }
    return removed;
  }

  allSubs() {
    return [...this.subs.values()];
  }

  snapshotFor(instruments) {
    const out = [];
    for (const inst of instruments || []) {
      const t = this.lastTicks.get(subKey(String(inst.exchange || '').toUpperCase(), String(inst.token)));
      if (t) out.push(t);
    }
    return out;
  }

  // ── reconnect helper ──────────────────────────────────────────────────────
  // Adapters call scheduleReconnect(fn) from their close/error handlers; the
  // backoff is 2s,4s,8s… capped at 60s, and stop() cancels it.
  scheduleReconnect(fn) {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > 50) {
      this.setStatus(false, 'Max reconnect attempts reached');
      return;
    }
    const delay = Math.min(2000 * 2 ** Math.min(this.reconnectAttempts - 1, 5), 60000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) fn();
    }, delay);
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── lifecycle (subclasses implement _connect/_disconnect/_subscribe/_unsubscribe) ──
  start() {
    if (this.running) return;
    this.running = true;
    this.reconnectAttempts = 0;
    this._connect();
  }

  stop() {
    this.running = false;
    this.clearReconnect();
    this._disconnect();
    this.subs.clear();
    this.lastTicks.clear();
    this.setStatus(false, 'stopped');
  }

  subscribe(instruments, mode = MODE_QUOTE) {
    const added = this.trackSubs(instruments, mode);
    if (added.length) this._subscribe(added, mode);
    return added.length;
  }

  unsubscribe(instruments) {
    const removed = this.dropSubs(instruments);
    if (removed.length) this._unsubscribe(removed);
    return removed.length;
  }

  status() {
    return {
      broker: this.broker,
      running: this.running,
      connected: this.connected,
      account: this.account,
      subscriptions: this.subs.size,
      lastError: this.lastError,
    };
  }

  /* eslint-disable class-methods-use-this */
  _connect() {}
  _disconnect() {}
  _subscribe(_instruments, _mode) {}
  _unsubscribe(_instruments) {}
}

export function subKey(exchange, token) {
  return `${exchange}|${token}`;
}
