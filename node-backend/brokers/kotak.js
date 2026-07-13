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
const REPORT_TIMEOUT_MS = 20_000;

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

async function doForm(url, headers, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'neo-fin-key': NEO_FIN_KEY,
      ...headers,
    },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(20_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out?.stat === 'Not_Ok' || out?.status === 'error') {
    const msg = out?.emsg || out?.message || out?.error?.[0]?.message || `Kotak HTTP ${res.status}`;
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
    serverId: td.hsServerId || td.serverId || '',
    dataCenter: td.dataCenter || '',
    baseUrl: td.baseUrl || '',
    ucc: cr.ucc,
    greeting: td.greetingName || '',
    loginAt: now,
    lastUsedAt: now,
  };
  return buildLoginResponse(session, 'totp-login');
}

export function sessionFromClient(input = {}) {
  const c = input?.client && typeof input.client === 'object' ? input.client : input;
  const s = c?.session || {};
  const session = {
    tradeToken: s.tradeToken || '',
    sid: s.sid || '',
    rid: s.rid || '',
    serverId: s.serverId || s.hsServerId || '',
    dataCenter: s.dataCenter || '',
    baseUrl: s.baseUrl || '',
    ucc: s.ucc || c.ucc || c.clientCode || '',
    greeting: s.greeting || '',
    loginAt: s.loginAt || '',
    lastUsedAt: new Date().toISOString(),
  };
  if (!session.tradeToken || !session.sid || !session.baseUrl) {
    throw new ApiError('Kotak session is incomplete. Login again to refresh token, sid and baseUrl.', 401);
  }
  return session;
}

