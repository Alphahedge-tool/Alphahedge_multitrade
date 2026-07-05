// Package httpapi wires the HTTP surface. Routes match the existing Node
// server's /api/angel/* paths exactly, so the React frontend needs zero changes.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"angelone-backend/internal/angel"
	"angelone-backend/internal/config"
	"angelone-backend/internal/kotak"
	"angelone-backend/internal/nubra"
	"angelone-backend/internal/supastore"
	"angelone-backend/internal/upstox"
)

// Server holds the shared dependencies and implements http.Handler.
type Server struct {
	cfg       config.Config
	client    *angel.Client
	master    *angel.MasterStore
	feed      *angel.Feed
	orderFeed *angel.OrderFeed
	upstox    *upstox.Client
	kotak     *kotak.Client
	nubra     *nubra.Client
	store     *supastore.Client // nil when Supabase isn't configured
}

func New(cfg config.Config, client *angel.Client, master *angel.MasterStore, feed *angel.Feed, orderFeed *angel.OrderFeed, ups *upstox.Client, kot *kotak.Client, nub *nubra.Client, store *supastore.Client) *Server {
	return &Server{cfg: cfg, client: client, master: master, feed: feed, orderFeed: orderFeed, upstox: ups, kotak: kot, nubra: nub, store: store}
}

// Handler builds the router.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/angel/auto-login", s.postJSON(s.handleAutoLogin))
	mux.HandleFunc("/api/angel/logout", s.handleLogout)
	mux.HandleFunc("/api/angel/master-index", s.handleMasterIndex)
	// Basket search: free-text FUT/OPT lookup from OUR master (no Angel round-trip).
	mux.HandleFunc("/api/angel/search-scrips", s.handleSearchScrips)
	// All option scrips for a symbol+expiry straight from OUR master (no Angel
	// round-trip), mirroring Angel's all-scrip-options. GET with query params.
	mux.HandleFunc("/api/angel/all-scrip-options", s.handleAllScripOptions)
	// Live prices only (LTP/OI/close per strike) for a symbol+expiry — the slow,
	// Angel-facing half, fired in the background after the instant ladder render.
	mux.HandleFunc("/api/angel/chain-prices", s.postJSON(s.handleChainPrices))
	mux.HandleFunc("/api/angel/refresh-master", s.postJSON(s.handleRefreshMaster))
	mux.HandleFunc("/api/angel/option-chain", s.postJSON(s.handleOptionChain))
	mux.HandleFunc("/api/angel/order-book", s.postJSON(s.handleOrderBook))
	mux.HandleFunc("/api/angel/trade-book", s.postJSON(s.handleTradeBook))
	mux.HandleFunc("/api/angel/place-basket", s.postJSON(s.handlePlaceBasket))
	mux.HandleFunc("/api/angel/margin", s.postJSON(s.handleMargin))
	mux.HandleFunc("/api/angel/charges", s.postJSON(s.handleCharges))
	mux.HandleFunc("/api/angel/resolve-leg", s.postJSON(s.handleResolveLeg))
	mux.HandleFunc("/api/angel/subscribe", s.postJSON(s.handleSubscribe))
	// Basket feed sync: client sends the FULL current leg-token set, server
	// reconciles (subscribe new, unsubscribe dropped). /subscribe-more kept as an
	// alias so an older frontend build still works.
	mux.HandleFunc("/api/angel/basket-tokens", s.postJSON(s.handleBasketTokens))
	mux.HandleFunc("/api/angel/subscribe-more", s.postJSON(s.handleBasketTokens))
	mux.HandleFunc("/api/angel/stream", s.handleStream)
	// Real-time order updates (Angel's order-status WebSocket → SSE). The client
	// posts its session to start watching, then listens on /order-stream.
	mux.HandleFunc("/api/angel/order-subscribe", s.postJSON(s.handleOrderSubscribe))
	mux.HandleFunc("/api/angel/order-stream", s.handleOrderStream)

	// ── Upstox (broker #2): OAuth 2.0 login ─────────────────────────────────
	// auto-login reuses a same-day token or returns {needsLogin, loginUrl};
	// login-url just returns the browser URL; callback is the OAuth redirect
	// target that finishes the login and stores the session.
	mux.HandleFunc("/api/upstox/auto-login", s.postJSON(s.handleUpstoxAutoLogin))
	mux.HandleFunc("/api/upstox/login-url", s.handleUpstoxLoginURL)
	// The OAuth redirect target. Registered at BOTH paths: /upstox/callback is
	// the default that must match the Upstox app registration (mirrors the known
	// -good Alphahedge redirect_uri); /api/upstox/callback is kept for anyone who
	// registered that variant instead.
	mux.HandleFunc("/upstox/callback", s.handleUpstoxCallback)
	mux.HandleFunc("/api/upstox/callback", s.handleUpstoxCallback)

	// ── Kotak NEO (broker #3): fully-headless Login-with-TOTP ────────────────
	// auto-login runs tradeApiLogin → tradeApiValidate server-side using the
	// stored TOTP secret; no browser, no SMS OTP.
	mux.HandleFunc("/api/kotak/auto-login", s.postJSON(s.handleKotakAutoLogin))

	// Nubra REST: fully-headless TOTP login followed by MPIN verification.
	mux.HandleFunc("/api/nubra/auto-login", s.postJSON(s.handleNubraAutoLogin))
	mux.HandleFunc("/api/nubra/totp/setup", s.postJSON(s.handleNubraTOTPSetup))
	mux.HandleFunc("/api/nubra/totp/generate-secret", s.postJSON(s.handleNubraTOTPGenerateSecret))
	mux.HandleFunc("/api/nubra/totp/enable", s.postJSON(s.handleNubraTOTPEnable))

	// ── Supabase-backed account storage ─────────────────────────────────────
	// GET  → load all saved accounts (frontend fills the table on open)
	// POST → save the current table back to Supabase {accounts:[...]}
	// Both return {enabled:false} when Supabase isn't configured, so the
	// frontend transparently falls back to local IndexedDB.
	mux.HandleFunc("/api/accounts", s.handleAccounts)

	mux.HandleFunc("/", s.serveStatic) // SPA static fallback
	return withCORS(mux)
}

