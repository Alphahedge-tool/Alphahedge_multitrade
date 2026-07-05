// /api/upstox/* — Upstox OAuth login.
//   POST /api/upstox/auto-login  -> reuse token OR {needsLogin, loginUrl}
//   GET  /api/upstox/login-url   -> the OAuth authorization URL
//   GET  /upstox/callback        -> OAuth redirect target; exchanges code, then
//                                    postMessages success back to the popup opener
//   GET  /api/upstox/callback    -> alias of the above

import { route, readJSON, ApiError } from '../server.js';
import * as upstox from '../brokers/upstox.js';
import { setFeedAccount } from '../lib/feedRegistry.js';

route('POST', '/api/upstox/auto-login', async (req) => {
  const b = await readJSON(req);
  try {
    const res = await upstox.autoLogin({
      userId: b.userId || b.clientCode,
      state: b.state,
      apiKey: b.apiKey,
      apiSecret: b.apiSecret,
      autoLogin: b.autoLogin,
      phone: b.phone,
      pin: b.pin,
      totpSecret: b.totpSecret,
      // Config id (broker_accounts row) so the resolved Upstox user_id can be
      // saved back to that config's account_id after login.
      configId: b.configId,
    });
    // Feed Master login registers this Upstox account as the feed's bid/ask
    // source (by its resolved user_id), so the Option Chain uses it later with
    // no account passed. Only when a live session was obtained (status true).
    if (b.feedRegister && res?.status && res.clientCode) {
      setFeedAccount('upstox', { userId: res.clientCode, account: res.clientCode, userName: b.userName || '' });
    }
    return res;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(err.message || 'Upstox login failed', err.status || 500);
  }
});

route('GET', '/api/upstox/login-url', async (req, res, { query }) => {
  const url = upstox.loginURL({ apiKey: query.get('apiKey') || '' }, query.get('state') || '');
  return { status: true, loginUrl: url };
});

// The OAuth redirect lands here as a browser GET with ?code&state. We exchange
// the code, then return a tiny HTML page that postMessages the result back to
// the window that opened the popup (matching the frontend's openUpstoxPopup).
async function handleCallback(req, res, { query }) {
  const code = query.get('code') || '';
  const state = query.get('state') || '';
  let detail = '';
  let success = false;

  // If this login's code is being exchanged by the headless Selenium flow, do
  // NOT exchange it here — the code is single-use and autoLoginSelenium performs
  // the one exchange. Just acknowledge so the browser page closes.
  if (upstox.isSeleniumState(state)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><body>Login handled — you can close this window.</body>');
    return;
  }

  try {
    const session = await upstox.completeCallback(code, state);
    success = true;
    detail = session.userId || '';
  } catch (err) {
    detail = err.message || 'Upstox login failed';
  }
  const html = `<!doctype html><meta charset="utf-8"><body><script>
    (function(){
      var msg = { source:'upstox-oauth', success:${success}, detail:${JSON.stringify(detail)} };
      try { if (window.opener) window.opener.postMessage(msg, '*'); } catch(e){}
      document.body.textContent = ${success ? "'Login complete — you can close this window.'" : JSON.stringify('Login failed: ' + detail)};
      setTimeout(function(){ try{ window.close(); }catch(e){} }, 800);
    })();
  </script></body>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

route('GET', '/upstox/callback', handleCallback);
route('GET', '/api/upstox/callback', handleCallback);
