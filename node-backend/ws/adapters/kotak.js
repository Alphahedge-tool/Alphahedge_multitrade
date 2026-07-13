// Kotak Neo (HSM) market-data adapter — port of openalgo's
// broker/kotak/streaming HSWebSocketLib + kotak_websocket to Node.
//
// Protocol (wss://mlhsm.kotaksecurities.com, all frames binary):
//   -> connection request  [len:2][type=1][fc=3][1][len2][jwt][2][len2][sid][3][len2]"JS_API"
//   <- connection response type=1, status 'K' (ok) + optional ack interval
//   -> subscribe           [len:2][type=4|5][fc=2][1][len2][scripArr][2][len2=1][channel]
//        scripArr = [count:2] then per scrip [len:1]["sf|nse_fo|54452"]
//   <- data type=6: [ackNum? 4B][count:2] sub-messages of SNAP(83)/UPDATE(85)
//        SNAP:   [topicId:4][nameLen:1][topicName][n:1][n x int32 values][m:1][m x (fid,len,str)]
//        UPDATE: [topicId:4][n:1][n x int32 values]
//   Values are int32 BE; TRASH (-2147483648) means "unchanged". FLOAT fields
//   are scaled ints: value / (multiplier * 10^precision) with per-topic
//   multiplier/precision delivered as regular fields.
//
// Auth: the Trade token (tradeApiValidate) as jwt + its sid.

import WebSocket from 'ws';
import { BaseAdapter, MODE_DEPTH, subKey } from '../baseAdapter.js';

const HSM_URL = process.env.KOTAK_HSM_URL || 'wss://mlhsm.kotaksecurities.com';
const MAX_INSTRUMENTS = 200;
const MAX_PER_FRAME = 100;
const MAX_CHANNELS = 16;
const TRASH = -2147483648;

const TYPES = { CONNECTION: 1, THROTTLE: 2, ACK: 3, SUBSCRIBE: 4, UNSUBSCRIBE: 5, DATA: 6 };
const SNAP = 83;
const UPDATE = 85;
const F = { FLOAT32: 1, LONG: 2, DATE: 3, STRING: 4 };

// project exchange -> Kotak HSM segment (and back)
const KOTAK_SEG = { NSE: 'nse_cm', BSE: 'bse_cm', NFO: 'nse_fo', BFO: 'bse_fo', CDS: 'cde_fo', MCX: 'mcx_fo' };
const SEG_EXCHANGE = Object.fromEntries(Object.entries(KOTAK_SEG).map(([k, v]) => [v, k]));

// field index -> {name, type} tables (HSWebSocketLib SCRIP/INDEX/DEPTH_MAPPING)
function table(entries, size) {
  const arr = new Array(size).fill(null);
  for (const [i, name, type] of entries) arr[i] = { name, type };
  return arr;
}
const SCRIP_MAP = table([
  [4, 'v', F.LONG], [5, 'ltp', F.FLOAT32], [6, 'ltq', F.LONG], [7, 'tbq', F.LONG],
  [8, 'tsq', F.LONG], [9, 'bp', F.FLOAT32], [10, 'sp', F.FLOAT32], [11, 'bq', F.LONG],
  [12, 'bs', F.LONG], [13, 'ap', F.FLOAT32], [14, 'lo', F.FLOAT32], [15, 'h', F.FLOAT32],
  [20, 'op', F.FLOAT32], [21, 'c', F.FLOAT32], [22, 'oi', F.LONG],
  [23, 'mul', F.LONG], [24, 'prec', F.LONG],
], 100);
const INDEX_MAP = table([
  [2, 'iv', F.FLOAT32], [3, 'ic', F.FLOAT32], [5, 'highPrice', F.FLOAT32],
  [6, 'lowPrice', F.FLOAT32], [7, 'openingPrice', F.FLOAT32],
  [8, 'mul', F.LONG], [9, 'prec', F.LONG],
], 100);
const DEPTH_MAP = table([
  [2, 'bp', F.FLOAT32], [3, 'bp1', F.FLOAT32], [4, 'bp2', F.FLOAT32], [5, 'bp3', F.FLOAT32], [6, 'bp4', F.FLOAT32],
  [7, 'sp', F.FLOAT32], [8, 'sp1', F.FLOAT32], [9, 'sp2', F.FLOAT32], [10, 'sp3', F.FLOAT32], [11, 'sp4', F.FLOAT32],
  [12, 'bq', F.LONG], [13, 'bq1', F.LONG], [14, 'bq2', F.LONG], [15, 'bq3', F.LONG], [16, 'bq4', F.LONG],
  [17, 'bs', F.LONG], [18, 'bs1', F.LONG], [19, 'bs2', F.LONG], [20, 'bs3', F.LONG], [21, 'bs4', F.LONG],
  [22, 'bno1', F.LONG], [23, 'bno2', F.LONG], [24, 'bno3', F.LONG], [25, 'bno4', F.LONG], [26, 'bno5', F.LONG],
  [27, 'sno1', F.LONG], [28, 'sno2', F.LONG], [29, 'sno3', F.LONG], [30, 'sno4', F.LONG], [31, 'sno5', F.LONG],
  [32, 'mul', F.LONG], [33, 'prec', F.LONG],
], 100);
const MAPS = { sf: { map: SCRIP_MAP, mulIdx: 23, precIdx: 24 }, if: { map: INDEX_MAP, mulIdx: 8, precIdx: 9 }, dp: { map: DEPTH_MAP, mulIdx: 32, precIdx: 33 } };

