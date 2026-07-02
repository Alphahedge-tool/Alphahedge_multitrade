// Package supastore is a tiny Supabase (PostgREST) client for the
// broker_accounts table. It reads/writes the account rows the frontend table
// shows, using the service-role key server-side so secrets never depend on the
// browser. It is optional: when Supabase isn't configured, callers skip it and
// the app uses local IndexedDB storage.
package supastore

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	neturl "net/url"
	"time"

	"angelone-backend/internal/config"
)

// Account is one broker account row. JSON tags use the frontend's camelCase so
// it maps straight onto the React `client` shape; the `db` conversions handle
// the snake_case Postgres columns.
type Account struct {
	Position      int    `json:"position"`
	Enabled       bool   `json:"enabled"`
	Alias         string `json:"alias"`
	ClientCode    string `json:"clientCode"`
	Broker        string `json:"broker"`
	MarketOrders  string `json:"marketOrders"`
	APIKey        string `json:"apiKey"`
	APISecret     string `json:"apiSecret"`
	TOTPSecret    string `json:"totpSecret"`
	PIN           string `json:"pin"`
	Phone         string `json:"phone"`
	AutoLogin     bool   `json:"autoLogin"`
	HistoricalAPI bool   `json:"historicalApi"`
	SqoffTime     string `json:"sqoffTime"`
}

// dbRow is the snake_case shape PostgREST returns / accepts.
type dbRow struct {
	Position      int    `json:"position"`
	Enabled       bool   `json:"enabled"`
	Alias         string `json:"alias"`
	ClientCode    string `json:"client_code"`
	Broker        string `json:"broker"`
	MarketOrders  string `json:"market_orders"`
	APIKey        string `json:"api_key"`
	APISecret     string `json:"api_secret"`
	TOTPSecret    string `json:"totp_secret"`
	PIN           string `json:"pin"`
	Phone         string `json:"phone"`
	AutoLogin     bool   `json:"auto_login"`
	HistoricalAPI bool   `json:"historical_api"`
	SqoffTime     string `json:"sqoff_time"`
}

func (r dbRow) toAccount() Account {
	return Account{
		Position: r.Position, Enabled: r.Enabled, Alias: r.Alias,
		ClientCode: r.ClientCode, Broker: r.Broker, MarketOrders: r.MarketOrders,
		APIKey: r.APIKey, APISecret: r.APISecret, TOTPSecret: r.TOTPSecret,
		PIN: r.PIN, Phone: r.Phone, AutoLogin: r.AutoLogin,
		HistoricalAPI: r.HistoricalAPI, SqoffTime: r.SqoffTime,
	}
}

func fromAccount(a Account, pos int) dbRow {
	return dbRow{
		Position: pos, Enabled: a.Enabled, Alias: a.Alias,
		ClientCode: a.ClientCode, Broker: a.Broker, MarketOrders: a.MarketOrders,
		APIKey: a.APIKey, APISecret: a.APISecret, TOTPSecret: a.TOTPSecret,
		PIN: a.PIN, Phone: a.Phone, AutoLogin: a.AutoLogin,
		HistoricalAPI: a.HistoricalAPI, SqoffTime: a.SqoffTime,
	}
}

// Client is the Supabase REST client for broker_accounts.
type Client struct {
	http    *http.Client
	baseURL string // e.g. https://xxx.supabase.co/rest/v1
	key     string // service-role key
}

// New returns a Supabase client, or nil when Supabase isn't configured.
func New(cfg config.Config) *Client {
	if !cfg.SupabaseEnabled() {
		return nil
	}
	return &Client{
		http:    &http.Client{Timeout: 15 * time.Second},
		baseURL: cfg.SupabaseURL + "/rest/v1",
		key:     cfg.SupabaseServiceKey,
	}
}

func (c *Client) headers(req *http.Request) {
	req.Header.Set("apikey", c.key)
	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
}

// List returns accounts ordered by position. When broker is non-empty it
// returns only that broker's rows (e.g. "Kotak"), so accounts can be loaded
// grouped by broker tag; empty broker returns every account.
func (c *Client) List(ctx context.Context, broker string) ([]Account, error) {
	url := c.baseURL + "/broker_accounts?select=*&order=position.asc"
	if broker != "" {
		url += "&broker=eq." + neturl.QueryEscape(broker)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	c.headers(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("supabase list failed (%d): %s", resp.StatusCode, string(body))
	}
	var rows []dbRow
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	out := make([]Account, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.toAccount())
	}
	return out, nil
}

// Replace overwrites stored accounts with the given set (delete then insert), so
// the stored set mirrors the frontend table. Positions come from slice order.
//
// When broker is non-empty, ONLY that broker's rows are replaced — other
// brokers' rows are left untouched — so you can save one broker's accounts
// independently. Empty broker replaces the whole table.
func (c *Client) Replace(ctx context.Context, accounts []Account, broker string) error {
	// 1) Delete existing rows. PostgREST needs a filter; position>=0 matches all.
	delURL := c.baseURL + "/broker_accounts?position=gte.0"
	if broker != "" {
		delURL += "&broker=eq." + neturl.QueryEscape(broker)
	}
	delReq, err := http.NewRequestWithContext(ctx, http.MethodDelete, delURL, nil)
	if err != nil {
		return err
	}
	c.headers(delReq)
	delResp, err := c.http.Do(delReq)
	if err != nil {
		return err
	}
	delBody, _ := io.ReadAll(delResp.Body)
	delResp.Body.Close()
	if delResp.StatusCode < 200 || delResp.StatusCode >= 300 {
		return fmt.Errorf("supabase clear failed (%d): %s", delResp.StatusCode, string(delBody))
	}

	if len(accounts) == 0 {
		return nil
	}

	// 2) Insert the new set.
	rows := make([]dbRow, 0, len(accounts))
	for i, a := range accounts {
		rows = append(rows, fromAccount(a, i))
	}
	payload, _ := json.Marshal(rows)
	insReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/broker_accounts", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	c.headers(insReq)
	insReq.Header.Set("Prefer", "return=minimal")
	insResp, err := c.http.Do(insReq)
	if err != nil {
		return err
	}
	insBody, _ := io.ReadAll(insResp.Body)
	insResp.Body.Close()
	if insResp.StatusCode < 200 || insResp.StatusCode >= 300 {
		return fmt.Errorf("supabase insert failed (%d): %s", insResp.StatusCode, string(insBody))
	}
	return nil
}
