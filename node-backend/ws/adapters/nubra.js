// Nubra market-data adapter — port of openalgo's broker/nubra streaming stack
// (nubrawebsocket.py + nubra_adapter.py).
//
// Upstream: wss://api.nubra.io/apibatch/ws with Authorization: Bearer
// <session_token> + x-device-id headers.
//   Subscribe/unsubscribe are TEXT commands:
//     batch_subscribe <token> index {"instruments":[],"indexes":["TCS"]} NSE
//     batch_subscribe <token> index_bucket {...} 1d NSE      (OHLC open/close)
//     batch_subscribe <token> orderbook {"instruments":[refId],"indexes":[]}
//     batch_subscribe <token> greeks {"instruments":[refId],"indexes":[]}
//   Data arrives as BINARY protobuf: Any -> Any -> Batch* message (prices in
//   paise; divide by 100).
//
// Routing: numeric tokens are Nubra ref_ids -> orderbook (+greeks) channels;
// anything else is a name on the index channel (works for indices AND stock
// symbols per the API docs). Index names map NIFTY <-> "Nifty 50" etc.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import protobuf from 'protobufjs';
import { BaseAdapter } from '../baseAdapter.js';

const WS_URL = process.env.NUBRA_WS_URL || 'wss://api.nubra.io/apibatch/ws';

const INDEX_NAME_MAP = {
  'NIFTY 50': 'NIFTY',
  'NIFTY BANK': 'BANKNIFTY',
  'NIFTY FINANCIAL SERVICES': 'FINNIFTY',
  'BSE SENSEX': 'SENSEX',
  'BSE SENSEX 50': 'SENSEX50',
};
const SUBSCRIPTION_MAP = {
  NIFTY: 'Nifty 50',
  BANKNIFTY: 'Nifty Bank',
  FINNIFTY: 'Nifty Financial Services',
  SENSEX: 'Bse Sensex',
  SENSEX50: 'Bse Sensex 50',
};

let proto = null;
function loadProto() {
  if (proto) return proto;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // keepCase so decoded fields match the snake_case proto names (index_value…)
  const root = new protobuf.Root();
  root.loadSync(path.join(here, '../proto/nubrafrontend.proto'), { keepCase: true });
  proto = {
    Any: root.lookupType('nubra.Any'),
    index: root.lookupType('nubra.BatchWebSocketIndexMessage'),
    orderbook: root.lookupType('nubra.BatchWebSocketOrderbookMessage'),
    bucket: root.lookupType('nubra.BatchWebSocketIndexBucketMessage'),
    greeks: root.lookupType('nubra.BatchWebSocketGreeksMessage'),
  };
  return proto;
}

const num = (v) => (v == null ? 0 : Number(v));
const paise = (v) => num(v) / 100;

export class NubraAdapter extends BaseAdapter {
  // auth: { sessionToken, deviceId, clientCode }
  constructor(auth) {
    super('nubra');
    this.auth = auth || {};
    this.account = auth?.clientCode || '';
    this.conn = null;
    this.pingTimer = null;
    this.nameMap = new Map(); // UPPER(ws indexname) -> sub entry {exchange, token}
    this.refIdMap = new Map(); // refId(number) -> sub entry
    this.ohlcCache = new Map(); // UPPER(name) -> { open, close }
  }

  _connect() {
    const { sessionToken, deviceId } = this.auth;
    if (!sessionToken) {
      this.setStatus(false, 'Nubra feed needs a session token');
      return;
    }
    loadProto();
    let conn;
    try {
      conn = new WebSocket(WS_URL, {
        headers: { Authorization: `Bearer ${sessionToken}`, 'x-device-id': deviceId || 'alphahedge' },
      });
    } catch (err) {
      this.setStatus(false, 'Nubra feed error: ' + err.message);
      this.scheduleReconnect(() => this._connect());
      return;
    }
    this.conn = conn;
    conn.binaryType = 'nodebuffer';

    conn.on('open', () => {
      this.reconnectAttempts = 0;
      this.setStatus(true, 'Nubra feed connected');
      this._startPing(conn);
      const subs = this.allSubs();
      if (subs.length) this._sendSubs(subs, false);
    });

    conn.on('message', (data, isBinary) => {
      if (isBinary) this._onBinary(data);
      else this._onText(String(data));
    });

    const onDown = (msg) => {
      if (this.conn !== conn) return;
      this.conn = null;
      this._stopPing();
      this.setStatus(false, msg);
      this.scheduleReconnect(() => this._connect());
    };
    conn.on('close', () => onDown('Nubra feed closed'));
    conn.on('error', (err) => onDown('Nubra feed error: ' + err.message));
  }

