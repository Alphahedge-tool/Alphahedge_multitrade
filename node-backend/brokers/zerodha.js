// Zerodha Kite Connect adapter.
// Flow: build Kite login URL -> browser redirects with request_token -> exchange
// request_token for access_token using SHA-256(api_key + request_token + secret).
//
// The browser step can also be driven headlessly — see the auto-login section
// below — so an account with a password + TOTP secret never shows a popup.

import { createHash } from 'node:crypto';

import { ApiError, getPort } from '../server.js';
import { setBrokerAccountId, isConfigured } from '../lib/supabaseAdmin.js';
import { generateTOTP, nearWindowEdge, msUntilNextWindow } from '../lib/totp.js';

const KITE_BASE = 'https://api.kite.trade';
const KITE_WEB = 'https://kite.zerodha.com';
const LOGIN_URL = `${KITE_WEB}/connect/login`;
const WEB_LOGIN_URL = `${KITE_WEB}/api/login`;
const TWOFA_URL = `${KITE_WEB}/api/twofa`;
const TOKEN_URL = `${KITE_BASE}/session/token`;
const PROFILE_URL = `${KITE_BASE}/user/profile`;
const MARGINS_URL = `${KITE_BASE}/user/margins`;
const ORDERS_URL = `${KITE_BASE}/orders`;
const TRADES_URL = `${KITE_BASE}/trades`;
const POSITIONS_URL = `${KITE_BASE}/portfolio/positions`;
const HOLDINGS_URL = `${KITE_BASE}/portfolio/holdings`;

function redirectURI() {
  // getPort() is the port actually bound, which may not be the preferred one if
  // it was occupied. ZERODHA_REDIRECT_URI still wins — it has to match whatever
  // is registered in the Kite app.
  return process.env.ZERODHA_REDIRECT_URI || `http://127.0.0.1:${getPort()}/zerodha/callback`;
}

const sessions = new Map();
const pending = new Map();

export function getSession(userId) {
  return sessions.get(userId) || null;
}

// Rehydrate a browser-persisted Kite session after a backend restart. autoLogin
// validates it through the margins call before deciding whether OAuth is needed.
export function restoreSession(session, fallbackUserId = '') {
  if (!session?.accessToken) return null;
  const userId = session.userId || fallbackUserId;
  if (!userId) return null;
  const restored = { ...session, userId };
  sessions.set(userId, restored);
  return restored;
}

export function credsForState(state) {
  return pending.get(state) || {};
}

export function loginURL(cr = {}, state = '') {
  const key = cr.apiKey || process.env.ZERODHA_API_KEY || '';
  if (!key) throw new ApiError('Zerodha API key is missing', 400);

  const q = new URLSearchParams({ v: '3', api_key: key });
  if (state) q.set('redirect_params', new URLSearchParams({ state }).toString());
  return `${LOGIN_URL}?${q}`;
}

function checksum(apiKey, requestToken, apiSecret) {
  return createHash('sha256').update(`${apiKey}${requestToken}${apiSecret}`).digest('hex');
}

async function postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'X-Kite-Version': '3',
    },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.status === 'error') {
    throw new ApiError(out?.message || `Zerodha HTTP ${res.status}`, res.status || 400);
  }
  return out;
}

