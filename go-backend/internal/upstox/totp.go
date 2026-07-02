package upstox

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"strings"
	"time"
)

// generateTOTP produces the current 6-digit RFC-6238 TOTP (SHA-1, 30 s step)
// for a base32 secret — the same algorithm used for Angel, so the Upstox 2FA
// step (Upstox's #otpNum field) is filled with a code we generate ourselves,
// keeping the scripted login fully hands-free.
func generateTOTP(secret string) (string, error) {
	clean := strings.ToUpper(strings.ReplaceAll(secret, " ", ""))
	clean = strings.TrimRight(clean, "=")
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(clean)
	if err != nil {
		return "", fmt.Errorf("Invalid TOTP secret")
	}
	counter := uint64(time.Now().Unix() / 30)
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