  _disconnect() {
    const conn = this.conn;
    this.conn = null;
    this._stopPing();
    this.nameMap.clear();
    this.refIdMap.clear();
    this.ohlcCache.clear();
    if (conn) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    }
  }

  _startPing(conn) {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.conn !== conn || conn.readyState !== WebSocket.OPEN) {
        this._stopPing();
        return;
      }
      try {
        conn.ping();
      } catch {
        this._stopPing();
      }
    }, 20000); // SDK uses a 20s ping interval
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _subscribe(instruments) {
    this._sendSubs(instruments, false);
  }

  _unsubscribe(instruments) {
    this._sendSubs(instruments, true);
  }

  _sendSubs(instruments, unsub) {
    const verb = unsub ? 'batch_unsubscribe' : 'batch_subscribe';
    const byExchange = new Map(); // NSE/BSE -> [subscription names]
    const refIds = [];

    for (const inst of instruments || []) {
      const token = String(inst.token);
      if (/^\d+$/.test(token)) {
        const refId = Number(token);
        refIds.push(refId);
        if (unsub) this.refIdMap.delete(refId);
        else this.refIdMap.set(refId, inst);
      } else {
        const subName = SUBSCRIPTION_MAP[token.toUpperCase()] || token;
        const exchange = (inst.exchange || 'NSE').replace(/_INDEX$/, '') || 'NSE';
        if (!byExchange.has(exchange)) byExchange.set(exchange, []);
        byExchange.get(exchange).push(subName);
        if (unsub) {
          this.nameMap.delete(subName.toUpperCase());
        } else {
          this.nameMap.set(subName.toUpperCase(), inst);
          this.nameMap.set(token.toUpperCase(), inst);
          for (const [wsName, sym] of Object.entries(INDEX_NAME_MAP)) {
            if (sym === token.toUpperCase()) this.nameMap.set(wsName, inst);
          }
        }
      }
    }

    for (const [exchange, names] of byExchange) {
      const payload = JSON.stringify({ instruments: [], indexes: names });
      this._sendText(`${verb} ${this.auth.sessionToken} index ${payload} ${exchange}`);
      this._sendText(`${verb} ${this.auth.sessionToken} index_bucket ${payload} 1d ${exchange}`);
    }
    if (refIds.length) {
      const payload = JSON.stringify({ instruments: refIds, indexes: [] });
      this._sendText(`${verb} ${this.auth.sessionToken} orderbook ${payload}`);
      this._sendText(`${verb} ${this.auth.sessionToken} greeks ${payload}`);
    }
  }

  _sendText(msg) {
    const conn = this.conn;
    if (!conn || conn.readyState !== WebSocket.OPEN) return;
    try {
      conn.send(msg);
    } catch {
      /* reconnect flow re-subscribes */
    }
  }

  _onText(data) {
    const text = data.trim();
    if (text === 'Invalid Token') {
      this.setStatus(false, 'Nubra feed token invalid/expired');
      try {
        this.conn?.close();
      } catch {
        /* ignore */
      }
    }
  }

  _onBinary(buf) {
    const p = loadProto();
    let inner;
    try {
      const wrapper = p.Any.decode(buf);
      inner = p.Any.decode(wrapper.value);
    } catch {
      return;
    }
    const url = inner.type_url || '';
    try {
      if (url.endsWith('BatchWebSocketIndexMessage')) {
        const msg = p.index.decode(inner.value);
        for (const obj of [...(msg.indexes || []), ...(msg.instruments || [])]) this._onIndex(obj);
      } else if (url.endsWith('BatchWebSocketOrderbookMessage')) {
        const msg = p.orderbook.decode(inner.value);
        for (const obj of msg.instruments || []) this._onOrderbook(obj);
      } else if (url.endsWith('BatchWebSocketIndexBucketMessage')) {
        const msg = p.bucket.decode(inner.value);
        for (const obj of [...(msg.indexes || []), ...(msg.instruments || [])]) this._onBucket(obj);
      } else if (url.endsWith('BatchWebSocketGreeksMessage')) {
        const msg = p.greeks.decode(inner.value);
        for (const obj of msg.instruments || []) this._onGreeks(obj);
      }
    } catch {
      /* undecodable frame: drop */
    }
  }

  _lookupName(rawName) {
    const upper = String(rawName || '').toUpperCase();
    if (!upper) return null;
    return this.nameMap.get(upper) || this.nameMap.get(INDEX_NAME_MAP[upper] || '') || null;
  }

  _onIndex(obj) {
    const inst = this._lookupName(obj.indexname);
    if (!inst) return;
    const ltp = paise(obj.index_value);
    const prevClose = paise(obj.prev_close);
    const ohlc = this.ohlcCache.get(String(obj.indexname).toUpperCase()) || this.ohlcCache.get(String(inst.token).toUpperCase()) || {};
    this.publish({
      exchange: inst.exchange,
      token: String(inst.token),
      symbol: inst.symbol || String(inst.token),
      mode: 'quote',
      ltp,
      high: paise(obj.high_index_value),
      low: paise(obj.low_index_value),
      open: ohlc.open || 0,
      close: ohlc.close || prevClose,
      prevClose,
      volume: num(obj.volume),
      changePercent: num(obj.changepercent),
      ts: num(obj.timestamp) || Date.now(),
    });
  }

  _onBucket(obj) {
    const upper = String(obj.indexname || '').toUpperCase();
    if (!upper) return;
    const entry = { open: paise(obj.open), close: paise(obj.close) };
    this.ohlcCache.set(upper, entry);
    const mapped = INDEX_NAME_MAP[upper];
    if (mapped) this.ohlcCache.set(mapped, entry);
  }

  _onOrderbook(obj) {
    const refId = num(obj.ref_id) || num(obj.inst_id);
    const inst = this.refIdMap.get(refId);
    if (!inst) return;
    const buy = (obj.bids || []).slice(0, 5).map((b) => ({ price: paise(b.price), quantity: num(b.quantity), orders: num(b.orders) }));
    const sell = (obj.asks || []).slice(0, 5).map((a) => ({ price: paise(a.price), quantity: num(a.quantity), orders: num(a.orders) }));
    while (buy.length < 5) buy.push({ price: 0, quantity: 0, orders: 0 });
    while (sell.length < 5) sell.push({ price: 0, quantity: 0, orders: 0 });
    this.publish({
      exchange: inst.exchange,
      token: String(inst.token),
      symbol: inst.symbol || undefined,
      mode: 'depth',
      ltp: paise(obj.ltp),
      volume: num(obj.volume),
      depth: { buy, sell },
      bid: buy[0].price,
      bidQty: buy[0].quantity,
      ask: sell[0].price,
      askQty: sell[0].quantity,
      totalBuyQty: buy.reduce((s, b) => s + b.quantity, 0),
      totalSellQty: sell.reduce((s, a) => s + a.quantity, 0),
      ts: num(obj.timestamp) || Date.now(),
    });
  }

  _onGreeks(obj) {
    const refId = num(obj.ref_id);
    const inst = this.refIdMap.get(refId);
    if (!inst) return;
    const tick = {
      exchange: inst.exchange,
      token: String(inst.token),
      mode: 'quote',
      oi: num(obj.oi),
      prevOi: num(obj.prev_oi),
      greeks: { delta: num(obj.delta), theta: num(obj.theta), gamma: num(obj.gamma), vega: num(obj.vega) },
      ts: num(obj.ts) || Date.now(),
    };
    if (num(obj.iv)) tick.iv = num(obj.iv);
    if (num(obj.ltp)) tick.ltp = paise(obj.ltp);
    if (num(obj.volume)) tick.volume = num(obj.volume);
    this.publish(tick);
  }
}

export function createNubraAdapter(feedEntry) {
  const session = feedEntry?.session || {};
  return new NubraAdapter({
    sessionToken: session.sessionToken || '',
    deviceId: session.deviceId || '',
    clientCode: session.clientCode || '',
  });
}
