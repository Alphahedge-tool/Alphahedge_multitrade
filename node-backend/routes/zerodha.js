// /api/zerodha/* - Zerodha Kite Connect OAuth login.

import { route, readJSON, ApiError } from '../server.js';
import * as zerodha from '../brokers/zerodha.js';
import { setFeedAccount } from '../lib/feedRegistry.js';
import { loadSessionMaster, resolveBroker } from '../master/manager.js';
import { resolveOrderBasket } from '../master/orderResolver.js';

const orderPollers = new Map();
const ORDER_POLL_MS = 3000;

function writeSse(res, event, data) {
  if (res.writableEnded) return false;
  try {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function orderHash(orders) {
  return JSON.stringify((orders || []).map((row) => ({
    id: row.orderid || row.order_id || '',
    symbol: row.tradingsymbol || '',
    status: row.status || row.orderstatus || '',
    qty: row.quantity || row.qty || '',
    filled: row.filled_quantity || row.filledshares || '',
    pending: row.pending_quantity || row.unfilledshares || '',
    updated: row.updatetime || row.exchange_update_timestamp || row.order_timestamp || '',
  })));
}

function getOrderPoller(userId) {
  const key = String(userId || '').trim();
  if (!key) return null;
  if (orderPollers.has(key)) return orderPollers.get(key);

  const poller = {
    key,
    clients: new Set(),
    timer: null,
    running: false,
    lastHash: '',
    lastOrders: [],
    failures: 0,
  };

  async function poll({ force = false } = {}) {
    if (poller.running) return;
    poller.running = true;
    try {
      const out = await zerodha.orderBook({ userId: key });
      const orders = out.orders || [];
      const nextHash = orderHash(orders);
      const changed = force || nextHash !== poller.lastHash;
      poller.lastHash = nextHash;
      poller.lastOrders = orders;
      poller.failures = 0;
      if (changed) {
        for (const client of poller.clients) {
          writeSse(client.res, 'orders', {
            status: true,
            broker: 'zerodha',
            account: key,
            orders,
            at: Date.now(),
          });
        }
      }
    } catch (err) {
      poller.failures += 1;
      const status = err?.status || 500;
      for (const client of poller.clients) {
        writeSse(client.res, status === 429 ? 'rate-limit' : 'error', {
          status: false,
          broker: 'zerodha',
          account: key,
          message: err.message || 'Zerodha order stream failed',
          at: Date.now(),
        });
      }
    } finally {
      poller.running = false;
      schedule();
    }
  }

  function schedule() {
    if (poller.timer) clearTimeout(poller.timer);
    if (!poller.clients.size) {
      orderPollers.delete(key);
      return;
    }
    const wait = poller.failures > 0 ? Math.min(15000, ORDER_POLL_MS * (poller.failures + 1)) : ORDER_POLL_MS;
    poller.timer = setTimeout(() => poll(), wait);
  }

  poller.add = (res) => {
    const client = { res };
    poller.clients.add(client);
    writeSse(res, 'status', {
      status: true,
      broker: 'zerodha',
      account: key,
      message: 'Order stream connected',
      pollMs: ORDER_POLL_MS,
      at: Date.now(),
    });
    if (poller.lastOrders.length) {
      writeSse(res, 'orders', {
        status: true,
        broker: 'zerodha',
        account: key,
        orders: poller.lastOrders,
        cached: true,
        at: Date.now(),
      });
    }
    poll({ force: !poller.lastHash });
    return () => {
      poller.clients.delete(client);
      if (!poller.clients.size) schedule();
    };
  };
  poller.refresh = () => poll({ force: true });

  orderPollers.set(key, poller);
  return poller;
}

function refreshOrderPoller(userId) {
  const poller = orderPollers.get(String(userId || '').trim());
  if (poller) poller.refresh();
}

route('POST', '/api/zerodha/auto-login', async (req) => {
  const b = await readJSON(req);
  try {
    const state = b.state || `zerodha-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const savedSession = b.session || b.client?.session || null;
    const brokerUserId = savedSession?.userId || b.clientCode || b.userId;
    if (savedSession?.accessToken) zerodha.restoreSession(savedSession, brokerUserId);
    const res = await zerodha.autoLogin({
      userId: brokerUserId,
      state,
      apiKey: b.apiKey,
      apiSecret: b.apiSecret,
      configId: b.configId,
      // Headless auto-login creds. broker_accounts has no password column, so the
      // Kite password is stored in the shared `pin` one (Zerodha has no PIN).
      clientCode: b.clientCode || '',
      password: b.password || b.pin || '',
      totpSecret: b.totpSecret || '',
      autoLogin: b.autoLogin !== false,
      // "Browser Login" button: skip headless, go straight to the Kite popup.
      manual: b.manual === true,
    });
    if (res?.session?.accessToken) {
      try {
        res.master = await loadSessionMaster('zerodha', res.session);
      } catch (masterError) {
        res.master = `error: ${masterError.message}`;
      }
    }
    if (b.feedRegister && res?.status && res.clientCode) {
      setFeedAccount('zerodha', {
        userId: res.clientCode,
        account: res.clientCode,
        userName: b.userName || '',
        session: res.session,
      });
    }
    return res;
  } catch (err) {
    // First-ever connection: 2FA passed but Kite is holding on the one-time app
    // Authorize screen. Don't surface this as an error — hand back a popup URL so
    // the user clicks Authorize once, exactly like the plain needsLogin fallback.
    if (err.needsAuthorize) {
      return {
        status: false,
        needsLogin: true,
        broker: 'zerodha',
        reason: err.message,
        loginUrl: zerodha.loginURL({ apiKey: b.apiKey }, b.state || ''),
      };
    }
    if (err instanceof ApiError) throw err;
    throw new ApiError(err.message || 'Zerodha login failed', err.status || 500);
  }
});

route('GET', '/api/zerodha/login-url', async (req, res, { query }) => {
  const url = zerodha.loginURL({ apiKey: query.get('apiKey') || '' }, query.get('state') || '');
  return { status: true, loginUrl: url };
});

route('POST', '/api/zerodha/order-book', async (req) => {
  const b = await readJSON(req);
  return zerodha.orderBook(b.client || b);
});

route('POST', '/api/zerodha/trade-book', async (req) => {
  const b = await readJSON(req);
  return zerodha.tradeBook(b.client || b);
});

route('POST', '/api/zerodha/positions', async (req) => {
  const b = await readJSON(req);
  const client = b.client || b;
  const session = zerodha.sessionFromClient(client);
  await loadSessionMaster('zerodha', session).catch(() => null);
  const result = await zerodha.positions(client);
  result.positions = result.positions.map((position) => {
    const instrument = resolveBroker(
      'zerodha',
      position.tradingsymbol,
      position.exchange,
      position.symboltoken || position.instrument_token,
    );
    if (!instrument) return position;
    return {
      ...position,
      lotsize: Number(instrument.lotsize) || Number(position.lotsize) || 1,
      optiontype: position.optiontype || instrument.optionType,
      expirydate: position.expirydate || instrument.expiry,
      strikeprice: position.strikeprice ?? instrument.strike,
      canonicalSymbol: instrument.symbol,
      brokerToken: String(instrument.token || position.symboltoken || ''),
    };
  });
  return result;
});

route('POST', '/api/zerodha/holdings', async (req) => {
  const b = await readJSON(req);
  return zerodha.holdings(b.client || b);
});

route('POST', '/api/zerodha/margins', async (req) => {
  const b = await readJSON(req);
  return zerodha.margins(b.client || b, b.segment || '');
});

route('POST', '/api/zerodha/logout', async (req) => {
  const b = await readJSON(req);
  return zerodha.logout(b.client || b);
});

route('POST', '/api/zerodha/place-basket', async (req) => {
  const b = await readJSON(req);
  const client = b.client || {};
  const session = zerodha.sessionFromClient(client);
  try {
    await loadSessionMaster('zerodha', session);
  } catch (err) {
    throw new ApiError(`Zerodha instrument master unavailable: ${err.message}`, 400);
  }
  let legs;
  try {
    legs = resolveOrderBasket('zerodha', b.legs || []);
  } catch (err) {
    throw new ApiError(err.message, 400);
  }
  const out = await zerodha.placeBasket({ client: { ...client, session }, legs });
  refreshOrderPoller(out.session?.userId || b.client?.userId || b.client?.clientCode);
  return out;
});

route('GET', '/api/zerodha/order-stream', async (req, res, { query }) => {
  const userId = query.get('userId') || query.get('clientCode') || '';
  if (!userId) throw new ApiError('Zerodha order stream needs userId', 400);
  if (!zerodha.getSession(userId)) throw new ApiError('Zerodha session unavailable. Login from Broker Configuration first.', 401);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 3000\n\n');

  const poller = getOrderPoller(userId);
  const unsubscribe = poller.add(res);
  const keepAlive = setInterval(() => {
    if (!writeSse(res, 'ping', { at: Date.now() })) clearInterval(keepAlive);
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
  return undefined;
});

async function handleCallback(req, res, { query }) {
  const requestToken = query.get('request_token') || '';
  const state = query.get('state') || '';
  let detail = '';
  let success = false;

  try {
    const session = await zerodha.completeCallback(requestToken, state);
    loadSessionMaster('zerodha', session).catch((err) => {
      console.log(`Zerodha master load after callback failed: ${err.message}`);
    });
    success = true;
    detail = session.userId || '';
  } catch (err) {
    detail = err.message || 'Zerodha login failed';
  }

  const html = `<!doctype html><meta charset="utf-8"><body><script>
    (function(){
      var msg = { source:'zerodha-oauth', broker:'zerodha', success:${success}, detail:${JSON.stringify(detail)} };
      try { if (window.opener) window.opener.postMessage(msg, '*'); } catch(e){}
      document.body.textContent = ${success ? "'Login complete - you can close this window.'" : JSON.stringify('Login failed: ' + detail)};
      setTimeout(function(){ try{ window.close(); }catch(e){} }, 800);
    })();
  </script></body>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

route('GET', '/zerodha/callback', handleCallback);
route('GET', '/api/zerodha/callback', handleCallback);
