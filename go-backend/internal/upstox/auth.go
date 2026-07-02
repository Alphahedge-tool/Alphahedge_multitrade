package upstox

import (
	"context"
	"fmt"
	"net/url"
	"time"

	"angelone-backend/internal/config"
)

// AppCreds are the per-account Upstox app credentials sent from the frontend
// account row — the same model as Angel, where the frontend supplies apiKey etc.
// on every request rather than the backend reading them from the environment.
// Empty fields fall back to the UPSTOX_* env vars, so either style works.
type AppCreds struct {
	APIKey    string
	APISecret string
}

// apiKey / apiSecret resolve the effective credential: the frontend-supplied
// value first, then the env-var fallback.
func (c *Client) apiKey(cr AppCreds) string {
	if cr.APIKey != "" {
		return cr.APIKey
	}
	return c.cfg.UpstoxAPIKey
}

func (c *Client) apiSecret(cr AppCreds) string {
	if cr.APISecret != "" {
		return cr.APISecret
	}
	return c.cfg.UpstoxAPISecret
}

// LoginURL builds the Upstox OAuth 2.0 authorization URL the user opens in the
// browser to log in. `state` is echoed back on the redirect so the frontend can
// correlate the callback with the request it started. The client_id comes from
// the passed creds (frontend account row) or the env fallback.
func (c *Client) LoginURL(cr AppCreds, state string) (string, error) {
	key := c.apiKey(cr)
	if key == "" {
		return "", fmt.Errorf("Upstox API key is missing")
	}
	if c.cfg.UpstoxRedirectURI == "" {
		return "", fmt.Errorf("UPSTOX_REDIRECT_URI is not set")
	}
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", key)
	q.Set("redirect_uri", c.cfg.UpstoxRedirectURI)
	if state != "" {
		q.Set("state", state)
	}
	return config.UpstoxAuthDialog + "?" + q.Encode(), nil
}

// ExchangeCode swaps the one-time authorization code (from the redirect) for an
// access token, then validates it with a profile call and stores the session
// for all-day reuse. Credentials come from the passed creds or the env fallback.
func (c *Client) ExchangeCode(ctx context.Context, code string, cr AppCreds) (*Session, error) {
	if code == "" {
		return nil, fmt.Errorf("missing authorization code")
	}
	key, secret := c.apiKey(cr), c.apiSecret(cr)
	if key == "" || secret == "" {
		return nil, fmt.Errorf("Upstox API key / secret are missing")
	}

	form := url.Values{}
	form.Set("code", code)
	form.Set("client_id", key)
	form.Set("client_secret", secret)
	form.Set("redirect_uri", c.cfg.UpstoxRedirectURI)
	form.Set("grant_type", "authorization_code")

	res, err := c.doForm(ctx, config.UpstoxTokenURL, form)
	if err != nil {
		return nil, err
	}
	token, _ := res["access_token"].(string)
	if token == "" {
		return nil, fmt.Errorf("Upstox token exchange returned no access_token")
	}

	now := time.Now().UTC().Format(time.RFC3339)
	sess := &Session{
		AccessToken: token,
		// The token response carries user_id/email; fill from it when present,
		// then let the profile call below authoritatively confirm identity.
		UserID:   strOr(res["user_id"], ""),
		Email:    strOr(res["email"], ""),
		UserName: strOr(res["user_name"], ""),
		Broker:   strOr(res["broker"], "UPSTOX"),
		LoginAt:  now,
	}

	// Confirm the token actually works and resolve the canonical user_id.
	if err := c.fillProfile(ctx, sess); err != nil {
		return nil, err
	}
	sess.LastUsedAt = now
	c.sessions.save(sess)
	return sess, nil
}