async function getJSON(url, session) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Kite-Version': '3',
      Authorization: `token ${session.apiKey}:${session.accessToken}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.status === 'error') {
    throw new ApiError(out?.message || `Zerodha HTTP ${res.status}`, res.status || 400);
  }
  return out;
}

async function postKiteForm(url, session, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'X-Kite-Version': '3',
      Authorization: `token ${session.apiKey}:${session.accessToken}`,
    },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.status === 'error') {
    throw new ApiError(out?.message || `Zerodha HTTP ${res.status}`, res.status || 400);
  }
  return out;
}

function normalizeClient(c = {}) {
  return c.client && typeof c.client === 'object' ? c.client : c;
}

export function sessionFromClient(input = {}) {
  const c = normalizeClient(input);
  const s = c.session || {};
  const apiKey = s.apiKey || c.apiKey || process.env.ZERODHA_API_KEY || '';
  const accessToken = s.accessToken || c.accessToken || '';
  const userId = s.userId || c.userId || c.clientCode || '';
  if (apiKey && accessToken) {
    const session = {
      apiKey,
      accessToken,
      publicToken: s.publicToken || '',
      refreshToken: s.refreshToken || '',
      userId,
      userName: s.userName || '',
      userShortname: s.userShortname || '',
      email: s.email || '',
      broker: s.broker || 'ZERODHA',
      exchanges: s.exchanges || [],
      products: s.products || [],
      orderTypes: s.orderTypes || [],
      loginAt: s.loginAt || new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    if (session.userId) sessions.set(session.userId, session);
    return session;
  }
  if (userId && sessions.has(userId)) return sessions.get(userId);
  throw new ApiError('Zerodha session unavailable. Login from Broker Configuration first.', 401);
}

export async function exchangeRequestToken(requestToken, cr = {}) {
  if (!requestToken) throw new ApiError('missing request token', 400);
  const key = cr.apiKey || process.env.ZERODHA_API_KEY || '';
  const secret = cr.apiSecret || process.env.ZERODHA_API_SECRET || '';
  if (!key || !secret) throw new ApiError('Zerodha API key / secret are missing', 400);

  const tokenRes = await postForm(TOKEN_URL, {
    api_key: key,
    request_token: requestToken,
    checksum: checksum(key, requestToken, secret),
  });
  const data = tokenRes.data || {};
  if (!data.access_token) throw new ApiError('Zerodha token exchange returned no access_token', 400);

  const now = new Date().toISOString();
  const session = {
    apiKey: key,
    accessToken: data.access_token || '',
    publicToken: data.public_token || '',
    refreshToken: data.refresh_token || '',
    userId: data.user_id || cr.userId || cr.clientCode || '',
    userName: data.user_name || '',
    userShortname: data.user_shortname || '',
    email: data.email || '',
    broker: data.broker || 'ZERODHA',
    exchanges: data.exchanges || [],
    products: data.products || [],
    orderTypes: data.order_types || [],
    // enctoken signs the private (non-Connect) Kite web endpoints; keep it so the
    // WS user-stream / any web-parity calls can reuse this same session.
    enctoken: data.enctoken || '',
    avatarUrl: data.avatar_url || '',
    meta: data.meta || {},
    loginAt: data.login_time || now,
    lastUsedAt: now,
  };

  try {
    const profileRes = await getJSON(PROFILE_URL, session);
    const profile = profileRes.data || {};
    session.userId = profile.user_id || session.userId;
    session.userName = profile.user_name || session.userName;
    session.userShortname = profile.user_shortname || session.userShortname;
    session.email = profile.email || session.email;
    session.broker = profile.broker || session.broker;
    session.exchanges = profile.exchanges || session.exchanges;
    session.products = profile.products || session.products;
    session.orderTypes = profile.order_types || session.orderTypes;
  } catch {
    /* token exchange succeeded; profile refresh can be retried later */
  }

  if (session.userId) sessions.set(session.userId, session);

  if (cr.configId && session.userId && isConfigured()) {
    try {
      await setBrokerAccountId(cr.configId, session.userId);
    } catch {
      /* non-fatal: login still succeeded even if saving account_id fails */
    }
  }

  return session;
}

function buildResponse(session, margins, source) {
  return {
    status: true,
    broker: 'zerodha',
    clientCode: session.userId,
    availableMargin: margins?.data?.equity?.available?.cash ?? margins?.data?.equity?.net ?? 0,
    sessionSource: source,
    session,
    data: margins?.data || {},
  };
}

function applyProfile(session, profile = {}) {
  session.userId = profile.user_id || session.userId;
  session.userName = profile.user_name || session.userName;
  session.userShortname = profile.user_shortname || session.userShortname;
  session.email = profile.email || session.email;
  session.broker = profile.broker || session.broker;
  session.exchanges = profile.exchanges || session.exchanges;
  session.products = profile.products || session.products;
  session.orderTypes = profile.order_types || session.orderTypes;
  return session;
}

// --- Headless auto-login (no popup, no browser) ------------------------------
// Kite's web login is a plain cookie + JSON flow, so the whole thing runs on
// fetch — unlike Upstox, which needs Selenium. Steps:
//
//   1. GET /connect/login?v=3&api_key=..  Follow the redirects; the page we land
//      on carries the sess_id Kite ties this attempt to, and sets the cookies.
//   2. POST /api/login  {user_id, password}            -> request_id
//   3. POST /api/twofa  {user_id, request_id, TOTP}    -> cookies become authorized
//   4. GET the step-1 URL again with &skip_session=true. Now that the cookies are
//      authorized, Kite redirects straight to the app's redirect_uri carrying
//      ?request_token=..., which we pluck off the Location header.
//   5. Exchange that request_token for an access_token — the same call the popup
//      flow makes, so everything downstream is identical.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A minimal cookie jar. fetch() drops Set-Cookie between calls, but Kite carries
// the whole login across cookies, so we harvest and replay them by hand.
function cookieJar() {
  const jar = new Map();
  return {
    header() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    names() {
      return [...jar.keys()];
    },
    absorb(res) {
      const lines =
        typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie()
          : [res.headers.get('set-cookie')].filter(Boolean);
      for (const line of lines) {
        const pair = line.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
  };
}

function jarHeaders(jar, extra = {}) {
  const cookie = jar.header();
  return { 'User-Agent': USER_AGENT, ...(cookie ? { Cookie: cookie } : {}), ...extra };
}

// ZERODHA_DEBUG=1 traces the login hop chain to stdout. It logs URLs, statuses
// and cookie NAMES only — never the password, the TOTP, or any cookie value.
const DEBUG = /^(1|true|yes)$/i.test(process.env.ZERODHA_DEBUG || '');

function debug(...args) {
  if (DEBUG) console.log('[zerodha]', ...args);
}

function requestTokenOf(url) {
  try {
    return new URL(url).searchParams.get('request_token') || '';
  } catch {
    return '';
  }
}

// jarGet walks the redirect chain itself (redirect: 'manual') for two reasons:
// fetch would not replay our cookies across hops, and we must STOP at the hop
// that carries request_token instead of chasing it into our own /zerodha/callback
// route — that route would exchange the token, and Kite only honours it once.
async function jarGet(jar, startUrl, maxHops = 10) {
  let url = startUrl;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: jarHeaders(jar, { Accept: 'text/html,application/xhtml+xml,*/*' }),
      signal: AbortSignal.timeout(20_000),
    });
    jar.absorb(res);
    debug(`GET ${res.status} ${url}`, res.headers.get('location') ? `-> ${res.headers.get('location')}` : '');
    // A 200 where we expected a redirect means Kite rendered a page instead of
    // handing back the token — the body says which page, so surface a snippet.
    if (DEBUG && res.status === 200) {
      const body = await res.clone().text().catch(() => '');
      debug(`  body[0:300]: ${body.slice(0, 300).replace(/\s+/g, ' ')}`);
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).toString();
      const token = requestTokenOf(url);
      if (token) return { url, requestToken: token };
      continue;
    }
    if (res.status >= 400) {
      throw new ApiError(`Zerodha login page returned HTTP ${res.status}`, res.status);
    }
    return { url, requestToken: requestTokenOf(url) };
  }
  throw new ApiError('Zerodha login redirected too many times', 502);
}

async function jarPost(jar, url, form, referer) {
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: jarHeaders(jar, {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'X-Kite-Version': '3',
      ...(referer ? { Referer: referer } : {}),
    }),
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  jar.absorb(res);
  const out = await res.json().catch(() => ({}));
  debug(`POST ${res.status} ${url} -> status=${out?.status || '?'} ${out?.message || ''}`);
  if (!res.ok || out.status === 'error') {
    throw new ApiError(out?.message || `Zerodha HTTP ${res.status}`, res.status || 400);
  }
  return out;
}

// Kite reports a bad TOTP as a generic "Invalid TOTP"; point at the usual cause,
// which is a secret copied from the wrong place rather than a mistyped code.
function hintTOTPError(err) {
  if (/totp|two.?fa/i.test(err?.message || '')) {
    return new ApiError(
      `${err.message} — check the TOTP secret is the base32 key from Kite's ` +
        'External TOTP setup ("Can\'t scan? Copy key"), and that the server clock is in sync',
      err.status || 403,
    );
  }
  return err;
}

