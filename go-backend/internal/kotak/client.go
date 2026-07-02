// Package kotak is the Kotak Securities NEO Trade API (V3) client. It implements
// the fully-headless "Login with TOTP" flow: we store the user's TOTP secret and
// generate the 6-digit code ourselves each login, so no browser or SMS OTP is
// involved — same model as the Angel package.
//
// Flow (two server-side calls):
//  1. tradeApiLogin    {mobileNumber, ucc, totp}          → View token + sid
//  2. tradeApiValidate {mpin} (+ sid/Auth headers)        → Trade token + baseUrl
//
// The Trade token (kType="Trade") is the session credential used as the "Auth"
// header for all subsequent trading APIs.
package kotak

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"angelone-backend/internal/config"
)

const (
	// LoginURL validates mobile + UCC + TOTP → View token.
	loginURL = "https://mis.kotaksecurities.com/login/1.0/tradeApiLogin"
	// ValidateURL exchanges MPIN (+ View token) → Trade token.
	validateURL = "https://mis.kotaksecurities.com/login/1.0/tradeApiValidate"
	// neoFinKey is the fixed header value Kotak requires on both login calls.
	neoFinKey = "neotradeapi"
)

// Client is a connection-pooling Kotak NEO client, shared across the server and
// safe for concurrent use. Sessions are kept in-memory keyed by UCC so a token
// obtained once is reused for the rest of the trading day.
type Client struct {
	http     *http.Client
	cfg      config.Config
	sessions *sessionStore
}

// NewClient builds the shared client with a pooling transport (same tuning as
// the Angel/Upstox clients).
func NewClient(cfg config.Config) *Client {
	transport := &http.Transport{
		MaxIdleConns:        50,
		MaxIdleConnsPerHost: 50,
		IdleConnTimeout:     90 * time.Second,
		ForceAttemptHTTP2:   true,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   5 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	return &Client{
		http: &http.Client{
			Transport: transport,
			Timeout:   15 * time.Second,
		},
		cfg:      cfg,
		sessions: newSessionStore(),
	}
}

// doJSON POSTs a JSON body with the given headers and decodes the response
// envelope, surfacing Kotak's {status:"error", message, errorCode} shape.
func (c *Client) doJSON(ctx context.Context, url string, headers map[string]string, body any) (map[string]any, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("neo-fin-key", neoFinKey)
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Kotak request failed: %w", err)
	}
	defer resp.Body.Close()

	rawResp, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if len(rawResp) > 0 {
		_ = json.Unmarshal(rawResp, &out) // tolerate non-JSON error bodies
	}
	if out == nil {
		out = map[string]any{}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || kotakIsError(out) {
		return out, fmt.Errorf("%s", kotakError(out, resp.StatusCode))
	}
	return out, nil
}

// kotakIsError reports a top-level {"status":"error"} envelope (Kotak can return
// HTTP 200 with an error status).
func kotakIsError(out map[string]any) bool {
	s, _ := out["status"].(string)
	return s == "error"
}

// kotakError builds the best human message from Kotak's error envelope.
func kotakError(out map[string]any, status int) string {
	if msg, _ := out["message"].(string); msg != "" {
		if code, _ := out["errorCode"].(string); code != "" {
			return fmt.Sprintf("%s (%s)", msg, code)
		}
		return msg
	}
	// Some errors nest under data.
	if data, ok := out["data"].(map[string]any); ok {
		if msg, _ := data["errMsg"].(string); msg != "" {
			return msg
		}
	}
	return fmt.Sprintf("Kotak HTTP %d", status)
}
