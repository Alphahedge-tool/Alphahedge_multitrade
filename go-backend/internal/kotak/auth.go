package kotak

import (
	"context"
	"fmt"
	"time"
)

// Creds are the per-account Kotak NEO credentials sent from the frontend row —
// same model as Angel/Upstox (the backend uses what the frontend provides).
//
//   AccessToken : the API access token from the NEO app (Invest → Trade API →
//                 Your Applications). Sent in the Authorization header.
//   MobileNumber: registered mobile WITH ISD, e.g. +91XXXXXXXXXX.
//   UCC         : Unique Client Code (client id).
//   MPIN        : 6-digit MPIN.
//   TOTPSecret  : the base32 secret from TOTP registration; we generate the code.
type Creds struct {
	AccessToken  string `json:"accessToken"`
	MobileNumber string `json:"mobileNumber"`
	UCC          string `json:"ucc"`
	MPIN         string `json:"mpin"`
	TOTPSecret   string `json:"totpSecret"`
}

// AutoLogin returns a usable session for the account, reusing a same-day Trade
// token when present, otherwise running the two-step headless TOTP login. The
// response shape mirrors Angel/Upstox so the frontend treats all brokers alike.
func (c *Client) AutoLogin(ctx context.Context, cr Creds) (map[string]any, error) {
	if cr.UCC == "" || cr.AccessToken == "" || cr.MobileNumber == "" || cr.MPIN == "" || cr.TOTPSecret == "" {
		return nil, fmt.Errorf("Kotak login needs accessToken, mobileNumber, UCC, MPIN and TOTP secret")
	}

	// Reuse a live same-day session if we have one. (Kotak has no cheap "ping"
	// endpoint here, so we optimistically reuse; a stale token surfaces on the
	// first real API call, which drops and re-logs in.)
	if sess := c.sessions.get(cr.UCC); sess != nil && sess.TradeToken != "" {
		c.sessions.touch(cr.UCC)
		return buildLoginResponse(sess, "session"), nil
	}

	sess, err := c.login(ctx, cr)
	if err != nil {
		return nil, err
	}
	c.sessions.save(sess)
	return buildLoginResponse(sess, "totp-login"), nil
}

// login runs the two Kotak calls: tradeApiLogin (→ View token) then
// tradeApiValidate (→ Trade token).
func (c *Client) login(ctx context.Context, cr Creds) (*Session, error) {
	totp, err := generateTOTP(cr.TOTPSecret)
	if err != nil {
		return nil, err
	}

	// ── Step 2 (docs): tradeApiLogin — mobile + UCC + TOTP → View token ──────
	loginRes, err := c.doJSON(ctx, loginURL, map[string]string{
		"Authorization": cr.AccessToken,
	}, map[string]any{
		"mobileNumber": cr.MobileNumber,
		"ucc":          cr.UCC,
		"totp":         totp,
	})
	if err != nil {
		return nil, err
	}
	loginData := dataOf(loginRes)
	viewToken := strOr(loginData["token"], "")
	viewSID := strOr(loginData["sid"], "")
	if viewToken == "" || viewSID == "" {
		return nil, fmt.Errorf("Kotak login returned no view token/sid")
	}

	// ── Step 3 (docs): tradeApiValidate — MPIN (+ view sid/token) → Trade token
	validateRes, err := c.doJSON(ctx, validateURL, map[string]string{
		"Authorization": cr.AccessToken,
		"sid":           viewSID,
		"Auth":          viewToken,
	}, map[string]any{
		"mpin": cr.MPIN,
	})
	if err != nil {
		return nil, err
	}
	td := dataOf(validateRes)
	tradeToken := strOr(td["token"], "")
	if tradeToken == "" {
		return nil, fmt.Errorf("Kotak MPIN validation returned no trade token")
	}

	now := time.Now().UTC().Format(time.RFC3339)
	return &Session{
		TradeToken: tradeToken,
		SID:        strOr(td["sid"], viewSID),
		RID:        strOr(td["rid"], ""),
		BaseURL:    strOr(td["baseUrl"], ""),
		UCC:        cr.UCC,
		Greeting:   strOr(td["greetingName"], ""),
		LoginAt:    now,
		LastUsedAt: now,
	}, nil
}

// Logout drops any stored session for the UCC.
func (c *Client) Logout(ucc string) {
	c.sessions.drop(ucc)
}

// buildLoginResponse shapes the auto-login result, parallel to Angel/Upstox
// (status/clientCode/session/data) so the UI can treat brokers uniformly. Kotak
// does not return margin on login, so availableMargin is 0 here.
func buildLoginResponse(sess *Session, source string) map[string]any {
	return map[string]any{
		"status":          true,
		"broker":          "kotak",
		"clientCode":      sess.UCC,
		"availableMargin": 0,
		"marginSource":    "n/a",
		"sessionSource":   source,
		"session":         sess,
		"data":            map[string]any{"baseUrl": sess.BaseURL, "greetingName": sess.Greeting},
	}
}

// dataOf returns the nested "data" object, or the top-level map if absent.
func dataOf(res map[string]any) map[string]any {
	if d, ok := res["data"].(map[string]any); ok {
		return d
	}
	return res
}

// strOr returns v as a non-empty string, or the fallback.
func strOr(v any, fallback string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return fallback
}
