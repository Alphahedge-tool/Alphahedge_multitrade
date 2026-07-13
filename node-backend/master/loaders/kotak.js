// Kotak master loader — Kotak NEO's scripmaster returns per-segment CSV file
// URLs which are then downloaded and parsed. Requires a logged-in session.
//
// Flow (ported from OpenAlgo's kotak master_contract_db):
//   1. GET {baseUrl}/Files/1.0/masterscrip/v1/file-paths  (Authorization: access token)
//      -> { data: { filesPaths: [ "...nse_cm.csv", "...nse_fo.csv", ... ] } }
//   2. Download each CSV, parse columns:
//        pSymbol (token), pTrdSymbol (broker symbol), pSymbolName (name),
//        pExpiryDate, dStrikePrice, pOptionType (CE/PE/XX), pInstType, lLotSize
//   3. Normalize to the canonical symbol.
//
// NOTE: Kotak's scripmaster host/endpoint has varied; we try the session's
// baseUrl first, then known alternates. This loader is best-effort — a failure
// here does not affect the other brokers' masters.

import { canonicalSymbol } from '../symbol.js';
import { parseBrokerCSV } from '../csv.js';
import { setMaster } from '../store.js';

const SCRIP_ENDPOINTS = [
  '/Files/1.0/masterscrip/v2/file-paths',
  '/Files/1.0/masterscrip/v1/file-paths',
  '/script-details/1.0/masterscrip/file-paths',
];
const ALT_HOSTS = ['https://gw-napi.kotaksecurities.com', 'https://cis.kotaksecurities.com', 'https://neo-gw.kotaksecurities.com'];

// Kotak CSV segment (from the file name) -> canonical exchange.
function exchangeFromFile(fileName) {
  const f = String(fileName || '').toLowerCase();
  if (f.includes('nse_fo')) return { exchange: 'NFO', segment: 'nse_fo' };
  if (f.includes('bse_fo')) return { exchange: 'BFO', segment: 'bse_fo' };
  if (f.includes('cde_fo') || f.includes('cds')) return { exchange: 'CDS', segment: 'cde_fo' };
  if (f.includes('bcs-fo') || f.includes('bcd')) return { exchange: 'BCD', segment: 'bcs-fo' };
  if (f.includes('mcx')) return { exchange: 'MCX', segment: 'mcx_fo' };
  if (f.includes('bse_cm') || f.includes('bse')) return { exchange: 'BSE', segment: 'bse_cm' };
  return { exchange: 'NSE', segment: 'nse_cm' };
}

function typeOf(optionType, instType) {
  const ot = String(optionType || '').toUpperCase();
  if (ot === 'CE' || ot === 'PE') return ot;
  if (ot === 'XX' || String(instType || '').toUpperCase().includes('FUT')) return 'FUT';
  return 'EQ';
}

function kotakExpiry(raw, segment) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return raw || '';
  // Kotak's NSE-FO epoch values are stored ten years behind. This mirrors the
  // current official SDK's scrip_search normalization.
  const seconds = value + (segment === 'nse_fo' ? 315_511_200 : 0);
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

async function fetchFilePaths(baseUrl, accessToken) {
  const hosts = [baseUrl, ...ALT_HOSTS].filter(Boolean);
  for (const host of hosts) {
    for (const endpoint of SCRIP_ENDPOINTS) {
      try {
        const res = await fetch(host.replace(/\/+$/, '') + endpoint, {
          headers: { Authorization: accessToken, 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) continue;
        const body = await res.json();
        const paths = body?.data?.filesPaths || body?.filesPaths || [];
        if (paths.length) return paths;
      } catch {
        /* try next endpoint/host */
      }
    }
  }
  return [];
}

export function normalizeKotakRows(files) {
  const rows = [];
  for (const { url, text } of files) {
    const { exchange, segment } = exchangeFromFile(url);
    for (const r of parseBrokerCSV(text)) {
      const name = String(r.pSymbolName || '').toUpperCase().trim();
      const brsymbol = String(r.pTrdSymbol || '').trim();
      if (!name || !brsymbol) continue;
      const type = typeOf(r.pOptionType, r.pInstType);
      const rawStrike = Number(r.dStrikePrice);
      const strike = type === 'CE' || type === 'PE'
        ? (Number.isFinite(rawStrike) && rawStrike > 0 ? rawStrike / 100 : null)
        : null;
      const expiry = type === 'EQ' ? '' : kotakExpiry(r.pExpiryDate, segment);
      const symbol = type === 'EQ'
        ? name
        : canonicalSymbol({ name, expiry, strike, type });
      rows.push({
        symbol,
        brsymbol,
        name,
        exchange,
        brexchange: segment,
        token: String(r.pSymbol ?? ''),
        expiry,
        strike,
        optionType: type === 'CE' || type === 'PE' ? type : '',
        lotsize: Number(r.lLotSize) || 1,
        ticksize: Number(r.dTickSize) || 0,
        segment,
        instrumentType: r.pInstType || '',
      });
    }
  }
  return rows;
}

// loadKotakMaster needs { accessToken, baseUrl }. accessToken is the NEO access
// token (broker config app_secret / app_key); baseUrl comes from the login
// session (session.baseUrl) or an alternate is tried.
export async function loadKotakMaster({ accessToken, baseUrl }) {
  if (!accessToken) throw new Error('Kotak master needs the NEO access token');

  const filePaths = await fetchFilePaths(baseUrl, accessToken);
  if (!filePaths.length) throw new Error('Kotak scripmaster returned no file paths (token/host issue)');

  const files = [];
  for (const url of filePaths) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      files.push({ url, text: await res.text() });
    } catch {
      /* skip a bad CSV, keep the rest */
    }
  }
  const rows = normalizeKotakRows(files);
  if (rows.length === 0) throw new Error('Kotak master parsed no instruments');
  return setMaster('kotak', rows);
}
