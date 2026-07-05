// /api/users/* and /api/users/broker-config/* — admin users + per-user broker
// configs, backed by Supabase (app_users, broker_configs).
//
// Response envelope matches the ported admin frontend's apiGet/apiPost, which
// expects { success: true, data } (not the { status } shape the broker-login
// routes use). Errors return { success: false, message }.

import { route, readJSON, ApiError } from '../server.js';
import * as db from '../lib/supabaseAdmin.js';

const ok = (data, extra = {}) => ({ success: true, data, ...extra });

// ── users ──────────────────────────────────────────────────────────────────
route('GET', '/api/users/list', async () => ok(await db.listUsers()));

route('POST', '/api/users/create', async (req) => {
  const b = await readJSON(req);
  if (!b.username?.trim()) throw new ApiError('Username required', 400);
  const user = await db.createUser({
    first_name: b.first_name || b.firstName || '',
    last_name: b.last_name || b.lastName || '',
    username: b.username.trim(),
    email: b.email || '',
    mobile: b.mobile || '',
    segments: b.segments || '',
    status: b.status || 'active',
  });
  return ok(user);
});

route('POST', '/api/users/update', async (req) => {
  const b = await readJSON(req);
  if (!b.id) throw new ApiError('id required', 400);
  const patch = {};
  for (const [k, col] of [
    ['firstName', 'first_name'], ['first_name', 'first_name'],
    ['lastName', 'last_name'], ['last_name', 'last_name'],
    ['username', 'username'], ['email', 'email'], ['mobile', 'mobile'],
    ['segments', 'segments'], ['status', 'status'],
  ]) {
    if (b[k] !== undefined) patch[col] = b[k];
  }
  return ok(await db.updateUser(b.id, patch));
});

route('POST', '/api/users/toggle-status', async (req) => {
  const b = await readJSON(req);
  if (!b.id) throw new ApiError('id required', 400);
  const status = b.status || (b.active ? 'active' : 'inactive');
  return ok(await db.updateUser(b.id, { status }));
});

route('POST', '/api/users/delete', async (req) => {
  const b = await readJSON(req);
  if (!b.id) throw new ApiError('id required', 400);
  await db.deleteUser(b.id);
  return ok(null);
});

// ── per-user broker configs (multi-broker) ──────────────────────────────────
route('GET', '/api/users/broker-config/list', async (req, res, { query }) => {
  const userId = query.get('user_id') || '';
  return ok(await db.listBrokerConfigs(userId));
});

route('GET', '/api/users/broker-config/get', async (req, res, { query }) => {
  const id = query.get('id');
  if (!id) throw new ApiError('id required', 400);
  return ok(await db.getBrokerConfig(id));
});

function brokerConfigFrom(b) {
  return {
    broker_name: b.broker_name || b.broker || 'angelone',
    account_id: b.account_id || '',
    app_name: b.app_name || '',
    app_key: b.app_key || '',
    app_secret: b.app_secret || '',
    pin: b.pin || '',
    totp_secret: b.totp_secret || '',
    password: b.password || '',
    phone: b.phone || '',
    enabled: b.enabled ?? true,
    auto_login: b.auto_login ?? true,
    position: b.position ?? 0,
  };
}

route('POST', '/api/users/broker-config/create', async (req) => {
  const b = await readJSON(req);
  if (!b.user_id) throw new ApiError('user_id required', 400);
  // In the broker_accounts-backed model, the user_id IS the alias.
  return ok(await db.createBrokerConfig(brokerConfigFrom(b), b.user_id));
});

route('POST', '/api/users/broker-config/update', async (req) => {
  const b = await readJSON(req);
  if (!b.id) throw new ApiError('id required', 400);
  return ok(await db.updateBrokerConfig(b.id, brokerConfigFrom(b)));
});

route('POST', '/api/users/broker-config/delete', async (req) => {
  const b = await readJSON(req);
  if (!b.id) throw new ApiError('id required', 400);
  await db.deleteBrokerConfig(b.id);
  return ok(null);
});
