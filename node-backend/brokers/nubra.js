// Nubra broker adapter — fully automated TOTP + MPIN login over raw HTTP, plus
// one-time TOTP self-setup. No SDK: this mirrors the Go backend's
// internal/nubra flow and the REST API V3 auth doc, so it is version-proof and
// runs the same everywhere Node runs.
//
// Endpoints used (REST API V3):
//   POST /sendphoneotp     -> temp_token   (setup only; triggers SMS OTP)
//   POST /verifyphoneotp   -> auth_token   (setup only; needs the SMS OTP)
//   POST /verifypin        -> session_token
//   GET  /totp/generate-secret -> secret_key + qr_image   (setup only)
//   POST /totp/enable      -> enables TOTP                 (setup only)
//   POST /totp/login       -> auth_token                   (headless login)

import {
  generateTOTP,
  validateTOTPSecret,
  nearWindowEdge,
  msUntilNextWindow,
} from '../lib/totp.js';
import { setBrokerAccountId, isConfigured } from '../lib/supabaseAdmin.js';

const DEFAULT_BASE_URL = 'https://api.nubra.io';
const UAT_BASE_URL = 'https://uatapi.nubra.io';

export function baseUrlFor(env = process.env.NUBRA_ENV) {
  if (String(env).toUpperCase() === 'UAT') return UAT_BASE_URL;
  return process.env.NUBRA_BASE_URL || DEFAULT_BASE_URL;
}

// deviceId derives a stable per-account device id, matching the Go backend's
// defaultDeviceID so a re-login reuses the same device identity.
export function deviceId(cr) {
  if (cr.deviceId) return cr.deviceId;
  const base = String(cr.clientCode || cr.phone || 'device').replace(/[^a-zA-Z0-9]/g, '') || 'device';
  return `alphahedge-${base}`;
}

function authHeaders(devId, token) {
  const h = { 'x-device-id': devId };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// nubraError pulls the human-readable message out of a Nubra error body. The V3
// error shape is { error, nubra_error_code }; older/other endpoints use message.
function nubraError(body, status) {
  if (body && typeof body === 'object') {
    for (const key of ['error', 'message', 'detail']) {
      if (typeof body[key] === 'string' && body[key]) return body[key];
    }
  }
  return `Nubra HTTP ${status}`;
}

// AuthError carries the HTTP status so callers can special-case 440 (session
// expired -> re-login) as the REST doc's errors_and_exceptions page describes.
export class AuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

async function doJSON(baseUrl, method, path, headers, body) {
  const res = await fetch(baseUrl.replace(/\/+$/, '') + path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  if (!res.ok) throw new AuthError(nubraError(out, res.status), res.status);
  return out;
}

// serverTimeMs anchors TOTP generation to Nubra's clock (from the HTTP Date
// header) instead of this host's possibly-skewed clock. Any failure falls back
// to local time so login never blocks on this probe.
async function serverTimeMs(baseUrl) {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5_000),
    });
    const date = res.headers.get('date');
    if (date) {
      const t = Date.parse(date);
      if (!Number.isNaN(t)) return t;
    }
  } catch {
    /* fall through to local time */
  }
  return Date.now();
}

// verifyPin exchanges an auth_token + MPIN for the final session_token. Shared
// by both the TOTP login path and the one-time setup path.
async function verifyPin(baseUrl, cr, devId, authToken) {
  const pin = cr.mpin || cr.pin;
  const res = await doJSON(baseUrl, 'POST', '/verifypin', authHeaders(devId, authToken), { pin });
  const sessionToken = res.session_token;
  if (!sessionToken) throw new AuthError('Nubra MPIN verification returned no session_token', 440);
  return {
    sessionToken,
    phone: res.phone || cr.phone,
    userId: res.userId,
    clientCode: cr.clientCode,
    deviceId: devId,
    loginAt: new Date().toISOString(),
  };
}

