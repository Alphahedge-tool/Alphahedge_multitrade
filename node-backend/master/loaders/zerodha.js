// Zerodha instrument loader. Kite returns one authenticated, gzipped CSV dump
// containing every exchange. Orders use exchange + tradingsymbol; the numeric
// instrument_token is retained for market-data subscriptions.

import { canonicalSymbol } from '../symbol.js';
import { parseBrokerCSV } from '../csv.js';
import { setMaster } from '../store.js';

const INSTRUMENTS_URL = 'https://api.kite.trade/instruments';

export function normalizeZerodhaRows(raw) {
  const rows = [];
  for (const r of raw) {
    const exchange = String(r.exchange || '').toUpperCase();
    const type = String(r.instrument_type || '').toUpperCase();
    const brsymbol = String(r.tradingsymbol || '').trim();
    if (!exchange || !brsymbol || !['EQ', 'FUT', 'CE', 'PE'].includes(type)) continue;

    // Derivative rows occasionally have an empty name; derive the root from the
    // broker symbol only as a fallback. Normal rows use the master-provided name.
    let name = String(r.name || '').toUpperCase().trim();
    if (!name && type !== 'EQ') {
      name = brsymbol.toUpperCase().replace(/\d{1,2}[A-Z]{3}\d{2}.*$/, '');
    }
    if (!name) name = brsymbol.toUpperCase().replace(/-(EQ|BE)$/i, '');

    const strike = type === 'CE' || type === 'PE' ? Number(r.strike) : null;
    const symbol = type === 'EQ'
      ? brsymbol.toUpperCase().replace(/-(EQ|BE)$/i, '')
      : canonicalSymbol({ name, expiry: r.expiry, strike, type });

    rows.push({
      symbol,
      brsymbol,
      name,
      exchange,
      brexchange: exchange,
      token: String(r.instrument_token || ''),
      exchangeToken: String(r.exchange_token || ''),
      expiry: r.expiry || '',
      strike: Number.isFinite(strike) ? strike : null,
      optionType: type === 'CE' || type === 'PE' ? type : '',
      lotsize: Number(r.lot_size) || 1,
      ticksize: Number(r.tick_size) || 0,
      segment: r.segment || exchange,
      instrumentType: type,
    });
  }
  return rows;
}

export async function loadZerodhaMaster({ apiKey, accessToken }) {
  if (!apiKey || !accessToken) throw new Error('Zerodha master needs apiKey and accessToken');
  const res = await fetch(INSTRUMENTS_URL, {
    headers: {
      Accept: 'text/csv',
      'X-Kite-Version': '3',
      Authorization: `token ${apiKey}:${accessToken}`,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Zerodha instruments download failed: HTTP ${res.status}`);
  const rows = normalizeZerodhaRows(parseBrokerCSV(await res.text()));
  if (!rows.length) throw new Error('Zerodha instruments file parsed no rows');
  return setMaster('zerodha', rows);
}
