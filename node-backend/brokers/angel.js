// Angel One (SmartAPI) broker adapter — headless TOTP login, ported from the Go
// backend's internal/angel/auth.go. Flow: loginByPassword (clientcode + PIN +
// TOTP) -> getRMS (margins) -> getProfile (name/email; confirm client code).
// Reuses an existing JWT if it still validates.
//
// Unlike Upstox/Nubra, Angel's client code is the LOGIN INPUT (not resolved
// after login), so getProfile mainly confirms it and pulls the name/email —
// the confirmed clientcode is still saved to Supabase for consistency.

import { generateTOTP } from '../lib/totp.js';
import { ApiError } from '../server.js';
import { setBrokerAccountId, isConfigured } from '../lib/supabaseAdmin.js';

const DEFAULT_BASE = 'https://apiconnect.angelbroking.com';

function baseUrl() {
  return (process.env.ANGEL_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

// smartHeaders builds the standard SmartAPI header set. The X-Client*IP and
// X-MACAddress headers are required by SmartAPI but need not be routable; env
// overrides mirror the Go config (ANGEL_PUBLIC_IP / ANGEL_MAC_ADDRESS).
function smartHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': process.env.ANGEL_LOCAL_IP || '127.0.0.1',
    'X-ClientPublicIP': process.env.ANGEL_PUBLIC_IP || '127.0.0.1',
    'X-MACAddress': process.env.ANGEL_MAC_ADDRESS || '00:00:00:00:00:00',
    'X-PrivateKey': apiKey,
  };
}

async function doJSON(method, path, headers, body) {
  const res = await fetch(baseUrl() + path, {
    method,
    headers,
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
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
  return out;
}

function mapData(res) {
  return (res && typeof res.data === 'object' && res.data) || {};
}

async function getRMS(headers, jwt) {
  const rms = await doJSON('GET', '/rest/secure/angelbroking/user/v1/getRMS', { ...headers, Authorization: `Bearer ${jwt}` });
  if (rms.status !== true) throw new ApiError(rms.message || 'RMS margin request failed', 400);
  return rms;
}

// getProfile returns the SmartAPI user profile (clientcode, name, email,
// exchanges, products). Best-effort — a failure here shouldn't fail login.
async function getProfile(headers, jwt) {
  try {
    const res = await doJSON('GET', '/rest/secure/angelbroking/user/v1/getProfile', { ...headers, Authorization: `Bearer ${jwt}` });
    if (res.status !== true) return {};
    const d = mapData(res);
    return {
      clientCode: d.clientcode || d.clientCode || '',
      name: d.name || '',
      email: d.email || '',
      exchanges: d.exchanges || [],
      products: d.products || [],
    };
  } catch {
    return {};
  }
}

async function loginWithTotp(cc, headers) {
  if (!cc.pin || !cc.totpSecret) throw new ApiError('PIN and TOTP secret are required', 400);
  const totp = generateTOTP(cc.totpSecret);
  const login = await doJSON('POST', '/rest/auth/angelbroking/user/v1/loginByPassword', headers, {
    clientcode: cc.clientCode,
    password: cc.pin,
    totp,
  });
  if (login.status !== true) throw new ApiError(login.message || 'SmartAPI login failed', 400);
  if (mapData(login).jwtToken == null) throw new ApiError('SmartAPI login returned no jwtToken', 400);
  return login;
}

const MARGIN_KEYS = ['net', 'availablecash', 'availablelimitmargin', 'collateral'];

function pickMargin(data) {
  for (const k of MARGIN_KEYS) if (data[k] != null) return Number(data[k]) || 0;
  return 0;
}
function pickMarginSource(data) {
  for (const k of MARGIN_KEYS) if (data[k] != null) return k;
  return 'unknown';
}

function buildRMSResponse(clientCode, data, source, session) {
  return {
    status: true,
    clientCode,
    availableMargin: pickMargin(data),
    marginSource: pickMarginSource(data),
    sessionSource: source,
    session,
    data,
  };
}

// AutoLogin reuses an existing session (validated via getRMS) or performs a fresh
// TOTP login. Returns the RMS envelope the frontend expects.
export async function autoLogin(cc) {
  if (!cc.clientCode || !cc.apiKey) throw new ApiError('User ID and API key are required', 400);
  const headers = smartHeaders(cc.apiKey);

  // Reuse a still-valid JWT if the caller sent one back.
  if (cc.session && cc.session.jwtToken) {
    try {
      const rms = await getRMS(headers, cc.session.jwtToken);
      const session = { ...cc.session, apiKey: cc.apiKey, lastUsedAt: new Date().toISOString(), lastRms: mapData(rms) };
      return buildRMSResponse(cc.clientCode, mapData(rms), 'session', session);
    } catch {
      /* fall through to a fresh login */
    }
  }

  const login = await loginWithTotp(cc, headers);
  const data = mapData(login);
  const jwt = data.jwtToken || '';
  const rms = await getRMS(headers, jwt);
  const now = new Date().toISOString();
  const session = {
    apiKey: cc.apiKey,
    jwtToken: jwt,
    refreshToken: data.refreshToken || '',
    feedToken: data.feedToken || '',
    loginSource: 'totp-login',
    loginAt: now,
    lastUsedAt: now,
    lastRms: mapData(rms),
  };

  // Fetch the authoritative profile (name/email; confirm client code) and save
  // the confirmed client code to this config's account_id in Supabase — same
  // pattern as Upstox (user_id) and Nubra (client_code). Best-effort.
  const profile = await getProfile(headers, jwt);
  const resolvedCode = profile.clientCode || cc.clientCode;
  session.name = profile.name || '';
  session.email = profile.email || '';
  if (cc.configId && resolvedCode && isConfigured()) {
    try {
      await setBrokerAccountId(cc.configId, resolvedCode);
    } catch {
      /* non-fatal */
    }
  }
  return buildRMSResponse(resolvedCode, mapData(rms), 'totp-login', session);
}