// fetchAccountInfo calls GET /users/account_info with the session token to get
// the authoritative Nubra account details (client code / user id / name). This
// is what the Nubra web app calls after login. Best-effort: returns {} on error.
async function fetchAccountInfo(baseUrl, session) {
  try {
    const res = await doJSON(baseUrl, 'GET', '/users/account_info', authHeaders(session.deviceId, session.sessionToken));
    // Nubra nests details under data on some deployments; accept both shapes.
    const d = (res && typeof res.data === 'object' && res.data) || res || {};
    return {
      clientCode: d.client_code || d.clientCode || d.ucc || '',
      userId: d.user_id ?? d.userId ?? session.userId,
      name: d.name || d.client_name || d.display_name || '',
      email: d.email || '',
    };
  } catch {
    return {};
  }
}

// postTOTP performs POST /totp/login. Nubra decodes `totp` as an integer, so a
// code like "012345" is sent as 12345 and the server zero-pads it back.
async function postTOTP(baseUrl, cr, devId, code) {
  const totpNum = Number.parseInt(code, 10);
  if (!Number.isInteger(totpNum)) throw new AuthError('Nubra TOTP must be a 6-digit number', 400);
  return doJSON(baseUrl, 'POST', '/totp/login', authHeaders(devId, ''), {
    phone: cr.phone,
    totp: totpNum,
    otp: '',
  });
}

// login runs the fully headless flow: /totp/login -> /verifypin. A TOTP is valid
// only for its 30s window, so if the first attempt fails right at a window edge
// we wait for the next window and retry once with a fresh code. Any other
// failure (bad phone/secret/network) surfaces immediately.
export async function login(cr) {
  if (!cr.phone || !(cr.mpin || cr.pin) || !cr.totpSecret) {
    throw new AuthError('Nubra login needs phone, MPIN and TOTP secret', 400);
  }
  validateTOTPSecret(cr.totpSecret);

  const baseUrl = baseUrlFor(cr.env);
  const devId = deviceId(cr);

  for (let attempt = 0; ; attempt++) {
    const genMs = await serverTimeMs(baseUrl);
    const code = generateTOTP(cr.totpSecret, genMs);
    try {
      const loginRes = await postTOTP(baseUrl, cr, devId, code);
      const authToken = loginRes.auth_token;
      if (!authToken) throw new AuthError('Nubra TOTP login returned no auth_token', 440);
      const session = await verifyPin(baseUrl, cr, devId, authToken);

      // After login, call /users/account_info to resolve the authoritative Nubra
      // client code, and persist it to this broker config's account_id in
      // Supabase (mirrors the Upstox user_id save). Best-effort, non-fatal.
      const info = await fetchAccountInfo(baseUrl, session);
      if (info.clientCode) {
        session.clientCode = info.clientCode;
        session.name = info.name || session.name;
        if (info.userId != null) session.userId = info.userId;
        if (cr.configId && isConfigured()) {
          try {
            await setBrokerAccountId(cr.configId, info.clientCode);
          } catch {
            /* non-fatal: login still succeeded even if the save fails */
          }
        }
      }
      return session;
    } catch (err) {
      // Only retry the one failure this guards: a code expiring at a window
      // edge. One retry is enough; bail on anything else.
      if (attempt > 0 || !nearWindowEdge(genMs)) throw hintTOTPError(err);
      await sleep(msUntilNextWindow(genMs));
    }
  }
}

// hintTOTPError adds actionable context when Nubra rejects the generated code.
// Our generator is byte-for-byte identical to pyotp, so a rejected code almost
// always means the stored secret is wrong or the clock is off, not a bug.
function hintTOTPError(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('totp') || msg.includes('otp') || msg.includes('invalid')) {
    return new AuthError(
      `${err.message} — verify the TOTP secret matches the one enabled on this Nubra account and that the server clock is accurate`,
      err.status,
    );
  }
  return err;
}

