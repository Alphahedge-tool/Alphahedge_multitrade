// Zerodha Kite Connect adapter.
// Flow: build Kite login URL -> browser redirects with request_token -> exchange
// request_token for access_token using SHA-256(api_key + request_token + secret).

import { createHash } from 'node:crypto';

import { ApiError } from '../server.js';
import { setBrokerAccountId, isConfigured } from '../lib/supabaseAdmin.js';

const KITE_BASE = 'https://api.kite.trade';
const LOGIN_URL = 'https://kite.zerodha.com/connect/login';
const TOKEN_URL = `${KITE_BASE}/session/token`;
const PROFILE_URL = `${KITE_BASE}/user/profile`;
const MARGINS_URL = `${KITE_BASE}/user/margins`;
const ORDERS_URL = `${KITE_BASE}/orders`;
const TRADES_URL = `${KITE_BASE}/trades`;
const POSITIONS_URL = `${KITE_BASE}/portfolio/positions`;
const HOLDINGS_URL = `${KITE_BASE}/portfolio/holdings`;

function redirectURI() {
  const port = Number(process.env.PORT || 3001);
  return process.env.ZERODHA_REDIRECT_URI || `http://127.0.0.1:${port}/zerodha/callback`;
}

const sessions = new Map();
const pending = new Map();

export function getSession(userId) {
  return sessions.get(userId) || null;
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

export async function autoLogin({ userId, state, ...cr }) {
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

  return {
    status: false,
    needsLogin: true,
    broker: 'zerodha',
    loginUrl: loginURL(cr, state),
  };
}

export async function completeCallback(requestToken, state) {
  const cr = credsForState(state);
  const session = await exchangeRequestToken(requestToken, cr);
  if (state) pending.delete(state);
  return session;
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
      results.push({ status: true, orderid: raw?.data?.order_id || '', request: form, raw });
    } catch (err) {
      results.push({ status: false, error: err.message || 'Order rejected', request: form || leg });
    }
  }
  const placed = results.filter((r) => r.status).length;
  return { status: placed === results.length, broker: 'zerodha', placed, failed: results.length - placed, results, session };
}
