// Upstox adapter — OAuth 2.0 login, ported from the Go backend's
// internal/upstox/auth.go. Flow: build a login URL -> user authorizes in a popup
// -> callback delivers a one-time code -> exchange it for an access_token ->
// validate with a profile call -> reuse the token for the rest of the day.
//
// NOTE: the Go backend also has a Selenium path that drives Upstox's login page
// fully automatically (mobile -> TOTP -> PIN). That needs a headless browser and
// is NOT ported here — this adapter uses the browser-popup OAuth path, which the
// frontend already supports via openUpstoxPopup(). autoLogin() returns
// {needsLogin, loginUrl} when there's no stored token.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiError } from '../server.js';
import { generateTOTP } from '../lib/totp.js';
import { setBrokerAccountId, isConfigured } from '../lib/supabaseAdmin.js';

const UPSTOX_BASE = 'https://api.upstox.com/v2';
const AUTH_DIALOG = 'https://api.upstox.com/v2/login/authorization/dialog';
const TOKEN_URL = `${UPSTOX_BASE}/login/authorization/token`;
const PROFILE_URL = `${UPSTOX_BASE}/user/profile`;
const FUNDS_URL = `${UPSTOX_BASE}/user/get-funds-and-margin`;

function redirectURI() {
  const port = Number(process.env.PORT || 3001);
  return process.env.UPSTOX_REDIRECT_URI || `http://127.0.0.1:${port}/upstox/callback`;
}

// In-memory session + pending-state stores (token reuse for the day; state ->
// creds so the callback, which is a bare browser redirect, can find them).
const sessions = new Map(); // userId -> session
const pending = new Map(); // state -> creds
const seleniumStates = new Set(); // states whose code the Selenium flow exchanges itself

export function credsForState(state) {
  return pending.get(state) || {};
}

// isSeleniumState reports whether this login's code is being exchanged by the
// headless Selenium flow. When true, the /upstox/callback route must NOT
// exchange the (single-use) code, or it burns it before autoLoginSelenium can —
// which surfaces as "Invalid Auth code". Mirrors the Go backend's markSelenium.
export function isSeleniumState(state) {
  return seleniumStates.has(state);
}
export function getSession(userId) {
  return sessions.get(userId) || null;
}

export function loginURL(cr, state) {
  const key = cr.apiKey || process.env.UPSTOX_API_KEY || '';
  if (!key) throw new ApiError('Upstox API key is missing', 400);
  const q = new URLSearchParams({ response_type: 'code', client_id: key, redirect_uri: redirectURI() });
  if (state) q.set('state', state);
  return `${AUTH_DIALOG}?${q}`;
}

async function postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(out?.errors?.[0]?.message || out?.message || `Upstox HTTP ${res.status}`, res.status);
  return out;
}

async function getJSON(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(out?.errors?.[0]?.message || out?.message || `Upstox HTTP ${res.status}`, res.status);
  return out;
}

// exchangeCode swaps the OAuth code for an access token, validates it via the
// profile call, and stores the session.
export async function exchangeCode(code, cr) {
  if (!code) throw new ApiError('missing authorization code', 400);
  const key = cr.apiKey || process.env.UPSTOX_API_KEY || '';
  const secret = cr.apiSecret || process.env.UPSTOX_API_SECRET || '';
  if (!key || !secret) throw new ApiError('Upstox API key / secret are missing', 400);

  const res = await postForm(TOKEN_URL, {
    code,
    client_id: key,
    client_secret: secret,
    redirect_uri: redirectURI(),
    grant_type: 'authorization_code',
  });
  const token = res.access_token;
  if (!token) throw new ApiError('Upstox token exchange returned no access_token', 400);

  const now = new Date().toISOString();
  const session = {
    accessToken: token,
    userId: res.user_id || '',
    email: res.email || '',
    userName: res.user_name || '',
    broker: res.broker || 'UPSTOX',
    loginAt: now,
    lastUsedAt: now,
  };
  // Resolve the canonical Upstox user_id from /user/profile (the token response's
  // user_id can be absent; profile is authoritative).
  const profile = await getJSON(PROFILE_URL, token);
  session.userId = profile?.data?.user_id || session.userId;
  session.userName = profile?.data?.user_name || session.userName;
  session.email = profile?.data?.email || session.email;
  sessions.set(session.userId, session);

  // Persist the resolved user_id into this broker config's account_id
  // (broker_accounts.client_code) so Supabase reflects the real Upstox user id.
  if (cr.configId && session.userId && isConfigured()) {
    try {
      await setBrokerAccountId(cr.configId, session.userId);
    } catch {
      /* non-fatal: login still succeeded even if the save fails */
    }
  }
  return session;
}

