// Nubra market-data access — server-side port of Alphahedgetool's Nubra data
// layer (its browser `nubraFetch` + charts/timeseries + charts/refdata calls).
//
// Alphahedgetool ran these from the browser through an /api/proxy passthrough,
// authing with the logged-in session token + device id. Here we call Nubra
// directly from node-backend using the account registered in Feed Master
// (getFeedAccount('nubra').session -> { sessionToken, deviceId }). Same
// endpoints, same request/response shapes, same unit conventions:
//   • timestamps arrive in NANOSECONDS  -> pointMs divides by 1e6
//   • prices arrive in PAISE            -> toRupees divides by 100
//
// Endpoints (REST data host):
//   POST charts/timeseries        spot / option bid,ask,iv,close series
//   GET  refdata/refdata/<date>   the day's instrument list (strikes, refIds)

import { getFeedAccount } from './feedRegistry.js';

const DEFAULT_BASE_URL = 'https://api.nubra.io';
const UAT_BASE_URL = 'https://uatapi.nubra.io';

// Match Alphahedgetool's constants exactly. Nubra's gateway 403s on bursts, so
// batches stay small and serialized with a short pause between them.
export const ROLLING_INTERVALS = ['1s', '1m'];
export const ROLLING_BATCH_SIZE = 8;
export const ROLLING_BATCH_DELAY_MS = 220;

function baseUrl() {
  if (String(process.env.NUBRA_ENV).toUpperCase() === 'UAT') return UAT_BASE_URL;
  return process.env.NUBRA_BASE_URL || DEFAULT_BASE_URL;
}

export class NubraDataError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'NubraDataError';
    this.status = status || 500;
  }
}

// nubraSession returns the Feed Master Nubra session, or throws a clear 400 so
// the UI tells the user to log a Nubra account into Feed Master first.
export function nubraSession() {
  const feed = getFeedAccount('nubra');
  const session = feed?.session;
  if (!session?.sessionToken || !session?.deviceId) {
    throw new NubraDataError('Log a Nubra account into Feed Master first', 400);
  }
  return session;
}

function authHeaders(session) {
  const token = String(session.sessionToken).trim();
  return {
    Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
    'x-device-id': String(session.deviceId).trim(),
    'x-app-version': '0.4.5',
    'x-device-os': 'sdk',
    'content-type': 'application/json',
  };
}

// nubraFetch is the server-side twin of Alphahedgetool's browser nubraFetch:
// same URL resolution (path against the base host), same auth headers, same
// "status: detail" error surface. No /api/proxy — we ARE the backend.
export async function nubraFetch(path, options = {}) {
  const session = options.session || nubraSession();
  const url = new URL(path, `${baseUrl()}/`).toString();
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { ...authHeaders(session), ...(options.headers || {}) },
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs || 25_000),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const detail = payload?.error || payload?.message || response.statusText;
    throw new NubraDataError(`${response.status}: ${detail}`, response.status);
  }
  return payload;
}

// ── unit + point helpers (ported from Alphahedgetool lib/chain.js) ──

// Nubra timestamps are nanoseconds; return epoch milliseconds.
export function pointMs(point) {
  const ts = Number(point?.ts ?? point?.timestamp);
  return Number.isFinite(ts) ? Math.floor(ts / 1_000_000) : null;
}

export function toRupees(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n / 100 : null;
}