// ── frame encoders ──────────────────────────────────────────────────────────

function withLenPrefix(build) {
  const chunks = [];
  build({
    byte: (b) => chunks.push(Buffer.from([b & 255])),
    short: (v) => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(v);
      chunks.push(b);
    },
    int: (v) => {
      const b = Buffer.alloc(4);
      b.writeInt32BE(v);
      chunks.push(b);
    },
    str: (s) => chunks.push(Buffer.from(s, 'utf8')),
    raw: (b) => chunks.push(b),
  });
  const body = Buffer.concat(chunks);
  const out = Buffer.alloc(body.length + 2);
  out.writeUInt16BE(body.length);
  body.copy(out, 2);
  return out;
}

export function connectionRequest(jwt, sid) {
  return withLenPrefix((w) => {
    w.byte(TYPES.CONNECTION);
    w.byte(3);
    w.byte(1);
    w.short(Buffer.byteLength(jwt));
    w.str(jwt);
    w.byte(2);
    w.short(Buffer.byteLength(sid));
    w.str(sid);
    w.byte(3);
    w.short(6);
    w.str('JS_API');
  });
}

function scripByteArray(scrips, prefix) {
  const items = scrips.map((s) => `${prefix}|${s}`);
  const parts = [Buffer.alloc(2)];
  parts[0].writeUInt16BE(items.length);
  for (const item of items) {
    const b = Buffer.from(item, 'utf8');
    parts.push(Buffer.from([b.length & 255]), b);
  }
  return Buffer.concat(parts);
}

export function subsRequest(scrips, type, prefix, channel = 1) {
  const arr = scripByteArray(scrips, prefix);
  return withLenPrefix((w) => {
    w.byte(type);
    w.byte(2);
    w.byte(1);
    w.short(arr.length);
    w.raw(arr);
    w.byte(2);
    w.short(1);
    w.byte(channel);
  });
}

function ackRequest(msgNum) {
  return withLenPrefix((w) => {
    w.byte(TYPES.ACK);
    w.byte(1);
    w.byte(1);
    w.short(4);
    w.int(msgNum);
  });
}

export function throttleRequest() {
  return withLenPrefix((w) => {
    w.byte(TYPES.THROTTLE);
    w.byte(1);
    w.byte(1);
    w.short(4);
    w.int(0);
  });
}

