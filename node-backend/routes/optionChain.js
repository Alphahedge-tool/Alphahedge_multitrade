// /api/master/option-chain-extra — returns Upstox's per-strike bid/ask/greeks
// for an underlying + expiry, aligned to a given strike list, so the frontend
// can merge it onto the Angel chain it already loaded.
//
// Body: { symbol, expiry (YYYY-MM-DD or YYYYMMDD), strikes: number[],
//         upstoxUserId?, upstoxAccessToken? }
// Returns: { status, source, spot, byStrike: { <strike>: {call, put} }, aligned:{...arrays} }
//
// The Upstox access token is resolved from the logged-in Upstox session (by
// user id) if not passed directly.

import { route, readJSON, ApiError } from '../server.js';
import { fetchUpstoxChain } from '../master/optionChain.js';
import { getSession } from '../brokers/upstox.js';

// normalize expiry to Upstox's YYYY-MM-DD.
function toISODate(expiry) {
  const s = String(expiry || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

route('POST', '/api/master/option-chain-extra', async (req) => {
  const b = await readJSON(req);
  if (!b.symbol || !b.expiry) throw new ApiError('symbol and expiry required', 400);

  // Resolve the Upstox access token: explicit, else from the logged-in session.
  let accessToken = b.upstoxAccessToken || '';
  if (!accessToken && b.upstoxUserId) {
    const sess = getSession(b.upstoxUserId);
    accessToken = sess?.accessToken || '';
  }
  if (!accessToken) {
    return { status: true, source: 'no-upstox-session', byStrike: {}, aligned: null };
  }

  const expiryISO = toISODate(b.expiry);
  const { byStrike, source, spot } = await fetchUpstoxChain({ symbol: b.symbol, expiryISO, accessToken });

  // If the frontend passed the Angel strike list, return arrays aligned to it
  // (index-matched) so it can splice bid/ask straight into its chain object.
  let aligned = null;
  if (Array.isArray(b.strikes)) {
    const A = { callBid: [], callAsk: [], callBidQty: [], callAskQty: [], callGreeks: [], putBid: [], putAsk: [], putBidQty: [], putAskQty: [], putGreeks: [] };
    for (const strike of b.strikes) {
      const u = byStrike[strike] || byStrike[Number(strike)] || {};
      const c = u.call || {}, p = u.put || {};
      A.callBid.push(c.bid ?? null); A.callAsk.push(c.ask ?? null); A.callBidQty.push(c.bidQty ?? null); A.callAskQty.push(c.askQty ?? null);
      A.putBid.push(p.bid ?? null); A.putAsk.push(p.ask ?? null); A.putBidQty.push(p.bidQty ?? null); A.putAskQty.push(p.askQty ?? null);
      A.callGreeks.push(c.iv != null ? { iv: c.iv, delta: c.delta, gamma: c.gamma, theta: c.theta, vega: c.vega } : null);
      A.putGreeks.push(p.iv != null ? { iv: p.iv, delta: p.delta, gamma: p.gamma, theta: p.theta, vega: p.vega } : null);
    }
    aligned = A;
  }

  return { status: true, source, spot: spot ?? null, byStrike, aligned };
});
