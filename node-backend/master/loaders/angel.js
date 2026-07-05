// Angel master loader — fetches Angel's public scrip master and normalizes every
// instrument to the canonical symbol, then stores it under broker "angel".
//
// Source (public, no auth):
//   https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json
//
// Angel's own `symbol` is ALREADY close to canonical (NIFTY29JUN2730000CE), but:
//   - strike is in price×100 units (3000000 -> 30000)
//   - equity symbols carry a -EQ / -BE suffix we strip for the canonical key
//   - instrumenttype drives whether it's EQ / FUT / CE / PE

import { canonicalSymbol } from '../symbol.js';
import { setMaster } from '../store.js';

const URL = process.env.ANGEL_MASTER_URL
  || 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

// Angel exch_seg -> canonical exchange. NFO/BFO are the F&O segments.
function mapExchange(seg, instrumenttype) {
  const s = String(seg || '').toUpperCase();
  if (s === 'NFO' || s === 'BFO' || s === 'MCX' || s === 'CDS') return s;
  if (s === 'NSE') return 'NSE';
  if (s === 'BSE') return 'BSE';
  return s;
}

// typeFromInstrument derives EQ / FUT / CE / PE from Angel's instrumenttype +
// the trailing CE/PE on the symbol.
function typeOf(instrumenttype, symbol) {
  const it = String(instrumenttype || '').toUpperCase();
  if (it.startsWith('OPT')) return symbol.endsWith('PE') ? 'PE' : 'CE';
  if (it.startsWith('FUT')) return 'FUT';
  return 'EQ';
}

export async function loadAngelMaster() {
  const res = await fetch(URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Angel master download failed: HTTP ${res.status}`);
  const raw = await res.json();

  const rows = [];
  for (const r of raw) {
    const seg = String(r.exch_seg || '').toUpperCase();
    const exchange = mapExchange(seg, r.instrumenttype);
    const name = String(r.name || '').toUpperCase();
    const type = typeOf(r.instrumenttype, String(r.symbol || ''));
    // Angel strike is price×100 (3000000 -> 30000). -1 means N/A (EQ/FUT).
    const rawStrike = Number(r.strike);
    const strike = Number.isFinite(rawStrike) && rawStrike > 0 ? rawStrike / 100 : null;

    const symbol =
      type === 'EQ'
        ? String(r.symbol || '').replace(/-(EQ|BE|MF|SG)$/i, '') // strip suffix for canonical
        : canonicalSymbol({ name, expiry: r.expiry, strike, type });

    rows.push({
      symbol,
      brsymbol: r.symbol,          // Angel's own trading symbol
      name,
      exchange,
      brexchange: seg,             // Angel's exch_seg
      token: String(r.token),
      expiry: r.expiry || '',
      strike,
      optionType: type === 'CE' || type === 'PE' ? type : '',
      lotsize: Number(r.lotsize) || 1,
      ticksize: Number(r.tick_size) || 0,
      segment: seg,
      instrumentType: r.instrumenttype || '',
    });
  }

  return setMaster('angel', rows);
}
