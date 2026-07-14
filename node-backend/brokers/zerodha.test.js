import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { autoLogin, canHeadlessLogin } from './zerodha.js';

const API_KEY = 'apikey123';
const API_SECRET = 'apisecret456';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

function res({ status = 200, body = {}, location = '', cookies = [] } = {}) {
  const headers = new Headers();
  if (location) headers.set('location', location);
  for (const c of cookies) headers.append('set-cookie', c);
  return {
    status,
    ok: status < 400,
    headers,
    json: async () => body,
  };
}

// fakeKite stands in for the whole Kite login surface and records every call, so
// a test can assert on what we sent AND on what we deliberately never fetched.
function fakeKite(opts = {}) {
  const { twofaFails = 0 } = opts;
  const calls = [];
  let failures = twofaFails;

  const handler = async (url, init = {}) => {
    const u = new URL(url);
    const form = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    calls.push({ url, path: u.pathname, form, headers: init.headers || {} });

    // 1. connect/login -> one redirect that attaches a session cookie + sess_id.
    if (u.pathname === '/connect/login' && !u.searchParams.get('sess_id')) {
      return res({
        status: 302,
        location: `https://kite.zerodha.com/connect/login?api_key=${API_KEY}&sess_id=SESS9`,
        cookies: ['kf_session=cookie-abc; Path=/; HttpOnly'],
      });
    }
    // 4. Replay with skip_session -> Kite hands back the request_token. When
    //    opts.pendingAuthorize is set, instead park on the consent screen the way
    //    Kite does for a never-authorized app (302 -> /connect/authorize -> 200).
    if (u.pathname === '/connect/login' && u.searchParams.get('skip_session') === 'true') {
      if (opts.pendingAuthorize) {
        return res({ status: 302, location: 'https://kite.zerodha.com/connect/authorize?sess_id=SESS9' });
      }
      return res({
        status: 302,
        location: 'http://127.0.0.1:3001/zerodha/callback?request_token=RT777&action=login&status=success',
      });
    }
    if (u.pathname === '/connect/authorize') return res({ status: 200, body: {} });
    if (u.pathname === '/connect/login') return res({ status: 200 });

    if (u.pathname === '/api/login') {
      return res({ body: { status: 'success', data: { request_id: 'REQ42', twofa_type: 'totp' } } });
    }
    if (u.pathname === '/api/twofa') {
      if (failures > 0) {
        failures -= 1;
        return res({ status: 403, body: { status: 'error', message: 'Invalid TOTP' } });
      }
      return res({ body: { status: 'success', data: {} } });
    }
    if (u.pathname === '/session/token') {
      return res({
        body: {
          status: 'success',
          data: { access_token: 'AT_LIVE', public_token: 'PT', user_id: 'AB1234', user_name: 'Trader' },
        },
      });
    }
    if (u.pathname === '/user/profile') {
      return res({ body: { status: 'success', data: { user_id: 'AB1234', user_name: 'Trader' } } });
    }
    if (u.pathname === '/user/margins') {
      return res({ body: { status: 'success', data: { equity: { available: { cash: 51000 } } } } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  return { handler, calls, find: (path) => calls.find((c) => c.path === path) };
}

function creds(extra = {}) {
  return {
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    clientCode: 'AB1234',
    password: 'secretpw',
    totpSecret: TOTP_SECRET,
    autoLogin: true,
    ...extra,
  };
}

async function withFakeKite(kite, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = kite.handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('headless login: password + TOTP -> access token, no browser', async () => {
  const kite = fakeKite();
  const out = await withFakeKite(kite, () => autoLogin(creds()));

  assert.equal(out.status, true);
  assert.equal(out.sessionSource, 'auto-login');
  assert.equal(out.clientCode, 'AB1234');
  assert.equal(out.session.accessToken, 'AT_LIVE');
  assert.equal(out.availableMargin, 51000);
  assert.ok(!out.needsLogin, 'must not fall back to the popup');

  // Password step, then a 6-digit TOTP bound to the request_id from that step.
  assert.equal(kite.find('/api/login').form.user_id, 'AB1234');
  assert.equal(kite.find('/api/login').form.password, 'secretpw');
  const twofa = kite.find('/api/twofa').form;
  assert.equal(twofa.request_id, 'REQ42');
  assert.equal(twofa.twofa_type, 'totp');
  assert.match(twofa.twofa_value, /^\d{6}$/);

  // The token is exchanged with the SHA-256(api_key + request_token + secret) checksum.
  const token = kite.find('/session/token').form;
  assert.equal(token.request_token, 'RT777');
  assert.equal(
    token.checksum,
    createHash('sha256').update(`${API_KEY}RT777${API_SECRET}`).digest('hex'),
  );
});

test('cookies from the login page are replayed on the 2FA calls', async () => {
  const kite = fakeKite();
  await withFakeKite(kite, () => autoLogin(creds({ clientCode: 'CD5678' })));

  assert.equal(kite.find('/api/login').headers.Cookie, 'kf_session=cookie-abc');
  assert.equal(kite.find('/api/twofa').headers.Cookie, 'kf_session=cookie-abc');
});

test('stops at the request_token redirect instead of calling our own callback', async () => {
  const kite = fakeKite();
  await withFakeKite(kite, () => autoLogin(creds({ clientCode: 'EF9012' })));

  // Following that last hop would hit /zerodha/callback, which exchanges the
  // token — and Kite honours a request_token exactly once, so the real exchange
  // would then fail with "token is invalid or has expired".
  assert.equal(kite.calls.filter((c) => c.path === '/zerodha/callback').length, 0);
});

test('a TOTP rejected at the window edge is retried once with a fresh code', async () => {
  const kite = fakeKite({ twofaFails: 1 });
  // Anchor to the last second of a 30s TOTP window so the retry path engages.
  const realNow = Date.now;
  Date.now = () => Math.ceil(realNow() / 30_000) * 30_000 - 500;
  try {
    const out = await withFakeKite(kite, () => autoLogin(creds({ clientCode: 'GH3456' })));
    assert.equal(out.status, true);
    assert.equal(kite.calls.filter((c) => c.path === '/api/twofa').length, 2);
  } finally {
    Date.now = realNow;
  }
});

test('a never-authorized app raises needsAuthorize instead of a bogus token error', async () => {
  const kite = fakeKite({ pendingAuthorize: true });
  await withFakeKite(kite, async () => {
    await assert.rejects(
      () => autoLogin(creds({ clientCode: 'IJ7890' })),
      (err) => {
        assert.equal(err.needsAuthorize, true);
        assert.equal(err.status, 428);
        assert.match(err.message, /Authorize/i);
        return true;
      },
    );
  });
  // 2FA still ran — this is a post-login consent gate, not a credential failure.
  assert.ok(kite.find('/api/twofa'), 'must have reached 2FA before the consent screen');
});

test('falls back to the browser popup when password or TOTP is missing', async () => {
  const kite = fakeKite();
  const out = await withFakeKite(kite, () => autoLogin({ apiKey: API_KEY, apiSecret: API_SECRET, autoLogin: true }));

  assert.equal(out.needsLogin, true);
  assert.match(out.loginUrl, /kite\.zerodha\.com\/connect\/login/);
  assert.equal(kite.calls.length, 0, 'no headless attempt without creds');
  // The fallback must name what's missing — a silent popup is what sent us
  // hunting for a phantom bug when the password was being dropped on save.
  assert.match(out.reason, /User ID/);
  assert.match(out.reason, /Password/);
  assert.match(out.reason, /TOTP Secret/);
});

test('canHeadlessLogin requires auto-login plus user id, password and TOTP', () => {
  assert.equal(canHeadlessLogin(creds()), true);
  assert.equal(canHeadlessLogin(creds({ autoLogin: false })), false);
  assert.equal(canHeadlessLogin(creds({ password: '', pin: '' })), false);
  assert.equal(canHeadlessLogin(creds({ totpSecret: '' })), false);
  assert.equal(canHeadlessLogin(creds({ clientCode: '', userId: '' })), false);
  // The Kite password may arrive in the shared `pin` column instead.
  assert.equal(canHeadlessLogin(creds({ password: '', pin: 'secretpw' })), true);
});
