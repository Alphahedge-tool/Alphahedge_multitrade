// Rolling Straddle — exact port of Alphahedgetool's Nubra rolling-straddle.
//
// Algorithm (unchanged from Alphahedgetool's loadRollingStraddle):
//   1. Fetch the SPOT close series over the window.
//   2. Fetch the day's option refdata; keep this symbol/expiry's CE/PE rows.
//   3. For each spot bar: atm = strike nearest spot, look at ATM +-2 strikes,
//      combine CE+PE bid/ask/iv; pick the CHEAPEST straddle by MID = (bid+ask)/2
//      ("lowest ATM +-2 straddle") and emit Bid, Ask and IV-mid for that strike.
//      The strike rolls automatically as spot moves.
//
// Data comes from Nubra (via lib/nubraData.js) using the account logged into
// Feed Master — the same source Alphahedgetool uses. Prices are already
// converted from paise to rupees and timestamps from ns to ms by that layer.

import { route, readJSON, ApiError } from '../server.js';
import {
  nubraSession, rollingOptionRows, fetchTimeseriesWithIntervals, fetchRollingSeries,
  extractSymbolData, pointMs, pointNumber, ROLLING_INTERVALS, NubraDataError,
} from '../lib/nubraData.js';

const BAND = 2; // ATM +- 2 strikes (Alphahedgetool's rollCandidateStrikes)

function asApiError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof NubraDataError) return new ApiError(error.message, error.status);
  return new ApiError(error?.message || 'Rolling straddle failed', 500);
}

function inferStep(strikes) {
  let step = Infinity;
  for (let i = 1; i < strikes.length; i++) {
    const diff = strikes[i] - strikes[i - 1];
    if (diff > 0) step = Math.min(step, diff);
  }
  return Number.isFinite(step) ? step : 50;
}

function nearestStrike(price, strikes, step) {
  const target = step > 0 ? Math.round(price / step) * step : price;
  return strikes.reduce((best, strike) => Math.abs(strike - target) < Math.abs(best - target) ? strike : best, strikes[0]);
}

// candidateStrikes = ATM +-BAND snapped to listed strikes (Alphahedgetool's
// rollCandidateStrikes, minus the manual-selection branch).
function candidateStrikes(atm, strikes, step) {
  const out = [];
  for (let offset = -BAND; offset <= BAND; offset++) out.push(nearestStrike(atm + offset * step, strikes, step));
  return [...new Set(out)];
}

// advanceQuote carries the last bid/ask/iv at or before ts for one option
// series — the cursor walk from Alphahedgetool's advanceQuote.
function advanceQuote(name, seriesByName, cursorByName, ts) {
  const keyName = String(name || '').toUpperCase();
  const series = seriesByName.get(keyName);
  if (!series) return { bid: 0, ask: 0, ivBid: null, ivAsk: null, ivMid: null };
  const cursor = cursorByName.get(keyName) || { bi: 0, ai: 0, ibi: 0, iai: 0, imi: 0, bid: 0, ask: 0, ivBid: null, ivAsk: null, ivMid: null };
  while (cursor.bi < series.bid.length && series.bid[cursor.bi].ts <= ts) { cursor.bid = series.bid[cursor.bi].v; cursor.bi++; }
  while (cursor.ai < series.ask.length && series.ask[cursor.ai].ts <= ts) { cursor.ask = series.ask[cursor.ai].v; cursor.ai++; }
  while (cursor.ibi < (series.ivBid?.length || 0) && series.ivBid[cursor.ibi].ts <= ts) { cursor.ivBid = series.ivBid[cursor.ibi].v; cursor.ibi++; }
  while (cursor.iai < (series.ivAsk?.length || 0) && series.ivAsk[cursor.iai].ts <= ts) { cursor.ivAsk = series.ivAsk[cursor.iai].v; cursor.iai++; }
  while (cursor.imi < (series.ivMid?.length || 0) && series.ivMid[cursor.imi].ts <= ts) { cursor.ivMid = series.ivMid[cursor.imi].v; cursor.imi++; }
  cursorByName.set(keyName, cursor);
  return cursor;
}