function buildResponse(session, funds, source) {
  return {
    status: true,
    broker: 'upstox',
    clientCode: session.userId,
    availableMargin: funds?.data?.equity?.available_margin ?? 0,
    sessionSource: source,
    session,
    data: funds?.data || {},
  };
}

// --- Selenium auto-login (fully headless, no popup) --------------------------
// Reuses the SAME Python/Selenium helper the Go backend shells out to
// (go-backend/scripts/upstox_login.py). Node builds the OAuth URL + generates
// the TOTP, the script drives Chrome (mobile -> TOTP -> PIN) and returns the
// redirect ?code=, which we exchange for a token. Fully hands-free.

const HERE = path.dirname(fileURLToPath(import.meta.url));

function scriptPath() {
  if (process.env.UPSTOX_LOGIN_SCRIPT) return process.env.UPSTOX_LOGIN_SCRIPT;
  const candidates = [
    path.resolve(HERE, '../../go-backend/scripts/upstox_login.py'),
    path.resolve(process.cwd(), 'go-backend/scripts/upstox_login.py'),
    path.resolve(process.cwd(), 'scripts/upstox_login.py'),
  ];
  return candidates.find((p) => existsSync(p)) || '';
}

function pythonExe() {
  return process.env.UPSTOX_PYTHON || 'python';
}

// runLoginScript spawns the Python helper, feeds it the JSON config on argv, and
// parses the LAST JSON line of stdout ({success, code} or {success:false,error}).
function runLoginScript(input) {
  const script = scriptPath();
  if (!script) return Promise.reject(new ApiError('upstox_login.py not found (set UPSTOX_LOGIN_SCRIPT)', 500));

  return new Promise((resolve, reject) => {
    const child = spawn(pythonExe(), [script, JSON.stringify(input)], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => process.stderr.write(d)); // stream Selenium logs
    const timer = setTimeout(() => {
      child.kill();
      reject(new ApiError('Upstox auto-login timed out', 504));
    }, 120_000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ApiError(`could not start python (${pythonExe()}): ${err.message}`, 500));
    });
    child.on('close', () => {
      clearTimeout(timer);
      let last = null;
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (t.startsWith('{')) {
          try {
            last = JSON.parse(t);
          } catch {
            /* keep scanning */
          }
        }
      }
      if (!last) return reject(new ApiError('Upstox login helper produced no result', 500));
      resolve(last);
    });
  });
}

// autoLoginSelenium drives the headless browser end to end and returns a live
// session envelope — no popup, no manual OTP.
async function autoLoginSelenium(cr, state) {
  if (!cr.phone || !cr.pin || !cr.totpSecret) {
    throw new ApiError('Upstox auto-login needs phone, PIN and TOTP secret', 400);
  }
  // Claim this state so the callback route won't double-exchange the code.
  seleniumStates.add(state);
  try {
    const totp = generateTOTP(cr.totpSecret);
    const authUrl = loginURL(cr, state);
    const res = await runLoginScript({
      authUrl,
      redirectUri: redirectURI(),
      phone: cr.phone,
      pin: cr.pin,
      totp,
      headless: true,
    });
    if (!res.success || !res.code) {
      throw new ApiError(res.error || 'Upstox auto-login did not return an authorization code', 400);
    }
    const session = await exchangeCode(res.code, cr);
    let funds = {};
    try {
      funds = await getJSON(FUNDS_URL, session.accessToken);
    } catch {
      /* funds may be closed outside market hours; login still succeeded */
    }
    return buildResponse(session, funds, 'auto-login');
  } finally {
    seleniumStates.delete(state);
    pending.delete(state);
  }
}

// autoLogin: reuse a stored token; else if autoLogin is enabled with
// phone/PIN/TOTP, run the headless Selenium flow (no popup); otherwise fall back
// to returning needsLogin + loginUrl for the manual browser-popup OAuth path.
export async function autoLogin({ userId, state, ...cr }) {
  if (state) pending.set(state, cr);

  const existing = userId && sessions.get(userId);
  if (existing) {
    try {
      const funds = await getJSON(FUNDS_URL, existing.accessToken);
      existing.lastUsedAt = new Date().toISOString();
      return buildResponse(existing, funds, 'session');
    } catch {
      sessions.delete(userId); // stale token -> fall through to fresh login
    }
  }

  // Fully-automated headless path when the row has Auto Login ticked + creds.
  if (cr.autoLogin && cr.phone && cr.pin && cr.totpSecret) {
    return autoLoginSelenium(cr, state || `selenium-${Date.now()}`);
  }

  // Manual OAuth popup fallback.
  return { status: false, needsLogin: true, broker: 'upstox', loginUrl: loginURL(cr, state) };
}

// completeCallback is called by the /upstox/callback route with the OAuth code.
export async function completeCallback(code, state) {
  const cr = credsForState(state);
  const session = await exchangeCode(code, cr);
  pending.delete(state);
  return session;
}
