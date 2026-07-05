// Multi-broker auto-login manager.
//
// Flow per Nubra account (mirrors the Python self-setup script, but Supabase is
// the source of truth instead of .env):
//
//   1. totp_secret present  -> headless TOTP login (nubra.login)
//   2. totp_secret missing   -> not set up yet. Setup is a two-call flow the
//      frontend drives, because it needs the one-time SMS OTP:
//        a. POST /api/nubra/setup/start  { id } -> Node sends OTP, returns a
//           setup handle (temp token). Frontend shows an "Enter OTP" box.
//        b. POST /api/nubra/setup/finish { id, tempToken, otp } -> Node enables
//           TOTP, SAVES the secret to that Supabase row, then logs in.
//      After that, step 1 handles every future run with no human involved.
//
// loginAllNubra runs step 1 for all enabled Nubra accounts in parallel and
// reports which ones still need setup, so the frontend can prompt only those.

import { pathToFileURL } from 'node:url';

import * as nubra from './brokers/nubra.js';
import { getEnabledBrokers, saveTotpSecret, clearTotpSecret } from './lib/supabase.js';

// Sessions are kept in-memory keyed by account id and reused until restart,
// same lifetime model as the Go backend's sessionStore.
const sessions = new Map();

export function getSession(id) {
  return sessions.get(id) || null;
}

// startHeal wipes a broken secret and kicks off a fresh setup: it deletes the
// stored secret from Supabase and auto-sends a new SMS OTP, returning the temp
// token so the caller can finish setup with the code the user receives.
// Returns a needs-otp result — or, if even the OTP send fails, an error.
async function startHeal(cr, reason) {
  const base = { id: cr.id, broker: cr.broker, alias: cr.alias, clientCode: cr.clientCode };
  try {
    // Drop the dead secret first, so a later run never retries it and the row
    // truthfully reflects "not set up" until a new secret is enabled + saved.
    await clearTotpSecret(cr.id);
    const { tempToken } = await nubra.startSetup(cr);
    return { ...base, status: 'needs-otp', tempToken, reason };
  } catch (err) {
    // Couldn't even send the OTP (e.g. rate-limited). Secret is already cleared;
    // surface the reason so the caller can retry the setup later.
    return { ...base, status: 'needs-otp', tempToken: null, reason, sendError: err.message };
  }
}

// loginOne logs in a single account whose creds already include a totpSecret.
// Self-healing: if login fails specifically because the stored TOTP secret is
// broken (not enabled / reset / rejected), it clears that secret from Supabase
// and auto-starts a fresh setup (new OTP), returning needs-otp. Transient
// failures (network, 5xx, session) are reported as plain errors and leave the
// secret untouched. Returns a uniform result the frontend can render.
async function loginOne(cr) {
  if (!cr.totpSecret) {
    // No secret yet → begin setup immediately (this also sends the OTP).
    return startHeal(cr, 'no-secret');
  }
  try {
    const session = await nubra.login(cr);
    sessions.set(cr.id, session);
    return { id: cr.id, broker: cr.broker, alias: cr.alias, status: 'ok', clientCode: cr.clientCode };
  } catch (err) {
    if (nubra.isTOTPError(err)) {
      // The saved secret is dead → wipe it and regenerate a fresh one.
      return startHeal(cr, err.message);
    }
    return {
      id: cr.id,
      broker: cr.broker,
      alias: cr.alias,
      status: 'error',
      httpStatus: err.status,
      message: err.message,
    };
  }
}

// loginAllNubra logs into every enabled Nubra account at once. Promise.all fans
// them out; each result carries its own success/failure so one bad account never
// blocks the others.
export async function loginAllNubra() {
  const brokers = (await getEnabledBrokers({ broker: 'Nubra' })).filter((c) => c.autoLogin);
  const results = await Promise.all(brokers.map(loginOne));
  return {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    // Accounts whose secret was missing or just got wiped by self-heal — each
    // carries a tempToken (when the OTP send succeeded) for finishNubraSetup.
    needsOtp: results
      .filter((r) => r.status === 'needs-otp')
      .map((r) => ({ id: r.id, tempToken: r.tempToken, reason: r.reason })),
    results,
  };
}

// --- Self-setup, driven by the frontend for the one-time SMS OTP -------------

async function credsById(id) {
  const brokers = await getEnabledBrokers();
  const cr = brokers.find((c) => c.id === id);
  if (!cr) throw new Error(`No enabled broker account with id ${id}`);
  return cr;
}

// startNubraSetup triggers the SMS OTP and returns the handle the frontend sends
// back to finishNubraSetup with the code the user received.
export async function startNubraSetup(id) {
  const cr = await credsById(id);
  const { tempToken } = await nubra.startSetup(cr);
  return { id, tempToken };
}

// finishNubraSetup completes enrollment with the user's SMS OTP, SAVES the
// generated secret to Supabase, then immediately auto-logs in with it — so from
// here on the account is fully headless.
export async function finishNubraSetup(id, tempToken, otp) {
  const cr = await credsById(id);
  const { totpSecret } = await nubra.finishSetup(cr, { tempToken, otp });

  await saveTotpSecret(id, totpSecret);

  // Log in right away using only the freshly-enabled secret.
  const session = await nubra.login({ ...cr, totpSecret });
  sessions.set(id, session);
  return { id, status: 'ok', clientCode: cr.clientCode, totpEnabled: true };
}

// CLI entry: `node node-backend/loginAll.js` logs in all enabled Nubra accounts
// and prints a summary. Accounts that need one-time setup are listed so you know
// to run the setup flow (from the frontend) for them once. Guard with
// pathToFileURL (handles Windows backslashes) and argv[1] being absent when this
// module is imported (e.g. via `node -e`), so importing never runs the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loginAllNubra()
    .then((summary) => {
      console.log(`Nubra auto-login: ${summary.ok}/${summary.total} logged in`);
      for (const r of summary.results) {
        const label = r.alias || r.clientCode || r.id;
        if (r.status === 'ok') {
          console.log(`  ✅ ${label}`);
        } else if (r.status === 'needs-otp') {
          // Secret was missing or just wiped by self-heal; a fresh OTP was sent.
          const why = r.reason && r.reason !== 'no-secret' ? ` (old secret cleared: ${r.reason})` : '';
          const sent = r.tempToken ? 'OTP sent — enter it to finish setup' : `could not send OTP: ${r.sendError}`;
          console.log(`  ⚙️  ${label} — ${sent}${why}`);
        } else {
          console.log(`  ❌ ${label} — ${r.message}`);
        }
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('Nubra auto-login failed:', err.message);
      process.exit(1);
    });
}
