// Angel One SmartWebSocket V2 adapter — openalgo broker/angel/streaming port.
// One upstream connection per feed account; subscribes in SNAP_QUOTE (mode 3)
// so a single stream carries LTP + OHLC + volume + OI + best-5 depth, and every
// consumer mode (ltp/quote/depth) is served from the same packets.
//
// Auth (all four headers required): raw JWT, api key, client code, feed token.
// Binary tick layout (little-endian) per SmartAPI docs / openalgo
// smartWebSocketV2.py: [0]=mode [1]=exchangeType [2:27]=token(ascii,NUL-term)
// [35:43]=exch ts [43:51]=LTP(paise) [51:59]=ltq [59:67]=atp [67:75]=volume
// [75:83]=totBuyQty(f64) [83:91]=totSellQty(f64) [91:99]=open [99:107]=high
// [107:115]=low [115:123]=close [123:131]=ltt [131:139]=OI
// [147:347]=best5 (10 x 20B: flag u16, qty i64, price i64, orders u16).

import WebSocket from 'ws';
import { SMART_STREAM_URL } from '../../angel/config.js';
import { BaseAdapter } from '../baseAdapter.js';

// exchange segment -> SmartStream exchangeType code
const EXCHANGE_TYPE = { NSE: 1, NFO: 2, BSE: 3, BFO: 4, MCX: 5, CDS: 7, NCDEX: 7 };
const TYPE_EXCHANGE = { 1: 'NSE', 2: 'NFO', 3: 'BSE', 4: 'BFO', 5: 'MCX', 7: 'CDS' };
const SNAP_QUOTE = 3; // Angel subscription mode: full snap quote

export class AngelAdapter extends BaseAdapter {
  // auth: { apiKey, clientCode, jwtToken, feedToken }
  constructor(auth) {
    super('angel');
    this.auth = auth || {};
    this.account = auth?.clientCode || '';
    this.conn = null;
    this.pingTimer = null;
  }

  _connect() {
    const { jwtToken, apiKey, clientCode, feedToken } = this.auth;
    if (!jwtToken || !feedToken) {
      this.setStatus(false, 'Angel feed needs jwtToken + feedToken');
      return;
    }
    let conn;
    try {
      conn = new WebSocket(SMART_STREAM_URL, {
        headers: {
          Authorization: jwtToken, // raw JWT, no "Bearer "
          'x-api-key': apiKey,
          'x-client-code': clientCode,
          'x-feed-token': feedToken,
        },
      });
    } catch (err) {
      this.setStatus(false, 'Angel feed error: ' + err.message);
      this.scheduleReconnect(() => this._connect());
      return;
    }
    this.conn = conn;
    conn.binaryType = 'nodebuffer';

    conn.on('open', () => {
      this.reconnectAttempts = 0;
      this.setStatus(true, 'Angel feed connected');
      this._sendSubscribe(this.allSubs());
      this._startPing(conn);
    });

    conn.on('message', (data, isBinary) => {
      if (!isBinary) return; // pong / error text frames
      const tick = parseSnapQuote(data);
      if (tick) this.publish(tick);
    });

    const onDown = (msg) => {
      if (this.conn !== conn) return;
      this.conn = null;
      this._stopPing();
      this.setStatus(false, msg);
      this.scheduleReconnect(() => this._connect());
    };
    conn.on('close', () => onDown('Angel feed closed'));
    conn.on('error', (err) => onDown('Angel feed error: ' + err.message));
  }

  _disconnect() {
    const conn = this.conn;
    this.conn = null;
    this._stopPing();
    if (conn) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    }
  }

  _subscribe(instruments) {
    this._sendSubscribe(instruments);
  }

  _unsubscribe(instruments) {
    this._sendFrame(0, instruments);
  }

  _sendSubscribe(instruments) {
    this._sendFrame(1, instruments);
  }

  // action 1 = subscribe, 0 = unsubscribe; always SNAP_QUOTE upstream.
  _sendFrame(action, instruments) {
    const conn = this.conn;
    if (!conn || conn.readyState !== WebSocket.OPEN || !instruments?.length) return;
    const byType = new Map();
    for (const inst of instruments) {
      const exType = EXCHANGE_TYPE[inst.exchange] ?? EXCHANGE_TYPE.NFO;
      if (!byType.has(exType)) byType.set(exType, []);
      byType.get(exType).push(inst.token);
    }
    const tokenList = [...byType].map(([exchangeType, tokens]) => ({ exchangeType, tokens }));
    const msg = { correlationID: 'ws-feed', action, params: { mode: SNAP_QUOTE, tokenList } };
    try {
      conn.send(JSON.stringify(msg));
    } catch {
      /* connection raced shut; reconnect flow re-subscribes */
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
        conn.send('ping');
      } catch {
        this._stopPing();
      }
    }, 10000); // Angel wants a ping ~every 10s
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

function parseSnapQuote(buf) {
  if (buf.length < 51) return null;
  const token = buf.toString('ascii', 2, 27).split('\x00')[0].replace(/[ \x00]+$/, '');
  if (!token) return null;
  const mode = buf.readUInt8(0);
  const paise = (off) => Number(buf.readBigInt64LE(off)) / 100;

  const tick = {
    exchange: TYPE_EXCHANGE[buf.readUInt8(1)] || 'NFO',
    token,
    mode: 'quote',
    ltp: paise(43),
    ts: Number(buf.readBigInt64LE(35)),
  };
  if (mode >= 2 && buf.length >= 123) {
    tick.volume = Number(buf.readBigInt64LE(67));
    tick.totalBuyQty = buf.readDoubleLE(75);
    tick.totalSellQty = buf.readDoubleLE(83);
    tick.open = paise(91);
    tick.high = paise(99);
    tick.low = paise(107);
    tick.close = paise(115);
    tick.prevClose = tick.close;
    if (tick.close) tick.changePercent = Number((((tick.ltp - tick.close) / tick.close) * 100).toFixed(2));
  }
  if (mode === SNAP_QUOTE && buf.length >= 347) {
    tick.oi = Number(buf.readBigInt64LE(131));
    const buy = [];
    const sell = [];
    for (let i = 0; i < 10; i++) {
      const off = 147 + i * 20;
      const level = {
        quantity: Number(buf.readBigInt64LE(off + 2)),
        price: Number(buf.readBigInt64LE(off + 10)) / 100,
        orders: buf.readUInt16LE(off + 18),
      };
      // flag 1 = buy side (openalgo swaps: packets flagged buy are the bid book)
      if (buf.readUInt16LE(off) === 1) buy.push(level);
      else sell.push(level);
    }
    tick.depth = { buy: buy.slice(0, 5), sell: sell.slice(0, 5) };
    tick.bid = buy[0]?.price ?? 0;
    tick.bidQty = buy[0]?.quantity ?? 0;
    tick.ask = sell[0]?.price ?? 0;
    tick.askQty = sell[0]?.quantity ?? 0;
    tick.mode = 'depth';
  }
  return tick;
}

export function createAngelAdapter(feedEntry) {
  const client = feedEntry?.client || {};
  const session = client.session || {};
  return new AngelAdapter({
    apiKey: client.apiKey || '',
    clientCode: client.clientCode || '',
    jwtToken: session.jwtToken || '',
    feedToken: session.feedToken || '',
  });
}
