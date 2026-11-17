package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func uiClient(t *testing.T) (*session, *wire) {
	t.Helper()
	s := newSession()
	w := newWire()
	w.send, w.close = s.accept, s.close
	t.Cleanup(s.close)
	go func() {
		for {
			select {
			case <-s.ctx.Done():
				return
			case frame := <-s.out:
				if !w.emit(frame.data) {
					return
				}
			}
		}
	}()
	init := initJSON()
	p := init["params"].(map[string]any)
	p["permissions"] = []string{"ui.custom"}
	p["optionalFeatures"] = []string{"tui_v1"}
	p["ui"] = map[string]any{"timeoutMs": 1000}
	w.put(t, init)
	result := expectResult(t, w, "pi-init")
	if len(result["commands"].([]any)) != 3 || result["features"].([]any)[0] != "tui_v1" {
		t.Fatal(result)
	}
	return s, w
}
func uiOpen(t *testing.T, w *wire, id, name string) map[string]any {
	t.Helper()
	w.put(t, requestJSON(id, "command.execute", map[string]any{"name": name, "arguments": "", "context": contextJSON()}))
	open := w.read(t)
	if open["method"] != "host.ui.open" {
		t.Fatal(open)
	}
	p := open["params"].(map[string]any)
	if p["parentRequestId"] != id || !viewIDPattern.MatchString(p["viewId"].(string)) {
		t.Fatal(open)
	}
	return open
}
func uiEventJSON(id string, open map[string]any, revision int, event any) map[string]any {
	p := open["params"].(map[string]any)
	return requestJSON(id, "ui.event", map[string]any{"parentRequestId": p["parentRequestId"], "viewId": p["viewId"], "revision": revision, "event": event})
}
func assertUIClean(t *testing.T, s *session) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		clean := len(s.views) == 0 && len(s.pending) == 0 && len(s.active) == 0
		s.mu.Unlock()
		if clean {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("UI state retained")
		}
		time.Sleep(time.Millisecond)
	}
}
func TestUICounterConcurrentEvents(t *testing.T) {
	s, w := uiClient(t)
	open := uiOpen(t, w, "pi-counter", "ui_counter")
	if !strings.Contains(fmt.Sprint(open), "Counter: 0") {
		t.Fatal(open)
	}
	// The command remains pending while event requests and ordinary commands run.
	w.put(t, requestJSON("pi-hello", "command.execute", map[string]any{"name": "hello", "arguments": "", "context": contextJSON()}))
	expectResult(t, w, "pi-hello")
	w.put(t, uiEventJSON("pi-resize", open, 0, map[string]any{"type": "resize", "width": 80, "height": 24}))
	expectResult(t, w, "pi-resize")
	for i, key := range []string{"up", "down", "up"} {
		id := fmt.Sprintf("pi-key%d", i)
		w.put(t, uiEventJSON(id, open, i, map[string]any{"type": "key", "key": key}))
		update := w.read(t)
		p := update["params"].(map[string]any)
		if update["method"] != "host.ui.update" || p["revision"] != float64(i+1) || p["parentRequestId"] != "pi-counter" || p["viewId"] != open["params"].(map[string]any)["viewId"] {
			t.Fatal(update)
		}
		w.put(t, resultJSON(update["id"], map[string]any{"applied": true}))
		expectResult(t, w, id)
	}
	w.put(t, uiEventJSON("pi-stale", open, 0, map[string]any{"type": "key", "key": "up"}))
	expectError(t, w, "pi-stale", -32602)
	w.put(t, uiEventJSON("pi-enter", open, 3, map[string]any{"type": "key", "key": "enter"}))
	close := w.read(t)
	if close["method"] != "host.ui.close" || close["params"].(map[string]any)["parentRequestId"] != "pi-counter" {
		t.Fatal(close)
	}
	result := map[string]any{"cancelled": false, "result": close["params"].(map[string]any)["result"]}
	// Exercise open settling BEFORE the close acknowledgement.
	w.put(t, resultJSON(open["id"], result))
	summary := expectResult(t, w, "pi-counter")["text"].(string)
	if !strings.HasPrefix(summary, "UI result: ") || !strings.Contains(summary, `"count":1`) {
		t.Fatal(summary)
	}
	w.put(t, resultJSON(close["id"], map[string]any{}))
	expectResult(t, w, "pi-enter")
	w.put(t, uiEventJSON("pi-late", open, 3, map[string]any{"type": "key", "key": "enter"}))
	expectError(t, w, "pi-late", -32001)
	assertUIClean(t, s)
}
func TestUIFormLocalResultAndInvalidEvents(t *testing.T) {
	s, w := uiClient(t)
	open := uiOpen(t, w, "pi-form", "ui_form")
	if !strings.Contains(fmt.Sprint(open), "select") || !strings.Contains(fmt.Sprint(open), "input") {
		t.Fatal(open)
	}
	for i, event := range []any{map[string]any{"type": "bogus"}, map[string]any{"type": "key", "key": 1}, map[string]any{"type": "resize", "width": 0, "height": 24}, map[string]any{"type": "change", "id": "unknown", "value": "x"}, map[string]any{"type": "text", "text": "\x1b"}} {
		id := fmt.Sprintf("pi-invalid%d", i)
		w.put(t, uiEventJSON(id, open, 0, event))
		expectError(t, w, id, -32602)
	}
	wrong := uiEventJSON("pi-wrong", open, 0, map[string]any{"type": "key", "key": "up"})
	wrong["params"].(map[string]any)["parentRequestId"] = "pi-other"
	w.put(t, wrong)
	expectError(t, w, "pi-wrong", -32001)
	wrong = uiEventJSON("pi-view", open, 0, map[string]any{"type": "key", "key": "up"})
	wrong["params"].(map[string]any)["viewId"] = "other"
	w.put(t, wrong)
	expectError(t, w, "pi-view", -32001)
	w.put(t, uiEventJSON("pi-change", open, 0, map[string]any{"type": "change", "id": "name", "value": "Grace"}))
	expectResult(t, w, "pi-change")
	result := map[string]any{"cancelled": false, "result": map[string]any{"action": "submit", "values": map[string]any{"name": "Grace", "target": "prod"}}}
	w.put(t, resultJSON(open["id"], result))
	text := expectResult(t, w, "pi-form")["text"].(string)
	var got any
	if json.Unmarshal([]byte(strings.TrimPrefix(text, "UI result: ")), &got) != nil || !strings.Contains(text, "Grace") {
		t.Fatal(text)
	}
	assertUIClean(t, s)
}
func TestUILifetime(t *testing.T) {
	for _, mode := range []string{"escape", "cancel", "timeout", "disconnect", "host-error"} {
		t.Run(mode, func(t *testing.T) {
			s, w := uiClient(t)
			open := uiOpen(t, w, "pi-open", "ui_counter")
			switch mode {
			case "escape":
				w.put(t, resultJSON(open["id"], map[string]any{"cancelled": true, "reason": "escape"}))
				expectResult(t, w, "pi-open")
			case "cancel":
				w.put(t, requestJSON("", "$/cancelRequest", map[string]any{"id": "pi-open"}))
				expectError(t, w, "pi-open", -32800)
			case "timeout":
				expectError(t, w, "pi-open", -32800)
			case "disconnect":
				s.close()
			case "host-error":
				w.put(t, map[string]any{"jsonrpc": "2.0", "id": open["id"], "error": map[string]any{"code": -32001, "message": "Unavailable"}})
				expectError(t, w, "pi-open", -32000)
			}
			assertUIClean(t, s)
			if mode != "disconnect" {
				w.put(t, uiEventJSON("pi-late", open, 0, map[string]any{"type": "key", "key": "up"}))
				expectError(t, w, "pi-late", -32001)
			}
		})
	}
}
func TestUIParentSettlesDuringUpdate(t *testing.T) {
	for _, mode := range []string{"complete", "cancel", "disconnect"} {
		t.Run(mode, func(t *testing.T) {
			s, w := uiClient(t)
			open := uiOpen(t, w, "pi-open", "ui_counter")
			w.put(t, uiEventJSON("pi-update", open, 0, map[string]any{"type": "key", "key": "up"}))
			update := w.read(t)
			if update["method"] != "host.ui.update" {
				t.Fatal(update)
			}
			switch mode {
			case "complete":
				w.put(t, resultJSON(open["id"], map[string]any{"cancelled": true, "reason": "escape"}))
			case "cancel":
				w.put(t, requestJSON("", "$/cancelRequest", map[string]any{"id": "pi-open"}))
			case "disconnect":
				s.close()
			}
			if mode != "disconnect" {
				seen := map[string]bool{}
				for i := 0; i < 2; i++ {
					msg := w.read(t)
					seen[msg["id"].(string)] = true
					if msg["id"] == "pi-update" || mode == "cancel" {
						if msg["error"].(map[string]any)["code"] != float64(-32800) {
							t.Fatal(msg)
						}
					} else if msg["result"] == nil {
						t.Fatal(msg)
					}
				}
				if !seen["pi-open"] || !seen["pi-update"] {
					t.Fatal(seen)
				}
			}
			assertUIClean(t, s)
		})
	}
}

