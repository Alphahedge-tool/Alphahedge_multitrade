// Merged option chain — combines Angel's chain (strikes, LTP, OI) with Upstox's
// /v2/option/chain (bid/ask price+qty and full greeks) per strike, using the
// global master to resolve the Upstox underlying instrument_key.
//
// Angel provides the base ladder; Upstox enriches each strike with bid/ask.
// If Upstox isn't available (no logged-in Upstox session, or the symbol isn't
// found), the chain still returns with bid/ask null — Angel data is unaffected.

import { resolve } from './store.js';
import { canonicalSymbol } from './symbol.js';

const UPSTOX_BASE = 'https://api.upstox.com/v2';

// upstoxUnderlyingKey resolves the underlying's Upstox instrument_key for an
// index/equity so we can call /v2/option/chain. Indices live under NSE_INDEX.
function upstoxUnderlyingKey(symbol) {
  // Try the common index exchange first, then plain NSE equity.
  for (const ex of ['NSE_INDEX', 'NSE', 'BSE_INDEX', 'BSE']) {
    const row = resolve('upstox', symbol, ex);
    if (row?.token) return row.token;
  }
  // Upstox indexes are keyed like "NSE_INDEX|Nifty 50" — the master may store
  // the display name; fall back to a best-effort direct key for the majors.
  const MAJORS = {
    NIFTY: 'NSE_INDEX|Nifty 50',
    BANKNIFTY: 'NSE_INDEX|Nifty Bank',
    FINNIFTY: 'NSE_INDEX|Nifty Fin Service',
    MIDCPNIFTY: 'NSE_INDEX|Nifty Midcap Select',
    SENSEX: 'BSE_INDEX|SENSEX',
  };
  return MAJORS[String(symbol).toUpperCase()] || null;
}

// fetchUpstoxChain calls Upstox's option chain for an underlying + expiry and
// returns a map: strike -> { call:{bid,ask,bidQty,askQty,ltp,oi,greeks}, put:{...} }.
async function fetchUpstoxChain({ symbol, expiryISO, accessToken }) {
  const key = upstoxUnderlyingKey(symbol);
  if (!key || !accessToken) return { byStrike: {}, source: key ? 'no-token' : 'no-key' };

  const url = `${UPSTOX_BASE}/option/chain?instrument_key=${encodeURIComponent(key)}&expiry_date=${expiryISO}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { byStrike: {}, source: `http-${res.status}` };
  const body = await res.json();
  const byStrike = {};
  for (const row of body?.data || []) {
    const strike = Number(row.strike_price);
    const pick = (o) => {
      if (!o) return null;
      const md = o.market_data || {};
      const g = o.option_greeks || {};
      return {
        instrumentKey: o.instrument_key,
        ltp: md.ltp, oi: md.oi, prevOi: md.prev_oi, volume: md.volume, close: md.close_price,
        bid: md.bid_price, bidQty: md.bid_qty, ask: md.ask_price, askQty: md.ask_qty,
        iv: g.iv, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, pop: g.pop,
      };
    };
    byStrike[strike] = { call: pick(row.call_options), put: pick(row.put_options), spot: row.underlying_spot_price };
  }
  return { byStrike, source: 'ok', spot: body?.data?.[0]?.underlying_spot_price };
}

// mergeChain enriches an Angel chain object (with strikes[], callLtp[], etc.)
// by attaching Upstox bid/ask/greeks per strike. Angel strikes are in ₹ (e.g.
// 25000); Upstox strikes are also ₹, so we match directly.
export async function buildMergedChain({ angelChain, symbol, expiryISO, upstoxAccessToken }) {
  const strikes = angelChain?.strikes || [];
  const up = await fetchUpstoxChain({ symbol, expiryISO, accessToken: upstoxAccessToken });

  // Build parallel bid/ask arrays aligned to Angel's strike order.
  const callBid = [], callAsk = [], callBidQty = [], callAskQty = [], callGreeks = [];
  const putBid = [], putAsk = [], putBidQty = [], putAskQty = [], putGreeks = [];
  for (const strike of strikes) {
    const u = up.byStrike[strike] || up.byStrike[Number(strike)] || {};
    const c = u.call || {}, p = u.put || {};
    callBid.push(c.bid ?? null); callAsk.push(c.ask ?? null); callBidQty.push(c.bidQty ?? null); callAskQty.push(c.askQty ?? null);
    putBid.push(p.bid ?? null); putAsk.push(p.ask ?? null); putBidQty.push(p.bidQty ?? null); putAskQty.push(p.askQty ?? null);
    callGreeks.push(c.iv != null ? { iv: c.iv, delta: c.delta, gamma: c.gamma, theta: c.theta, vega: c.vega } : null);
    putGreeks.push(p.iv != null ? { iv: p.iv, delta: p.delta, gamma: p.gamma, theta: p.theta, vega: p.vega } : null);
  }

  return {
    ...angelChain,
    upstox: {
      source: up.source,
      spot: up.spot ?? null,
      callBid, callAsk, callBidQty, callAskQty, callGreeks,
      putBid, putAsk, putBidQty, putAskQty, putGreeks,
    },
  };
}

export { fetchUpstoxChain };