// submitTOTP sends the 2FA code, retrying once if the first code was generated in
// the dying seconds of its 30s window and could have expired in flight.
async function submitTOTP(jar, userId, totpSecret, requestId, twofaType, referer) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const genMs = Date.now();
    try {
      return await jarPost(
        jar,
        TWOFA_URL,
        {
          user_id: userId,
          request_id: requestId,
          twofa_value: generateTOTP(totpSecret, genMs),
          ...(twofaType ? { twofa_type: twofaType } : {}),
        },
        referer,
      );
    } catch (err) {
      if (attempt > 0 || !nearWindowEdge(genMs)) throw hintTOTPError(err);
      await sleep(msUntilNextWindow(genMs));
    }
  }
  throw new ApiError('Zerodha 2FA failed', 403);
}

// headlessLogin runs the five steps above and returns a live session envelope.
async function headlessLogin(cr) {
  const userId = cr.clientCode || cr.userId || '';
  const password = cr.password || cr.pin || '';
  if (!userId || !password || !cr.totpSecret) {
    throw new ApiError('Zerodha auto-login needs User ID, password and TOTP secret', 400);
  }

  const jar = cookieJar();

  // 1. Land on the login page (no state: headless never round-trips the callback).
  const entry = await jarGet(jar, loginURL(cr));

  // 2. Password -> request_id.
  const login = await jarPost(jar, WEB_LOGIN_URL, { user_id: userId, password }, entry.url);
  const requestId = login?.data?.request_id;
  if (!requestId) throw new ApiError('Zerodha login did not return a request_id', 502);

  // 3. TOTP -> the jar's cookies are now an authorized Kite session.
  await submitTOTP(jar, userId, cr.totpSecret, requestId, login?.data?.twofa_type, entry.url);
  debug('2FA accepted; cookies now:', jar.names().join(', '));

  // 4. Replay the connect URL; skip_session=true makes Kite mint the token instead
  //    of showing the "you are already logged in" interstitial.
  const url = new URL(entry.url);
  url.searchParams.set('skip_session', 'true');
  debug('replaying connect URL:', url.toString());
  const { url: landedUrl, requestToken } = await jarGet(jar, url.toString());
  if (!requestToken) {
    // Login itself succeeded (2FA passed), but Kite parked us on the app-consent
    // screen instead of redirecting with a token. That screen appears exactly
    // once per app+account and can only be cleared by a human clicking Authorize
    // — Zerodha allows no headless path for it. So the FIRST connection must go
    // through the browser popup once; every later headless login sails through.
    const stuckOnAuth = /\/connect\/(authorize|finish)/.test(landedUrl || '');
    if (stuckOnAuth) {
      const err = new ApiError(
        'Zerodha needs a one-time app authorization: open the Kite login popup once and ' +
          'click “Authorize”. After that, auto-login runs headless with no popup.',
        428, // Precondition Required — signals the UI to fall back to the popup.
      );
      err.needsAuthorize = true;
      throw err;
    }
    throw new ApiError(
      'Zerodha login succeeded but returned no request_token — check the API key is active ' +
        'and its redirect URL matches the one registered in the Kite developer console.',
      502,
    );
  }

  // 5. Same exchange the popup flow performs.
  const session = await exchangeRequestToken(requestToken, cr);
  let margins = {};
  try {
    margins = await getJSON(MARGINS_URL, session);
  } catch {
    /* token is good; margins are optional for login status */
  }
  return buildResponse(session, margins, 'auto-login');
}