func TestUINegotiation(t *testing.T) {
	for _, mode := range []string{"legacy", "permission-only", "unoffered", "denied", "bad-timeout", "missing-ui"} {
		t.Run(mode, func(t *testing.T) {
			s := newSession()
			defer s.close()
			msg := initJSON()
			p := msg["params"].(map[string]any)
			if mode != "legacy" {
				p["permissions"] = []string{"ui.custom"}
			}
			if mode != "legacy" && mode != "permission-only" {
				p["optionalFeatures"] = []string{"tui_v1"}
				p["ui"] = map[string]any{"timeoutMs": 300000}
			}
			switch mode {
			case "denied":
				p["permissions"] = []string{}
			case "unoffered":
				p["optionalFeatures"] = []string{"future"}
			case "bad-timeout":
				p["ui"] = map[string]any{"timeoutMs": 0}
			case "missing-ui":
				delete(p, "ui")
			}
			raw, _ := json.Marshal(p)
			got, err := s.initialize(raw)
			if mode == "denied" || mode == "bad-timeout" || mode == "missing-ui" {
				if err == nil || err.Code != -32602 {
					t.Fatal(got, err)
				}
				return
			}
			a, _ := json.Marshal(got)
			b, _ := json.Marshal(catalog())
			if string(a) != string(b) {
				t.Fatal(string(a))
			}
		})
	}
	_, w := sessionClient(t)
	w.put(t, requestJSON("pi-no-ui", "command.execute", map[string]any{"name": "ui_counter", "arguments": "", "context": contextJSON()}))
	expectError(t, w, "pi-no-ui", -32602)
}
