package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"
	"unicode/utf8"
)

type output struct {
	data       []byte
	closeAfter bool
}
type request struct {
	ctx    context.Context
	cancel context.CancelFunc
	method string
}
type session struct {
	ctx         context.Context
	cancel      context.CancelFunc
	out         chan output
	mu          sync.Mutex
	initialized bool
	closing     bool
	permissions map[string]bool
	active      map[string]*request
	seen        map[string]bool
	pending     map[string]chan envelope
	serial      uint64
	workers     int
}

func newSession() *session {
	ctx, cancel := context.WithCancel(context.Background())
	return &session{ctx: ctx, cancel: cancel, out: make(chan output, queueSize), permissions: map[string]bool{}, active: map[string]*request{}, seen: map[string]bool{}, pending: map[string]chan envelope{}}
}
func (s *session) close() { s.cancel() }

func (s *session) enqueue(v any, closeAfter bool) bool {
	data, err := json.Marshal(v)
	if err != nil || len(data) > maxFrame {
		s.close()
		return false
	}
	select {
	case <-s.ctx.Done():
		return false
	default:
	}
	select {
	case s.out <- output{data, closeAfter}:
		return true
	default:
		s.close()
		return false // A stalled consumer cannot retain unbounded work.
	}
}
func (s *session) reply(id string, result any, err *rpcError, closeAfter bool) {
	v := map[string]any{"jsonrpc": "2.0", "id": id}
	if err != nil {
		v["error"] = err
	} else {
		v["result"] = result
	}
	s.enqueue(v, closeAfter)
}

// accept never waits for a handler or a reverse callback. Transport readers can
// therefore receive callback replies and cancellation during a tool operation.
func (s *session) accept(data []byte) error {
	e, err := decodeEnvelope(data)
	if err != nil {
		s.close()
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing || s.ctx.Err() != nil {
		return fmt.Errorf("connection closed")
	}
	if e.Response {
		if ch, ok := s.pending[e.ID]; ok {
			delete(s.pending, e.ID)
			ch <- e // Buffered single-use channel; never block the reader.
		}
		return nil // Late callback replies are harmless after cancellation.
	}
	if e.Method == "$/cancelRequest" {
		if e.HasID {
			s.reply(e.ID, nil, invalid(), false)
			return nil
		}
		m, validation := object(e.Params, []string{"id"}, nil)
		var id string
		if validation == nil && stringValue(m["id"], &id) {
			if r := s.active[id]; r != nil {
				r.cancel()
			}
		}
		return nil
	}
	if e.HasID {
		if s.seen[e.ID] || len(s.seen) >= 4096 {
			s.close()
			return fmt.Errorf("duplicate ID or connection request limit")
		}
		s.seen[e.ID] = true
	}
	if e.Method == "initialize" {
		result, failure := s.initialize(e.Params)
		if e.HasID {
			s.reply(e.ID, result, failure, false)
		}
		return nil
	}
	if !s.initialized {
		if e.HasID {
			s.reply(e.ID, nil, failed("Initialize first"), false)
		}
		return nil
	}
	if e.Method == "shutdown" {
		_, failure := object(e.Params, nil, nil)
		if failure != nil {
			if e.HasID {
				s.reply(e.ID, nil, failure, false)
			}
			return nil
		}
		s.closing = true
		for _, r := range s.active {
			r.cancel()
		}
		if e.HasID {
			s.reply(e.ID, map[string]any{}, nil, true)
		} else {
			s.close()
		}
		return nil
	}
	if s.workers >= maxConcurrent {
		if e.HasID {
			s.reply(e.ID, nil, failed("Too many concurrent requests"), false)
		}
		return nil
	}
	ctx, cancel := context.WithCancel(s.ctx)
	r := &request{ctx, cancel, e.Method}
	if e.HasID {
		s.active[e.ID] = r
	}
	s.workers++
	go func() {
		defer cancel()
		result, failure := s.handle(ctx, e)
		s.mu.Lock()
		defer s.mu.Unlock()
		s.workers--
		delete(s.active, e.ID)
		if ctx.Err() != nil {
			result, failure = nil, cancelled()
		}
		if e.HasID && !s.closing && s.ctx.Err() == nil {
			s.reply(e.ID, result, failure, false)
		}
	}()
	return nil
}

// Caller holds mu; initialization is ordered with subsequent incoming requests.
func (s *session) initialize(raw json.RawMessage) (any, *rpcError) {
	if s.initialized {
		return nil, failed("Already initialized")
	}
	m, err := object(raw, []string{"protocolVersion", "client", "permissions", "context"}, nil)
	var version string
	if err != nil || !stringValue(m["protocolVersion"], &version) || version != "0.1" || !contextOK(m["context"]) {
		return nil, invalid()
	}
	client, err := object(m["client"], []string{"name", "version"}, nil)
	var name, clientVersion string
	if err != nil || !stringValue(client["name"], &name) || !stringValue(client["version"], &clientVersion) {
		return nil, invalid()
	}
	var permissions []json.RawMessage
	if len(m["permissions"]) == 0 || m["permissions"][0] != '[' || json.Unmarshal(m["permissions"], &permissions) != nil {
		return nil, invalid()
	}
	validated := make(map[string]bool)
	for _, rawPermission := range permissions {
		var permission string
		if !stringValue(rawPermission, &permission) {
			return nil, invalid()
		}
		validated[permission] = true
	}
	s.permissions = validated
	s.initialized = true
	return catalog(), nil
}

func (s *session) reverse(ctx context.Context, parent, method string, params map[string]any) (json.RawMessage, *rpcError) {
	s.mu.Lock()
	permission := map[string]string{"host.ui.confirm": "ui.confirm", "host.ui.notify": "ui.notify"}[method]
	if s.active[parent] == nil || ctx.Err() != nil || s.closing {
		s.mu.Unlock()
		return nil, cancelled()
	}
	if !s.permissions[permission] {
		s.mu.Unlock()
		return nil, failed("Required UI permission is missing")
	}
	s.serial++
	id := fmt.Sprintf("ext-%d", s.serial)
	ch := make(chan envelope, 1)
	s.pending[id] = ch
	params["parentRequestId"] = parent
	s.enqueue(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}, false)
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.pending, id); s.mu.Unlock() }()
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return nil, cancelled()
	case <-timer.C:
		return nil, failed("Host callback timed out")
	case reply := <-ch:
		if reply.Error != nil {
			return nil, failed("Host UI request failed")
		}
		return reply.Result, nil
	}
}