export function canHeadlessLogin(cr = {}) {
  return !missingForHeadless(cr).length;
}

// missingForHeadless names what the account still needs to skip the popup, so a
// fallback to the browser can say WHY instead of silently opening a window.
function missingForHeadless(cr = {}) {
  const missing = [];
  if (!cr.clientCode && !cr.userId) missing.push('User ID');
  if (!cr.password && !cr.pin) missing.push('Password');
  if (!cr.totpSecret) missing.push('TOTP Secret');
  if (!cr.autoLogin) missing.push('Auto Login');
  return missing;
}

export async function autoLogin({ userId, state, manual, ...cr }) {
  if (state) pending.set(state, cr);

  const existing = userId && sessions.get(userId);
  if (existing) {
    try {
      const profileRes = await getJSON(PROFILE_URL, existing);
      applyProfile(existing, profileRes.data || {});
      existing.lastUsedAt = new Date().toISOString();
      let margins = {};
      try {
        margins = await getJSON(MARGINS_URL, existing);
      } catch {
        /* profile validated the token; margins are optional for login status */
      }
      return buildResponse(existing, margins, 'session');
    } catch {
      sessions.delete(userId);
    }
  }

  // Manual browser login requested (the "Browser Login" button): skip the headless
  // attempt entirely and hand back the Kite popup URL. registering the state above
  // means the callback has the api_secret it needs to exchange the request_token.
  // This is the path for accounts with no stored TOTP.
  if (manual) {
    return { status: false, needsLogin: true, broker: 'zerodha', loginUrl: loginURL(cr, state) };
  }

  // Fully-automated path when the account has Auto Login ticked and carries a
  // password + TOTP secret. Falls back to the popup below if anything is missing.
  const creds = { ...cr, clientCode: cr.clientCode || userId || '' };
  const missing = missingForHeadless(creds);
  if (!missing.length) return headlessLogin(creds);

  // No browser-popup fallback for Zerodha. The popup follows whichever user the
  // browser last logged into kite.zerodha.com as — a cookie we can't read or set
  // — so with several accounts it can silently sign in as the wrong one. Headless
  // posts the exact user_id, so it's the only account-safe path. Require the creds
  // instead of falling back. (deliberately no loginUrl -> the UI won't open a popup.)
  return {
    status: false,
    needsLogin: true,
    needsCreds: true,
    broker: 'zerodha',
    reason: `Add ${missing.join(', ')} to this Zerodha account — login is headless, no browser popup.`,
  };
}

