package nubra

import (
	"sync"
	"time"
)

// Session is the logged-in Nubra token bundle returned by /verifypin.
type Session struct {
	SessionToken string `json:"sessionToken"`
	Phone        string `json:"phone,omitempty"`
	UserID       any    `json:"userId,omitempty"`
	ClientCode   string `json:"clientCode,omitempty"`
	DeviceID     string `json:"deviceId,omitempty"`
	LoginAt      string `json:"loginAt,omitempty"`
	LastUsedAt   string `json:"lastUsedAt,omitempty"`
}

type sessionStore struct {
	mu sync.RWMutex
	m  map[string]*Session
}

func newSessionStore() *sessionStore {
	return &sessionStore{m: make(map[string]*Session)}
}

func (s *sessionStore) save(key string, sess *Session) {
	if key == "" || sess == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[key] = sess
}

func (s *sessionStore) get(key string) *Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.m[key]
}

func (s *sessionStore) touch(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sess, ok := s.m[key]; ok {
		sess.LastUsedAt = time.Now().UTC().Format(time.RFC3339)
	}
}
