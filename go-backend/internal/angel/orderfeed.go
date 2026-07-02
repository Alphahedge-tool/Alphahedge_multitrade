package angel

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"angelone-backend/internal/config"
)

// OrderStreamURL is Angel's real-time order-status feed. Note the host differs
// from the market feed (smartapisocket.angelone.in) — its 3-connection-per-client
// limit is counted separately.
const OrderStreamURL = "wss://tns.angelone.in/smart-order-update"

// OrderFeed keeps one upstream order-status WebSocket per logged-in account
// (client code) and fans every order event out to the connected SSE clients.
// Angel pushes an account's order updates automatically once the socket is open
// with that account's session — there is NO subscribe frame. This replaces
// polling the order book: the browser gets an event the instant an order is
// placed / opened / executed / cancelled / rejected / modified.
type OrderFeed struct {
	cfg config.Config

	mu         sync.Mutex
	conns      map[string]*orderConn // clientCode -> upstream socket
	sseClients map[chan SSEEvent]bool
}

type orderConn struct {
	conn *websocket.Conn
	stop chan struct{}
}

func NewOrderFeed(cfg config.Config) *OrderFeed {
	return &OrderFeed{
		cfg:        cfg,
		conns:      map[string]*orderConn{},
		sseClients: map[chan SSEEvent]bool{},
	}
}

// ── SSE client registry ─────────────────────────────────────────────────────

// AddClient registers an SSE listener and reports whether any upstream order
// socket is currently connected.
func (f *OrderFeed) AddClient() (chan SSEEvent, bool) {
	ch := make(chan SSEEvent, 64)
	f.mu.Lock()
	f.sseClients[ch] = true
	connected := f.hasLiveConnLocked()
	f.mu.Unlock()
	return ch, connected
}

// RemoveClient unregisters a listener; when the last one leaves, every upstream
// order socket is dropped (nothing to feed).
func (f *OrderFeed) RemoveClient(ch chan SSEEvent) {
	f.mu.Lock()
	if _, ok := f.sseClients[ch]; ok {
		delete(f.sseClients, ch)
		close(ch)
	}
	last := len(f.sseClients) == 0
	var toClose []*orderConn
	if last {
		for code, oc := range f.conns {
			toClose = append(toClose, oc)
			delete(f.conns, code)
		}
	}
	f.mu.Unlock()
	for _, oc := range toClose {
		oc.close()
	}
}

func (f *OrderFeed) hasClients() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sseClients) > 0
}

func (f *OrderFeed) hasLiveConnLocked() bool {
	for _, oc := range f.conns {
		if oc.conn != nil {
			return true
		}
	}
	return false
}

func (f *OrderFeed) broadcast(ev SSEEvent) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for ch := range f.sseClients {
		select {
		case ch <- ev:
		default: // slow client: drop rather than block
		}
	}
}

// ── Upstream order socket ───────────────────────────────────────────────────

// Watch ensures an order-status socket is open for the account. Idempotent per
// client code; a dropped socket reconnects itself while SSE clients remain.
func (f *OrderFeed) Watch(creds FeedCredentials) error {
	if creds.JWTToken == "" || creds.ClientCode == "" {
		return errFeedSession
	}
	f.mu.Lock()
	if _, ok := f.conns[creds.ClientCode]; ok {
		f.mu.Unlock()
		return nil // already watching (connected or dialing)
	}
	// Reserve the slot so two concurrent Watch calls don't both dial.
	f.conns[creds.ClientCode] = &orderConn{}
	f.mu.Unlock()
	go f.connect(creds)
	return nil
}

func (f *OrderFeed) connect(creds FeedCredentials) {
	header := http.Header{}
	// NOTE: unlike the market feed (raw JWT), the order-update service at
	// tns.angelone.in requires the "Bearer " prefix — without it the upgrade is
	// rejected 401 ("bad handshake"). Confirmed against Angel's official SDKs.
	header.Set("Authorization", "Bearer "+creds.JWTToken)
	header.Set("x-api-key", creds.APIKey)
	header.Set("x-client-code", creds.ClientCode)
	header.Set("x-feed-token", creds.FeedToken)

	conn, _, err := websocket.DefaultDialer.Dial(OrderStreamURL, header)
	if err != nil {
		f.mu.Lock()
		delete(f.conns, creds.ClientCode) // free the reserved slot so Watch can retry
		f.mu.Unlock()
		f.broadcast(statusEvent(false, "Order feed error: "+err.Error()))
		return
	}

	stop := make(chan struct{})
	f.mu.Lock()
	f.conns[creds.ClientCode] = &orderConn{conn: conn, stop: stop}
	f.mu.Unlock()

	f.broadcast(statusEvent(true, "Order feed connected"))
	go f.readLoop(creds, conn, stop)
	go f.pingLoop(conn, stop)
}

func (f *OrderFeed) readLoop(creds FeedCredentials, conn *websocket.Conn, stop chan struct{}) {
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if mt != websocket.TextMessage {
			continue
		}
		text := strings.TrimSpace(string(data))
		if text == "" || text == "pong" {
			continue // heartbeat ack
		}
		// Forward the raw order-status JSON; the frontend refreshes the book.
		f.broadcast(SSEEvent{Event: "order", Data: text})
	}

	// Drop this socket from the registry (if it's still the current one).
	f.mu.Lock()
	if oc, ok := f.conns[creds.ClientCode]; ok && oc.conn == conn {
		delete(f.conns, creds.ClientCode)
	}
	f.mu.Unlock()

	select {
	case <-stop:
		return // intentional close (last SSE client left)
	default:
	}
	f.broadcast(statusEvent(false, "Order feed disconnected"))
	// Reconnect once after a short delay, but only while someone's listening —
	// so a dropped socket recovers without hammering when the tab is closed.
	if f.hasClients() {
		time.AfterFunc(3*time.Second, func() {
			if f.hasClients() {
				_ = f.Watch(creds)
			}
		})
	}
}

func (f *OrderFeed) pingLoop(conn *websocket.Conn, stop chan struct{}) {
	ticker := time.NewTicker(10 * time.Second) // Angel wants a ping ~every 10s
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
				return
			}
		}
	}
}

func (oc *orderConn) close() {
	if oc.stop != nil {
		select {
		case <-oc.stop:
		default:
			close(oc.stop)
		}
	}
	if oc.conn != nil {
		_ = oc.conn.Close()
	}
}