export async function completeCallback(requestToken, state) {
  const cr = credsForState(state);
  const session = await exchangeRequestToken(requestToken, cr);
  if (state) pending.delete(state);
  return session;
}

// logout invalidates the access_token via the official DELETE /session/token,
// then drops the in-memory session. Per the docs this does NOT sign the user out
// of Kite web/mobile — it only kills this API session. The local session is
// cleared even if the remote call fails, so a dead token never lingers.
export async function logout(client) {
  const session = sessionFromClient(client);
  const url = `${TOKEN_URL}?api_key=${encodeURIComponent(session.apiKey)}&access_token=${encodeURIComponent(session.accessToken)}`;
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'X-Kite-Version': '3' },
      signal: AbortSignal.timeout(20_000),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.status === 'error') {
      throw new ApiError(out?.message || `Zerodha HTTP ${res.status}`, res.status || 400);
    }
  } finally {
    if (session.userId) sessions.delete(session.userId);
  }
  return { status: true, broker: 'zerodha', loggedOut: true, userId: session.userId };
}

function listData(out) {
  return Array.isArray(out?.data) ? out.data : [];
}

function normalizeOrder(row = {}) {
  return {
    ...row,
    orderid: row.order_id || row.orderid || '',
    uniqueorderid: row.exchange_order_id || row.uniqueorderid || '',
    tradingsymbol: row.tradingsymbol || row.symbolname || row.symbol || '',
    symbolname: row.tradingsymbol || row.symbolname || row.symbol || '',
    transactiontype: row.transaction_type || row.transactiontype || '',
    ordertype: row.order_type || row.ordertype || '',
    producttype: row.product || row.producttype || '',
    triggerprice: row.trigger_price ?? row.triggerprice ?? 0,
    updatetime: row.exchange_update_timestamp || row.exchange_timestamp || row.order_timestamp || row.updatetime || '',
  };
}

function normalizeTrade(row = {}) {
  return {
    ...row,
    orderid: row.order_id || row.orderid || '',
    tradeid: row.trade_id || row.tradeid || '',
    tradingsymbol: row.tradingsymbol || row.symbolname || row.symbol || '',
    symbolname: row.tradingsymbol || row.symbolname || row.symbol || '',
    transactiontype: row.transaction_type || row.transactiontype || '',
    producttype: row.product || row.producttype || '',
    updatetime: row.exchange_timestamp || row.fill_timestamp || '',
  };
}

function normalizePosition(row = {}) {
  return {
    ...row,
    symboltoken: row.instrument_token || row.symboltoken || '',
    tradingsymbol: row.tradingsymbol || row.symbolname || row.symbol || '',
    symbolname: row.tradingsymbol || row.symbolname || row.symbol || '',
    producttype: row.product || row.producttype || '',
    netqty: row.quantity ?? row.netqty ?? 0,
    buyqty: row.buy_quantity ?? row.buyqty ?? 0,
    sellqty: row.sell_quantity ?? row.sellqty ?? 0,
    buyavgprice: row.buy_price ?? row.buyavgprice ?? 0,
    sellavgprice: row.sell_price ?? row.sellavgprice ?? 0,
    totalbuyavgprice: row.buy_price ?? row.totalbuyavgprice ?? 0,
    totalsellavgprice: row.sell_price ?? row.totalsellavgprice ?? 0,
    ltp: row.last_price ?? row.ltp ?? 0,
    realised: row.realised ?? 0,
    unrealised: row.unrealised ?? 0,
    pnl: row.pnl ?? (Number(row.realised || 0) + Number(row.unrealised || 0)),
  };
}

