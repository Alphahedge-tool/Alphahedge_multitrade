// Package upstox is the Upstox v2 client: OAuth 2.0 authorization-code login
// (with all-day token reuse), plus the profile/funds calls used to validate a
// session. It mirrors the angel package's shape so the HTTP surface stays
// consistent, but Upstox has no headless login — the user logs in once per day
// through the browser and the resulting access_token is reused until it expires.
package upstox

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"angelone-backend/internal/config"
)

// Client is a connection-pooling Upstox v2 HTTP client. One Client is shared
// across the server; it is safe for concurrent use. Sessions are held in-memory
// keyed by user_id so a token obtained once is reused for the rest of the day.
type Client struct {
	http     *http.Client
	cfg      config.Config
	sessions *sessionStore
	pending  *pendingStore
}

// NewClient builds the shared Upstox client with a pooling transport, matching
// the tuning used for the Angel client (warm keep-alive connections to one host).
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
		pending:  newPendingStore(),
	}
}

// doForm POSTs an application/x-www-form-urlencoded body (the OAuth token
// exchange) and decodes the JSON response.
func (c *Client) doForm(ctx context.Context, endpoint string, form url.Values) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	return c.do(req)
}

// doGet performs a bearer-authenticated GET (profile, funds-and-margin).
func (c *Client) doGet(ctx context.Context, endpoint, accessToken string) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+accessToken)
	return c.do(req)
}

// do runs the request and decodes the JSON envelope, surfacing Upstox's error
// shape ({"status":"error","errors":[{"message":...}]}) as a Go error.
func (c *Client) do(req *http.Request) (map[string]any, error) {
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out) // tolerate non-JSON error bodies
	}
	if out == nil {
		out = map[string]any{}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return out, fmt.Errorf("%s", upstoxError(out, resp.StatusCode))
	}
	return out, nil
}

// upstoxError pulls the best human message out of an Upstox error envelope.
func upstoxError(out map[string]any, status int) string {
	if errs, ok := out["errors"].([]any); ok && len(errs) > 0 {
		if first, ok := errs[0].(map[string]any); ok {
			if msg, _ := first["message"].(string); msg != "" {
				if code, _ := first["error_code"].(string); code != "" {
					return fmt.Sprintf("%s (%s)", msg, code)
				}
				return msg
			}
		}
	}
	if msg, _ := out["message"].(string); msg != "" {
		return msg
	}
	return fmt.Sprintf("Upstox HTTP %d", status)
}
