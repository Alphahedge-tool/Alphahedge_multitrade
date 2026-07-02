package upstox

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// AutoCreds carries the stored per-account credentials the Selenium script uses
// to auto-fill Upstox's login page. Upstox login is mobile → TOTP → PIN, so we
// need the registered phone, the 6-digit PIN, and the TOTP secret (we generate
// the code ourselves, making the flow fully hands-free). No password/DOB — those
// are not part of Upstox's login.
type AutoCreds struct {
	Phone      string
	PIN        string
	TOTPSecret string
	APIKey     string // Upstox app key (from the frontend row; env fallback)
	APISecret  string // Upstox app secret
}

// scriptResult is the JSON the Python helper prints on its last stdout line.
type scriptResult struct {
	Success bool   `json:"success"`
	Code    string `json:"code"`
	Error   string `json:"error"`
}

// AutoLoginSelenium runs the scripted-browser flow: it builds the OAuth URL,
// launches the Python/Selenium helper to auto-fill mobile → TOTP → PIN and
// capture the redirect ?code=, then exchanges that code for a token and stores
// the session.
//
// The TOTP code is generated here (from the stored secret) and passed in, so the
// login is fully hands-free — Upstox's second factor is satisfied without any
// SMS OTP to type, and the browser runs headless.
func (c *Client) AutoLoginSelenium(ctx context.Context, creds AutoCreds) (map[string]any, error) {
	if creds.Phone == "" || creds.PIN == "" || creds.TOTPSecret == "" {
		return nil, fmt.Errorf("Upstox auto-login needs phone, PIN and TOTP secret")
	}
	appCreds := AppCreds{APIKey: creds.APIKey, APISecret: creds.APISecret}
	// Mark this login's state as Selenium-owned: when the headless browser lands
	// on our /upstox/callback, the handler must NOT exchange the (single-use)
	// code — this method does the one exchange itself, below.
	state := fmt.Sprintf("selenium-%d", time.Now().UnixNano())
	c.pending.markSelenium(state)
	defer c.pending.take(state)
	loginURL, err := c.LoginURL(appCreds, state)
	if err != nil {
		return nil, err
	}
	totp, err := generateTOTP(creds.TOTPSecret)
	if err != nil {
		return nil, err
	}

	script, err := scriptPath()
	if err != nil {
		return nil, err
	}
	input, _ := json.Marshal(map[string]any{
		"authUrl":     loginURL,
		"redirectUri": c.cfg.UpstoxRedirectURI,
		"phone":       creds.Phone,
		"pin":         creds.PIN,
		"totp":        totp,
		"headless":    true, // fully automated: TOTP generated, no manual step
	})

	// Two minutes is ample for a headless 3-step form + redirect.
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	res, err := runLoginScript(runCtx, script, input)
	if err != nil {
		return nil, err
	}
	if !res.Success || res.Code == "" {
		msg := res.Error
		if msg == "" {
			msg = "Upstox auto-login did not return an authorization code"
		}
		return nil, fmt.Errorf("%s", msg)
	}

	sess, err := c.ExchangeCode(ctx, res.Code, appCreds)
	if err != nil {
		return nil, err
	}
	funds, fundsErr := c.getFunds(ctx, sess.AccessToken)
	return buildLoginResponse(sess, funds, "auto-login", fundsErr), nil
}

// runLoginScript executes the Python helper and parses the LAST JSON line from
// its stdout (diagnostics go to stderr, so we scan for the result object).
func runLoginScript(ctx context.Context, script string, input []byte) (*scriptResult, error) {
	cmd := exec.CommandContext(ctx, pythonExe(), script, string(input))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = os.Stderr // stream Selenium diagnostics to the server log
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("could not start python (%s): %w", pythonExe(), err)
	}

	var last *scriptResult
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || line[0] != '{' {
			continue
		}
		var r scriptResult
		if json.Unmarshal([]byte(line), &r) == nil {
			r := r
			last = &r
		}
	}
	waitErr := cmd.Wait()
	if last != nil {
		return last, nil
	}
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("Upstox auto-login timed out")
	}
	if waitErr != nil {
		return nil, fmt.Errorf("Upstox login helper failed: %w", waitErr)
	}
	return nil, fmt.Errorf("Upstox login helper produced no result")
}

// scriptPath resolves the Selenium helper relative to the backend working dir
// (main runs from go-backend/), with a fallback to an env override.
func scriptPath() (string, error) {
	if p := os.Getenv("UPSTOX_LOGIN_SCRIPT"); p != "" {
		return p, nil
	}
	candidates := []string{
		filepath.Join("scripts", "upstox_login.py"),
		filepath.Join("go-backend", "scripts", "upstox_login.py"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			abs, _ := filepath.Abs(p)
			return abs, nil
		}
	}
	return "", fmt.Errorf("upstox_login.py not found (set UPSTOX_LOGIN_SCRIPT)")
}

// pythonExe picks the Python interpreter (override with UPSTOX_PYTHON; defaults
// to "python", which is the launcher on Windows).
func pythonExe() string {
	if p := os.Getenv("UPSTOX_PYTHON"); p != "" {
		return p
	}
	return "python"
}