// AutoLogin returns a usable session for the given user_id, reusing a stored
// token if it still validates. If there's no live session it returns a
// NeedsLogin error carrying the browser login URL — the frontend opens that,
// the user approves once, and the callback finishes the login. This mirrors
// Angel's AutoLogin "reuse-or-fresh" contract, adapted to OAuth's browser step.
//
// `cr` are the account's app credentials (from the frontend row). We remember
// them keyed by `state` so the callback — a plain browser redirect with no body
// — can exchange the code using the right key/secret.
func (c *Client) AutoLogin(ctx context.Context, userID, state string, cr AppCreds) (map[string]any, error) {
	if sess := c.sessions.get(userID); sess != nil {
		if err := c.fillProfile(ctx, sess); err == nil {
			c.sessions.touch(userID)
			funds, fundsErr := c.getFunds(ctx, sess.AccessToken)
			return buildLoginResponse(sess, funds, "session", fundsErr), nil
		}
		// Token no longer valid (new day / revoked) — drop it and fall through.
		c.sessions.drop(userID)
	}
	loginURL, err := c.LoginURL(cr, state)
	if err != nil {
		return nil, err
	}
	if state != "" {
		c.pending.put(state, cr)
	}
	return nil, &NeedsLogin{LoginURL: loginURL}
}

// CredsForState returns the app creds remembered for a login state (used by the
// callback), consuming the entry. Falls back to empty (env) creds if unknown.
func (c *Client) CredsForState(state string) AppCreds {
	return c.pending.take(state)
}

// IsSeleniumState reports that this callback belongs to the headless auto-login
// flow, so the callback handler must NOT exchange the single-use code (the
// AutoLoginSelenium call already does that).
func (c *Client) IsSeleniumState(state string) bool {
	return c.pending.isSelenium(state)
}

// fillProfile calls /user/profile to confirm the token and populate identity
// fields on the session.
func (c *Client) fillProfile(ctx context.Context, sess *Session) error {
	res, err := c.doGet(ctx, config.UpstoxBase+"/user/profile", sess.AccessToken)
	if err != nil {
		return err
	}
	data, _ := res["data"].(map[string]any)
	if data == nil {
		return fmt.Errorf("Upstox profile returned no data")
	}
	if v := strOr(data["user_id"], ""); v != "" {
		sess.UserID = v
	}
	if v := strOr(data["user_name"], ""); v != "" {
		sess.UserName = v
	}
	if v := strOr(data["email"], ""); v != "" {
		sess.Email = v
	}
	if v := strOr(data["broker"], ""); v != "" {
		sess.Broker = v
	}
	if sess.UserID == "" {
		return fmt.Errorf("Upstox profile returned no user_id")
	}
	return nil
}

// getFunds calls /user/get-funds-and-margin for available margin. Upstox closes
// this service outside its daily funds window, so token validity is checked with
// /user/profile instead.
func (c *Client) getFunds(ctx context.Context, accessToken string) (map[string]any, error) {
	res, err := c.doGet(ctx, config.UpstoxBase+"/user/get-funds-and-margin", accessToken)
	if err != nil {
		return nil, err
	}
	data, _ := res["data"].(map[string]any)
	if data == nil {
		return nil, fmt.Errorf("Upstox funds returned no data")
	}
	return data, nil
}

// buildLoginResponse shapes the auto-login result the frontend consumes,
// deliberately parallel to Angel's buildRMSResponse (status/availableMargin/
// session/data) so the UI can treat both brokers uniformly.
func buildLoginResponse(sess *Session, funds map[string]any, source string, fundsErr error) map[string]any {
	if funds == nil {
		funds = map[string]any{}
	}
	margin, marginSrc := pickUpstoxMargin(funds)
	out := map[string]any{
		"status":          true,
		"broker":          "upstox",
		"clientCode":      sess.UserID,
		"availableMargin": margin,
		"marginSource":    marginSrc,
		"sessionSource":   source,
		"session":         sess,
		"data":            funds,
	}
	if fundsErr != nil {
		out["fundsAvailable"] = false
		out["fundsMessage"] = fundsErr.Error()
		out["marginSource"] = "funds-unavailable"
	} else {
		out["fundsAvailable"] = true
	}
	return out
}

// pickUpstoxMargin extracts available margin, preferring equity then commodity.
func pickUpstoxMargin(funds map[string]any) (float64, string) {
	for _, seg := range []string{"equity", "commodity"} {
		if segMap, ok := funds[seg].(map[string]any); ok {
			if v, ok := segMap["available_margin"]; ok && v != nil {
				return toFloat(v), seg + ".available_margin"
			}
		}
	}
	return 0, "unknown"
}
