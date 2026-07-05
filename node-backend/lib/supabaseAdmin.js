// Admin data layer built ON TOP of the existing broker_accounts table — no new
// tables. A "user" is modeled as a distinct `username` value: all
// broker_accounts rows sharing a username are that user's broker accounts, so
// one user owns many brokers. Everything goes through the PostgREST API with the
// service-role key.
//
// Column mapping (broker_accounts -> admin concept):
//   username     -> user name (the grouping key)
//   broker       -> broker_name
//   client_code  -> account_id
//   api_key      -> app_key
//   api_secret   -> app_secret
//   pin, totp_secret, phone, enabled, auto_login, position -> same

const URL_ENV = 'SUPABASE_URL';
const KEY_ENV = 'SUPABASE_SERVICE_KEY';
const TABLE = 'broker_accounts';

function cfg() {
  const url = process.env[URL_ENV];
  const key = process.env[KEY_ENV];
  if (!url || !key) throw new Error(`Supabase not configured — set ${URL_ENV} and ${KEY_ENV}`);
  return { url: url.replace(/\/+$/, ''), key };
}
function headers(key, extra = {}) {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}
async function rest(method, path, { body, prefer } = {}) {
  const { url, key } = cfg();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: headers(key, {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} failed: HTTP ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// rowToConfig maps a broker_accounts row to the admin "broker config" shape the
// ported UI/Feedmaster consume (account_id / app_key / totp_secret / ...).
function rowToConfig(r) {
  return {
    id: r.id,
    user_id: r.username || '',      // the username IS the user id in this model
    broker_name: r.broker || 'angelone',
    account_id: r.client_code || '',
    app_key: r.api_key || '',
    app_secret: r.api_secret || '',
    pin: r.pin || '',
    totp_secret: r.totp_secret || '',
    phone: r.phone || '',
    enabled: !!r.enabled,
    auto_login: !!r.auto_login,
    position: r.position ?? 0,
  };
}

// configToRow maps the admin shape back to broker_accounts columns for save.
function configToRow(c, username) {
  return {
    username: username ?? c.user_id ?? '',
    broker: c.broker_name || c.broker || 'angelone',
    client_code: c.account_id || '',
    api_key: c.app_key || '',
    api_secret: c.app_secret || '',
    pin: c.pin || '',
    totp_secret: c.totp_secret || '',
    phone: c.phone || '',
    enabled: c.enabled ?? true,
    auto_login: c.auto_login ?? true,
    market_orders: c.market_orders || 'Allowed',
    position: c.position ?? 0,
    updated_at: new Date().toISOString(),
  };
}

async function allRows() {
  return (await rest('GET', `${TABLE}?order=position.asc`)) || [];
}

// ── users (derived: one per distinct username) ──────────────────────────────
// User CONTACT details (mobile/email) live in their own columns (user_mobile,
// user_email) — SEPARATE from each broker's login `phone`. Editing a user's
// mobile therefore never touches a broker's login phone.
export async function listUsers() {
  const rows = await allRows();
  const byUser = new Map();
  for (const r of rows) {
    const username = r.username || '(unnamed)';
    if (!byUser.has(username)) {
      byUser.set(username, {
        id: username, username, first_name: '', last_name: '',
        email: r.user_email || '',
        mobile: r.user_mobile || '',   // user's contact mobile, NOT the broker phone
        brokers: 0,
      });
    }
    const u = byUser.get(username);
    u.brokers += 1;
    // Prefer any non-empty contact value found across the user's rows.
    if (!u.email && r.user_email) u.email = r.user_email;
    if (!u.mobile && r.user_mobile) u.mobile = r.user_mobile;
  }
  return [...byUser.values()];
}

// createUser: a user with no brokers yet is just a name; we can't store an empty
// user in broker_accounts, so we return a synthetic record. The first broker
// config created under this username makes it real.
export async function createUser(u) {
  return { id: u.username, username: u.username, first_name: u.first_name || '', last_name: u.last_name || '', email: u.email || '', mobile: u.mobile || '', brokers: 0 };
}

// usernameFilter builds the PostgREST filter that selects a user's rows. The
// list groups rows with a blank username under the display id "(unnamed)", so
// map that back to an empty-string match (is.null OR eq.'') — otherwise an edit
// on the unnamed user matches nothing and silently does nothing. The id is
// trimmed so a stray leading/trailing space never causes a 0-row mismatch.
function usernameFilter(id) {
  const v = typeof id === 'string' ? id.trim() : id;
  if (v === '(unnamed)' || v === '' || v == null) {
    return `or=(username.is.null,username.eq.)`;
  }
  return `username=eq.${encodeURIComponent(v)}`;
}

// updateUser: apply username rename and/or user CONTACT details to ALL of that
// user's broker rows. Contact mobile/email go to the dedicated user_mobile /
// user_email columns — NOT the broker login `phone`, so a user edit can never
// break a broker's auto-login.
export async function updateUser(id, patch) {
  const body = { updated_at: new Date().toISOString() };
  // Trim the new username so a stray space is never stored (it would break the
  // exact-match lookups that group a user's broker rows).
  const newName = typeof patch.username === 'string' ? patch.username.trim() : patch.username;
  if (newName != null && newName !== id) body.username = newName;
  if (patch.mobile != null) body.user_mobile = patch.mobile;
  if (patch.email != null) body.user_email = patch.email;

  // Nothing to change beyond the timestamp → no-op.
  if (body.username === undefined && body.user_mobile === undefined && body.user_email === undefined) {
    return { id, username: id, ...patch };
  }

  await rest('PATCH', `${TABLE}?${usernameFilter(id)}`, { body, prefer: 'return=minimal' });
  const newId = body.username ?? id;
  return { id: newId, username: newId, mobile: patch.mobile, email: patch.email };
}

// deleteUser: remove all broker rows under this username (including unnamed).
export function deleteUser(id) {
  return rest('DELETE', `${TABLE}?${usernameFilter(id)}`, { prefer: 'return=minimal' });
}

// ── broker configs (per user = per username) ────────────────────────────────
export async function listBrokerConfigs(userId) {
  // Map "(unnamed)" / blank back to the null-or-empty username match so the
  // unnamed user's brokers actually show (otherwise the list is empty).
  const q = userId ? `?${usernameFilter(userId)}&order=position.asc` : '?order=position.asc';
  const rows = (await rest('GET', `${TABLE}${q}`)) || [];
  return rows.map(rowToConfig);
}
export async function getBrokerConfig(id) {
  const rows = await rest('GET', `${TABLE}?id=eq.${encodeURIComponent(id)}`);
  return rows?.[0] ? rowToConfig(rows[0]) : null;
}
export async function createBrokerConfig(c, username) {
  // "(unnamed)" is a display label, never a real stored username. Trim so a
  // stray space never gets stored (it would break username-grouped lookups).
  const raw = typeof username === 'string' ? username.trim() : username;
  const name = raw === '(unnamed)' ? '' : raw;
  const rows = await rest('POST', TABLE, { body: [configToRow(c, name)], prefer: 'return=representation' });
  return rows?.[0] ? rowToConfig(rows[0]) : null;
}
export async function updateBrokerConfig(id, c) {
  const row = configToRow(c);
  delete row.username; // don't move the config to another user on a plain edit
  const rows = await rest('PATCH', `${TABLE}?id=eq.${encodeURIComponent(id)}`, { body: row, prefer: 'return=representation' });
  return rows?.[0] ? rowToConfig(rows[0]) : null;
}
export function deleteBrokerConfig(id) {
  return rest('DELETE', `${TABLE}?id=eq.${encodeURIComponent(id)}`, { prefer: 'return=minimal' });
}

// setBrokerAccountId writes the resolved broker account id (e.g. Upstox's
// user_id from /user/profile) into one config's client_code column, without
// touching any other field. Used after a broker login resolves the account id.
export async function setBrokerAccountId(id, accountId) {
  if (!id || !accountId) return null;
  const rows = await rest('PATCH', `${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    body: { client_code: accountId, updated_at: new Date().toISOString() },
    prefer: 'return=representation',
  });
  return rows?.[0] ? rowToConfig(rows[0]) : null;
}

export function isConfigured() {
  return Boolean(process.env[URL_ENV] && process.env[KEY_ENV]);
}