function chunks(items, size = MAX_PER_FRAME) {
  const out = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

export function subscriptionRequests(scrips, { unsubscribe = false, prefix = 'sf', channel = 1 } = {}) {
  const type = unsubscribe ? TYPES.UNSUBSCRIBE : TYPES.SUBSCRIBE;
  return chunks(scrips).map((batch, index) => subsRequest(
    batch,
    type,
    prefix,
    ((channel - 1 + index) % MAX_CHANNELS) + 1,
  ));
}

// ── adapter ─────────────────────────────────────────────────────────────────

export class KotakAdapter extends BaseAdapter {
  // auth: { tradeToken, sid, ucc }
  constructor(auth) {
    super('kotak');
    this.auth = auth || {};
    this.account = auth?.ucc || '';
    this.conn = null;
    this.cnAcked = false;
    this.pending = []; // frames queued until the cn ack arrives
    this.topics = new Map(); // topicId -> { feedType, exchange, token, fields[], mul, prec }
    this.ackNum = 0;
    this.dataCounter = 0;
    this.pingTimer = null;
  }

  _connect() {
    const { tradeToken, sid } = this.auth;
    if (!tradeToken || !sid) {
      this.setStatus(false, 'Kotak feed needs trade token + sid');
      return;
    }
    let conn;
    try {
      conn = new WebSocket(HSM_URL);
    } catch (err) {
      this.setStatus(false, 'Kotak feed error: ' + err.message);
      this.scheduleReconnect(() => this._connect());
      return;
    }
    this.conn = conn;
    conn.binaryType = 'nodebuffer';
    this.cnAcked = false;
    this.topics.clear();
    this.dataCounter = 0;

    conn.on('open', () => {
      try {
        conn.send(connectionRequest(tradeToken, sid));
      } catch (err) {
        this.setStatus(false, 'Kotak feed error: ' + err.message);
      }
      this._startPing(conn);
    });

    conn.on('message', (data, isBinary) => {
      if (isBinary) this._onFrame(data);
    });

    const onDown = (msg) => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.cnAcked = false;
      this._stopPing();
      this.setStatus(false, msg);
      this.scheduleReconnect(() => this._connect());
    };
    conn.on('close', () => onDown('Kotak feed closed'));
    conn.on('error', (err) => onDown('Kotak feed error: ' + err.message));
  }

  _disconnect() {
    const conn = this.conn;
    this.conn = null;
    this._stopPing();
    this.pending = [];
    this.topics.clear();
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
        conn.send(throttleRequest());
      } catch {
        this._stopPing();
      }
    }, 30000);
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // Non-numeric tokens are index names ("Nifty 50") on the index feed; numeric
  // tokens are scrips (quote feed, plus depth feed in mode 3).
  subscribe(instruments, mode) {
    let available = Math.max(0, MAX_INSTRUMENTS - this.subs.size);
    const accepted = [];
    for (const inst of instruments || []) {
      if (!inst?.token) continue;
      const key = subKey(String(inst.exchange || '').toUpperCase(), String(inst.token));
      if (this.subs.has(key)) accepted.push(inst);
      else if (available > 0) {
        accepted.push(inst);
        available -= 1;
      }
    }
    return super.subscribe(accepted, mode);
  }

  _subscribe(instruments, mode) {
    this._sendSubs(instruments, mode, false);
  }

  _unsubscribe(instruments) {
    this._sendSubs(instruments, MODE_DEPTH, true);
  }

  _sendSubs(instruments, mode, unsub) {
    const idx = [];
    const scrips = [];
    for (const inst of instruments || []) {
      const seg = KOTAK_SEG[inst.exchange] || String(inst.exchange || '').toLowerCase();
      const scrip = `${seg}|${inst.token}`;
      if (/^\d+$/.test(String(inst.token))) scrips.push({ scrip, mode: inst.mode ?? mode });
      else idx.push(scrip);
    }
    let channel = 1;
    const indexFrames = subscriptionRequests(idx, { unsubscribe: unsub, prefix: 'if', channel });
    for (const frame of indexFrames) this._send(frame);
    channel = ((channel - 1 + indexFrames.length) % MAX_CHANNELS) + 1;
    if (scrips.length) {
      const quoteFrames = subscriptionRequests(scrips.map((s) => s.scrip), { unsubscribe: unsub, prefix: 'sf', channel });
      for (const frame of quoteFrames) this._send(frame);
      channel = ((channel - 1 + quoteFrames.length) % MAX_CHANNELS) + 1;
      const depth = scrips.filter((s) => s.mode === MODE_DEPTH).map((s) => s.scrip);
      const depthFrames = subscriptionRequests(depth, { unsubscribe: unsub, prefix: 'dp', channel });
      for (const frame of depthFrames) this._send(frame);
    }
  }

  _send(frame) {
    if (!frame) return;
    const conn = this.conn;
    if (!conn || conn.readyState !== WebSocket.OPEN || !this.cnAcked) {
      this.pending.push(frame);
      return;
    }
    try {
      conn.send(frame);
    } catch {
      /* reconnect flow re-subscribes */
    }
  }

  // ── binary parse ──────────────────────────────────────────────────────────
  _onFrame(buf) {
    if (buf.length < 3) return;
    let pos = 2; // skip length prefix
    const type = buf.readUInt8(pos++);
    try {
      if (type === TYPES.CONNECTION) this._onConnResponse(buf, pos);
      else if (type === TYPES.DATA) this._onData(buf, pos);
      // SUBSCRIBE/UNSUBSCRIBE acks carry only OK/NOT_OK — nothing to do.
    } catch {
      /* malformed frame: drop, stream re-syncs on the next frame */
    }
  }

  _onConnResponse(buf, pos) {
    const fCount = buf.readUInt8(pos++);
    if (fCount < 1) return;
    pos++; // field id
    const len = buf.readUInt16BE(pos);
    pos += 2;
    const status = buf.toString('utf8', pos, pos + len);
    pos += len;
    if (fCount >= 2) {
      pos++; // field id
      const ackLen = buf.readUInt16BE(pos);
      pos += 2;
      this.ackNum = Number(buf.readUIntBE(pos, Math.min(ackLen, 6)) || 0);
    }
    if (status === 'K') {
      this.reconnectAttempts = 0;
      this.cnAcked = true;
      this.setStatus(true, 'Kotak feed connected');
      // Pending frames describe older incremental states. Rebuild one exact
      // subscription set to avoid sending every initial subscription twice.
      this.pending = [];
      const subs = this.allSubs();
      if (subs.length) this._sendSubs(subs.map((s) => ({ ...s })), undefined, false);
    } else {
      this.setStatus(false, 'Kotak feed authentication failed');
      try {
        this.conn?.close();
      } catch {
        /* ignore */
      }
    }
  }

  _onData(buf, pos) {
    if (this.ackNum > 0) {
      this.dataCounter++;
      const msgNum = buf.readInt32BE(pos);
      pos += 4;
      if (this.dataCounter === this.ackNum) {
        this.dataCounter = 0;
        try {
          this.conn?.send(ackRequest(msgNum));
        } catch {
          /* ignore */
        }
      }
    }
    const count = buf.readUInt16BE(pos);
    pos += 2;
    for (let n = 0; n < count; n++) {
      const subLen = buf.readUInt16BE(pos);
      pos += 2;
      const start = pos;
      const kind = buf.readUInt8(pos++);
      if (kind === SNAP) {
        const topicId = buf.readInt32BE(pos);
        pos += 4;
        const nameLen = buf.readUInt8(pos++);
        const topicName = buf.toString('utf8', pos, pos + nameLen);
        pos += nameLen;
        const topic = newTopic(topicName);
        if (!topic) {
          pos = start + subLen;
          continue;
        }
        this.topics.set(topicId, topic);
        pos = this._readLongFields(buf, pos, topic);
        const strCount = buf.readUInt8(pos++);
        for (let i = 0; i < strCount; i++) {
          const fid = buf.readUInt8(pos++);
          const slen = buf.readUInt8(pos++);
          const sval = buf.toString('utf8', pos, pos + slen);
          pos += slen;
          if (fid === 52) topic.token = sval;
          else if (fid === 53) topic.segment = sval;
          else if (fid === 54) topic.tsym = sval;
        }
        this._publishTopic(topic);
        pos = start + subLen;
      } else if (kind === UPDATE) {
        const topicId = buf.readInt32BE(pos);
        pos += 4;
        const topic = this.topics.get(topicId);
        if (!topic) {
          pos = start + subLen;
          continue;
        }
        pos = this._readLongFields(buf, pos, topic);
        this._publishTopic(topic);
        pos = start + subLen;
      } else {
        pos = start + subLen; // unknown sub-message: skip cleanly
      }
    }
  }

  _readLongFields(buf, pos, topic) {
    const fcount = buf.readUInt8(pos++);
    for (let i = 0; i < fcount; i++) {
      const val = buf.readInt32BE(pos);
      pos += 4;
      if (val !== TRASH && i < topic.fields.length) topic.fields[i] = val;
    }
    const spec = MAPS[topic.feedType];
    if (topic.fields[spec.precIdx] != null) topic.prec = topic.fields[spec.precIdx];
    if (topic.fields[spec.mulIdx] != null) topic.mul = topic.fields[spec.mulIdx] || 1;
    return pos;
  }

  _publishTopic(topic) {
    const tick = topicToTick(topic);
    if (tick) this.publish(tick);
  }
}