// Nubra prices are paise; iv fields are already plain numbers.
export function pointNumber(point, rupeeValue = false) {
  const raw = point?.v ?? point?.value;
  const value = rupeeValue ? toRupees(raw) : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

export function extractSymbolData(data, symbol) {
  const result = data?.result?.[0]?.values || [];
  for (const entry of result) {
    if (entry[symbol]) return entry[symbol];
    const firstKey = Object.keys(entry)[0];
    if (firstKey) return entry[firstKey];
  }
  return null;
}

export function symbolDataHasPoints(symData) {
  if (!symData || typeof symData !== 'object') return false;
  return Object.values(symData).some((arr) => Array.isArray(arr) && arr.length);
}

// ── refdata (ported from rollingOptionRows / refdataPath) ──

function refdataPath(date, exchange = 'NSE') {
  const name = String(exchange || 'NSE').toUpperCase();
  return name === 'NSE'
    ? `refdata/refdata/${date}`
    : `refdata/refdata/${date}?exchange=${encodeURIComponent(name)}`;
}

function optionRowSide(row) {
  return String(row.option_type || row.ot || row.side || '').toUpperCase();
}

function optionSymbolAliases(row) {
  return [...new Set([
    row.stock_name, row.symbol, row.trading_symbol, row.tradingsymbol,
    row.display_name, row.displayName, row.zanskar_name, row.nubra_name,
  ].map((value) => String(value || '').trim().toUpperCase()).filter(Boolean))];
}

function liveRefId(row) {
  const refId = row?.refId ?? row?.ref_id ?? row?.refid ?? row?.instrument_id;
  return refId == null ? '' : String(refId);
}

function normalizeStrike(value) {
  const rupeeValue = toRupees(value);
  return rupeeValue == null ? Number(value) : rupeeValue;
}

// rollingOptionRows fetches the day's instrument list and keeps this symbol's
// CE/PE option rows, mirroring Alphahedgetool exactly (asset match, OPT type,
// CE/PE side, strike in rupees, first alias as the canonical name).
export async function rollingOptionRows({ symbol, exchange = 'NSE', date, session }) {
  const day = (date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const data = await nubraFetch(refdataPath(day, exchange), { session });
  const refRows = Array.isArray(data.refdata) ? data.refdata : [];
  const sym = String(symbol).trim().toUpperCase();
  return refRows
    .filter((row) => {
      const asset = String(row.asset || '').toUpperCase();
      const dtype = String(row.derivative_type || '').toUpperCase();
      const side = optionRowSide(row);
      return asset === sym && dtype === 'OPT' && (side === 'CE' || side === 'PE') && optionSymbolAliases(row).length;
    })
    .map((row) => {
      const aliases = optionSymbolAliases(row);
      return {
        name: aliases[0],
        aliases,
        refId: liveRefId(row),
        expiry: String(row.expiry || ''),
        side: optionRowSide(row),
        strike: normalizeStrike(row.strike_price),
      };
    })
    .filter((row) => Number.isFinite(row.strike) && row.expiry && row.name);
}

// ── timeseries (ported from fetchTimeseriesWithIntervals / fetchRollingBatch) ──

// fetchTimeseriesWithIntervals tries each interval until one returns data. A
// 400 means "interval unsupported for this range" -> try the next; anything
// else is a real error and rethrows immediately.
export async function fetchTimeseriesWithIntervals(query, intervals = ROLLING_INTERVALS, session) {
  let lastError = null;
  for (const interval of intervals) {
    try {
      const data = await nubraFetch('charts/timeseries', {
        session,
        method: 'POST',
        body: JSON.stringify({ query: [{ ...query, interval }] }),
      });
      return { data, interval };
    } catch (error) {
      lastError = error;
      if (!String(error?.message || '').startsWith('400:')) throw error;
    }
  }
  throw lastError || new NubraDataError('No supported chart interval returned data.', 502);
}

// parseRollingSeriesValues turns Nubra's per-symbol arrays into sorted
// {ts,v} series for bid, ask, ltp, and the three IV fields — ported verbatim.
export function parseRollingSeriesValues(values, seriesByName, aliasToCanonical) {
  for (const entry of values) {
    for (const [name, symData] of Object.entries(entry)) {
      const keyName = String(name || '').toUpperCase();
      if (!symbolDataHasPoints(symData)) continue;
      const canonicalName = aliasToCanonical.get(keyName) || keyName;
      const parsePoints = (arr, rupee = false) =>
        (Array.isArray(arr) ? arr : [])
          .map((p) => ({ ts: pointMs(p), v: pointNumber(p, rupee) }))
          .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.v))
          .sort((a, b) => a.ts - b.ts);
      const close = parsePoints(symData?.close, true);
      const open = parsePoints(symData?.open, true);
      const bid = parsePoints(symData?.l1bid, true);
      const ask = parsePoints(symData?.l1ask, true);
      const priceFallback = close.length ? close : open;
      const series = {
        bid: bid.length ? bid : priceFallback,
        ask: ask.length ? ask : priceFallback,
        ltp: close.length ? close : open,
        ivBid: parsePoints(symData?.iv_bid, false),
        ivAsk: parsePoints(symData?.iv_ask, false),
        ivMid: parsePoints(symData?.iv_mid, false),
      };
      if ((series.bid.length || series.ask.length) && !seriesByName.has(canonicalName)) seriesByName.set(canonicalName, series);
      if ((series.bid.length || series.ask.length) && !seriesByName.has(keyName)) seriesByName.set(keyName, series);
    }
  }
}

// fetchRollingBatch requests one batch of option symbols' bid/ask/iv/close
// series, with the 1s->1m fallback Alphahedgetool uses when 1s is unsupported.
async function fetchRollingBatch({ batch, start, end, interval, exchange, session }) {
  const request = { type: 'OPT', fields: ['l1bid', 'l1ask', 'iv_bid', 'iv_ask', 'close'] };
  const base = {
    exchange, type: request.type, values: batch, fields: request.fields,
    startDate: start, endDate: end, intraDay: false, realTime: false,
  };
  try {
    const { data } = await fetchTimeseriesWithIntervals(base, [interval], session);
    const values = data?.result?.[0]?.values || [];
    if (values.some((entry) => Object.values(entry || {}).some(symbolDataHasPoints))) return values;
  } catch (error) {
    if (String(error?.message || '').startsWith('400:') && interval === '1s') {
      const { data } = await fetchTimeseriesWithIntervals(base, ['1m'], session);
      const values = data?.result?.[0]?.values || [];
      if (values.some((entry) => Object.values(entry || {}).some(symbolDataHasPoints))) return values;
    } else {
      throw error;
    }
  }
  return [];
}

// fetchRollingSeries fans a symbol list out into batches (serialized, with a
// short pause) and returns a Map name -> {bid,ask,ltp,ivBid,ivAsk,ivMid}.
export async function fetchRollingSeries({ names, start, end, interval, exchange, aliasToCanonical = new Map(), session }) {
  const seriesByName = new Map();
  const unique = [...new Set(names)];
  let firstError = null;
  for (let i = 0; i < unique.length; i += ROLLING_BATCH_SIZE) {
    const batch = unique.slice(i, i + ROLLING_BATCH_SIZE);
    try {
      const values = await fetchRollingBatch({ batch, start, end, interval, exchange, session });
      parseRollingSeriesValues(values, seriesByName, aliasToCanonical);
    } catch (error) {
      firstError ??= error;
    }
    if (i + ROLLING_BATCH_SIZE < unique.length) await new Promise((r) => setTimeout(r, ROLLING_BATCH_DELAY_MS));
  }
  if (!seriesByName.size && firstError) throw firstError;
  return seriesByName;
}
