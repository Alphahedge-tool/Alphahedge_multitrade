// Package nubra implements Nubra REST API login using the fully automated
// TOTP + MPIN flow documented for algo-trading use.
package nubra

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"angelone-backend/internal/config"
)

// Client is a connection-pooling Nubra REST client. Sessions are kept in-memory
// keyed by phone/client code and reused until backend restart.
type Client struct {
	http     *http.Client
	cfg      config.Config
	sessions *sessionStore
}

// serverTime reads Nubra's clock from the HTTP Date header so the generated
// TOTP is anchored to the server's 30s window, not this host's (possibly skewed)
// clock. It HEADs the API root — any status is fine, we only want the Date
// header — and falls back to local time on any failure so login never blocks on
// this probe.
func (c *Client) serverTime(ctx context.Context) time.Time {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, strings.TrimRight(c.cfg.NubraBaseURL, "/")+"/", nil)
	if err != nil {
		return time.Now()
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return time.Now()
	}
	defer resp.Body.Close()
	if date := resp.Header.Get("Date"); date != "" {
		if t, err := http.ParseTime(date); err == nil {
			return t
		}
	}
	return time.Now()
}

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
			Timeout:   20 * time.Second,
		},
		cfg:      cfg,
		sessions: newSessionStore(),
	}
}

func (c *Client) doJSON(ctx context.Context, method, path string, headers map[string]string, body any) (map[string]any, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.cfg.NubraBaseURL, "/")+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		if v != "" {
			req.Header.Set(k, v)
		}
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Nubra request failed: %w", err)
	}
	defer resp.Body.Close()

	rawResp, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if len(rawResp) > 0 {
		_ = json.Unmarshal(rawResp, &out)
	}
	if out == nil {
		out = map[string]any{}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return out, fmt.Errorf("%s", nubraError(out, resp.StatusCode))
	}
	return out, nil
}

// authHeaders builds the exact header set the Nubra V3 REST docs require:
// x-device-id on every call, and Authorization: Bearer <token> once a token
// exists. Earlier builds also sent guessed x-app-version / x-device-os / Cookie
// headers; those aren't in the docs and a stale app-version value can make the
// gateway reject an otherwise-valid login, so they're intentionally omitted.
func authHeaders(deviceID, token string) map[string]string {
	h := map[string]string{
		"x-device-id": deviceID,
	}
	if token != "" {
		h["Authorization"] = "Bearer " + token
	}
	return h
}

func nubraError(out map[string]any, status int) string {
	for _, key := range []string{"message", "error", "detail"} {
		if msg, _ := out[key].(string); msg != "" {
			return msg
		}
	}
	return fmt.Sprintf("Nubra HTTP %d", status)
}