// isTOTPError reports whether a login failure is a genuine TOTP problem — the
// stored secret is not enabled, has been reset, or is otherwise rejected — as
// opposed to a transient failure (network, 5xx, or a 440 session hiccup) that
// should NOT cause us to throw away an otherwise-good secret. The self-heal
// path uses this to decide whether to wipe + re-generate the secret.
export function isTOTPError(err) {
  if (!err) return false;
  // Transient / non-secret failures: never treat these as a broken secret.
  if (err.status >= 500) return false; // upstream/OMS blip
  const msg = String(err.message || '').toLowerCase();
  if (msg.includes('fetch') || msg.includes('timeout') || msg.includes('network') || msg.includes('abort')) {
    return false;
  }
  // Positive signals that the secret itself is the problem.
  return (
    msg.includes('totp') ||
    msg.includes('not enabled') ||
    msg.includes('incorrect') ||
    (msg.includes('otp') && !msg.includes('temp')) ||
    (msg.includes('invalid') && err.status === 400)
  );
}

// --- One-time TOTP self-setup (frontend supplies the SMS OTP once) -----------

// startSetup begins TOTP enrollment for an account that has no secret yet. It
// triggers the SMS OTP and returns a handle the frontend echoes back to
// finishSetup along with the code the user received.
export async function startSetup(cr) {
  if (!cr.phone) throw new AuthError('Nubra TOTP setup needs a phone number', 400);
  const baseUrl = baseUrlFor(cr.env);
  const devId = deviceId(cr);

  // A single /sendphoneotp already dispatches the OTP (the response comes back
  // with message "OTP sent", next "VERIFY_MOBILE", and a temp_token). The REST
  // doc shows a second call, but on the live PROD flow that second call is
  // counted as another send and trips "Maximum attempts reached", so we make
  // exactly one call and carry its temp_token into finishSetup.
  const res = await doJSON(baseUrl, 'POST', '/sendphoneotp', {}, { phone: cr.phone, skip_totp: false });
  if (!res.temp_token) throw new AuthError('Nubra /sendphoneotp returned no temp_token', 440);
  return { tempToken: res.temp_token, deviceId: devId, baseUrl };
}

// finishSetup completes enrollment with the SMS OTP the user typed:
//   verify OTP -> verify MPIN (session) -> generate secret -> enable TOTP.
// It returns the generated secret so the caller can persist it (Supabase) and
// immediately auto-login with it.
export async function finishSetup(cr, { tempToken, otp }) {
  if (!tempToken || !otp) throw new AuthError('Nubra TOTP setup needs the temp token and SMS OTP', 400);
  const baseUrl = baseUrlFor(cr.env);
  const devId = deviceId(cr);

  const verified = await doJSON(baseUrl, 'POST', '/verifyphoneotp', { 'x-temp-token': tempToken, 'x-device-id': devId }, {
    phone: cr.phone,
    otp: String(otp),
  });
  const authToken = verified.auth_token;
  if (!authToken) throw new AuthError('Nubra OTP verification returned no auth_token', 440);

  const session = await verifyPin(baseUrl, cr, devId, authToken);

  const generated = await doJSON(baseUrl, 'GET', '/totp/generate-secret', authHeaders(devId, session.sessionToken));
  const secret = generated?.data?.secret_key || generated?.secret_key;
  const qrImage = generated?.data?.qr_image || generated?.qr_image || '';
  if (!secret) throw new AuthError('Nubra TOTP setup returned no secret_key', 500);
  validateTOTPSecret(secret);

  // Enable TOTP with a fresh code (retry once at a window edge, like login).
  for (let attempt = 0; ; attempt++) {
    const genMs = await serverTimeMs(baseUrl);
    const code = generateTOTP(secret, genMs);
    try {
      await doJSON(baseUrl, 'POST', '/totp/enable', authHeaders(devId, session.sessionToken), {
        mpin: cr.mpin || cr.pin,
        totp: code,
      });
      break;
    } catch (err) {
      if (attempt > 0 || !nearWindowEdge(genMs)) throw hintTOTPError(err);
      await sleep(msUntilNextWindow(genMs));
    }
  }

  return { totpSecret: secret, qrImage, session };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
