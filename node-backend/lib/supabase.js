// Minimal Supabase REST helper using the service-role key (server-side only,
// bypasses RLS — never expose this key to the browser). Talks to the
// broker_accounts table defined in supabase_schema.sql. No SDK dependency: the
// two operations we need (select enabled brokers, patch one row's totp_secret)
// are one fetch each against the PostgREST endpoint.

const URL_ENV = 'SUPABASE_URL';
const KEY_ENV = 'SUPABASE_SERVICE_KEY';
const TABLE = 'broker_accounts';

function config() {
  const url = process.env[URL_ENV];
  const key = process.env[KEY_ENV];
  if (!url || !key) {
    throw new Error(
      `Supabase not configured — set ${URL_ENV} and ${KEY_ENV} (see SUPABASE_SETUP.md)`,
    );
  }
  return { url: url.replace(/\/+$/, ''), key };
}

function headers(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

// rowToCreds maps a broker_accounts row (snake_case columns) to the camelCase
// creds shape the broker adapters expect.
function rowToCreds(row) {
  return {
    id: row.id,
    broker: row.broker,
    alias: row.alias,
    clientCode: row.client_code,
    phone: row.phone,
    mpin: row.pin,
    pin: row.pin,
    totpSecret: row.totp_secret,
    apiKey: row.api_key,
    apiSecret: row.api_secret,
    marketOrders: row.market_orders,
    enabled: row.enabled,
    autoLogin: row.auto_login,
  };
}

// getEnabledBrokers returns creds for every enabled row, optionally filtered to
// one broker name (e.g. "Nubra"). Used by the login manager to fan out logins.
export async function getEnabledBrokers({ broker } = {}) {
  const { url, key } = config();
  const params = new URLSearchParams({ enabled: 'eq.true', order: 'position.asc' });
  if (broker) params.set('broker', `eq.${broker}`);
  const res = await fetch(`${url}/rest/v1/${TABLE}?${params}`, { headers: headers(key) });
  if (!res.ok) {
    throw new Error(`Supabase select failed: HTTP ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return rows.map(rowToCreds);
}

// saveTotpSecret persists a generated TOTP secret back onto one broker row after
// self-setup, so the next login is fully headless with no SMS OTP.
export async function saveTotpSecret(id, totpSecret) {
  const { url, key } = config();
  const res = await fetch(`${url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: headers(key, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify({ totp_secret: totpSecret, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    throw new Error(`Supabase update failed: HTTP ${res.status} ${await res.text()}`);
  }
}

// clearTotpSecret wipes the stored secret on one broker row. Used by the
// self-heal path when the saved secret is rejected/not-enabled, so the account
// falls back to the fresh-setup flow instead of retrying a dead secret forever.
export async function clearTotpSecret(id) {
  return saveTotpSecret(id, '');
}

export function isConfigured() {
  return Boolean(process.env[URL_ENV] && process.env[KEY_ENV]);
}
