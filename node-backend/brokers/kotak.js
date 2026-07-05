// Kotak Securities NEO Trade API (V3) adapter — headless TOTP login, ported from
// the Go backend's internal/kotak/auth.go. Flow: tradeApiLogin (mobile + UCC +
// TOTP -> View token) then tradeApiValidate (MPIN -> Trade token).

import { generateTOTP } from '../lib/totp.js';
import { ApiError } from '../server.js';

const LOGIN_URL = 'https://mis.kotaksecurities.com/login/1.0/tradeApiLogin';
const VALIDATE_URL = 'https://mis.kotaksecurities.com/login/1.0/tradeApiValidate';
// Kotak requires this fixed header on both login calls. Without it the API
// rejects the request with "Missing required field 'NeoFinKey'".
const NEO_FIN_KEY = 'neotradeapi';

async function doJSON(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'neo-fin-key': NEO_FIN_KEY, ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let out = {};
  if (text) {
    try {
      out = JSON.parse(text);
    } catch {
      out = { raw: text };
    }
  }
  // Kotak can return a top-level {status:"error"} even on HTTP 200.
  if (!res.ok || out?.status === 'error') {
    const msg = out?.message || out?.error?.[0]?.message || out?.fault?.message || `Kotak HTTP ${res.status}`;
    throw new ApiError(msg, res.status >= 400 ? res.status : 400);
  }
  return out;
}

function dataOf(res) {
  return (res && typeof res.data === 'object' && res.data) || res || {};
}

function buildLoginResponse(session, source) {
  return {
    status: true,
    broker: 'kotak',
    clientCode: session.ucc,
    availableMargin: 0,
    marginSource: 'n/a',
    sessionSource: source,
    session,
    data: { baseUrl: session.baseUrl, greetingName: session.greeting },
  };
}

// autoLogin runs the two-step headless flow and returns the uniform envelope.
export async function autoLogin(cr) {
  if (!cr.ucc || !cr.accessToken || !cr.mobileNumber || !cr.mpin || !cr.totpSecret) {
    throw new ApiError('Kotak login needs accessToken, mobileNumber, UCC, MPIN and TOTP secret', 400);
  }
  const totp = generateTOTP(cr.totpSecret);

  // Step: tradeApiLogin -> View token + sid.
  const loginRes = await doJSON(LOGIN_URL, { Authorization: cr.accessToken }, {
    mobileNumber: cr.mobileNumber,
    ucc: cr.ucc,
    totp,
  });
  const ld = dataOf(loginRes);
  const viewToken = ld.token || '';
  const viewSID = ld.sid || '';
  if (!viewToken || !viewSID) throw new ApiError('Kotak login returned no view token/sid', 400);

  // Step: tradeApiValidate -> Trade token.
  const validateRes = await doJSON(VALIDATE_URL, { Authorization: cr.accessToken, sid: viewSID, Auth: viewToken }, {
    mpin: cr.mpin,
  });
  const td = dataOf(validateRes);
  const tradeToken = td.token || '';
  if (!tradeToken) throw new ApiError('Kotak MPIN validation returned no trade token', 400);

  const now = new Date().toISOString();
  const session = {
    tradeToken,
    sid: td.sid || viewSID,
    rid: td.rid || '',
    baseUrl: td.baseUrl || '',
    ucc: cr.ucc,
    greeting: td.greetingName || '',
    loginAt: now,
    lastUsedAt: now,
  };
  return buildLoginResponse(session, 'totp-login');
}
