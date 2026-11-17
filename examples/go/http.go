package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const maxSessions = 128

type httpSession struct {
	s         *session
	streaming bool // Protected by httpTransport.mu.
	orphan    *time.Timer
}
type httpTransport struct {
	tokenHash [32]byte
	mu        sync.Mutex
	sessions  map[string]*httpSession
	closed    bool
}

func newHTTPTransport(token string) *httpTransport {
	return &httpTransport{tokenHash: sha256.Sum256([]byte("Bearer " + token)), sessions: map[string]*httpSession{}}
}
func authorized(expected [32]byte, headers []string) bool {
	if len(headers) != 1 {
		return false
	}
	actual := sha256.Sum256([]byte(headers[0]))
	return subtle.ConstantTimeCompare(expected[:], actual[:]) == 1
}
func (h *httpTransport) close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for _, entry := range h.sessions {
		entry.orphan.Stop()
		entry.s.close()
	}
	h.sessions = map[string]*httpSession{}
}
func (h *httpTransport) discard(id string, entry *httpSession) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.sessions[id] == entry {
		delete(h.sessions, id)
	}
	entry.orphan.Stop()
	entry.s.close()
}
func readHTTPBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFrame)
	defer r.Body.Close()
	return io.ReadAll(r.Body)
}
func (h *httpTransport) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !authorized(h.tokenHash, r.Header.Values("Authorization")) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if r.URL.Path == "/sessions" && r.Method == http.MethodPost {
		data, err := readHTTPBody(w, r)
		if err != nil {
			http.Error(w, "Body too large or unreadable", http.StatusRequestEntityTooLarge)
			return
		}
		if _, err := object(data, nil, nil); err != nil {
			http.Error(w, "Expected empty object", http.StatusBadRequest)
			return
		}
		var random [32]byte
		if _, err := rand.Read(random[:]); err != nil {
			http.Error(w, "Unavailable", http.StatusServiceUnavailable)
			return
		}
		id := hex.EncodeToString(random[:])
		h.mu.Lock()
		if h.closed || len(h.sessions) >= maxSessions {
			h.mu.Unlock()
			http.Error(w, "Session limit", http.StatusServiceUnavailable)
			return
		}
		entry := &httpSession{s: newSession()}
		entry.orphan = time.AfterFunc(30*time.Second, func() { h.discard(id, entry) })
		h.sessions[id] = entry
		h.mu.Unlock()
		go func() { <-entry.s.ctx.Done(); h.discard(id, entry) }()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"sessionId": id})
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if len(parts) < 2 || len(parts) > 3 || parts[0] != "sessions" || len(parts[1]) != 64 {
		http.NotFound(w, r)
		return
	}
	id := parts[1]
	h.mu.Lock()
	entry := h.sessions[id]
	if entry == nil || entry.s.ctx.Err() != nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if len(parts) == 2 && r.Method == http.MethodDelete {
		delete(h.sessions, id)
		entry.orphan.Stop()
		entry.s.close()
		h.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if len(parts) == 3 && parts[2] == "events" && r.Method == http.MethodGet {
		if entry.streaming {
			h.mu.Unlock()
			http.Error(w, "Stream already open", http.StatusConflict)
			return
		}
		entry.streaming = true
		entry.orphan.Stop()
		h.mu.Unlock()
		defer h.discard(id, entry)
		h.events(w, r, entry.s)
		return
	}
	streaming := entry.streaming
	h.mu.Unlock()
	if len(parts) == 3 && parts[2] == "messages" && r.Method == http.MethodPost {
		if !streaming {
			http.Error(w, "Open events first", http.StatusConflict)
			return
		}
		data, err := readHTTPBody(w, r)
		if err != nil {
			entry.s.close()
			http.Error(w, "Body too large or unreadable", http.StatusRequestEntityTooLarge)
			return
		}
		if err := entry.s.accept(data); err != nil {
			http.Error(w, "Invalid frame or closed connection", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		return
	}
	http.NotFound(w, r)
}
func (h *httpTransport) events(w http.ResponseWriter, r *http.Request, s *session) {
	w.Header().Set("Content-Type", "text/event-stream")
	controller := http.NewResponseController(w)
	write := func(data string) error {
		if err := controller.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return err
		}
		if _, err := io.WriteString(w, data); err != nil {
			return err
		}
		return controller.Flush()
	}
	if err := write(": ready\n\n"); err != nil {
		return
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			if err := write(": heartbeat\n\n"); err != nil {
				return
			}
		case frame := <-s.out:
			if err := write(fmt.Sprintf("data: %s\n\n", frame.data)); err != nil {
				return
			}
			if frame.closeAfter {
				return
			}
		}
	}
}
