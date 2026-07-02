// Package config centralizes runtime configuration and the fixed Angel SmartAPI
// constants. Values come from the environment (matching the Node server's env
// vars) with sane defaults so the server runs with zero configuration.
package config

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"time"
)

const (
	// SmartAPIBase is the REST root for all secured/auth calls.
	SmartAPIBase = "https://apiconnect.angelone.in"
	// SmartStreamURL is the SmartWebSocket V2 endpoint for the live feed.
	SmartStreamURL = "wss://smartapisocket.angelone.in/smart-stream"
	// MasterURL is Angel's full scrip-master (symbol→token) JSON (~8.8 MB).
	MasterURL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"

	// MasterTTL is how long the on-disk/in-memory scrip master stays fresh.
	MasterTTL = 24 * time.Hour
	// QuoteCacheTTL is the short window during which repeated identical quote
	// reads are served from cache instead of re-hitting Angel. This is the main
	// lever against the "same round-trip paid over and over" bottleneck.
	QuoteCacheTTL = 750 * time.Millisecond

	// UpstoxBase is the REST root for all Upstox v2 API calls.
	UpstoxBase = "https://api.upstox.com/v2"
	// UpstoxAuthDialog is the OAuth 2.0 authorization page the user logs in on.
	UpstoxAuthDialog = UpstoxBase + "/login/authorization/dialog"
	// UpstoxTokenURL is the OAuth token-exchange endpoint (code → access_token).
	UpstoxTokenURL = UpstoxBase + "/login/authorization/token"
)

// Config holds resolved runtime settings.
type Config struct {
	Port         int
	MasterFile   string
	IndexFile    string
	StaticRoot   string
	LocalIP      string
	PublicIP     string
	MACAddress   string
	FeedDebug    bool

	// Upstox OAuth app credentials (from account.upstox.com/developer/apps).
	// The redirect URI must EXACTLY match what's registered on the Upstox app.
	UpstoxAPIKey      string
	UpstoxAPISecret   string
	UpstoxRedirectURI string

	// Supabase-backed account storage (optional). When both are set, the backend
	// reads/writes broker accounts in Supabase; otherwise the app uses the
	// frontend's local IndexedDB only.
	SupabaseURL        string
	SupabaseServiceKey string
}

// Load builds a Config from the environment, mirroring the Node server's knobs
// (PORT, ANGEL_LOCAL_IP, ANGEL_PUBLIC_IP, ANGEL_MAC_ADDRESS, FEED_DEBUG).
func Load() Config {
	ip := envOr("ANGEL_LOCAL_IP", localIPv4())
	return Config{
		Port:       envInt("PORT", 3001),
		MasterFile: envOr("ANGEL_MASTER_FILE", "scrip_master.json"),
		IndexFile:  envOr("ANGEL_INDEX_FILE", "scrip_index.json"),
		StaticRoot: envOr("ANGEL_STATIC_ROOT", "../dist"),
		LocalIP:    ip,
		PublicIP:   envOr("ANGEL_PUBLIC_IP", ip),
		MACAddress: os.Getenv("ANGEL_MAC_ADDRESS"),
		FeedDebug:  os.Getenv("FEED_DEBUG") == "1",

		UpstoxAPIKey:    os.Getenv("UPSTOX_API_KEY"),
		UpstoxAPISecret: os.Getenv("UPSTOX_API_SECRET"),
		// Must match EXACTLY what's registered on the Upstox app. Default mirrors
		// the known-good value used by the existing Alphahedge setup:
		// http://127.0.0.1:3001/upstox/callback (127.0.0.1, and no /api prefix).
		UpstoxRedirectURI: envOr("UPSTOX_REDIRECT_URI", fmt.Sprintf("http://127.0.0.1:%d/upstox/callback", envInt("PORT", 3001))),

		SupabaseURL:        os.Getenv("SUPABASE_URL"),
		SupabaseServiceKey: os.Getenv("SUPABASE_SERVICE_KEY"),
	}
}

// SupabaseEnabled reports whether Supabase-backed storage is configured.
func (c Config) SupabaseEnabled() bool {
	return c.SupabaseURL != "" && c.SupabaseServiceKey != ""
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

// localIPv4 returns the first non-loopback IPv4 address, or 127.0.0.1. Angel
// requires an X-ClientLocalIP header; it doesn't have to be routable.
func localIPv4() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return "127.0.0.1"
	}
	for _, addr := range addrs {
		if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
			if ip4 := ipnet.IP.To4(); ip4 != nil {
				return ip4.String()
			}
		}
	}
	return "127.0.0.1"
}
