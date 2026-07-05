// TOTP generation, ported from the Go backend's internal/nubra/totp.go so the
// codes are byte-for-byte identical to what Nubra's server expects. Nubra's own
// SDK computes codes with pyotp.TOTP(secret).now(); this mirrors pyotp exactly:
//   - strip an otpauth:// wrapper and any spaces authenticator apps display
//   - upper-case (pyotp uses casefold=True on the base32 decode)
//   - pad the secret up to a multiple of 8 with '=' before base32-decoding
// For any secret pyotp accepts, the decoded key bytes are the same.

import crypto from 'node:crypto';

// extractTOTPSecret unwraps an otpauth:// URI to its `secret` query param, so a
// pasted authenticator export still works. Anything else is returned as-is.
function extractTOTPSecret(secret) {
  const raw = String(secret ?? '').trim();
  if (!raw.toLowerCase().startsWith('otpauth://')) return raw;
  try {
    const u = new URL(raw);
    return u.searchParams.get('secret') || raw;
  } catch {
    return raw;
  }
}

// decodeBase32 decodes an RFC 4648 base32 string (A-Z, 2-7, optional '='
// padding) to a Buffer, matching Python's base64.b32decode(casefold=True).
function decodeBase32(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error('not valid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

// decodeTOTPSecret turns a user-supplied secret into the HMAC key the same way
// pyotp.byte_secret does. Throws a message aimed at the real-world mistake:
// pasting the API secret or MPIN into the TOTP box.
export function decodeTOTPSecret(secret) {
  let clean = extractTOTPSecret(secret).replace(/\s+/g, '');
  if (!clean) throw new Error('Nubra TOTP secret is empty');
  clean = clean.toUpperCase();
  const missing = clean.length % 8;
  if (missing !== 0) clean += '='.repeat(8 - missing);
  try {
    return decodeBase32(clean);
  } catch {
    throw new Error(
      'Nubra TOTP secret is not a valid base32 authenticator secret — paste the ' +
        'TOTP/authenticator secret from Nubra, not the API secret or MPIN',
    );
  }
}

// validateTOTPSecret rejects a secret that cannot be a real TOTP seed before we
// try to log in. An API key like "AQDK44U4" is accidentally valid base32 and
// would silently produce a wrong code that Nubra rejects as "incorrect TOTP",
// sending you chasing a phantom bug. Authenticator secrets decode to >=10 bytes.
export function validateTOTPSecret(secret) {
  const key = decodeTOTPSecret(secret);
  if (key.length < 10) {
    throw new Error(
      'Nubra TOTP secret looks too short to be an authenticator secret — paste ' +
        'the TOTP secret from Nubra, not the API secret or MPIN',
    );
  }
}

// generateTOTP returns the current 6-digit code for the secret. `atMs` lets the
// caller anchor to Nubra's server clock (see nubra.js serverTimeMs) instead of a
// possibly-skewed local clock; defaults to now.
export function generateTOTP(secret, atMs = Date.now()) {
  const key = decodeTOTPSecret(secret);
  const counter = Math.floor(atMs / 1000 / 30);

  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter. TOTP counters stay well within 2^53, so we can
  // split into two 32-bit halves without BigInt.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const mac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

const WINDOW_MS = 30_000;

// nearWindowEdge reports whether the given time sits in the last few seconds of
// its 30s TOTP window — the only zone where a same-window round-trip is likely
// to expire before Nubra checks it.
export function nearWindowEdge(atMs, edgeMs = 3_000) {
  const into = atMs % WINDOW_MS;
  return WINDOW_MS - into <= edgeMs;
}

// msUntilNextWindow returns how long to wait so the next code has a fresh full
// lifetime. Used to retry once when the first code expired at a window edge.
export function msUntilNextWindow(atMs) {
  return WINDOW_MS - (atMs % WINDOW_MS) + 250;
}
