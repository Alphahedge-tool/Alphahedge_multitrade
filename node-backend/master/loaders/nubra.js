// Nubra master loader — fetches Nubra's refdata per exchange and normalizes to
// the canonical symbol under broker "nubra". Requires a logged-in session
// (session token + device id) since refdata is authenticated.
//
// Source (auth):
//   GET https://api.nubra.io/refdata/refdata/{YYYY-MM-DD}?exchange={NSE|BSE|MCX}
//   headers: Authorization: Bearer <session_token>, x-device-id: <device_id>
//
// Nubra refdata rows: ref_id (THE TOKEN — order/feed API uses ref_id, not the
// exchange token), stock_name, asset, expiry (YYYYMMDD int), strike_price
// (×100), option_type (CE/PE), derivative_type (STOCK/FUT/OPT), lot_size,
// tick_size, exchange.

import { canonicalSymbol } from '../symbol.js';
import { setMaster } from '../store.js';

const BASE = process.env.NUBRA_BASE_URL || 'https://api.nubra.io';

// exchange mapping: derivatives move NSE->NFO, BSE->BFO; STOCK keeps exchange.
function mapExchange(exchange, derivativeType) {
  const ex = String(exchange || '').toUpperCase();
  const dt = String(derivativeType || '').toUpperCase();
  if (ex === 'NSE' && dt !== 'STOCK') return 'NFO';
  if (ex === 'BSE' && dt !== 'STOCK') return 'BFO';
  return ex; // MCX stays MCX; STOCK keeps NSE/BSE
}

function typeOf(derivativeType, optionType) {
  const dt = String(derivativeType || '').toUpperCase();
  const ot = String(optionType || '').toUpperCase();
  if (dt === 'OPT' || ot === 'CE' || ot === 'PE') return ot === 'PE' ? 'PE' : 'CE';
  if (dt === 'FUT') return 'FUT';
  return 'EQ';
}

// loadNubraMaster needs { sessionToken, deviceId }. Fetches NSE/BSE/MCX for
// today and merges. Best-effort per exchange (one failing exchange won't abort).
export async function loadNubraMaster({ sessionToken, deviceId }) {
  if (!sessionToken || !deviceId) throw new Error('Nubra master needs a logged-in session (sessionToken + deviceId)');
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const headers = { Authorization: `Bearer ${sessionToken}`, 'x-device-id': deviceId, Accept: 'application/json' };

  const all = [];
  for (const exchange of ['NSE', 'BSE', 'MCX']) {
    try {
      const res = await fetch(`${BASE.replace(/\/+$/, '')}/refdata/refdata/${date}?exchange=${exchange}`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) continue;
      const body = await res.json();
      const list = Array.isArray(body?.refdata) ? body.refdata : [];
      all.push(...list);
    } catch {
      /* skip this exchange on failure */
    }
  }
  if (all.length === 0) throw new Error('Nubra master returned no instruments (token expired or refdata unavailable)');

  const rows = all.map((r) => {
    const name = String(r.asset || '').toUpperCase();
    const type = typeOf(r.derivative_type, r.option_type);
    const strike = type === 'CE' || type === 'PE'
      ? (Number(r.strike_price) > 0 ? Number(r.strike_price) / 100 : null)
      : null;
    const exchange = mapExchange(r.exchange, r.derivative_type);
    const symbol =
      type === 'EQ'
        ? String(r.stock_name || name).toUpperCase()
        : canonicalSymbol({ name, expiry: String(r.expiry || ''), strike, type });

    return {
      symbol,
      brsymbol: r.stock_name || '',
      name,
      exchange,
      brexchange: String(r.exchange || '').toUpperCase(),
      token: String(r.ref_id ?? ''),      // ref_id IS the Nubra token
      expiry: String(r.expiry || ''),
      strike,
      optionType: type === 'CE' || type === 'PE' ? type : '',
      lotsize: Number(r.lot_size) || 1,
      ticksize: Number(r.tick_size) ? Number(r.tick_size) / 100 : 0,
      segment: String(r.asset_type || ''),
      instrumentType: r.derivative_type || '',
    };
  });

  return setMaster('nubra', rows);
}