// ── handlers ────────────────────────────────────────────────────────────────

func (s *Server) handleAutoLogin(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var wrap struct {
		Client angel.ClientCreds `json:"client"`
	}
	decodeInto(body, &wrap)
	return s.client.AutoLogin(ctx, wrap.Client)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"status": true, "message": "Logged out"})
}

func (s *Server) handleMasterIndex(w http.ResponseWriter, r *http.Request) {
	idx, err := s.master.Index(r.Context())
	if err != nil {
		writeJSON(w, 500, errBody(err))
		return
	}
	writeJSON(w, 200, idx)
}

// handleAllScripOptions serves every option scrip for a symbol+expiry from our
// master, mirroring Angel's all-scrip-options query shape. Two forms:
//
//	GET  ?TradeSymbol=NIFTY&ExpiryDate=2026-07-07&MarketSegmentId=1  → pure master
//	POST {client, TradeSymbol, ExpiryDate, MarketSegmentId}          → + spot/atm
//
// The POST form does one cheap spot LTP quote so the skeleton carries spot+atm.
func (s *Server) handleAllScripOptions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		q := r.URL.Query()
		res, err := s.master.AllScripOptions(r.Context(), angel.ScripOptionsReq{
			TradeSymbol:     q.Get("TradeSymbol"),
			ExpiryDate:      q.Get("ExpiryDate"),
			MarketSegmentId: q.Get("MarketSegmentId"),
		})
		if err != nil {
			writeJSON(w, 400, errBody(err))
			return
		}
		writeJSON(w, 200, res)
	case http.MethodPost:
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		var body struct {
			Client          angel.ClientCreds `json:"client"`
			TradeSymbol     string            `json:"TradeSymbol"`
			ExpiryDate      string            `json:"ExpiryDate"`
			MarketSegmentId string            `json:"MarketSegmentId"`
		}
		_ = json.Unmarshal(raw, &body)
		res, err := s.client.ScripOptionsWithSpot(r.Context(), s.master, angel.ScripOptionsReq{
			TradeSymbol:     body.TradeSymbol,
			ExpiryDate:      body.ExpiryDate,
			MarketSegmentId: body.MarketSegmentId,
		}, body.Client)
		if err != nil {
			writeJSON(w, 400, errBody(err))
			return
		}
		writeJSON(w, 200, res)
	default:
		writeJSON(w, 405, map[string]any{"status": false, "message": "Method not allowed"})
	}
}

