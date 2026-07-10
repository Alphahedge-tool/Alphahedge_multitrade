// /api/feed/* — the shared feed the Option Chain (and other consumers) read.
// No account is passed in requests: the feed uses whatever Angel + Upstox
// accounts were logged in via Feed Master (tracked in the feed registry).
//
//   GET  /api/feed/status                 -> which broker accounts are live
//   POST /api/feed/option-chain {symbol,expiry,fast?} -> chain; fast skips Upstox REST enrichment
//   POST /api/feed/option-chain-extra {symbol,expiry,strikes} -> Upstox bid/ask/greeks only
//   GET  /api/feed/expiries?symbol=        -> expiry list for the underlying

import { route, readJSON, ApiError } from '../server.js';
import { getFeedAccount, feedStatus } from '../lib/feedRegistry.js';
import { getSession as getUpstoxSession } from '../brokers/upstox.js';
import { fetchUpstoxChain } from '../master/optionChain.js';
import { getAngelChain, getAngelExpiries } from '../angel/feedChain.js';

route('GET', '/api/feed/status', () => ({ status: true, feed: feedStatus() }));

// Expiry list for the underlying — from the Angel scrip master (feed's Angel).
route('GET', '/api/feed/expiries', async (req, res, { query }) => {
  const symbol = query.get('symbol');
  if (!symbol) throw new ApiError('symbol required', 400);
  return { status: true, symbol, expiries: await getAngelExpiries(symbol) };
});

function toISODate(expiry) {
  const s = String(expiry || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  // DDMMMYYYY (Angel) -> YYYY-MM-DD
  const m = s.toUpperCase().match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (m) {
    const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const mm = String(MON.indexOf(m[2]) + 1).padStart(2, '0');
    return `${m[3]}-${mm}-${m[1]}`;
  }
  return s;
}

// The account-less merged option chain: Angel LTP/OI from the feed's Angel
// account, Upstox bid/ask/greeks from the feed's Upstox account.
route('POST', '/api/feed/option-chain', async (req) => {
  const b = await readJSON(req);
  if (!b.symbol || !b.expiry) throw new ApiError('symbol and expiry required', 400);

  const angelFeed = getFeedAccount('angel');
  if (!angelFeed?.client?.session?.jwtToken) {
    throw new ApiError('No Angel account in the feed — log one in via Feed Master', 400);
  }

  // 1) Angel chain (base ladder: strikes, LTP, OI, spot, atm).
  const chain = await getAngelChain(angelFeed.client, b.symbol, b.expiry);

  if (b.fast || b.includeUpstox === false) {
    return { status: true, ...chain, upstox: { source: 'deferred', aligned: null } };
  }

  // 2) Upstox enrichment (bid/ask/greeks) — from the feed's Upstox account.
  //    MCX options need the future's key as the underlying; pass the chain's
  //    resolved exchange + spot (future) token through so it can be built.
  const upstox = await buildUpstoxExtra({
    symbol: b.symbol,
    expiry: chain.expiry || b.expiry,
    strikes: chain.strikes || [],
    exchange: chain.exchange,
    spotToken: chain.spotToken,
  });

  return { status: true, ...chain, upstox };
});

route('POST', '/api/feed/option-chain-extra', async (req) => {
  const b = await readJSON(req);
  if (!b.symbol || !b.expiry) throw new ApiError('symbol and expiry required', 400);
  const upstox = await buildUpstoxExtra({
    symbol: b.symbol,
    expiry: b.expiry,
    strikes: Array.isArray(b.strikes) ? b.strikes : [],
    exchange: b.exchange,
    spotToken: b.spotToken,
  });
  return { status: true, ...upstox };
});

async function buildUpstoxExtra({ symbol, expiry, strikes, exchange, spotToken }) {
  const upFeed = getFeedAccount('upstox');
  let upstox = { source: 'no-upstox-in-feed', aligned: null };
  if (upFeed?.userId) {
    const sess = getUpstoxSession(upFeed.userId);
    if (sess?.accessToken && strikes?.length) {
      const { byStrike, source, spot } = await fetchUpstoxChain({
        symbol, expiryISO: toISODate(expiry), accessToken: sess.accessToken, exchange, spotToken,
      });
      const A = { callBid: [], callAsk: [], callBidQty: [], callAskQty: [], callGreeks: [], putBid: [], putAsk: [], putBidQty: [], putAskQty: [], putGreeks: [] };
      for (const strike of strikes) {
        const u = byStrike[strike] || byStrike[Number(strike)] || {};
        const c = u.call || {}, p = u.put || {};
        A.callBid.push(c.bid ?? null); A.callAsk.push(c.ask ?? null); A.callBidQty.push(c.bidQty ?? null); A.callAskQty.push(c.askQty ?? null);
        A.putBid.push(p.bid ?? null); A.putAsk.push(p.ask ?? null); A.putBidQty.push(p.bidQty ?? null); A.putAskQty.push(p.askQty ?? null);
        A.callGreeks.push(c.iv != null ? { iv: c.iv, delta: c.delta, gamma: c.gamma, theta: c.theta, vega: c.vega } : null);
        A.putGreeks.push(p.iv != null ? { iv: p.iv, delta: p.delta, gamma: p.gamma, theta: p.theta, vega: p.vega } : null);
      }
      upstox = { source, spot: spot ?? null, aligned: A };
    } else {
      upstox = { source: 'upstox-session-missing', aligned: null };
    }
  }
  return upstox;
}
