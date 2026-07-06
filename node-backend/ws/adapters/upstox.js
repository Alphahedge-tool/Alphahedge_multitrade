// Upstox Market Data Feed V3 adapter — openalgo broker/upstox/streaming port.
// Flow: GET /v3/feed/market-data-feed/authorize (Bearer access token) returns a
// one-time wss:// URL -> connect -> send subscribe requests as JSON encoded in
// BINARY frames -> receive protobuf FeedResponse frames (MarketDataFeedV3).
//
// Subscription keys are Upstox instrument keys ("NSE_FO|54452",
// "NSE_INDEX|Nifty 50"). subscribe() accepts {exchange, token} and builds the
// key; a token that already contains '|' is passed through untouched.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import protobuf from 'protobufjs';
import { BaseAdapter, MODE_LTP } from '../baseAdapter.js';

const AUTH_ENDPOINT = 'https://api.upstox.com/v3/feed/market-data-feed/authorize';

// project exchange segment -> Upstox instrument-key prefix
const SEGMENT = {
  NSE: 'NSE_EQ',
  BSE: 'BSE_EQ',
  NFO: 'NSE_FO',
  BFO: 'BSE_FO',
  MCX: 'MCX_FO',
  CDS: 'NCD_FO',
  NSE_INDEX: 'NSE_INDEX',
  BSE_INDEX: 'BSE_INDEX',
};

let FeedResponse = null;
function loadProto() {
  if (FeedResponse) return FeedResponse;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = protobuf.loadSync(path.join(here, '../proto/MarketDataFeedV3.proto'));
  FeedResponse = root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
  return FeedResponse;
}

export class UpstoxAdapter extends BaseAdapter {
  // auth: { accessToken, userId }
  constructor(auth) {
    super('upstox');
    this.auth = auth || {};
    this.account = auth?.userId || '';
    this.conn = null;
    this.keyMap = new Map(); // instrumentKey -> { exchange, token }
  }

  async _authorizeURL() {
    const res = await fetch(AUTH_ENDPOINT, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${this.auth.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out?.errors?.[0]?.message || `Upstox authorize HTTP ${res.status}`);
    const url = out?.data?.authorized_redirect_uri || out?.data?.authorizedRedirectUri;
    if (!url) throw new Error('Upstox authorize returned no WebSocket URL');
    return url;
  }

  _connect() {
    if (!this.auth.accessToken) {
      this.setStatus(false, 'Upstox feed needs an access token');
      return;
    }
    loadProto();
    this._authorizeURL()
      .then((url) => {
        if (!this.running) return;
        const conn = new WebSocket(url, { followRedirects: true });
        this.conn = conn;
        conn.binaryType = 'nodebuffer';

        conn.on('open', () => {
          this.reconnectAttempts = 0;
          this.setStatus(true, 'Upstox feed connected');
          this._sendSub('sub', this.allSubs());
        });

        conn.on('message', (data, isBinary) => {
          if (isBinary) this._onFeed(data);
          else this._onText(data);
        });

        const onDown = (msg) => {
          if (this.conn !== conn) return;
          this.conn = null;
          this.setStatus(false, msg);
          this.scheduleReconnect(() => this._connect());
        };
        conn.on('close', () => onDown('Upstox feed closed'));
        conn.on('error', (err) => onDown('Upstox feed error: ' + err.message));
      })
      .catch((err) => {
        this.setStatus(false, 'Upstox feed error: ' + err.message);
        this.scheduleReconnect(() => this._connect());
      });
  }

  _disconnect() {
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    }
  }

  _subscribe(instruments, mode) {
    this._sendSub('sub', instruments, mode);
  }

  _unsubscribe(instruments) {
    this._sendSub('unsub', instruments);
  }

  instrumentKey(inst) {
    const token = String(inst.token);
    if (token.includes('|')) return token;
    return `${SEGMENT[inst.exchange] || inst.exchange}|${token}`;
  }

  _sendSub(method, instruments, mode) {
    const conn = this.conn;
    if (!conn || conn.readyState !== WebSocket.OPEN || !instruments?.length) return;
    const instrumentKeys = [];
    for (const inst of instruments) {
      const key = this.instrumentKey(inst);
      instrumentKeys.push(key);
      if (method === 'sub') this.keyMap.set(key, { exchange: inst.exchange, token: String(inst.token) });
      else this.keyMap.delete(key);
    }
    const msg = {
      guid: Math.random().toString(36).slice(2, 14) + Date.now().toString(36),
      method,
      data: { instrumentKeys },
    };
    // LTP-only subs use the cheap ltpc mode; anything else gets the full feed.
    if (method === 'sub') msg.data.mode = mode === MODE_LTP ? 'ltpc' : 'full';
    try {
      conn.send(Buffer.from(JSON.stringify(msg), 'utf8')); // binary frame, per V3 spec
    } catch {
      /* reconnect flow re-subscribes */
    }
  }