func (s *Server) handleRefreshMaster(ctx context.Context, _ map[string]json.RawMessage) (any, error) {
	return s.master.Refresh(ctx)
}

// handleSearchScrips serves the basket's FUT/OPT search: GET ?q=nifty&limit=80.
func (s *Server) handleSearchScrips(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	limit := 80
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	res, err := s.master.SearchScrips(r.Context(), q, limit)
	if err != nil {
		writeJSON(w, 500, errBody(err))
		return
	}
	writeJSON(w, 200, map[string]any{"status": true, "results": res})
}

func (s *Server) handleOptionChain(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req angel.OptionChainReq
	decodeReq(body, &req)
	return s.client.GetOptionChain(ctx, req, s.master)
}

func (s *Server) handleOrderBook(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req angel.BookReq
	decodeReq(body, &req)
	return s.client.GetOrderBook(ctx, req)
}

func (s *Server) handleTradeBook(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req angel.BookReq
	decodeReq(body, &req)
	return s.client.GetTradeBook(ctx, req)
}

func (s *Server) handlePlaceBasket(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req angel.PlaceBasketReq
	decodeReq(body, &req)
	return s.client.PlaceBasket(ctx, req)
}

// handleChainPrices returns just the live prices for a symbol+expiry (the slow,
// Angel-facing half), so the frontend can render the master ladder instantly and
// fill these in via a background call.
func (s *Server) handleChainPrices(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req struct {
		Client      angel.ClientCreds `json:"client"`
		TradeSymbol string            `json:"TradeSymbol"`
		ExpiryDate  string            `json:"ExpiryDate"`
	}
	decodeReq(body, &req)
	return s.client.ChainPrices(ctx, s.master, angel.ScripOptionsReq{
		TradeSymbol: req.TradeSymbol,
		ExpiryDate:  req.ExpiryDate,
	}, req.Client)
}

func (s *Server) handleMargin(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req angel.MarginReq
	decodeReq(body, &req)
	return s.client.GetMargin(ctx, req)
}

func (s *Server) handleCharges(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req angel.ChargesReq
	decodeReq(body, &req)
	return s.client.GetCharges(ctx, req)
}

func (s *Server) handleResolveLeg(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req angel.ResolveLegReq
	decodeReq(body, &req)
	return s.client.ResolveLeg(ctx, req, s.master)
}

func (s *Server) handleSubscribe(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req struct {
		Credentials angel.FeedCredentials `json:"credentials"`
		Exchange    string                `json:"exchange"`
		Tokens      []string              `json:"tokens"`
		Spot        *struct {
			Token    string `json:"token"`
			Exchange string `json:"exchange"`
		} `json:"spot"`
	}
	decodeReq(body, &req)
	spotToken, spotExchange := "", ""
	if req.Spot != nil {
		spotToken, spotExchange = req.Spot.Token, req.Spot.Exchange
	}
	n, err := s.feed.Subscribe(req.Credentials, orNFO(req.Exchange), req.Tokens, spotToken, spotExchange)
	if err != nil {
		return nil, err
	}
	return map[string]any{"status": true, "subscribed": n, "exchange": orNFO(req.Exchange)}, nil
}

// handleBasketTokens reconciles the live feed to EXACTLY the basket's current
// leg tokens: the client posts the full set, the server subscribes new ones and
// unsubscribes dropped ones (old strike/expiry after a change, or removed legs).
func (s *Server) handleBasketTokens(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req struct {
		Credentials *angel.FeedCredentials `json:"credentials"`
		Items       []struct {
			Exchange string `json:"exchange"`
			Token    string `json:"token"`
		} `json:"items"`
	}
	decodeReq(body, &req)
	items := make([]angel.FeedItem, 0, len(req.Items))
	for _, it := range req.Items {
		items = append(items, angel.FeedItem{Exchange: it.Exchange, Token: it.Token})
	}
	res, err := s.feed.SetBasketTokensItems(req.Credentials, items)
	if err != nil {
		return nil, err
	}
	// `dropped` is non-zero only when the 1000-token session cap is full; the
	// frontend can surface that so the user knows some legs aren't ticking live.
	return map[string]any{
		"status":  true,
		"added":   res.Added,
		"removed": res.Removed,
		"dropped": res.Dropped,
		"total":   res.Total,
	}, nil
}

