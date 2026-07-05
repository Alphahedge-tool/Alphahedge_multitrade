// /api/kotak/* — Kotak NEO headless TOTP login. Frontend posts flat fields
// (accessToken, mobileNumber, ucc, mpin, totpSecret).

import { route, readJSON, ApiError } from '../server.js';
import * as kotak from '../brokers/kotak.js';

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
    return await kotak.autoLogin(cr);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(err.message || 'Kotak login failed', err.status || 500);
  }
});
