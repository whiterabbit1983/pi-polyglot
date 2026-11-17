package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/dynamicpb"
)

// The child runs the actual CLI, not a mock handler. No Go install is needed.
func TestMain(m *testing.M) {
	if os.Getenv("POLYGLOT_TEST_CLI") == "1" {
		main()
		return
	}
	os.Exit(m.Run())
}

type wire struct {
	send     func([]byte) error
	messages chan map[string]any
	errors   chan error
	close    func()
}

func newWire() *wire {
	return &wire{messages: make(chan map[string]any, 128), errors: make(chan error, 1)}
}
func (w *wire) emit(data []byte) bool {
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		w.errors <- err
		return false
	}
	select {
	case w.messages <- value:
		return true
	default:
		w.errors <- fmt.Errorf("test client overflow")
		return false
	}
}
func (w *wire) put(t *testing.T, v any) {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.send(data); err != nil {
		t.Fatal(err)
	}
}
func (w *wire) read(t *testing.T) map[string]any {
	t.Helper()
	select {
	case m := <-w.messages:
		return m
	case err := <-w.errors:
		// The stream can end immediately after delivering its final envelope.
		select {
		case m := <-w.messages:
			w.errors <- err
			return m
		default:
		}
		t.Fatalf("stream ended: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("response timed out")
	}
	return nil
}
func (w *wire) ended(t *testing.T) {
	t.Helper()
	select {
	case <-w.errors:
	case m := <-w.messages:
		t.Fatalf("unexpected envelope after shutdown: %v", m)
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not close")
	}
}
func requestJSON(id, method string, params any) map[string]any {
	m := map[string]any{"jsonrpc": "2.0", "method": method, "params": params}
	if id != "" {
		m["id"] = id
	}
	return m
}
func resultJSON(id any, result any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}
func contextJSON() map[string]any { return map[string]any{"cwd": "/workspace"} }
func initJSON() map[string]any {
	return requestJSON("pi-init", "initialize", map[string]any{"protocolVersion": "0.1", "client": map[string]any{"name": "test", "version": "1"}, "permissions": []string{"ui.notify", "ui.confirm"}, "context": contextJSON()})
}
func toolJSON(id, name string, args any) map[string]any {
	return requestJSON(id, "tool.call", map[string]any{"name": name, "arguments": args, "context": contextJSON()})
}
func expectResult(t *testing.T, w *wire, id string) map[string]any {
	t.Helper()
	m := w.read(t)
	if m["id"] != id || m["error"] != nil || m["result"] == nil {
		t.Fatalf("expected result %s, got %v", id, m)
	}
	return m["result"].(map[string]any)
}
func expectError(t *testing.T, w *wire, id string, code int) {
	t.Helper()
	for {
		m := w.read(t)
		if m["method"] == "progress" {
			continue
		}
		err, ok := m["error"].(map[string]any)
		if m["id"] != id || !ok || err["code"] != float64(code) {
			t.Fatalf("expected error %s/%d, got %v", id, code, m)
		}
		return
	}
}
func exercise(t *testing.T, w *wire) {
	t.Helper()
	w.put(t, initJSON())
	catalog := expectResult(t, w, "pi-init")
	if len(catalog["tools"].([]any)) != 2 || len(catalog["hooks"].([]any)) != 3 {
		t.Fatal("incorrect catalog")
	}
	w.put(t, toolJSON("pi-greet", "greet", map[string]any{"name": "Ada"}))
	confirm := w.read(t)
	if confirm["method"] != "host.ui.confirm" || confirm["params"].(map[string]any)["parentRequestId"] != "pi-greet" {
		t.Fatalf("bad confirmation: %v", confirm)
	}
	// Another request must finish while the confirmation is pending.
	w.put(t, requestJSON("pi-hello", "command.execute", map[string]any{"name": "hello", "arguments": "", "context": contextJSON()}))
	if got := expectResult(t, w, "pi-hello")["text"]; got != "Hello, world!" {
		t.Fatalf("hello: %v", got)
	}
	w.put(t, resultJSON(confirm["id"], map[string]any{"confirmed": true}))
	notify := w.read(t)
	if notify["method"] != "host.ui.notify" || notify["params"].(map[string]any)["parentRequestId"] != "pi-greet" {
		t.Fatalf("bad notification: %v", notify)
	}
	w.put(t, resultJSON(notify["id"], map[string]any{}))
	if got := expectResult(t, w, "pi-greet")["content"].([]any)[0].(map[string]any)["text"]; got != "Hello, Ada!" {
		t.Fatalf("greet: %v", got)
	}
	w.put(t, toolJSON("pi-denied", "greet", map[string]any{"name": "Ada"}))
	confirm = w.read(t)
	w.put(t, resultJSON(confirm["id"], map[string]any{"confirmed": false}))
	expectError(t, w, "pi-denied", -32000)
	w.put(t, toolJSON("pi-wait", "wait", map[string]any{"milliseconds": 10000}))
	progress := w.read(t)
	if progress["method"] != "progress" || progress["params"].(map[string]any)["requestId"] != "pi-wait" {
		t.Fatalf("bad progress: %v", progress)
	}
	w.put(t, requestJSON("", "$/cancelRequest", map[string]any{"id": "pi-wait"}))
	expectError(t, w, "pi-wait", -32800)
	w.put(t, toolJSON("pi-zero", "wait", map[string]any{"milliseconds": 0}))
	if w.read(t)["method"] != "progress" {
		t.Fatal("missing wait progress")
	}
	if got := expectResult(t, w, "pi-zero")["content"].([]any)[0].(map[string]any)["text"]; got != "Finished waiting." {
		t.Fatal(got)
	}
	for name, event := range map[string]any{
		"session_start":      map[string]any{"reason": "new"},
		"before_agent_start": map[string]any{"prompt": "prompt", "systemPrompt": "system"},
		"tool_call":          map[string]any{"toolName": "test", "toolCallId": "call", "input": map[string]any{"x": 1}},
	} {
		id := "pi-" + name
		w.put(t, requestJSON(id, "hook.run", map[string]any{"name": name, "event": event, "context": contextJSON()}))
		if len(expectResult(t, w, id)) != 0 {
			t.Fatal("hook was not a no-op")
		}
	}
	w.put(t, toolJSON("pi-invalid", "wait", map[string]any{"milliseconds": -1}))
	expectError(t, w, "pi-invalid", -32602)
	w.put(t, requestJSON("pi-unknown", "unknown", map[string]any{}))
	expectError(t, w, "pi-unknown", -32601)
	w.put(t, requestJSON("pi-shutdown", "shutdown", map[string]any{}))
	expectResult(t, w, "pi-shutdown")
	w.ended(t)
}

func stdioClient(t *testing.T) *wire {
	t.Helper()
	cmd := exec.Command(os.Args[0], "--transport", "stdio")
	cmd.Env = append(os.Environ(), "POLYGLOT_TEST_CLI=1")
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	w := newWire()
	w.send = func(data []byte) error { _, err := input.Write(append(data, '\n')); return err }
	w.close = func() { _ = input.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }
	t.Cleanup(w.close)
	go func() {
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 4096), maxFrame+2)
		for scanner.Scan() {
			if !w.emit(scanner.Bytes()) {
				return
			}
		}
		if err := scanner.Err(); err != nil {
			w.errors <- err
		} else {
			w.errors <- io.EOF
		}
	}()
	return w
}
func TestStdioSmoke(t *testing.T) { exercise(t, stdioClient(t)) }