// handleStream is the market-data SSE endpoint: tick/status events.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	serveSSE(w, r, s.feed.AddClient, s.feed.RemoveClient)
}

// handleOrderSubscribe opens (idempotently) an order-status WebSocket for the
// posted account so its order updates start flowing to /order-stream.
func (s *Server) handleOrderSubscribe(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req struct {
		Credentials angel.FeedCredentials `json:"credentials"`
	}
	decodeReq(body, &req)
	if err := s.orderFeed.Watch(req.Credentials); err != nil {
		return nil, err
	}
	return map[string]any{"status": true, "watching": req.Credentials.ClientCode}, nil
}

// handleOrderStream is the order-update SSE endpoint: pushes each order event
// (and connection status) as the account's orders change.
func (s *Server) handleOrderStream(w http.ResponseWriter, r *http.Request) {
	serveSSE(w, r, s.orderFeed.AddClient, s.orderFeed.RemoveClient)
}

// ── Upstox handlers ──────────────────────────────────────────────────────────

// handleUpstoxAutoLogin logs an Upstox account in. It first reuses a same-day
// token. If none exists:
//   - autoLogin=true with phone/pin/totpSecret → runs the scripted-browser
//     (Selenium) mobile→TOTP→PIN flow server-side; fully automated (TOTP is
//     generated server-side).
//   - otherwise → returns {needsLogin:true, loginUrl} so the frontend opens the
//     one-click OAuth popup.
//
// Body: {userId, state?, autoLogin?, phone?, pin?, totpSecret?}.
func (s *Server) handleUpstoxAutoLogin(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req struct {
		UserID     string `json:"userId"`
		State      string `json:"state"`
		AutoLogin  bool   `json:"autoLogin"`
		Phone      string `json:"phone"`
		PIN        string `json:"pin"`
		TOTPSecret string `json:"totpSecret"`
		APIKey     string `json:"apiKey"`
		APISecret  string `json:"apiSecret"`
	}
	decodeReq(body, &req)

	creds := upstox.AppCreds{APIKey: req.APIKey, APISecret: req.APISecret}
	res, err := s.upstox.AutoLogin(ctx, req.UserID, req.State, creds)
	if err == nil {
		return res, nil // reused a live same-day token
	}
	var need *upstox.NeedsLogin
	if !errors.As(err, &need) {
		return nil, err
	}
	// No live token: pick the login path based on the account's Auto Login tick.
	if req.AutoLogin {
		return s.upstox.AutoLoginSelenium(ctx, upstox.AutoCreds{
			Phone:      req.Phone,
			PIN:        req.PIN,
			TOTPSecret: req.TOTPSecret,
			APIKey:     req.APIKey,
			APISecret:  req.APISecret,
		})
	}
	return map[string]any{"status": false, "needsLogin": true, "loginUrl": need.LoginURL}, nil
}

// handleUpstoxLoginURL returns just the browser OAuth URL (GET ?state=...), so
// the frontend can trigger a fresh login without first attempting a reuse.
func (s *Server) handleUpstoxLoginURL(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	creds := upstox.AppCreds{APIKey: q.Get("apiKey"), APISecret: q.Get("apiSecret")}
	loginURL, err := s.upstox.LoginURL(creds, q.Get("state"))
	if err != nil {
		writeJSON(w, 400, errBody(err))
		return
	}
	writeJSON(w, 200, map[string]any{"status": true, "loginUrl": loginURL})
}

