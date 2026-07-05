package nubra

import (
	"context"
	"fmt"
	"time"
)

// TOTPSetupCreds are used for the one-time Nubra TOTP enrollment flow. The
// session token must come from a first-time/manual Nubra login, before TOTP is
// enabled for the account.
type TOTPSetupCreds struct {
	SessionToken string `json:"sessionToken"`
	DeviceID     string `json:"deviceId"`
	MPIN         string `json:"mpin"`
	PIN          string `json:"pin"`
	TOTP         string `json:"totp"`
	Phone        string `json:"phone"`
	ClientCode   string `json:"clientCode"`
}

// SetupTOTP runs Nubra's documented one-time setup:
// GET /totp/generate-secret -> POST /totp/enable.
//
// It returns the generated secret_key so callers can store it as totpSecret for
// future fully-headless /totp/login calls.
func (c *Client) SetupTOTP(ctx context.Context, cr TOTPSetupCreds) (map[string]any, error) {
	if cr.MPIN == "" {
		cr.MPIN = cr.PIN
	}
	if cr.DeviceID == "" {
		cr.DeviceID = defaultDeviceID(Creds{Phone: cr.Phone, ClientCode: cr.ClientCode})
	}
	if cr.SessionToken == "" || cr.MPIN == "" || cr.DeviceID == "" {
		return nil, fmt.Errorf("Nubra TOTP setup needs session token, MPIN and device ID")
	}

	generated, err := c.GenerateTOTPSecret(ctx, cr)
	if err != nil {
		return nil, err
	}
	secret := secretFromGenerateResponse(generated)
	if secret == "" {
		return nil, fmt.Errorf("Nubra TOTP setup returned no secret_key")
	}
	if err := validateTOTPSecret(secret); err != nil {
		return nil, err
	}

	enabled, err := c.enableGeneratedTOTP(ctx, cr, secret)
	if err != nil {
		return nil, err
	}

	return map[string]any{
		"status":     true,
		"broker":     "nubra",
		"deviceId":   cr.DeviceID,
		"totpSecret": secret,
		"qrImage":    qrImageFromGenerateResponse(generated),
		"data": map[string]any{
			"generate": generated,
			"enable":   enabled,
		},
	}, nil
}

func (c *Client) enableGeneratedTOTP(ctx context.Context, cr TOTPSetupCreds, secret string) (map[string]any, error) {
	if cr.TOTP != "" {
		return c.EnableTOTP(ctx, cr, cr.TOTP)
	}

	const window = 30
	for attempt := 0; ; attempt++ {
		gen := c.serverTime(ctx)
		totp, err := generateTOTPAt(secret, gen)
		if err != nil {
			return nil, err
		}
		enabled, err := c.EnableTOTP(ctx, cr, totp)
		if err == nil {
			return enabled, nil
		}
		if attempt > 0 || !nearWindowEdge(gen, window*time.Second) {
			return enabled, hintTOTPError(err)
		}
		if err := sleepInto(ctx, gen, window*time.Second); err != nil {
			return enabled, err
		}
	}
}

func (c *Client) GenerateTOTPSecret(ctx context.Context, cr TOTPSetupCreds) (map[string]any, error) {
	if cr.DeviceID == "" {
		cr.DeviceID = defaultDeviceID(Creds{Phone: cr.Phone, ClientCode: cr.ClientCode})
	}
	if cr.SessionToken == "" || cr.DeviceID == "" {
		return nil, fmt.Errorf("Nubra TOTP secret generation needs session token and device ID")
	}
	return c.doJSON(ctx, "GET", "/totp/generate-secret", authHeaders(cr.DeviceID, cr.SessionToken), nil)
}

func (c *Client) EnableTOTP(ctx context.Context, cr TOTPSetupCreds, totp string) (map[string]any, error) {
	if cr.MPIN == "" {
		cr.MPIN = cr.PIN
	}
	if cr.DeviceID == "" {
		cr.DeviceID = defaultDeviceID(Creds{Phone: cr.Phone, ClientCode: cr.ClientCode})
	}
	if cr.SessionToken == "" || cr.MPIN == "" || cr.DeviceID == "" || totp == "" {
		return nil, fmt.Errorf("Nubra TOTP enable needs session token, MPIN, TOTP and device ID")
	}
	return c.doJSON(ctx, "POST", "/totp/enable", authHeaders(cr.DeviceID, cr.SessionToken), map[string]any{
		"mpin": cr.MPIN,
		"totp": totp,
	})
}

func secretFromGenerateResponse(res map[string]any) string {
	if res == nil {
		return ""
	}
	if s := strOr(res["secret_key"], ""); s != "" {
		return s
	}
	if data, _ := res["data"].(map[string]any); data != nil {
		return strOr(data["secret_key"], "")
	}
	return ""
}

func qrImageFromGenerateResponse(res map[string]any) string {
	if res == nil {
		return ""
	}
	if s := strOr(res["qr_image"], ""); s != "" {
		return s
	}
	if data, _ := res["data"].(map[string]any); data != nil {
		return strOr(data["qr_image"], "")
	}
	return ""
}
