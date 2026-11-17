package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"
)

const maxFrame = 1 << 20
const maxConcurrent = 32
const queueSize = 64

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string     { return e.Message }
func invalid() *rpcError              { return &rpcError{-32602, "Invalid params"} }
func failed(message string) *rpcError { return &rpcError{-32000, message} }
func cancelled() *rpcError            { return &rpcError{-32800, "Request cancelled"} }

type envelope struct {
	JSONRPC  string          `json:"jsonrpc"`
	ID       string          `json:"-"`
	HasID    bool            `json:"-"`
	Method   string          `json:"method,omitempty"`
	Params   json.RawMessage `json:"params,omitempty"`
	Result   json.RawMessage `json:"result,omitempty"`
	Error    *rpcError       `json:"error,omitempty"`
	Response bool            `json:"-"`
}

// A malformed envelope closes the connection. Valid requests with invalid
// parameters receive -32602. This avoids emitting forbidden null/stringless IDs.
func decodeEnvelope(data []byte) (envelope, error) {
	var e envelope
	if len(data) > maxFrame || !utf8.Valid(data) {
		return e, errors.New("invalid frame")
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(data, &m) != nil || m == nil {
		return e, errors.New("invalid JSON object")
	}
	if json.Unmarshal(m["jsonrpc"], &e.JSONRPC) != nil || e.JSONRPC != "2.0" {
		return e, errors.New("invalid JSON-RPC version")
	}
	if v, ok := m["id"]; ok {
		e.HasID = true
		if json.Unmarshal(v, &e.ID) != nil || e.ID == "" || utf8.RuneCountInString(e.ID) > 128 {
			return e, errors.New("invalid ID")
		}
	}
	method, hasMethod := m["method"]
	result, hasResult := m["result"]
	errData, hasError := m["error"]
	if hasMethod {
		if hasResult || hasError || json.Unmarshal(method, &e.Method) != nil || e.Method == "" {
			return e, errors.New("invalid request")
		}
		e.Params = m["params"]
		if e.HasID && (len(e.ID) < 4 || e.ID[:3] != "pi-") {
			return e, errors.New("invalid host ID")
		}
	} else {
		e.Response = true
		if !e.HasID || hasResult == hasError || len(e.ID) < 5 || e.ID[:4] != "ext-" {
			return e, errors.New("invalid response")
		}
		if _, ok := m["params"]; ok {
			return e, errors.New("invalid response params")
		}
		e.Result = result
		if hasError {
			x, err := object(errData, []string{"code", "message"}, []string{"data"})
			var code int
			var message string
			if err != nil || json.Unmarshal(x["code"], &code) != nil || !stringValue(x["message"], &message) {
				return e, errors.New("invalid error")
			}
			if bytes.Equal(x["code"], []byte("null")) {
				return e, errors.New("invalid error code")
			}
			e.Error = &rpcError{code, message}
		}
	}
	return e, nil
}

func object(raw json.RawMessage, required, optional []string) (map[string]json.RawMessage, *rpcError) {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return nil, invalid()
	}
	allowed := make(map[string]bool)
	for _, k := range required {
		allowed[k] = true
		if _, ok := m[k]; !ok {
			return nil, invalid()
		}
	}
	for _, k := range optional {
		allowed[k] = true
	}
	for k := range m {
		if !allowed[k] {
			return nil, invalid()
		}
	}
	return m, nil
}

func stringValue(raw json.RawMessage, out *string) bool {
	return len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, out) == nil
}
func contextOK(raw json.RawMessage) bool {
	m, err := object(raw, []string{"cwd"}, nil)
	var cwd string
	return err == nil && stringValue(m["cwd"], &cwd)
}
func textContent(text string) map[string]any {
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}, "details": map[string]any{}}
}
func catalog() map[string]any {
	return map[string]any{
		"protocolVersion": "0.1", "name": "demo",
		"tools": []any{
			map[string]any{"name": "greet", "description": "Greet a person", "parameters": map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string", "maxLength": 100}}, "required": []string{"name"}, "additionalProperties": false}},
			map[string]any{"name": "wait", "description": "Wait with progress and cancellation", "parameters": map[string]any{"type": "object", "properties": map[string]any{"milliseconds": map[string]any{"type": "integer", "minimum": 0, "maximum": 10000}}, "required": []string{"milliseconds"}, "additionalProperties": false}},
		},
		"commands": []any{map[string]any{"name": "hello", "description": "Show a greeting"}},
		"hooks":    []string{"session_start", "before_agent_start", "tool_call"},
	}
}

func waitArguments(raw json.RawMessage) (int, *rpcError) {
	m, err := object(raw, []string{"milliseconds"}, nil)
	var n json.Number
	if err != nil || json.Unmarshal(m["milliseconds"], &n) != nil || n == "" {
		return 0, invalid()
	}
	// JSON Schema integer also accepts mathematically integral values such as 1.0.
	var f float64
	if json.Unmarshal(m["milliseconds"], &f) != nil || f < 0 || f > 10000 || f != float64(int(f)) {
		return 0, invalid()
	}
	return int(f), nil
}

func hello(s string) string {
	if s == "" {
		s = "world"
	}
	return fmt.Sprintf("Hello, %s!", s)
}
