// Upstox master loader — fetches Upstox's public gzipped instrument JSON and
// normalizes to the canonical symbol under broker "upstox".
//
// Source (public, no auth):
//   https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz
//
// Upstox row shape: instrument_key (its TOKEN, e.g. "NSE_FO|14294"),
// underlying_symbol / asset_symbol, expiry (epoch ms), strike_price (real ₹),
// instrument_type (CE/PE/FUT/EQ/…), segment (NSE_EQ / NSE_FO / …).

import zlib from 'node:zlib';
import { canonicalSymbol } from '../symbol.js';
import { setMaster } from '../store.js';

const URL = process.env.UPSTOX_MASTER_URL
  || 'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz';

// Upstox segment -> canonical exchange.
function mapExchange(segment) {
  const s = String(segment || '').toUpperCase();
  const map = {
    NSE_EQ: 'NSE', BSE_EQ: 'BSE',
    NSE_FO: 'NFO', BSE_FO: 'BFO', NCD_FO: 'CDS', BCD_FO: 'BCD', MCX_FO: 'MCX',
    NSE_INDEX: 'NSE_INDEX', BSE_INDEX: 'BSE_INDEX', NSE_COM: 'NSE_COM',
  };
  return map[s] || s;
}

function typeOf(instrumentType) {
  const it = String(instrumentType || '').toUpperCase();
  if (it === 'CE' || it === 'PE') return it;
  if (it === 'FUT') return 'FUT';
  return 'EQ';
}

export async function loadUpstoxMaster() {
  const res = await fetch(URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Upstox master download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const raw = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

  const rows = [];
  for (const r of raw) {
    const exchange = mapExchange(r.segment);
    const type = typeOf(r.instrument_type);
    const name = String(r.underlying_symbol || r.asset_symbol || r.name || '').toUpperCase();
    const strike = type === 'CE' || type === 'PE' ? Number(r.strike_price) : null;

    // Equity/index canonical = the trading symbol (no expiry); derivatives use
    // the canonical builder from the resolved parts.
    const symbol =
      type === 'EQ'
        ? String(r.trading_symbol || name).toUpperCase().replace(/\s+/g, '')
        : canonicalSymbol({ name, expiry: r.expiry, strike, type });

    rows.push({
      symbol,
      brsymbol: r.trading_symbol || '',
      name,
      exchange,
      brexchange: r.segment || '',
      token: r.instrument_key || '',      // Upstox uses instrument_key everywhere
      expiry: r.expiry || '',
      strike,
      optionType: type === 'CE' || type === 'PE' ? type : '',
      lotsize: Number(r.lot_size) || 1,
      ticksize: Number(r.tick_size) || 0,
      segment: r.segment || '',
      instrumentType: r.instrument_type || '',
    });
  }

  return setMaster('upstox', rows);
}
