// /api/kotak/* — Kotak NEO headless TOTP login. Frontend posts flat fields
// (accessToken, mobileNumber, ucc, mpin, totpSecret).

import { route, readJSON, ApiError } from '../server.js';
import * as kotak from '../brokers/kotak.js';
import { setFeedAccount } from '../lib/feedRegistry.js';

route('POST', '/api/kotak/auto-login', async (req) => {
  const b = await readJSON(req);
  const c = b.client && typeof b.client === 'object' ? b.client : b;
  const cr = {
    accessToken: c.accessToken || c.apiKey,
    mobileNumber: c.mobileNumber || c.phone,
    ucc: c.ucc || c.clientCode,
    mpin: c.mpin || c.pin,
    totpSecret: c.totpSecret,
  };
  try {
    const res = await kotak.autoLogin(cr);
    // Feed Master logins register this account as the feed's Kotak source; the
    // registry change hook then starts the Kotak HSM WebSocket automatically.
    if ((b.feedRegister || c.feedRegister) && res?.session?.tradeToken) {
      setFeedAccount('kotak', {
        session: res.session,
        account: res.clientCode || cr.ucc,
        userName: b.userName || c.userName || '',
      });
    }
    return res;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(err.message || 'Kotak login failed', err.status || 500);
  }
});
