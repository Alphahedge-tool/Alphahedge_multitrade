package kotak

import (
	"sync"
	"time"
)

// Session is the logged-in Kotak NEO token bundle. The Trade token is valid for
// the trading day, so we reuse one until it stops validating and only then
// re-run the (headless) TOTP login.
type Session struct {
	TradeToken string `json:"tradeToken"` // kType="Trade" — the "Auth" header for trading APIs
	SID        string `json:"sid"`
	RID        string `json:"rid,omitempty"`
	BaseURL    string `json:"baseUrl,omitempty"` // use for all post-login APIs
	UCC        string `json:"ucc,omitempty"`
	Greeting   string `json:"greetingName,omitempty"`
	LoginAt    string `json:"loginAt,omitempty"`
	LastUsedAt string `json:"lastUsedAt,omitempty"`
}

// sessionStore keeps sessions in memory keyed by UCC (client code). Safe for
// concurrent use; no persistence (a restart just re-runs the TOTP login).
type sessionStore struct {
	mu sync.RWMutex
	m  map[string]*Session
}

func newSessionStore() *sessionStore {
	return &sessionStore{m: make(map[string]*Session)}
}

func (s *sessionStore) save(sess *Session) {
	if sess == nil || sess.UCC == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[sess.UCC] = sess
}

func (s *sessionStore) get(ucc string) *Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.m[ucc]
}

func (s *sessionStore) touch(ucc string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess, ok := s.m[ucc]; ok {
		sess.LastUsedAt = time.Now().UTC().Format(time.RFC3339)
	}
}

func (s *sessionStore) drop(ucc string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, ucc)
}
