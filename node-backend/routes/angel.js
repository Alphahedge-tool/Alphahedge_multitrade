// /api/angel/* — Angel One (SmartAPI) login route.
// The frontend posts {client}; we run the headless TOTP login and return the
// RMS envelope. logout is a no-op ack (matches the Go backend).

import { route, readJSON, ApiError } from '../server.js';
import * as angel from '../brokers/angel.js';
import { setFeedAccount } from '../lib/feedRegistry.js';

function credsFrom(body) {
  const c = body.client && typeof body.client === 'object' ? body.client : body;
  return {
    configId: c.configId || c.id,  // broker_accounts row id, for saving the confirmed client code
    clientCode: c.clientCode,
    apiKey: c.apiKey,
    pin: c.pin,
    totpSecret: c.totpSecret,
    session: c.session || null,
  };
}

route('POST', '/api/angel/auto-login', async (req) => {
  const body = await readJSON(req);
  const cc = credsFrom(body);
  try {
    const res = await angel.autoLogin(cc);
    // Feed Master logins register this account as the feed's Angel source, so the
    // Option Chain can use it later WITHOUT the caller passing an account.
    if (body.feedRegister && res?.session?.jwtToken) {
      setFeedAccount('angel', {
        client: { ...cc, session: res.session, clientCode: res.clientCode || cc.clientCode },
        account: res.clientCode || cc.clientCode,
        userName: body.userName || '',
      });
    }
    return res;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(err.message || 'Angel login failed', err.status || 500);
  }
});

route('POST', '/api/angel/logout', async () => ({ status: true, message: 'Logged out' }));