// handleUpstoxCallback is the OAuth redirect target. Upstox sends ?code=&state=;
// we exchange the code for a token, store the session, and return a tiny HTML
// page that hands the session back to the opener window and closes itself.
func (s *Server) handleUpstoxCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if apiErr := q.Get("error"); apiErr != "" {
		writeCallbackHTML(w, false, apiErr)
		return
	}
	code := q.Get("code")
	if code == "" {
		writeCallbackHTML(w, false, "missing authorization code")
		return
	}
	// If this is the headless auto-login flow, the AutoLoginSelenium call owns the
	// (single-use) code exchange — do NOT consume it here. Just render a blank OK
	// page so the browser navigation completes.
	if s.upstox.IsSeleniumState(q.Get("state")) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<!doctype html><title>ok</title>Login captured.")
		return
	}
	// The account creds were stashed when the login URL was issued (keyed by
	// state), so this credential-less redirect can exchange the code.
	creds := s.upstox.CredsForState(q.Get("state"))
	sess, err := s.upstox.ExchangeCode(r.Context(), code, creds)
	if err != nil {
		writeCallbackHTML(w, false, err.Error())
		return
	}
	writeCallbackHTML(w, true, sess.UserID)
}

// writeCallbackHTML renders the popup-completion page: it posts the result to
// the window that opened it (postMessage) and closes. Falls back to plain text
// if it wasn't opened as a popup.
func writeCallbackHTML(w http.ResponseWriter, ok bool, detail string) {
	payload, _ := json.Marshal(map[string]any{
		"source":  "upstox-oauth",
		"success": ok,
		"detail":  detail,
	})
	msg := "Upstox login complete — you can close this window."
	if !ok {
		msg = "Upstox login failed: " + detail
	}
	html := fmt.Sprintf(`<!doctype html><meta charset="utf-8"><title>Upstox login</title>
<body style="font-family:system-ui;padding:2rem">%s
<script>
try { if (window.opener) { window.opener.postMessage(%s, "*"); } } catch (e) {}
setTimeout(function(){ try { window.close(); } catch (e) {} }, 800);
</script></body>`, htmlEscape(msg), string(payload))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, html)
}

func htmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}

// ── Kotak handler ────────────────────────────────────────────────────────────

// handleKotakAutoLogin logs a Kotak NEO account in with the fully-headless
// Login-with-TOTP flow (tradeApiLogin → tradeApiValidate). Credentials come from
// the account row. Body: {accessToken, mobileNumber, ucc, mpin, totpSecret}.
func (s *Server) handleKotakAutoLogin(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req kotak.Creds
	decodeReq(body, &req)
	return s.kotak.AutoLogin(ctx, req)
}

// handleNubraAutoLogin logs a Nubra account in with the fully-headless
// TOTP + MPIN REST flow: /totp/login -> /verifypin.
func (s *Server) handleNubraAutoLogin(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req nubra.Creds
	decodeReq(body, &req)
	return s.nubra.AutoLogin(ctx, req)
}

// handleNubraTOTPSetup performs Nubra's one-time TOTP enrollment:
// /totp/generate-secret -> locally generate the current TOTP -> /totp/enable.
// Body: {sessionToken, deviceId?, mpin|pin, phone?, clientCode?}.
func (s *Server) handleNubraTOTPSetup(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req nubra.TOTPSetupCreds
	decodeReq(body, &req)
	return s.nubra.SetupTOTP(ctx, req)
}

func (s *Server) handleNubraTOTPGenerateSecret(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req nubra.TOTPSetupCreds
	decodeReq(body, &req)
	res, err := s.nubra.GenerateTOTPSecret(ctx, req)
	if err != nil {
		return nil, err
	}
	return map[string]any{"status": true, "broker": "nubra", "data": res}, nil
}

func (s *Server) handleNubraTOTPEnable(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req nubra.TOTPSetupCreds
	decodeReq(body, &req)
	res, err := s.nubra.EnableTOTP(ctx, req, req.TOTP)
	if err != nil {
		return nil, err
	}
	return map[string]any{"status": true, "broker": "nubra", "data": res}, nil
}