function ivMidOf(quote) {
  if (quote.ivMid != null) return quote.ivMid;
  if (quote.ivBid != null && quote.ivAsk != null) return (quote.ivBid + quote.ivAsk) / 2;
  return null;
}

// GET /api/feed/rolling-straddle/expiries?symbol=&exchange=&date=
route('GET', '/api/feed/rolling-straddle/expiries', async (req, res, { query }) => {
  try {
    const session = nubraSession();
    const symbol = query.get('symbol');
    if (!symbol) throw new ApiError('symbol is required', 400);
    const exchange = query.get('exchange') || 'NSE';
    const date = query.get('date') || undefined;
    const rows = await rollingOptionRows({ symbol, exchange, date, session });
    const expiries = [...new Set(rows.map((row) => row.expiry))].sort();
    return { status: true, expiries };
  } catch (error) {
    throw asApiError(error);
  }
});

// POST /api/feed/rolling-straddle — the full plot.
// Body: { symbol, expiry, exchange?, start, end, type? }
route('POST', '/api/feed/rolling-straddle', async (req) => {
  try {
    const body = await readJSON(req);
    const session = nubraSession();
    const symbol = String(body.symbol || '').trim().toUpperCase();
    if (!symbol) throw new ApiError('symbol is required', 400);
    const exchange = String(body.exchange || 'NSE').toUpperCase();
    const start = Number(body.start);
    const end = Number(body.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new ApiError('start and end (epoch ms, start < end) are required', 400);
    }
    const spotType = body.type || (exchange === 'MCX' ? 'FUT' : 'INDEX');
    // Nubra's charts/timeseries wants ISO-8601 date strings for start/end (that's
    // what Alphahedgetool's fromLocalInput produces); raw epoch ms is rejected
    // with "400: invalid request body".
    const startISO = new Date(start).toISOString();
    const endISO = new Date(end).toISOString();

    // 1) Spot close series (drives the whole walk).
    let resolvedInterval = ROLLING_INTERVALS[0];
    let spotPoints = [];
    let spotError = null;
    for (const interval of ROLLING_INTERVALS) {
      try {
        const { data } = await fetchTimeseriesWithIntervals({
          exchange, type: spotType, values: [symbol], fields: ['close'],
          startDate: startISO, endDate: endISO, intraDay: false, realTime: false,
        }, [interval], session);
        const symbolData = extractSymbolData(data, symbol);
        spotPoints = (Array.isArray(symbolData?.close) ? symbolData.close : [])
          .map((p) => ({ ts: pointMs(p), spot: pointNumber(p, true) }))
          .filter((p) => Number.isFinite(p.ts) && p.spot > 0)
          .sort((a, b) => a.ts - b.ts);
        if (spotPoints.length) { resolvedInterval = interval; break; }
      } catch (error) { spotError = error; }
    }
    if (!spotPoints.length) throw asApiError(spotError || new ApiError(`No spot data for ${exchange} ${spotType} ${symbol}`, 404));

    // 2) Option refdata for this symbol + expiry.
    let rows = await rollingOptionRows({ symbol, exchange, date: new Date(start).toISOString().slice(0, 10), session });
    let expiries = [...new Set(rows.map((row) => row.expiry))].sort();
    if (!expiries.length) throw new ApiError(`No option expiries for ${exchange} ${symbol}`, 404);
    const expiry = body.expiry && expiries.includes(String(body.expiry)) ? String(body.expiry) : expiries[0];
    rows = rows.filter((row) => row.expiry === expiry);
    if (!rows.length) throw new ApiError('No option rows for selected expiry', 404);

    const strikes = [...new Set(rows.map((row) => row.strike))].sort((a, b) => a - b);
    const step = inferStep(strikes);
    const rowByKey = new Map(rows.map((row) => [`${row.strike}|${row.side}`, row]));

    // 3) Which strikes the day's spot ever made ATM +-BAND (union).
    const requiredStrikes = new Set();
    for (const point of spotPoints) {
      const atm = nearestStrike(point.spot, strikes, step);
      for (const strike of candidateStrikes(atm, strikes, step)) requiredStrikes.add(strike);
    }

    const optionNames = [];
    const aliasToCanonical = new Map();
    const addAliases = (row) => {
      const aliases = row.aliases?.length ? row.aliases : [row.name];
      for (const alias of aliases) {
        const key = String(alias || '').toUpperCase();
        if (!key) continue;
        optionNames.push(key);
        aliasToCanonical.set(key, row.name);
      }
    };
    for (const strike of requiredStrikes) {
      const ce = rowByKey.get(`${strike}|CE`);
      const pe = rowByKey.get(`${strike}|PE`);
      if (ce) addAliases(ce);
      if (pe) addAliases(pe);
    }
    if (!optionNames.length) throw new ApiError('No CE/PE symbols found around ATM +-2', 404);

    // 4) Option bid/ask/iv series (with the 1s->1m fallback in the data layer).
    let seriesByName = await fetchRollingSeries({ names: optionNames, start: startISO, end: endISO, interval: resolvedInterval, exchange, aliasToCanonical, session });
    if (!seriesByName.size && resolvedInterval !== '1m') {
      const fallback = await fetchRollingSeries({ names: optionNames, start: startISO, end: endISO, interval: '1m', exchange, aliasToCanonical, session });
      if (fallback.size) { seriesByName = fallback; resolvedInterval = '1m'; }
    }
    if (!seriesByName.size) throw new ApiError(`No option chart series for ${exchange} ${symbol} ${expiry}`, 502);

    // 5) Walk spot bars → cheapest ATM+-2 straddle → Bid/Ask/IV points.
    const cursorByName = new Map();
    const points = [];
    for (const point of spotPoints) {
      const atm = nearestStrike(point.spot, strikes, step);
      let best = null;
      for (const strike of candidateStrikes(atm, strikes, step)) {
        const ce = rowByKey.get(`${strike}|CE`);
        const pe = rowByKey.get(`${strike}|PE`);
        if (!ce || !pe) continue;
        const ceQuote = advanceQuote(ce.name, seriesByName, cursorByName, point.ts);
        const peQuote = advanceQuote(pe.name, seriesByName, cursorByName, point.ts);
        const bid = ceQuote.bid + peQuote.bid;
        const ask = ceQuote.ask + peQuote.ask;
        if (bid <= 0 || ask <= 0) continue;
        const mid = (bid + ask) / 2;
        const ceIv = ivMidOf(ceQuote);
        const peIv = ivMidOf(peQuote);
        let ivMid = null;
        if (ceIv != null && peIv != null) ivMid = ((ceIv + peIv) / 2) * 100;
        else if (ceIv != null) ivMid = ceIv * 100;
        else if (peIv != null) ivMid = peIv * 100;
        if (!best || mid < best.mid) best = { strike, bid, ask, mid, ivMid };
      }
      if (!best) continue;
      points.push({
        time: point.ts, spot: point.spot, strike: best.strike,
        bid: best.bid, ask: best.ask, mid: best.mid,
        iv: best.ivMid != null && best.ivMid > 0 ? best.ivMid : null,
      });
    }
    if (!points.length) throw new ApiError('No complete bid/ask straddle points found', 404);

    return {
      status: true,
      source: 'nubra',
      interval: resolvedInterval,
      band: BAND,
      step,
      symbol, expiry, exchange,
      strikesChecked: requiredStrikes.size,
      spot: spotPoints[spotPoints.length - 1]?.spot ?? null,
      points,
    };
  } catch (error) {
    throw asApiError(error);
  }
});
