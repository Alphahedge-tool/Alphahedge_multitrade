package nubra

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Creds are the Nubra account credentials sent from the frontend/Supabase row.
// phone + TOTP secret + MPIN allows a fully automated login with no SMS/browser.
type Creds struct {
	Phone      string `json:"phone"`
	MPIN       string `json:"mpin"`
	PIN        string `json:"pin"`
	TOTPSecret string `json:"totpSecret"`
	APISecret  string `json:"apiSecret"`
	TOTP       string `json:"totp"`
	DeviceID   string `json:"deviceId"`
	ClientCode string `json:"clientCode"`
}

func (c *Client) AutoLogin(ctx context.Context, cr Creds) (map[string]any, error) {
	if cr.MPIN == "" {
		cr.MPIN = cr.PIN
	}
	if cr.DeviceID == "" {
		cr.DeviceID = defaultDeviceID(cr)
	}
	if cr.Phone == "" || cr.MPIN == "" || cr.TOTPSecret == "" || cr.DeviceID == "" {
		return nil, fmt.Errorf("Nubra login needs phone, MPIN, TOTP secret and device ID")
	}
	// Reject a secret that can't be a Nubra TOTP secret up front. The row has both
	// an API-secret and a TOTP-secret box, and an API key like "AQDK44U4" is
	// accidentally valid base32 — it would decode and produce a plausible-looking
	// code that Nubra rejects as "incorrect TOTP", sending the user chasing a
	// phantom bug. Fail here with a message that points at the real cause.
	if cr.TOTP == "" {
		if err := validateTOTPSecret(cr.TOTPSecret); err != nil {
			return nil, err
		}
	}

	key := sessionKey(cr)
	if sess := c.sessions.get(key); sess != nil && sess.SessionToken != "" {
		c.sessions.touch(key)
		return buildLoginResponse(sess, "session", nil, nil), nil
	}

	sess, loginData, err := c.login(ctx, cr)
	if err != nil {
		return nil, err
	}
	c.sessions.save(key, sess)

	funds, fundsErr := c.getFunds(ctx, sess)
	return buildLoginResponse(sess, "totp-login", loginData, fundsOrError(funds, fundsErr)), nil
}

func (c *Client) login(ctx context.Context, cr Creds) (*Session, map[string]any, error) {
	loginRes, err := c.totpLogin(ctx, cr)
	if err != nil {
		return nil, loginRes, err
	}
	authToken := strOr(loginRes["auth_token"], "")
	if authToken == "" {
		return nil, loginRes, fmt.Errorf("Nubra TOTP login returned no auth_token")
	}

	pinRes, err := c.doJSON(ctx, "POST", "/verifypin", authHeaders(cr.DeviceID, authToken), map[string]any{
		"pin": cr.MPIN,
	})
	if err != nil {
		return nil, pinRes, err
	}
	sessionToken := strOr(pinRes["session_token"], "")
	if sessionToken == "" {
		return nil, pinRes, fmt.Errorf("Nubra MPIN verification returned no session_token")
	}

	now := time.Now().UTC().Format(time.RFC3339)
	return &Session{
		SessionToken: sessionToken,
		Phone:        strOr(pinRes["phone"], cr.Phone),
		UserID:       pinRes["userId"],
		ClientCode:   cr.ClientCode,
		DeviceID:     cr.DeviceID,
		LoginAt:      now,
		LastUsedAt:   now,
	}, pinRes, nil
}

// totpLogin performs POST /totp/login. Nubra decodes `totp` as a uint32, so a
// generated code like "012345" is sent as the integer 12345 and the server
// zero-pads it back before checking — no client-side leading-zero handling is
// needed.
//
// A TOTP is only valid for its 30s window. When we generate a code late in a
// window, the round-trip can land after it rolls over and the server rejects it.
// To make auto-login reliable we retry once: if the first attempt fails right at
// a window boundary, we wait for the next window to open and generate a fresh
// code. A caller-supplied one-time code (cr.TOTP) is used as-is with no retry.
func (c *Client) totpLogin(ctx context.Context, cr Creds) (map[string]any, error) {
	if manual := strings.TrimSpace(cr.TOTP); manual != "" {
		return c.postTOTP(ctx, cr, manual)
	}

	const window = 30 * time.Second
	for attempt := 0; ; attempt++ {
		gen := c.serverTime(ctx)
		totp, err := generateTOTPAt(cr.TOTPSecret, gen)
		if err != nil {
			return nil, err
		}
		res, err := c.postTOTP(ctx, cr, totp)
		if err == nil {
			return res, nil
		}
		// Only retry the one failure this guards against: the code expiring at a
		// window edge. One retry is enough; bail on anything else (bad phone,
		// bad secret, network) so we surface the real error immediately.
		if attempt > 0 || !nearWindowEdge(gen, window) {
			return res, hintTOTPError(err)
		}
		if err := sleepInto(ctx, gen, window); err != nil {
			return res, err
		}
	}
}

