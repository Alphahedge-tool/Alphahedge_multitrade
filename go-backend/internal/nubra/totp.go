package nubra

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

func generateTOTP(secret string) (string, error) {
	return generateTOTPAt(secret, time.Now())
}

func generateTOTPAt(secret string, at time.Time) (string, error) {
	key, err := decodeTOTPSecret(secret)
	if err != nil {
		return "", err
	}
	counter := uint64(at.Unix() / 30)
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)

	mac := hmac.New(sha1.New, key)
	mac.Write(buf[:])
	sum := mac.Sum(nil)

	offset := sum[len(sum)-1] & 0x0f
	code := (uint32(sum[offset]&0x7f) << 24) |
		(uint32(sum[offset+1]&0xff) << 16) |
		(uint32(sum[offset+2]&0xff) << 8) |
		uint32(sum[offset+3]&0xff)
	return fmt.Sprintf("%06d", code%1_000_000), nil
}

// decodeTOTPSecret turns a TOTP secret string into the HMAC key exactly the way
// pyotp does — Nubra's own SDK computes codes with `pyotp.TOTP(secret).now()`, so
// mirroring pyotp.OTP.byte_secret() keeps our codes byte-for-byte identical to
// what Nubra's server expects.
//
// pyotp.byte_secret does:  pad the secret to a multiple of 8 with '=', then
// base64.b32decode(secret, casefold=True)  (casefold makes it case-insensitive).
// We add two conveniences pyotp lacks so real-world input from the account row
// still works: strip an otpauth:// wrapper, and drop the spaces authenticator
// apps show in grouped secrets (pyotp would crash on those). For any secret
// pyotp accepts, the decoded bytes are the same.
func decodeTOTPSecret(secret string) ([]byte, error) {
	clean := extractTOTPSecret(secret)
	clean = strings.ReplaceAll(clean, " ", "")
	if clean == "" {
		return nil, fmt.Errorf("Nubra TOTP secret is empty")
	}
	// pyotp: casefold=True — accept lowercase by upper-casing before decode.
	clean = strings.ToUpper(clean)
	// pyotp: pad up to a multiple of 8 with '=', then b32decode (with padding).
	if missing := len(clean) % 8; missing != 0 {
		clean += strings.Repeat("=", 8-missing)
	}
	key, err := base32.StdEncoding.DecodeString(clean)
	if err != nil {
		return nil, fmt.Errorf("Nubra TOTP secret is not a valid base32 authenticator secret — paste the TOTP/authenticator secret from Nubra, not the API secret or MPIN")
	}
	return key, nil
}

// validateTOTPSecret checks a secret can actually produce a TOTP before we try
// to log in. An API key such as "AQDK44U4" is accidentally valid base32 and
// would silently yield a wrong code that Nubra rejects as "incorrect TOTP", so
// we also require the decoded key to be long enough to be a real TOTP seed
// (authenticator secrets are ≥16 base32 chars → ≥10 bytes; RFC 4226 mandates a
// shared secret of at least 128 bits / 16 bytes for new deployments, but we keep
// the floor at 10 bytes to avoid rejecting shorter legitimate seeds).
func validateTOTPSecret(secret string) error {
	key, err := decodeTOTPSecret(secret)
	if err != nil {
		return err
	}
	if len(key) < 10 {
		return fmt.Errorf("Nubra TOTP secret looks too short to be an authenticator secret — paste the TOTP secret from Nubra, not the API secret or MPIN")
	}
	return nil
}

func extractTOTPSecret(secret string) string {
	raw := strings.TrimSpace(secret)
	if !strings.HasPrefix(strings.ToLower(raw), "otpauth://") {
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if s := u.Query().Get("secret"); s != "" {
		return s
	}
	return raw
}
