// /api/angel/* trade-panel routes — scrip master, option chain, basket
// margin/charges/place, order/trade/positions books, and the live SSE feed.
//
// The heavy lifting lives in ../angel/* (master, market, orders, feed, auth) —
// framework-agnostic modules ported from the Go backend. This file just wires
// them into the plain-http route table. Kept separate from the broker-login
// routes so the two concerns stay independent.

import { route, readJSON } from '../server.js';
import { allScripOptions } from '../angel/scripoptions.js';
import { scripOptionsWithSpot, chainPrices, getOptionChain, resolveLeg } from '../angel/market.js';
import { getMargin, getCharges, placeBasket, book } from '../angel/orders.js';
// Shared singletons (also used by the feed's option-chain helper) so there's one
// scrip master and one connection pool across the trade panel and the feed.
import { client, auth, master, feed } from '../angel/singletons.js';

// Warm the scrip master on boot (load from disk if fresh, else download).
master.warm().then(
  () => console.log('Angel scrip master ready'),
  (err) => console.log('Angel master warm-up failed:', err.message),
);

// ── master / search ─────────────────────────────────────────────────────────
// (auto-login + logout are registered by routes/angel.js; this trade-panel's
// own Auth singleton is still used internally by the market/order handlers so
// the option chain and basket calls have a live JWT.)
route('GET', '/api/angel/master-index', async () => master.getIndex());
route('POST', '/api/angel/refresh-master', async () => master.refresh());
route('GET', '/api/angel/search-scrips', async (req, res, { query }) => {
  const raw = Number(query.get('limit'));
  const limit = Number.isFinite(raw) && raw > 0 ? raw : 80;
  return { status: true, results: await master.searchScrips(String(query.get('q') || ''), limit) };
});

// ── option chain ────────────────────────────────────────────────────────────
route('GET', '/api/angel/all-scrip-options', async (req, res, { query }) =>
  allScripOptions(master, {
    TradeSymbol: query.get('TradeSymbol'),
    ExpiryDate: query.get('ExpiryDate'),
    MarketSegmentId: query.get('MarketSegmentId'),
  }),
);
route('POST', '/api/angel/all-scrip-options', async (req) => {
  const b = await readJSON(req);
  return scripOptionsWithSpot(client, auth, master, {
    TradeSymbol: b.TradeSymbol, ExpiryDate: b.ExpiryDate, MarketSegmentId: b.MarketSegmentId,
  }, b.client || {});
});
route('POST', '/api/angel/chain-prices', async (req) => {
  const b = await readJSON(req);
  return chainPrices(client, auth, master, { TradeSymbol: b.TradeSymbol, ExpiryDate: b.ExpiryDate }, b.client || {});
});
route('POST', '/api/angel/option-chain', async (req) => {
  const b = await readJSON(req);
  return getOptionChain(client, auth, master, { client: b.client || {}, symbol: b.symbol, expiry: b.expiry, window: b.window });
});
route('POST', '/api/angel/resolve-leg', async (req) => {
  const b = await readJSON(req);
  return resolveLeg(client, auth, master, { client: b.client || null, symbol: b.symbol, expiry: b.expiry, strike: b.strike, optionType: b.optionType });
});

// ── basket: margin / charges / place, and books ─────────────────────────────
route('POST', '/api/angel/margin', async (req) => {
  const b = await readJSON(req);
  return getMargin(client, auth, { client: b.client || {}, legs: b.legs || [] });
});
route('POST', '/api/angel/charges', async (req) => {
  const b = await readJSON(req);
  return getCharges(client, auth, { client: b.client || {}, legs: b.legs || [] });
});
route('POST', '/api/angel/place-basket', async (req) => {
  const b = await readJSON(req);
  return placeBasket(client, auth, { client: b.client || {}, legs: b.legs || [] });
});
route('POST', '/api/angel/order-book', async (req) =>
  book(client, auth, (await readJSON(req)).client || {}, '/rest/secure/angelbroking/order/v1/getOrderBook', 'orders'));
route('POST', '/api/angel/trade-book', async (req) =>
  book(client, auth, (await readJSON(req)).client || {}, '/rest/secure/angelbroking/order/v1/getTradeBook', 'trades'));
route('POST', '/api/angel/positions', async (req) =>
  book(client, auth, (await readJSON(req)).client || {}, '/rest/secure/angelbroking/order/v1/getPosition', 'positions'));

// ── live feed: subscribe + basket sync + SSE stream ─────────────────────────
route('POST', '/api/angel/subscribe', async (req) => {
  const b = await readJSON(req);
  const spot = b.spot || null;
  const n = feed.subscribe(b.credentials || {}, b.exchange || 'NFO', b.tokens || [], spot ? spot.token : '', spot ? spot.exchange : '');
  return { status: true, subscribed: n, exchange: b.exchange || 'NFO' };
});
const basketSync = async (req) => {
  const b = await readJSON(req);
  return { status: true, ...feed.setBasketTokensItems(b.credentials || null, b.items || []) };
};
route('POST', '/api/angel/basket-tokens', basketSync);
route('POST', '/api/angel/subscribe-more', basketSync);

// SSE stream: write directly to res and return undefined so the router leaves
// the response open (long-lived Server-Sent-Events connection).
route('GET', '/api/angel/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const handle = {
    write: (ev) => {
      if (ev.event) res.write(`event: ${ev.event}\n`);
      res.write(`data: ${ev.data}\n\n`);
    },
  };
  res.write('retry: 3000\n\n');
  const connected = feed.addClient(handle);
  handle.write({ event: 'status', data: JSON.stringify({ connected, message: 'Stream open' }) });
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    feed.removeClient(handle);
  });
  return undefined; // handler owns the response; do not JSON-encode
});