  _onText(data) {
    try {
      const out = JSON.parse(String(data));
      if (out?.status === 'failed' && out?.error) {
        this.setStatus(this.connected, `Upstox ${out.method || 'request'} failed: ${out.error}`);
      }
    } catch {
      /* non-JSON text frame */
    }
  }

  _onFeed(buf) {
    let res;
    try {
      res = loadProto().decode(buf);
    } catch {
      return;
    }
    const feeds = res.feeds;
    if (!feeds) return;
    for (const [key, feed] of Object.entries(feeds)) {
      const id = this.keyMap.get(key) || splitKey(key);
      const tick = normalizeFeed(feed, id);
      if (tick) this.publish(tick);
    }
  }
}

function splitKey(key) {
  const i = key.indexOf('|');
  if (i < 0) return { exchange: 'NSE', token: key };
  return { exchange: key.slice(0, i), token: key.slice(i + 1) };
}

const num = (v) => (v == null ? 0 : Number(v));

function normalizeFeed(feed, id) {
  const tick = { exchange: id.exchange, token: id.token, mode: 'quote' };

  const applyLtpc = (ltpc) => {
    if (!ltpc) return;
    tick.ltp = num(ltpc.ltp);
    tick.prevClose = num(ltpc.cp);
    if (num(ltpc.ltt)) tick.ts = num(ltpc.ltt);
    if (tick.prevClose) {
      tick.changePercent = Number((((tick.ltp - tick.prevClose) / tick.prevClose) * 100).toFixed(2));
    }
  };

  const applyOHLC = (marketOHLC) => {
    const list = marketOHLC?.ohlc || [];
    const day = list.find((o) => o.interval === '1d') || list[0];
    if (!day) return;
    tick.open = num(day.open);
    tick.high = num(day.high);
    tick.low = num(day.low);
    tick.close = num(day.close);
    if (num(day.vol)) tick.volume = num(day.vol);
  };

  if (feed.ltpc) {
    applyLtpc(feed.ltpc);
    tick.mode = 'ltp';
  } else if (feed.fullFeed?.marketFF) {
    const ff = feed.fullFeed.marketFF;
    applyLtpc(ff.ltpc);
    applyOHLC(ff.marketOHLC);
    if (num(ff.vtt)) tick.volume = num(ff.vtt);
    tick.oi = num(ff.oi);
    tick.iv = num(ff.iv) || undefined;
    tick.totalBuyQty = num(ff.tbq);
    tick.totalSellQty = num(ff.tsq);
    if (ff.optionGreeks) {
      tick.greeks = {
        delta: num(ff.optionGreeks.delta),
        theta: num(ff.optionGreeks.theta),
        gamma: num(ff.optionGreeks.gamma),
        vega: num(ff.optionGreeks.vega),
      };
    }
    const quotes = ff.marketLevel?.bidAskQuote || [];
    if (quotes.length) {
      tick.depth = {
        buy: quotes.slice(0, 5).map((q) => ({ price: num(q.bidP), quantity: num(q.bidQ), orders: 0 })),
        sell: quotes.slice(0, 5).map((q) => ({ price: num(q.askP), quantity: num(q.askQ), orders: 0 })),
      };
      tick.bid = num(quotes[0].bidP);
      tick.bidQty = num(quotes[0].bidQ);
      tick.ask = num(quotes[0].askP);
      tick.askQty = num(quotes[0].askQ);
      tick.mode = 'depth';
    }
  } else if (feed.fullFeed?.indexFF) {
    const ff = feed.fullFeed.indexFF;
    applyLtpc(ff.ltpc);
    applyOHLC(ff.marketOHLC);
  } else if (feed.firstLevelWithGreeks) {
    const fl = feed.firstLevelWithGreeks;
    applyLtpc(fl.ltpc);
    if (num(fl.vtt)) tick.volume = num(fl.vtt);
    tick.oi = num(fl.oi);
    if (fl.firstDepth) {
      tick.bid = num(fl.firstDepth.bidP);
      tick.bidQty = num(fl.firstDepth.bidQ);
      tick.ask = num(fl.firstDepth.askP);
      tick.askQty = num(fl.firstDepth.askQ);
    }
  } else {
    return null;
  }
  return tick;
}

export function createUpstoxAdapter(feedEntry, session) {
  return new UpstoxAdapter({
    accessToken: session?.accessToken || '',
    userId: feedEntry?.userId || session?.userId || '',
  });
}