// hintTOTPError adds actionable context when Nubra rejects the generated code.
// Our generator is byte-for-byte identical to pyotp (which Nubra's SDK uses), so
// a rejected code almost always means the stored secret is wrong or this host's
// clock is off by more than a window — not a generation bug.
func hintTOTPError(err error) error {
	if err == nil {
		return nil
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "totp") || strings.Contains(msg, "otp") || strings.Contains(msg, "invalid") {
		return fmt.Errorf("%w — verify the TOTP secret matches the one enabled on this Nubra account and that the server clock is accurate", err)
	}
	return err
}

func (c *Client) postTOTP(ctx context.Context, cr Creds, totp string) (map[string]any, error) {
	totpNum, err := strconv.ParseUint(totp, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("Nubra TOTP must be a 6-digit number")
	}
	return c.doJSON(ctx, "POST", "/totp/login", authHeaders(cr.DeviceID, ""), map[string]any{
		"phone": cr.Phone,
		"totp":  uint32(totpNum),
		"otp":   "",
	})
}

// nearWindowEdge reports whether t sits in the last few seconds of its 30s TOTP
// window — the only zone where a same-window round-trip is likely to expire.
func nearWindowEdge(t time.Time, window time.Duration) bool {
	into := time.Duration(t.Unix()%int64(window.Seconds())) * time.Second
	return window-into <= 3*time.Second
}

// sleepInto blocks until just past the start of the window after t's, so the
// retry generates a code with a fresh full lifetime. Honors ctx cancellation.
func sleepInto(ctx context.Context, t time.Time, window time.Duration) error {
	into := time.Duration(t.Unix()%int64(window.Seconds())) * time.Second
	wait := window - into + 250*time.Millisecond
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (c *Client) getFunds(ctx context.Context, sess *Session) (map[string]any, error) {
	if sess == nil || sess.SessionToken == "" {
		return nil, fmt.Errorf("Nubra session unavailable for funds")
	}
	return c.doJSON(ctx, "GET", "/sentinel/portfolio/user_funds_and_margin", authHeaders(sess.DeviceID, sess.SessionToken), nil)
}

func buildLoginResponse(sess *Session, source string, loginData map[string]any, funds map[string]any) map[string]any {
	margin, marginSource := pickMargin(funds)
	if marginSource == "" {
		marginSource = "n/a"
	}
	data := map[string]any{}
	if loginData != nil {
		data["login"] = loginData
	}
	if funds != nil {
		data["funds"] = funds
	}
	return map[string]any{
		"status":          true,
		"broker":          "nubra",
		"clientCode":      sess.ClientCode,
		"availableMargin": margin,
		"marginSource":    marginSource,
		"sessionSource":   source,
		"session":         sess,
		"data":            data,
	}
}

func pickMargin(funds map[string]any) (float64, string) {
	if funds == nil {
		return 0, ""
	}
	pfm, _ := funds["port_funds_and_margin"].(map[string]any)
	for _, key := range []string{"net_margin_available", "available_balance", "total_balance"} {
		if v, ok := numberOf(pfm[key]); ok {
			return v, key
		}
	}
	return 0, ""
}

func fundsOrError(funds map[string]any, err error) map[string]any {
	if err == nil {
		return funds
	}
	return map[string]any{"fundsAvailable": false, "message": err.Error()}
}

func sessionKey(cr Creds) string {
	if cr.ClientCode != "" {
		return cr.ClientCode
	}
	return cr.Phone
}

func defaultDeviceID(cr Creds) string {
	base := cr.ClientCode
	if base == "" {
		base = cr.Phone
	}
	base = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, base)
	if base == "" {
		base = "device"
	}
	return "alphahedge-" + base
}

func strOr(v any, fallback string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return fallback
}

func numberOf(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case jsonNumber:
		f, err := strconv.ParseFloat(string(n), 64)
		return f, err == nil
	default:
		return 0, false
	}
}

type jsonNumber string