func (s *session) progress(id, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.active[id]; r != nil && r.ctx.Err() == nil && !s.closing {
		s.enqueue(map[string]any{"jsonrpc": "2.0", "method": "progress", "params": map[string]any{"requestId": id, "content": []any{map[string]any{"type": "text", "text": text}}}}, false)
	}
}

func (s *session) handle(ctx context.Context, e envelope) (any, *rpcError) {
	switch e.Method {
	case "tool.call":
		m, err := object(e.Params, []string{"name", "arguments", "context"}, nil)
		var name string
		if err != nil || !stringValue(m["name"], &name) || !contextOK(m["context"]) {
			return nil, invalid()
		}
		switch name {
		case "greet":
			args, err := object(m["arguments"], []string{"name"}, nil)
			var person string
			if err != nil || !stringValue(args["name"], &person) || utf8.RuneCountInString(person) > 100 {
				return nil, invalid()
			}
			// Check both permissions before requesting any UI action.
			s.mu.Lock()
			allowed := s.permissions["ui.confirm"] && s.permissions["ui.notify"]
			s.mu.Unlock()
			if !allowed {
				return nil, failed("Required UI permission is missing")
			}
			result, err := s.reverse(ctx, e.ID, "host.ui.confirm", map[string]any{"title": "Greeting", "message": "Greet " + person + "?"})
			if err != nil {
				return nil, err
			}
			confirm, err := object(result, []string{"confirmed"}, nil)
			var yes bool
			if err != nil || (string(confirm["confirmed"]) != "true" && string(confirm["confirmed"]) != "false") || json.Unmarshal(confirm["confirmed"], &yes) != nil {
				return nil, failed("Invalid confirmation response")
			}
			if !yes {
				return nil, failed("Greeting was not confirmed")
			}
			greeting := "Hello, " + person + "!"
			result, err = s.reverse(ctx, e.ID, "host.ui.notify", map[string]any{"message": greeting, "level": "info"})
			if err != nil {
				return nil, err
			}
			if _, err := object(result, nil, nil); err != nil {
				return nil, failed("Invalid notification response")
			}
			return textContent(greeting), nil
		case "wait":
			ms, err := waitArguments(m["arguments"])
			if err != nil {
				return nil, err
			}
			s.progress(e.ID, "Waiting...")
			timer := time.NewTimer(time.Duration(ms) * time.Millisecond)
			defer timer.Stop()
			ticker := time.NewTicker(250 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return nil, cancelled()
				case <-timer.C:
					return textContent("Finished waiting."), nil
				case <-ticker.C:
					s.progress(e.ID, "Still waiting...")
				}
			}
		default:
			return nil, invalid()
		}
	case "command.execute":
		m, err := object(e.Params, []string{"name", "arguments", "context"}, nil)
		var name, args string
		if err != nil || !stringValue(m["name"], &name) || name != "hello" || !stringValue(m["arguments"], &args) || !contextOK(m["context"]) {
			return nil, invalid()
		}
		return map[string]any{"text": hello(args)}, nil
	case "hook.run":
		m, err := object(e.Params, []string{"name", "event", "context"}, nil)
		var name string
		if err != nil || !stringValue(m["name"], &name) || !contextOK(m["context"]) {
			return nil, invalid()
		}
		var keys []string
		switch name {
		case "session_start":
			keys = []string{"reason"}
		case "before_agent_start":
			keys = []string{"prompt", "systemPrompt"}
		case "tool_call":
			keys = []string{"toolName", "toolCallId", "input"}
		default:
			return nil, invalid()
		}
		event, err := object(m["event"], keys, nil)
		if err != nil {
			return nil, err
		}
		for _, k := range keys {
			// input is opaque JSON; a no-op hook must not interpret or mutate it.
			if k != "input" {
				var value string
				if !stringValue(event[k], &value) {
					return nil, invalid()
				}
			}
		}
		return map[string]any{}, nil // No mutation, prompt replacement, or veto.
	default:
		return nil, &rpcError{-32601, "Method not found"}
	}
}