async function requestReport(input, path, { method = 'GET', jData } = {}) {
  const session = sessionFromClient(input);
  const body = jData == null ? undefined : new URLSearchParams({
    jData: JSON.stringify(jData),
  }).toString();
  const res = await fetch(`${session.baseUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      Sid: session.sid,
      Auth: session.tradeToken,
      'neo-fin-key': NEO_FIN_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  });
  const text = await res.text();
  let raw = {};
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ApiError(`Kotak returned an invalid response (HTTP ${res.status})`, 502);
    }
  }
  if (!res.ok || String(raw?.stat || '').toLowerCase() === 'not_ok') {
    throw new ApiError(raw?.emsg || raw?.message || `Kotak HTTP ${res.status}`, res.status >= 400 ? res.status : 400);
  }
  return { raw, session: { ...session, lastUsedAt: new Date().toISOString() } };
}

function numberOf(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sideOf(value) {
  return String(value || '').trim().toUpperCase().startsWith('S') ? 'SELL' : 'BUY';
}

function exchangeOf(value) {
  const raw = String(value || '').trim();
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  return ({
    nsecm: 'NSE', nsefo: 'NFO', bsecm: 'BSE', bsefo: 'BFO',
    cdefo: 'CDS', nsecd: 'CDS', mcxfo: 'MCX', bcsfo: 'BCD',
  })[key] || raw.toUpperCase();
}

function orderTypeOf(value) {
  const type = String(value || '').trim().toUpperCase().replace(/[_\s]/g, '-');
  if (type === 'L' || type === 'LIMIT') return 'LIMIT';
  if (type === 'M' || type === 'MKT' || type === 'MARKET') return 'MARKET';
  if (type === 'SL' || type === 'STOP-LOSS') return 'STOPLOSS_LIMIT';
  if (type === 'SL-M' || type === 'SLM') return 'STOPLOSS_MARKET';
  return type;
}

export function normalizeKotakOrder(row = {}) {
  const quantity = numberOf(row.qty);
  const filled = numberOf(row.fldQty ?? row.filledQty ?? row.filledshares);
  return {
    ...row,
    orderid: String(row.nOrdNo || row.orderid || ''),
    uniqueorderid: String(row.exOrdId || row.uniqueorderid || ''),
    exchangeorderid: String(row.exOrdId || row.exchangeorderid || ''),
    tradingsymbol: String(row.trdSym || row.sym || row.tradingsymbol || ''),
    symbolname: String(row.sym || row.trdSym || row.symbolname || ''),
    exchange: exchangeOf(row.exSeg || row.exchange),
    transactiontype: sideOf(row.trnsTp || row.transactiontype),
    ordertype: orderTypeOf(row.prcTp || row.ordertype),
    producttype: String(row.prod || row.product || row.producttype || ''),
    variety: String(row.ordGenTp || row.variety || 'NORMAL'),
    quantity,
    filledshares: filled,
    unfilledshares: numberOf(row.unFldSz ?? row.pendingQty ?? Math.max(quantity - filled, 0)),
    price: numberOf(row.prc ?? row.price),
    averageprice: numberOf(row.avgPrc ?? row.averageprice),
    triggerprice: numberOf(row.trgPrc ?? row.trigPrc ?? row.triggerprice),
    status: String(row.ordSt || row.status || ''),
    orderstatus: String(row.ordSt || row.orderstatus || row.status || ''),
    updatetime: String(row.ordDtTm || row.flDtTm || row.exTm || row.updatetime || ''),
    text: String(row.rejRsn || row.text || ''),
  };
}

export function normalizeKotakTrade(row = {}, index = 0) {
  const quantity = numberOf(row.fldQty ?? row.qty ?? row.quantity);
  const price = numberOf(row.flPrc ?? row.avgPrc ?? row.prc ?? row.price);
  const fillTime = String(row.flDtTm || row.exTm || row.flDt || row.filltime || '');
  const orderId = String(row.nOrdNo || row.orderid || '');
  return {
    ...row,
    orderid: orderId,
    fillid: String(row.flId || row.tradeId || row.exTradeId || `${orderId}-${index + 1}`),
    tradingsymbol: String(row.trdSym || row.tradingsymbol || ''),
    symbolname: String(row.trdSym || row.symbolname || ''),
    exchange: exchangeOf(row.exSeg || row.exchange),
    transactiontype: sideOf(row.trnsTp || row.transactiontype),
    ordertype: orderTypeOf(row.prcTp || row.ordertype),
    producttype: String(row.prod || row.product || row.producttype || ''),
    fillsize: quantity,
    quantity,
    fillprice: price,
    price,
    tradevalue: price * quantity,
    filltime: fillTime,
    updatetime: fillTime,
  };
}

export function normalizeKotakPosition(row = {}) {
  const dayBuyQty = numberOf(row.flBuyQty);
  const daySellQty = numberOf(row.flSellQty);
  const carryBuyQty = numberOf(row.cfBuyQty);
  const carrySellQty = numberOf(row.cfSellQty);
  const buyQty = dayBuyQty + carryBuyQty;
  const sellQty = daySellQty + carrySellQty;
  const buyAmount = numberOf(row.buyAmt) + numberOf(row.cfBuyAmt);
  const sellAmount = numberOf(row.sellAmt) + numberOf(row.cfSellAmt);
  const buyAvg = buyQty ? buyAmount / buyQty : 0;
  const sellAvg = sellQty ? sellAmount / sellQty : 0;
  const closedQty = Math.min(buyQty, sellQty);
  return {
    ...row,
    tradingsymbol: String(row.trdSym || row.tradingsymbol || ''),
    symbolname: String(row.sym || row.trdSym || row.symbolname || ''),
    exchange: exchangeOf(row.exSeg || row.exchange),
    producttype: String(row.prod || row.producttype || ''),
    netqty: numberOf(row.qty ?? row.netqty ?? (buyQty - sellQty)),
    buyqty: buyQty,
    sellqty: sellQty,
    totalbuyqty: buyQty,
    totalsellqty: sellQty,
    totalbuyvalue: buyAmount,
    totalsellvalue: sellAmount,
    buyavgprice: buyAvg,
    sellavgprice: sellAvg,
    totalbuyavgprice: buyAvg,
    totalsellavgprice: sellAvg,
    lotsize: numberOf(row.lotSz ?? row.brdLtQty ?? row.lotsize) || 1,
    strikeprice: numberOf(row.stkPrc ?? row.strikeprice),
    expirydate: String(row.expDt || row.expirydate || ''),
    optiontype: String(row.optTp || row.optiontype || ''),
    realised: (sellAvg - buyAvg) * closedQty,
    unrealised: 0,
    updatetime: String(row.hsUpTm || row.updatetime || ''),
  };
}

export async function orderBook(input) {
  const result = await requestReport(input, '/quick/user/orders');
  const rows = Array.isArray(result.raw?.data) ? result.raw.data : [];
  return { status: true, broker: 'kotak', orders: rows.map(normalizeKotakOrder), raw: result.raw, session: result.session };
}

export async function tradeBook(input) {
  const result = await requestReport(input, '/quick/user/trades');
  const rows = Array.isArray(result.raw?.data) ? result.raw.data : [];
  return { status: true, broker: 'kotak', trades: rows.map(normalizeKotakTrade), raw: result.raw, session: result.session };
}

export async function positions(input) {
  const result = await requestReport(input, '/quick/user/positions');
  const rows = Array.isArray(result.raw?.data) ? result.raw.data : [];
  return { status: true, broker: 'kotak', positions: rows.map(normalizeKotakPosition), raw: result.raw, session: result.session };
}

function kotakProduct(value) {
  const v = String(value || '').toUpperCase();
  if (v === 'MIS' || v === 'INTRADAY') return 'MIS';
  if (v === 'CNC' || v === 'DELIVERY') return 'CNC';
  if (v === 'MTF') return 'MTF';
  return 'NRML';
}

function kotakOrderType(value) {
  const v = String(value || '').toUpperCase();
  if (v === 'LIMIT' || v === 'LMT' || v === 'L') return 'L';
  if (v === 'SL' || v === 'STOPLOSS_LIMIT') return 'SL';
  if (v === 'SL-M' || v === 'SLM' || v === 'STOPLOSS_MARKET') return 'SL-M';
  return 'MKT';
}

function kotakOrderForm(leg = {}) {
  const quantity = Math.trunc((Number(leg.qty) || 0) * Math.max(Number(leg.lotSize) || 0, 1));
  if (!leg.symbol) throw new Error('Kotak trading symbol missing');
  if (!leg.exchange) throw new Error('Kotak exchange segment missing');
  if (quantity <= 0) throw new Error('quantity must be greater than zero');
  const type = kotakOrderType(leg.orderType);
  const price = Number(leg.price || 0);
  const trigger = Number(leg.triggerPrice || 0);
  if ((type === 'L' || type === 'SL') && price <= 0) throw new Error(`price required for ${type}`);
  if ((type === 'SL' || type === 'SL-M') && trigger <= 0) throw new Error(`trigger price required for ${type}`);
  return {
    am: 'NO',
    dq: '0',
    es: String(leg.exchange).toLowerCase(),
    mp: '0',
    pc: kotakProduct(leg.productType),
    pf: 'N',
    pr: type === 'MKT' || type === 'SL-M' ? '0' : String(price),
    pt: type,
    qt: String(quantity),
    rt: 'DAY',
    tp: type === 'SL' || type === 'SL-M' ? String(trigger) : '0',
    ts: leg.symbol,
    tt: String(leg.tradeType || '').toUpperCase() === 'SELL' ? 'S' : 'B',
    ig: 'alphahedge_basket',
    os: 'NEOTRADEAPI',
  };
}

export async function placeBasket({ client, legs = [] }) {
  const session = sessionFromClient(client);
  if (!session.serverId) {
    throw new ApiError('Kotak order session has no serverId. Login again before placing orders.', 401);
  }
  const endpoint = `${session.baseUrl.replace(/\/+$/, '')}/quick/order/rule/ms/place`;
  const url = `${endpoint}?sId=${encodeURIComponent(session.serverId)}`;
  const results = [];
  for (const leg of legs.slice(0, 50)) {
    let form = null;
    try {
      form = kotakOrderForm(leg);
      const raw = await doForm(url, { Sid: session.sid, Auth: session.tradeToken }, form);
      const ok = raw?.stat === 'Ok' || Number(raw?.stCode) === 200 || Boolean(raw?.nOrdNo);
      results.push({
        status: ok,
        orderid: raw?.nOrdNo || raw?.orderId || '',
        error: ok ? undefined : (raw?.emsg || raw?.message || 'Order rejected'),
        request: form,
        instrument: leg.resolvedInstrument,
        raw,
      });
    } catch (err) {
      results.push({ status: false, error: err.message || 'Order rejected', request: form || leg, instrument: leg.resolvedInstrument });
    }
  }
  const placed = results.filter((result) => result.status).length;
  return { status: placed === results.length, broker: 'kotak', placed, failed: results.length - placed, results, session };
}
