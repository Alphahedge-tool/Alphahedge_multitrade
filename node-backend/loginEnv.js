// Single-account Nubra auto-login from .env — the quickest way to run the flow
// without Supabase. This is the Node equivalent of the Python
// nubra_rest_totp_flow.py login: it reads one account's creds from the
// environment and does the headless TOTP login.
//
// Run with Node's native env-file loader (Node 20.6+/22+):
//   node --env-file=.env node-backend/loginEnv.js
//
// Reads NUBRA_PHONE, NUBRA_MPIN, NUBRA_TOTP_SECRET (PHONE_NO / MPIN / TOTP_SECRET
// also accepted). Set NUBRA_ENV=UAT to hit the UAT base URL; defaults to PROD.
//
// For multi-broker login backed by Supabase, use loginAll.js instead.

import * as nubra from './brokers/nubra.js';

function envAny(...names) {
  for (const name of names) {
    const v = (process.env[name] || '').trim();
    if (v && !v.toLowerCase().startsWith('your_')) return v;
  }
  return '';
}

async function main() {
  const cr = {
    phone: envAny('NUBRA_PHONE', 'PHONE_NO'),
    mpin: envAny('NUBRA_MPIN', 'MPIN'),
    totpSecret: envAny('NUBRA_TOTP_SECRET', 'TOTP_SECRET'),
    clientCode: envAny('NUBRA_CLIENT_CODE', 'CLIENT_CODE'),
    env: envAny('NUBRA_ENV') || undefined,
  };

  const missing = [
    ['NUBRA_PHONE', cr.phone],
    ['NUBRA_MPIN', cr.mpin],
    ['NUBRA_TOTP_SECRET', cr.totpSecret],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`Missing env keys: ${missing.join(', ')} (load them with --env-file=.env)`);
    process.exit(1);
  }

  const session = await nubra.login(cr);
  console.log('✅ Nubra login successful');
  console.log('   session token:', `${String(session.sessionToken).slice(0, 12)}…`);
  console.log('   device id    :', session.deviceId);
  console.log('   phone        :', session.phone);
}

main().catch((err) => {
  console.error('❌ Nubra login failed:', err.message);
  process.exit(1);
});
