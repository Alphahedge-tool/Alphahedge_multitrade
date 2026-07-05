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
import { setMaster } from '../store.js';

const SCRIP_ENDPOINT = '/Files/1.0/masterscrip/v1/file-paths';
const ALT_HOSTS = ['https://gw-napi.kotaksecurities.com', 'https://cis.kotaksecurities.com', 'https://neo-gw.kotaksecurities.com'];

// Kotak CSV segment (from the file name) -> canonical exchange.
function mapExchangeFromFile(fileName) {
  const f = String(fileName || '').toLowerCase();
  if (f.includes('nse_fo')) return 'NFO';
  if (f.includes('bse_fo')) return 'BFO';
  if (f.includes('cde_fo') || f.includes('cds')) return 'CDS';
  if (f.includes('mcx')) return 'MCX';
  if (f.includes('nse_cm') || f.includes('nse')) return 'NSE';
  if (f.includes('bse_cm') || f.includes('bse')) return 'BSE';
  return 'NSE';
}

function typeOf(optionType, instType) {
  const ot = String(optionType || '').toUpperCase();
  if (ot === 'CE' || ot === 'PE') return ot;
  if (ot === 'XX' || String(instType || '').toUpperCase().includes('FUT')) return 'FUT';
  return 'EQ';
}

// parseCSV: minimal CSV parser (Kotak files are ';'- or ','-delimited; the
// header tells us which). Returns array of row objects keyed by (cleaned) header.
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const delim = lines[0].includes(';') ? ';' : ',';
  const headers = lines[0].split(delim).map((h) => h.replace(/[;\s]/g, ''));
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim);
    const row = {};
    headers.forEach((h, j) => { row[h] = (cols[j] ?? '').trim(); });
    out.push(row);
  }
  return out;
}

async function fetchFilePaths(baseUrl, accessToken) {
  const hosts = [baseUrl, ...ALT_HOSTS].filter(Boolean);
  for (const host of hosts) {
    try {
      const res = await fetch(host.replace(/\/+$/, '') + SCRIP_ENDPOINT, {
        headers: { Authorization: accessToken, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;
      const body = await res.json();
      const paths = body?.data?.filesPaths || body?.filesPaths || [];
      if (paths.length) return paths;
    } catch {
      /* try next host */
    }
  }
  return [];
}

// loadKotakMaster needs { accessToken, baseUrl }. accessToken is the NEO access
// token (broker config app_secret / app_key); baseUrl comes from the login
// session (session.baseUrl) or an alternate is tried.
export async function loadKotakMaster({ accessToken, baseUrl }) {
  if (!accessToken) throw new Error('Kotak master needs the NEO access token');

  const filePaths = await fetchFilePaths(baseUrl, accessToken);
  if (!filePaths.length) throw new Error('Kotak scripmaster returned no file paths (token/host issue)');

  const rows = [];
  for (const url of filePaths) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) continue;
      const csv = parseCSV(await res.text());
      const exchange = mapExchangeFromFile(url);
      for (const r of csv) {
        const name = String(r.pSymbolName || '').toUpperCase();
        if (!name) continue;
        const type = typeOf(r.pOptionType, r.pInstType);
        const strike = type === 'CE' || type === 'PE'
          ? (Number(r.dStrikePrice) > 0 ? Number(r.dStrikePrice) : null)
          : null;
        const symbol = type === 'EQ'
          ? name
          : canonicalSymbol({ name, expiry: r.pExpiryDate, strike, type });
        rows.push({
          symbol,
          brsymbol: r.pTrdSymbol || '',
          name,
          exchange,
          brexchange: exchange,
          token: String(r.pSymbol ?? ''),   // Kotak token
          expiry: r.pExpiryDate || '',
          strike,
          optionType: type === 'CE' || type === 'PE' ? type : '',
          lotsize: Number(r.lLotSize) || 1,
          ticksize: Number(r.dTickSize) || 0,
          segment: r.pInstType || '',
          instrumentType: r.pInstType || '',
        });
      }
    } catch {
      /* skip a bad CSV, keep the rest */
    }
  }
  if (rows.length === 0) throw new Error('Kotak master parsed no instruments');
  return setMaster('kotak', rows);
}