function normalizeHolding(row = {}) {
  return {
    ...row,
    symboltoken: row.instrument_token || '',
    tradingsymbol: row.tradingsymbol || '',
    symbolname: row.tradingsymbol || '',
    producttype: row.product || 'CNC',
    netqty: row.quantity ?? 0,
    buyavgprice: row.average_price ?? 0,
    ltp: row.last_price ?? 0,
    pnl: row.pnl ?? 0,
  };
}

export async function orderBook(client) {
  const session = sessionFromClient(client);
  const raw = await getJSON(ORDERS_URL, session);
  return { status: true, broker: 'zerodha', orders: listData(raw).map(normalizeOrder), raw, session };
}

export async function tradeBook(client) {
  const session = sessionFromClient(client);
  const raw = await getJSON(TRADES_URL, session);
  return { status: true, broker: 'zerodha', trades: listData(raw).map(normalizeTrade), raw, session };
}

export async function positions(client) {
  const session = sessionFromClient(client);
  const raw = await getJSON(POSITIONS_URL, session);
  const data = raw?.data || {};
  const rows = Array.isArray(data.net) ? data.net : [];
  return { status: true, broker: 'zerodha', positions: rows.map(normalizePosition), day: (data.day || []).map(normalizePosition), raw, session };
}

export async function holdings(client) {
  const session = sessionFromClient(client);
  const raw = await getJSON(HOLDINGS_URL, session);
  return { status: true, broker: 'zerodha', holdings: listData(raw).map(normalizeHolding), raw, session };
}

export async function margins(client, segment = '') {
  const session = sessionFromClient(client);
  const path = segment ? `${MARGINS_URL}/${encodeURIComponent(segment)}` : MARGINS_URL;
  const raw = await getJSON(path, session);
  return { status: true, broker: 'zerodha', margins: raw.data || {}, raw, session };
}

function kiteProduct(value, exchange) {
  const v = String(value || '').toUpperCase();
  if (v === 'MIS' || v === 'INTRADAY') return 'MIS';
  if (v === 'CNC' || v === 'DELIVERY') return 'CNC';
  if (v === 'MTF') return 'MTF';
  return ['NFO', 'BFO', 'MCX', 'CDS', 'BCD'].includes(String(exchange || '').toUpperCase()) ? 'NRML' : 'CNC';
}

function kiteOrderType(value) {
  const v = String(value || '').toUpperCase();
  if (v === 'LIMIT' || v === 'LMT') return 'LIMIT';
  if (v === 'SL' || v === 'STOPLOSS_LIMIT') return 'SL';
  if (v === 'SL-M' || v === 'SLM' || v === 'STOPLOSS_MARKET') return 'SL-M';
  return 'MARKET';
}

function legQuantity(leg) {
  return Math.trunc((Number(leg.qty) || 0) * Math.max(Number(leg.lotSize) || 0, 1));
}

function orderForm(leg = {}) {
  const exchange = String(leg.exchange || 'NFO').toUpperCase();
  const type = kiteOrderType(leg.orderType);
  const quantity = legQuantity(leg);
  if (!leg.symbol) throw new Error('trading symbol missing');
  if (quantity <= 0) throw new Error('quantity must be greater than zero');
  const form = {
    tradingsymbol: leg.symbol,
    exchange,
    transaction_type: String(leg.tradeType || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
    order_type: type,
    quantity: String(quantity),
    product: kiteProduct(leg.productType, exchange),
    validity: 'DAY',
    tag: 'alphahedge_basket',
  };
  if (type === 'LIMIT' || type === 'SL') form.price = String(Number(leg.price || 0));
  if (type === 'SL' || type === 'SL-M') form.trigger_price = String(Number(leg.triggerPrice || 0));
  return form;
}

export async function placeBasket({ client, legs = [] }) {
  const session = sessionFromClient(client);
  const results = [];
  for (const leg of legs.slice(0, 50)) {
    let form = null;
    try {
      form = orderForm(leg);
      const raw = await postKiteForm(`${KITE_BASE}/orders/regular`, session, form);
      results.push({
        status: true,
        orderid: raw?.data?.order_id || '',
        request: form,
        instrument: leg.resolvedInstrument,
        raw,
      });
    } catch (err) {
      results.push({
        status: false,
        error: err.message || 'Order rejected',
        request: form || leg,
        instrument: leg.resolvedInstrument,
      });
    }
  }
  const placed = results.filter((r) => r.status).length;
  return { status: placed === results.length, broker: 'zerodha', placed, failed: results.length - placed, results, session };
}