// handleAccounts loads (GET) or saves (POST) the broker accounts in Supabase.
// When Supabase isn't configured it replies {status:true, enabled:false} so the
// frontend knows to use its local IndexedDB store instead.
func (s *Server) handleAccounts(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeJSON(w, 200, map[string]any{"status": true, "enabled": false, "accounts": []any{}})
		return
	}
	switch r.Method {
	case http.MethodGet:
		// Optional ?broker=Kotak → only that broker's accounts; empty → all.
		broker := r.URL.Query().Get("broker")
		accounts, err := s.store.List(r.Context(), broker)
		if err != nil {
			writeJSON(w, 500, errBody(err))
			return
		}
		writeJSON(w, 200, map[string]any{"status": true, "enabled": true, "broker": broker, "accounts": accounts})
	case http.MethodPost:
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
		var req struct {
			// Optional broker scope: when set, only that broker's rows are
			// replaced, leaving other brokers' accounts untouched.
			Broker   string              `json:"broker"`
			Accounts []supastore.Account `json:"accounts"`
		}
		_ = json.Unmarshal(raw, &req)
		if err := s.store.Replace(r.Context(), req.Accounts, req.Broker); err != nil {
			writeJSON(w, 500, errBody(err))
			return
		}
		writeJSON(w, 200, map[string]any{"status": true, "enabled": true, "broker": req.Broker, "saved": len(req.Accounts)})
	default:
		writeJSON(w, 405, map[string]any{"status": false, "message": "Method not allowed"})
	}
}

// serveSSE runs the shared Server-Sent-Events loop against any feed exposing
// AddClient/RemoveClient (market ticks or order updates).
func serveSSE(w http.ResponseWriter, r *http.Request, add func() (chan angel.SSEEvent, bool), remove func(chan angel.SSEEvent)) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)

	ch, connected := add()
	defer remove(ch)

	fmt.Fprint(w, "retry: 3000\n\n")
	writeSSE(w, "status", fmt.Sprintf(`{"connected":%t,"message":"Stream open"}`, connected))
	flusher.Flush()

	keepAlive := time.NewTicker(20 * time.Second)
	defer keepAlive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			writeSSE(w, ev.Event, ev.Data)
			flusher.Flush()
		case <-keepAlive.C:
			fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		}
	}
}

// serveStatic serves the built SPA from dist/, falling back to index.html.
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, 404, map[string]any{"status": false, "message": "Not found"})
		return
	}
	clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if clean == "." || clean == "" {
		clean = "index.html"
	}
	full := filepath.Join(s.cfg.StaticRoot, clean)
	if info, err := os.Stat(full); err != nil || info.IsDir() {
		full = filepath.Join(s.cfg.StaticRoot, "index.html")
	}
	http.ServeFile(w, r, full)
}

// ── plumbing ────────────────────────────────────────────────────────────────

// postJSON adapts a (ctx, body)→(any,error) handler into an http.HandlerFunc
// that reads the JSON body once and writes the JSON result or a 500 error body.
func (s *Server) postJSON(fn func(context.Context, map[string]json.RawMessage) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, 405, map[string]any{"status": false, "message": "Method not allowed"})
			return
		}
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
		body := map[string]json.RawMessage{}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		res, err := fn(r.Context(), body)
		if err != nil {
			writeJSON(w, 500, errBody(err))
			return
		}
		writeJSON(w, 200, res)
	}
}

func decodeReq(body map[string]json.RawMessage, target any) {
	// Re-marshal the whole body and unmarshal into the typed request. Cheap and
	// keeps the handlers declarative.
	raw, _ := json.Marshal(rawToAny(body))
	_ = json.Unmarshal(raw, target)
}

func decodeInto(body map[string]json.RawMessage, target any) { decodeReq(body, target) }

func rawToAny(body map[string]json.RawMessage) map[string]any {
	out := make(map[string]any, len(body))
	for k, v := range body {
		var val any
		_ = json.Unmarshal(v, &val)
		out[k] = val
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeSSE(w io.Writer, event, data string) {
	if event != "" {
		fmt.Fprintf(w, "event: %s\n", event)
	}
	fmt.Fprintf(w, "data: %s\n\n", data)
}

func errBody(err error) map[string]any {
	return map[string]any{"status": false, "message": err.Error()}
}

func orNFO(s string) string {
	if s == "" {
		return "NFO"
	}
	return s
}

// withCORS handles preflight and adds permissive CORS headers (dev parity with
// the Node server's sendCors).
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