func httpRequest(client *http.Client, method, url, token string, body []byte) (*http.Response, error) {
	r, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	r.Header.Set("Content-Type", "application/json")
	return client.Do(r)
}
func httpClient(t *testing.T, base, token string) (*wire, string) {
	t.Helper()
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := httpRequest(client, "POST", base+"/sessions", token, []byte("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 201 {
		t.Fatalf("create: %d", response.StatusCode)
	}
	var created struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	url := base + "/sessions/" + created.SessionID
	stream, err := httpRequest(http.DefaultClient, "GET", url+"/events", token, nil)
	if err != nil {
		t.Fatal(err)
	}
	if stream.StatusCode != 200 {
		stream.Body.Close()
		t.Fatalf("events: %d", stream.StatusCode)
	}
	w := newWire()
	w.send = func(data []byte) error {
		response, err := httpRequest(client, "POST", url+"/messages", token, data)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode != 202 {
			return fmt.Errorf("messages: %d", response.StatusCode)
		}
		return nil
	}
	w.close = func() { _ = stream.Body.Close() }
	t.Cleanup(w.close)
	go func() {
		scanner := bufio.NewScanner(stream.Body)
		scanner.Buffer(make([]byte, 4096), maxFrame+16)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "data: ") && !w.emit([]byte(strings.TrimPrefix(line, "data: "))) {
				return
			}
		}
		if err := scanner.Err(); err != nil {
			w.errors <- err
		} else {
			w.errors <- io.EOF
		}
	}()
	return w, url
}
func TestHTTPSmoke(t *testing.T) {
	h := newHTTPTransport("test-token")
	defer h.close()
	server := httptest.NewServer(h)
	defer server.Close()
	w, _ := httpClient(t, server.URL, "test-token")
	exercise(t, w)
	// A protocol shutdown must not stop the network server.
	w2, _ := httpClient(t, server.URL, "test-token")
	exercise(t, w2)
}
func grpcClient(t *testing.T, target, token string) *wire {
	t.Helper()
	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(maxFrame+16), grpc.MaxCallSendMsgSize(maxFrame+16)))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(metadata.AppendToOutgoingContext(context.Background(), "authorization", "Bearer "+token))
	stream, err := conn.NewStream(ctx, &grpc.StreamDesc{ClientStreams: true, ServerStreams: true}, "/pi.polyglot.v1.Extension/Connect")
	if err != nil {
		cancel()
		conn.Close()
		t.Fatal(err)
	}
	w := newWire()
	w.send = func(data []byte) error { return stream.SendMsg(newFrame(data)) }
	w.close = func() { cancel(); _ = conn.Close() }
	t.Cleanup(w.close)
	go func() {
		for {
			frame := dynamicpb.NewMessage(frameDescriptor)
			if err := stream.RecvMsg(frame); err != nil {
				w.errors <- err
				return
			}
			if !w.emit([]byte(frame.Get(jsonField).String())) {
				return
			}
		}
	}()
	return w
}
func startGRPC(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := newGRPCServer("test-token")
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { server.Stop(); _ = listener.Close() })
	return listener.Addr().String()
}
func TestGRPCSmoke(t *testing.T) {
	target := startGRPC(t)
	exercise(t, grpcClient(t, target, "test-token"))
	exercise(t, grpcClient(t, target, "test-token"))
}
func TestGRPCAuth(t *testing.T) {
	w := grpcClient(t, startGRPC(t), "wrong")
	select {
	case err := <-w.errors:
		if status.Code(err) != codes.Unauthenticated {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("authentication timed out")
	}
}
