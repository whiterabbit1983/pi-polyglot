package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

func sessionClient(t *testing.T) (*session, *wire) {
	t.Helper()
	s := newSession()
	w := newWire()
	w.send = s.accept
	w.close = s.close
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
				if frame.closeAfter {
					s.close()
					return
				}
			}
		}
	}()
	w.put(t, initJSON())
	expectResult(t, w, "pi-init")
	return s, w
}
func TestInvalidParams(t *testing.T) {
	_, w := sessionClient(t)
	cases := []any{
		toolJSON("pi-0", "greet", map[string]any{"name": strings.Repeat("x", 101)}),
		toolJSON("pi-1", "greet", map[string]any{"name": nil}),
		toolJSON("pi-2", "greet", map[string]any{"name": "Ada", "extra": 1}),
		toolJSON("pi-3", "wait", map[string]any{"milliseconds": 10001}),
		toolJSON("pi-4", "wait", map[string]any{"milliseconds": 0.5}),
		toolJSON("pi-5", "wait", map[string]any{"milliseconds": nil}),
		toolJSON("pi-6", "wait", map[string]any{"milliseconds": "10"}),
		requestJSON("pi-7", "command.execute", map[string]any{"name": "hello", "arguments": 1, "context": contextJSON()}),
		requestJSON("pi-8", "hook.run", map[string]any{"name": "session_start", "event": map[string]any{}, "context": contextJSON()}),
		requestJSON("pi-9", "tool.call", map[string]any{"name": "wait", "arguments": map[string]any{"milliseconds": 0}, "context": nil}),
	}
	for _, value := range cases {
		w.put(t, value)
		expectError(t, w, value.(map[string]any)["id"].(string), -32602)
	}
}
func TestDecodeEnvelope(t *testing.T) {
	for _, input := range []string{
		`[]`, `null`, `{}`, `{"jsonrpc":"1.0","id":"pi-1","method":"x"}`,
		`{"jsonrpc":"2.0","id":1,"method":"x"}`,
		`{"jsonrpc":"2.0","id":"ext-1","method":"x"}`,
		`{"jsonrpc":"2.0","id":"ext-1","result":{},"error":{"code":1,"message":"x"}}`,
		`{"jsonrpc":"2.0","id":"ext-1","error":{"code":null,"message":"x"}}`,
		`{"jsonrpc":"2.0","id":"ext-1","error":{"code":1.5,"message":"x"}}`,
		`{"jsonrpc":"2.0","id":"ext-1","error":{"code":1,"message":null}}`,
		strings.Repeat(" ", maxFrame+1), string([]byte{0xff}),
	} {
		if _, err := decodeEnvelope([]byte(input)); err == nil {
			t.Fatalf("accepted invalid envelope: %.100s", input)
		}
	}
	if _, err := decodeEnvelope([]byte(`{"jsonrpc":"2.0","id":"ext-1","result":null}`)); err != nil {
		t.Fatal(err)
	}
}
func TestQueueAndConcurrencyBounds(t *testing.T) {
	s := newSession()
	defer s.close()
	for i := 0; i < queueSize+1; i++ {
		s.enqueue(map[string]any{"jsonrpc": "2.0", "method": "test"}, false)
	}
	if s.ctx.Err() == nil || len(s.out) != queueSize {
		t.Fatal("unbounded queue")
	}
	s2, w := sessionClient(t)
	for i := 0; i < maxConcurrent; i++ {
		id := "pi-wait-" + strings.Repeat("x", i+1)
		w.put(t, toolJSON(id, "wait", map[string]any{"milliseconds": 10000}))
		if w.read(t)["method"] != "progress" {
			t.Fatal("expected progress")
		}
	}
	w.put(t, toolJSON("pi-overload", "wait", map[string]any{"milliseconds": 10000}))
	expectError(t, w, "pi-overload", -32000)
	s2.close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		s2.mu.Lock()
		count := s2.workers
		s2.mu.Unlock()
		if count == 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("handlers did not stop after connection loss")
}
func TestSessionIsolationAndCancelCallback(t *testing.T) {
	s1, w1 := sessionClient(t)
	_, w2 := sessionClient(t)
	w1.put(t, toolJSON("pi-greet", "greet", map[string]any{"name": "Ada"}))
	confirm := w1.read(t)
	// A callback reply in another connection cannot settle the first parent.
	w2.put(t, resultJSON(confirm["id"], map[string]any{"confirmed": true}))
	select {
	case m := <-w1.messages:
		t.Fatalf("cross-session reply: %v", m)
	case <-time.After(30 * time.Millisecond):
	}
	w1.put(t, requestJSON("", "$/cancelRequest", map[string]any{"id": "pi-greet"}))
	expectError(t, w1, "pi-greet", -32800)
	w1.put(t, resultJSON(confirm["id"], map[string]any{"confirmed": true}))
	s1.mu.Lock()
	pending := len(s1.pending)
	active := len(s1.active)
	s1.mu.Unlock()
	if pending != 0 || active != 0 {
		t.Fatal("cancelled parent or callback retained")
	}
	select {
	case m := <-w1.messages:
		t.Fatalf("late callback caused output: %v", m)
	case <-time.After(30 * time.Millisecond):
	}
}
func TestMissingPermissionAndNotification(t *testing.T) {
	s := newSession()
	defer s.close()
	init := initJSON()
	init["params"].(map[string]any)["permissions"] = []string{}
	data, _ := json.Marshal(init)
	if err := s.accept(data); err != nil {
		t.Fatal(err)
	}
	<-s.out
	data, _ = json.Marshal(toolJSON("pi-greet", "greet", map[string]any{"name": "Ada"}))
	_ = s.accept(data)
	select {
	case frame := <-s.out:
		var response map[string]any
		_ = json.Unmarshal(frame.data, &response)
		if response["error"].(map[string]any)["code"] != float64(-32000) {
			t.Fatal(response)
		}
	case <-time.After(time.Second):
		t.Fatal("missing permission did not fail")
	}
	data, _ = json.Marshal(requestJSON("", "command.execute", map[string]any{"name": "hello", "arguments": "Ada", "context": contextJSON()}))
	_ = s.accept(data)
	select {
	case frame := <-s.out:
		t.Fatalf("response to notification: %s", frame.data)
	case <-time.After(30 * time.Millisecond):
	}
}
func TestHTTPAuthAndStreamOwnership(t *testing.T) {
	h := newHTTPTransport("test-token")
	server := httptest.NewServer(h)
	t.Cleanup(func() { h.close(); server.Close() })
	w, url := httpClient(t, server.URL, "test-token")
	for _, endpoint := range []struct{ method, url string }{{"POST", server.URL + "/sessions"}, {"GET", url + "/events"}, {"POST", url + "/messages"}, {"DELETE", url}} {
		for _, token := range []string{"", "wrong"} {
			resp, err := httpRequest(http.DefaultClient, endpoint.method, endpoint.url, token, []byte("{}"))
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("auth %s: %d", endpoint.method, resp.StatusCode)
			}
		}
	}
	resp, err := httpRequest(http.DefaultClient, "GET", url+"/events", "test-token", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatal("second event consumer accepted")
	}
	resp, err = httpRequest(http.DefaultClient, "DELETE", url, "test-token", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatal(resp.StatusCode)
	}
	w.ended(t)
	resp, err = httpRequest(http.DefaultClient, "POST", url+"/messages", "test-token", []byte("{}"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatal("deleted session retained")
	}
}
func TestHTTPFrameLimitAndLostStream(t *testing.T) {
	h := newHTTPTransport("test-token")
	server := httptest.NewServer(h)
	t.Cleanup(func() { h.close(); server.Close() })
	w, url := httpClient(t, server.URL, "test-token")
	resp, err := httpRequest(http.DefaultClient, "POST", url+"/messages", "test-token", bytes.Repeat([]byte("x"), maxFrame+1))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatal(resp.StatusCode)
	}
	w.ended(t)
	w2, url2 := httpClient(t, server.URL, "test-token")
	w2.close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		resp, err = httpRequest(http.DefaultClient, "POST", url2+"/messages", "test-token", []byte("{}"))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusNotFound {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("lost stream session retained")
}
func TestProtoWireCompatibility(t *testing.T) {
	if jsonField.Kind() != protoreflect.StringKind || jsonField.Number() != 1 || frameDescriptor.FullName() != "pi.polyglot.v1.Frame" {
		t.Fatal("wrong descriptor")
	}
	encoded, err := proto.Marshal(newFrame([]byte("{}")))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, []byte{0x0a, 0x02, '{', '}'}) {
		t.Fatalf("wrong protobuf wire format: %x", encoded)
	}
}
