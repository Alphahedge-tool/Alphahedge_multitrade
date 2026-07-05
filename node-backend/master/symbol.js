// Canonical ("global") symbol format — adopted from OpenAlgo so one symbol
// string identifies an instrument across every broker. Each broker's master
// loader converts its own instruments to these keys, and the resolver maps a
// canonical symbol back to that broker's token.
//
//   EQUITY   : SBIN                         -> [SYMBOL]
//   FUTURES  : NIFTY30JAN25FUT              -> [SYMBOL][DD][MMM][YY]FUT
//   OPTIONS  : NIFTY30JAN2521500CE          -> [SYMBOL][DD][MMM][YY][STRIKE][CE|PE]
//
// Expiry is always DDMMMYY upper-case (e.g. 30JAN25). Strike is an integer with
// no decimals when whole (21500), else the minimal decimal form.

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// toExpiryDDMMMYY normalizes any common expiry input to DDMMMYY (e.g. 30JAN25).
// Accepts: "30JAN2025", "30JAN25", "2025-01-30", "20250130", 20250130, Date-ish.
export function toExpiryDDMMMYY(input) {
  if (input == null || input === '') return '';
  const s = String(input).trim().toUpperCase();

  // Already DDMMMYYYY or DDMMMYY (e.g. 30JAN2025 / 30JAN25)
  let m = s.match(/^(\d{1,2})([A-Z]{3})(\d{2}|\d{4})$/);
  if (m) {
    const [, dd, mon, yy] = m;
    return `${dd.padStart(2, '0')}${mon}${yy.slice(-2)}`;
  }

  // YYYY-MM-DD or YYYYMMDD
  m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (m) {
    const [, yyyy, mm, dd] = m;
    const mon = MONTHS[Number(mm) - 1];
    if (mon) return `${dd}${mon}${yyyy.slice(-2)}`;
  }

  // Epoch millis or a parseable date string
  const t = /^\d{10,13}$/.test(s) ? Number(s.length === 10 ? s * 1000 : s) : Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mon = MONTHS[d.getUTCMonth()];
    const yy = String(d.getUTCFullYear()).slice(-2);
    return `${dd}${mon}${yy}`;
  }

  return s; // unknown format — pass through
}

// formatStrike renders a strike price with no trailing ".0" (21500 not 21500.0),
// keeping real decimals when present (e.g. 0.5 for some currency options).
export function formatStrike(strike) {
  const n = Number(strike);
  if (!Number.isFinite(n)) return String(strike ?? '');
  return Number.isInteger(n) ? String(n) : String(n).replace(/\.?0+$/, '');
}

// canonicalSymbol builds the global symbol from parts.
//   type: 'EQ' | 'FUT' | 'CE' | 'PE' (or 'OPT' with optionType)
export function canonicalSymbol({ name, expiry, strike, type, optionType }) {
  const base = String(name || '').toUpperCase().trim();
  const t = String(type || '').toUpperCase();
  const ot = String(optionType || '').toUpperCase();

  if (t === 'FUT') return `${base}${toExpiryDDMMMYY(expiry)}FUT`;
  if (t === 'CE' || t === 'PE') return `${base}${toExpiryDDMMMYY(expiry)}${formatStrike(strike)}${t}`;
  if (t === 'OPT' && (ot === 'CE' || ot === 'PE')) {
    return `${base}${toExpiryDDMMMYY(expiry)}${formatStrike(strike)}${ot}`;
  }
  return base; // equity / index
}

// parseCanonical splits a canonical symbol back into its parts (best-effort).
// Useful for display and for building a broker's own symbol from the key.
export function parseCanonical(symbol) {
  const s = String(symbol || '').toUpperCase();
  // OPTION: NAME + DDMMMYY + STRIKE + CE/PE
  let m = s.match(/^([A-Z0-9]+?)(\d{1,2}[A-Z]{3}\d{2})(\d+(?:\.\d+)?)(CE|PE)$/);
  if (m) return { name: m[1], expiry: m[2], strike: Number(m[3]), type: m[4] };
  // FUTURE: NAME + DDMMMYY + FUT
  m = s.match(/^([A-Z0-9]+?)(\d{1,2}[A-Z]{3}\d{2})FUT$/);
  if (m) return { name: m[1], expiry: m[2], strike: null, type: 'FUT' };
  // EQUITY
  return { name: s, expiry: '', strike: null, type: 'EQ' };
}
