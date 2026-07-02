package upstox

import (
	"strings"
	"sync"
	"time"
)

// Session is the logged-in Upstox token bundle. Upstox access tokens are valid
// until roughly 3:30 AM IST the next day, so we reuse one all through a trading
// day and only fall back to a fresh browser login when it stops validating.
type Session struct {
	AccessToken string `json:"accessToken"`
	UserID      string `json:"userId"`
	UserName    string `json:"userName,omitempty"`
	Email       string `json:"email,omitempty"`
	Broker      string `json:"broker,omitempty"`
	LoginAt     string `json:"loginAt,omitempty"`
	LastUsedAt  string `json:"lastUsedAt,omitempty"`
}

// sessionStore keeps tokens in memory keyed by user_id. It is safe for
// concurrent use. Kept deliberately simple (no persistence) — a restart just
// means the next login re-runs the one-click OAuth.
type sessionStore struct {
	mu sync.RWMutex
	m  map[string]*Session
}

func newSessionStore() *sessionStore {
	return &sessionStore{m: make(map[string]*Session)}
}

// save stores (or replaces) the session for its user_id.
func (s *sessionStore) save(sess *Session) {
	if sess == nil || sess.UserID == "" {
		return
	}
	sess.UserID = strings.TrimSpace(sess.UserID)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[sess.UserID] = sess
}

// get returns the stored session for a user_id, if any.
func (s *sessionStore) get(userID string) *Session {
	userID = strings.TrimSpace(userID)
	s.mu.RLock()
	defer s.mu.RUnlock()
	if sess := s.m[userID]; sess != nil {
		return sess
	}
	for storedUserID, sess := range s.m {
		if strings.EqualFold(storedUserID, userID) {
			return sess
		}
	}
	return nil
}

// touch records the last-used time on a live session.
func (s *sessionStore) touch(userID string) {
	userID = strings.TrimSpace(userID)
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess, ok := s.m[userID]; ok {
		sess.LastUsedAt = time.Now().UTC().Format(time.RFC3339)
		return
	}
	for storedUserID, sess := range s.m {
		if strings.EqualFold(storedUserID, userID) {
			sess.LastUsedAt = time.Now().UTC().Format(time.RFC3339)
			return
		}
	}
}

// drop removes a session (e.g. after it fails validation or on logout).
func (s *sessionStore) drop(userID string) {
	userID = strings.TrimSpace(userID)
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, userID)
	for storedUserID := range s.m {
		if strings.EqualFold(storedUserID, userID) {
			delete(s.m, storedUserID)
			return
		}
	}
}

// pendingStore briefly remembers the app creds for an in-flight OAuth login,
// keyed by the `state` we put on the authorization URL, so the credential-less
// callback redirect can retrieve the right key/secret to exchange the code.
// It also tracks Selenium-owned states, for which the callback must NOT exchange
// the code (the AutoLoginSelenium call does that itself).
type pendingStore struct {
	mu       sync.Mutex
	m        map[string]AppCreds
	selenium map[string]bool
}

func newPendingStore() *pendingStore {
	return &pendingStore{m: make(map[string]AppCreds), selenium: make(map[string]bool)}
}

func (p *pendingStore) put(state string, cr AppCreds) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.m[state] = cr
}

// take returns and removes the creds for a state (single use).
func (p *pendingStore) take(state string) AppCreds {
	p.mu.Lock()
	defer p.mu.Unlock()
	cr := p.m[state]
	delete(p.m, state)
	delete(p.selenium, state)
	return cr
}

// markSelenium flags a state as driven by the headless auto-login browser.
func (p *pendingStore) markSelenium(state string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.selenium[state] = true
}

// isSelenium reports whether the callback for this state should skip exchange.
func (p *pendingStore) isSelenium(state string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.selenium[state]
}