function newTopic(topicName) {
  const [feedType, segment, ...rest] = topicName.split('|');
  if (!MAPS[feedType]) return null;
  return {
    feedType,
    segment: segment || '',
    token: rest.join('|') || '',
    tsym: '',
    mul: 1,
    prec: 2,
    fields: new Array(100).fill(null),
  };
}

function topicToTick(topic) {
  const { feedType, fields } = topic;
  const div = (topic.mul || 1) * 10 ** (topic.prec ?? 2);
  const flt = (i) => (fields[i] == null ? undefined : fields[i] / div);
  const lng = (i) => (fields[i] == null ? undefined : fields[i]);
  const exchange = SEG_EXCHANGE[topic.segment] || (topic.segment || '').toUpperCase();
  const base = { exchange, token: topic.token, symbol: topic.tsym || undefined };

  if (feedType === 'if') {
    const ltp = flt(2);
    if (ltp == null) return null;
    const prevClose = flt(3);
    return {
      ...base,
      mode: 'quote',
      ltp,
      prevClose,
      close: prevClose,
      high: flt(5),
      low: flt(6),
      open: flt(7),
      changePercent: prevClose ? Number((((ltp - prevClose) / prevClose) * 100).toFixed(2)) : undefined,
    };
  }
  if (feedType === 'sf') {
    const ltp = flt(5);
    const prevClose = flt(21);
    return {
      ...base,
      mode: 'quote',
      ltp,
      volume: lng(4),
      totalBuyQty: lng(7),
      totalSellQty: lng(8),
      bid: flt(9),
      ask: flt(10),
      bidQty: lng(11),
      askQty: lng(12),
      low: flt(14),
      high: flt(15),
      open: flt(20),
      close: prevClose,
      prevClose,
      oi: lng(22),
      changePercent: prevClose && ltp != null ? Number((((ltp - prevClose) / prevClose) * 100).toFixed(2)) : undefined,
    };
  }
  if (feedType === 'dp') {
    const buy = [];
    const sell = [];
    for (let i = 0; i < 5; i++) {
      buy.push({ price: flt(2 + i) ?? 0, quantity: lng(12 + i) ?? 0, orders: lng(22 + i) ?? 0 });
      sell.push({ price: flt(7 + i) ?? 0, quantity: lng(17 + i) ?? 0, orders: lng(27 + i) ?? 0 });
    }
    return {
      ...base,
      mode: 'depth',
      depth: { buy, sell },
      bid: buy[0].price,
      bidQty: buy[0].quantity,
      ask: sell[0].price,
      askQty: sell[0].quantity,
    };
  }
  return null;
}

export function createKotakAdapter(feedEntry) {
  const session = feedEntry?.session || {};
  return new KotakAdapter({
    tradeToken: session.tradeToken || '',
    sid: session.sid || '',
    ucc: session.ucc || '',
  });
}
