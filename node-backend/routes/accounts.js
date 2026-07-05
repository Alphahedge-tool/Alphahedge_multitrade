// /api/accounts — load (GET) and save (POST) broker accounts in Supabase.
// Matches the Go backend's handleAccounts contract exactly so the frontend needs
// no change: when Supabase isn't configured it replies {status:true,
// enabled:false} so the frontend falls back to its local IndexedDB store.

import { route, readJSON, ApiError } from '../server.js';
import { isConfigured } from '../lib/supabase.js';

const URL_ENV = 'SUPABASE_URL';
const KEY_ENV = 'SUPABASE_SERVICE_KEY';
const TABLE = 'broker_accounts';

function config() {
  return { url: process.env[URL_ENV].replace(/\/+$/, ''), key: process.env[KEY_ENV] };
}

function sbHeaders(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

// The DB columns are snake_case but the frontend consumes camelCase (it spreads
// each account straight onto a client row and reads clientCode/apiKey/etc.), so
// the Go store maps between the two — we must do the same or every credential
// field shows up blank in the UI. rowToClient: DB row -> frontend shape.
function rowToClient(r) {
  return {
    id: r.id,
    position: r.position,
    enabled: r.enabled,
    alias: r.alias || '',
    clientCode: r.client_code || '',
    broker: r.broker || 'Angel',
    marketOrders: r.market_orders || 'Allowed',
    apiKey: r.api_key || '',
    apiSecret: r.api_secret || '',
    totpSecret: r.totp_secret || '',
    pin: r.pin || '',
    phone: r.phone || '',
    autoLogin: !!r.auto_login,
    historicalApi: !!r.historical_api,
    sqoffTime: r.sqoff_time || '15:16',
  };
}

// clientToRow: frontend shape -> DB row for saving. Drops runtime-only fields
// (session, status, margins) so only credentials/config are persisted.
function clientToRow(c, i) {
  return {
    position: c.position ?? i,
    enabled: !!c.enabled,
    alias: c.alias || '',
    client_code: c.clientCode || '',
    broker: c.broker || 'Angel',
    market_orders: c.marketOrders || 'Allowed',
    api_key: c.apiKey || '',
    api_secret: c.apiSecret || '',
    totp_secret: c.totpSecret || '',
    pin: c.pin || '',
    phone: c.phone || '',
    auto_login: !!c.autoLogin,
    historical_api: !!c.historicalApi,
    sqoff_time: c.sqoffTime || '15:16',
    updated_at: new Date().toISOString(),
  };
}

// listAccounts returns raw broker_accounts rows (all, or filtered by ?broker=),
// ordered by position — the shape the frontend already consumes.
async function listAccounts(broker) {
  const { url, key } = config();
  const params = new URLSearchParams({ order: 'position.asc' });
  if (broker) params.set('broker', `eq.${broker}`);
  const res = await fetch(`${url}/rest/v1/${TABLE}?${params}`, { headers: sbHeaders(key) });
  if (!res.ok) throw new ApiError(`Supabase select failed: HTTP ${res.status}`, 500);
  return res.json();
}

// replaceAccounts mirrors the Go store.Replace: replace the given broker's rows
// (or all rows when broker is empty) with the supplied set. Done as delete +
// insert so removed rows actually disappear.
async function replaceAccounts(accounts, broker) {
  const { url, key } = config();

  const delParams = new URLSearchParams();
  if (broker) delParams.set('broker', `eq.${broker}`);
  else delParams.set('id', 'not.is.null'); // match-all guard PostgREST requires
  const del = await fetch(`${url}/rest/v1/${TABLE}?${delParams}`, {
    method: 'DELETE',
    headers: sbHeaders(key, { Prefer: 'return=minimal' }),
  });
  if (!del.ok) throw new ApiError(`Supabase delete failed: HTTP ${del.status}`, 500);

  if (!accounts || accounts.length === 0) return 0;
  const rows = accounts.map((a, i) => clientToRow(a, i));
  const ins = await fetch(`${url}/rest/v1/${TABLE}`, {
    method: 'POST',
    headers: sbHeaders(key, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!ins.ok) throw new ApiError(`Supabase insert failed: HTTP ${ins.status} ${await ins.text()}`, 500);
  return rows.length;
}

route('GET', '/api/accounts', async (req, res, { query }) => {
  if (!isConfigured()) return { status: true, enabled: false, accounts: [] };
  const broker = query.get('broker') || '';
  const rows = await listAccounts(broker);
  return { status: true, enabled: true, broker, accounts: rows.map(rowToClient) };
});

route('POST', '/api/accounts', async (req) => {
  if (!isConfigured()) return { status: true, enabled: false, accounts: [] };
  const body = await readJSON(req);
  const broker = body.broker || '';
  const accounts = Array.isArray(body.accounts) ? body.accounts : [];
  const saved = await replaceAccounts(accounts, broker);
  return { status: true, enabled: true, broker, saved };
});
