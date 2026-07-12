// /api/nubra/* — Nubra login routes.
//
// Uses the headless TOTP adapter (brokers/nubra.js) with the self-heal behavior:
// when a stored secret is rejected/not-enabled, the account is re-enrolled
// (delete old secret, send OTP, re-generate + enable + save the new one).
//
// Routes (matching the Go backend's shapes):
//   POST /api/nubra/auto-login            {client}         -> login (self-healing)
//   POST /api/nubra/totp/setup            {client, otp?}   -> start or finish setup
//   POST /api/nubra/totp/generate-secret  {client}         -> start setup (send OTP)
//   POST /api/nubra/totp/enable           {client, otp}    -> finish setup with OTP

import { route, readJSON, ApiError } from '../server.js';
import * as nubra from '../brokers/nubra.js';
import { saveTotpSecret, clearTotpSecret, isConfigured } from '../lib/supabase.js';
import { setFeedAccount } from '../lib/feedRegistry.js';

// The frontend sends creds inside {client}; some callers post the fields flat.
// Accept both and normalize to the adapter's camelCase creds shape.
function credsFrom(body) {
  const c = body.client && typeof body.client === 'object' ? body.client : body;
  return {
    id: c.id,
    configId: c.configId || c.id,   // broker_accounts row id, for saving the resolved client code
    phone: c.phone,
    mpin: c.mpin || c.pin,
    pin: c.pin,
    totpSecret: c.totpSecret,
    clientCode: c.clientCode,
    deviceId: c.deviceId,
    env: c.env,
  };
}

// persistSecret saves a (re)generated secret onto the account's Supabase row when
// we have an id and Supabase is configured — so the next login is headless.
async function persistSecret(id, secret) {
  if (id && isConfigured()) await saveTotpSecret(id, secret);
}

// buildLoginResponse shapes the adapter session into the envelope the frontend
// expects (status/clientCode/session/sessionSource + data).
function buildLoginResponse(session, source) {
  return {
    status: true,
    broker: 'nubra',
    clientCode: session.clientCode || '',
    sessionSource: source,
    session,
    data: { session },
  };
}

// registerFeed records this account as the feed's Nubra source when the login
// came from Feed Master (feedRegister); the registry change hook then starts
// the Nubra market-data WebSocket automatically.
function registerFeed(body, session) {
  const c = body.client && typeof body.client === 'object' ? body.client : body;
  if (!(body.feedRegister || c.feedRegister) || !session?.sessionToken) return;
  setFeedAccount('nubra', {
    session,
    account: session.clientCode || '',
    userName: body.userName || c.userName || '',
  });
}

// POST /api/nubra/auto-login — headless login, self-healing.
route('POST', '/api/nubra/auto-login', async (req) => {
  const body = await readJSON(req);
  const cr = credsFrom(body);
  const client = body.client && typeof body.client === 'object' ? body.client : body;
  const savedSession = client.session || body.session || null;

  // A complete saved Nubra session can be reused directly. This prevents a
  // second TOTP login when startup hands the same account to Feed Master.
  if (savedSession?.sessionToken && savedSession?.deviceId) {
    registerFeed(body, savedSession);
    return buildLoginResponse(savedSession, 'session');
  }

  if (!cr.totpSecret) {
    // Not set up yet → begin enrollment (sends the SMS OTP).
    if (id_needsClear(cr)) await clearTotpSecret(cr.id);
    const { tempToken } = await nubra.startSetup(cr);
    return { status: false, needsOtp: true, broker: 'nubra', tempToken, reason: 'no-secret' };
  }

  try {
    const session = await nubra.login(cr);
    registerFeed(body, session);
    return buildLoginResponse(session, 'totp-login');
  } catch (err) {
    if (!nubra.isTOTPError(err)) throw asApiError(err);
    // Stored secret is dead → self-heal: wipe it and start fresh enrollment.
    if (id_needsClear(cr)) await clearTotpSecret(cr.id);
    try {
      const { tempToken } = await nubra.startSetup(cr);
      return { status: false, needsOtp: true, broker: 'nubra', tempToken, reason: err.message };
    } catch (sendErr) {
      return { status: false, needsOtp: true, broker: 'nubra', tempToken: null, reason: err.message, sendError: sendErr.message };
    }
  }
});

// POST /api/nubra/totp/generate-secret — start setup: send the SMS OTP and
// return the temp token the frontend echoes back to enable.
route('POST', '/api/nubra/totp/generate-secret', async (req) => {
  const cr = credsFrom(await readJSON(req));
  const { tempToken } = await nubra.startSetup(cr);
  return { status: true, broker: 'nubra', needsOtp: true, tempToken };
});

// POST /api/nubra/totp/enable — finish setup with the SMS OTP: enable TOTP, save
// the new secret to Supabase, then log in with it.
route('POST', '/api/nubra/totp/enable', async (req) => {
  const body = await readJSON(req);
  const cr = credsFrom(body);
  const tempToken = body.tempToken || body.temp_token;
  const otp = body.otp || body.totp;
  if (!tempToken || !otp) throw new ApiError('Nubra TOTP enable needs tempToken and otp', 400);

  const { totpSecret, session } = await nubra.finishSetup(cr, { tempToken, otp });
  await persistSecret(cr.id, totpSecret);
  const loginSession = await nubra.login({ ...cr, totpSecret });
  registerFeed(body, loginSession);
  return { ...buildLoginResponse(loginSession, 'totp-setup'), totpSecret, totpEnabled: true };
});

// POST /api/nubra/totp/setup — convenience: no otp -> start (send OTP);
// with otp -> finish (same as enable). Lets a single endpoint drive both halves.
route('POST', '/api/nubra/totp/setup', async (req) => {
  const body = await readJSON(req);
  const cr = credsFrom(body);
  const otp = body.otp || body.totp;
  const tempToken = body.tempToken || body.temp_token;

  if (!otp) {
    const started = await nubra.startSetup(cr);
    return { status: true, broker: 'nubra', needsOtp: true, tempToken: started.tempToken };
  }
  if (!tempToken) throw new ApiError('Nubra TOTP setup finish needs tempToken', 400);
  const { totpSecret, session } = await nubra.finishSetup(cr, { tempToken, otp });
  await persistSecret(cr.id, totpSecret);
  const loginSession = await nubra.login({ ...cr, totpSecret });
  registerFeed(body, loginSession);
  return { ...buildLoginResponse(loginSession, 'totp-setup'), totpSecret, totpEnabled: true };
});

// id_needsClear: only clear a Supabase row when we actually have an id + config.
function id_needsClear(cr) {
  return Boolean(cr.id && isConfigured());
}

// asApiError preserves the adapter's HTTP status (e.g. 440) on the response.
function asApiError(err) {
  if (err instanceof ApiError) return err;
  return new ApiError(err.message || 'Nubra login failed', err.status || 500);
}
