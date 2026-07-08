// /api/zerodha/* - Zerodha Kite Connect OAuth login.

import { route, readJSON, ApiError } from '../server.js';
import * as zerodha from '../brokers/zerodha.js';
import { setFeedAccount } from '../lib/feedRegistry.js';

route('POST', '/api/zerodha/auto-login', async (req) => {
  const b = await readJSON(req);
  try {
    const state = b.state || `zerodha-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const res = await zerodha.autoLogin({
      userId: b.userId || b.clientCode,
      state,
      apiKey: b.apiKey,
      apiSecret: b.apiSecret,
      configId: b.configId,
    });
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
  return zerodha.positions(b.client || b);
});

route('POST', '/api/zerodha/holdings', async (req) => {
  const b = await readJSON(req);
  return zerodha.holdings(b.client || b);
});

route('POST', '/api/zerodha/margins', async (req) => {
  const b = await readJSON(req);
  return zerodha.margins(b.client || b, b.segment || '');
});

route('POST', '/api/zerodha/place-basket', async (req) => {
  const b = await readJSON(req);
  return zerodha.placeBasket({ client: b.client || {}, legs: b.legs || [] });
});

async function handleCallback(req, res, { query }) {
  const requestToken = query.get('request_token') || '';
  const state = query.get('state') || '';
  let detail = '';
  let success = false;

  try {
    const session = await zerodha.completeCallback(requestToken, state);
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
