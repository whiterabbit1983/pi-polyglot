package main

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"time"
	"unicode/utf8"
)

type uiView struct {
	id, kind        string
	revision, count int64
	busy, closing   bool
}

func negotiateUI(m map[string]json.RawMessage, permissions map[string]bool) (time.Duration, *rpcError) {
	features, hasFeatures := m["optionalFeatures"]
	ui, hasUI := m["ui"]
	if !hasFeatures && !hasUI {
		return 0, nil
	}
	if !permissions["ui.custom"] || !hasFeatures || !hasUI {
		return 0, invalid()
	}
	var offered []json.RawMessage
	if len(features) == 0 || features[0] != '[' || json.Unmarshal(features, &offered) != nil {
		return 0, invalid()
	}
	settings, err := object(ui, []string{"timeoutMs"}, nil)
	var ms int64
	if err != nil || json.Unmarshal(settings["timeoutMs"], &ms) != nil || ms < 1000 || ms > 900000 {
		return 0, invalid()
	}
	selected := false
	for _, rawFeature := range offered {
		var feature string
		if !stringValue(rawFeature, &feature) {
			return 0, invalid()
		}
		selected = selected || feature == "tui_v1"
	}
	if selected {
		return time.Duration(ms) * time.Millisecond, nil
	}
	return 0, nil
}

func counterDocument(count int64) any {
	return map[string]any{"type": "frame", "lines": []any{
		[]any{map[string]any{"text": fmt.Sprintf("Counter: %d", count), "style": "accent", "bold": true}},
		[]any{map[string]any{"text": "Up/down: change; Enter: finish; Escape: cancel", "style": "muted"}},
	}}
}
func formDocument() any {
	return map[string]any{"type": "column", "children": []any{
		map[string]any{"type": "frame", "lines": []any{[]any{map[string]any{"text": "Choose a target", "style": "accent", "bold": true}}}},
		map[string]any{"type": "input", "id": "name", "label": "Name", "value": "Ada"},
		map[string]any{"type": "select", "id": "target", "label": "Target", "options": []any{map[string]any{"value": "dev", "label": "Development"}, map[string]any{"value": "prod", "label": "Production"}}, "value": "dev"},
		map[string]any{"type": "button", "id": "submit", "label": "Deploy"},
	}}
}

func (s *session) uiCommand(ctx context.Context, parent, kind string) (any, *rpcError) {
	s.mu.Lock()
	if s.uiTimeout == 0 {
		s.mu.Unlock()
		return nil, invalid()
	}
	s.serial++
	view := &uiView{id: fmt.Sprintf("view-%d", s.serial), kind: kind}
	s.views[parent] = view
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.views, parent); s.mu.Unlock() }()
	document := counterDocument(0)
	title := "Counter"
	if kind == "ui_form" {
		document = formDocument()
		title = "Deployment"
	}
	result, err := s.reverse(ctx, parent, "host.ui.open", map[string]any{"viewId": view.id, "title": title, "surface": "overlay", "document": document})
	if err != nil {
		return nil, err
	}
	fields, failure := object(result, []string{"cancelled"}, []string{"result", "reason"})
	if failure != nil {
		return nil, failed("Invalid UI result")
	}
	if string(fields["cancelled"]) == "true" {
		var reason string
		if !stringValue(fields["reason"], &reason) || fields["result"] != nil {
			return nil, failed("Invalid UI result")
		}
	} else if string(fields["cancelled"]) == "false" {
		var value map[string]any
		if json.Unmarshal(fields["result"], &value) != nil || value == nil || len(fields["result"]) > 16384 || fields["reason"] != nil {
			return nil, failed("Invalid UI result")
		}
	} else {
		return nil, failed("Invalid UI result")
	}
	return map[string]any{"text": fmt.Sprintf("UI result: %s", result)}, nil
}

var viewIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
var controlIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)

func safeUIText(text string) bool {
	if utf8.RuneCountInString(text) > 4096 {
		return false
	}
	for _, r := range text {
		if r < 32 || (r >= 127 && r <= 159) || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) {
			return false
		}
	}
	return true
}
func validateUIEvent(raw json.RawMessage) (map[string]json.RawMessage, string, *rpcError) {
	var head struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &head) != nil {
		return nil, "", invalid()
	}
	keys := map[string][]string{"key": {"type", "key"}, "text": {"type", "text"}, "resize": {"type", "width", "height"}, "change": {"type", "id", "value"}}[head.Type]
	if keys == nil {
		return nil, "", invalid()
	}
	event, err := object(raw, keys, nil)
	if err != nil {
		return nil, "", err
	}
	for _, key := range keys[1:] {
		if head.Type == "resize" {
			var n int64
			if json.Unmarshal(event[key], &n) != nil || n <= 0 || n > 9007199254740991 {
				return nil, "", invalid()
			}
		} else {
			var text string
			if !stringValue(event[key], &text) || !safeUIText(text) || (key == "id" && !controlIDPattern.MatchString(text)) || (key == "key" && (text == "" || len(text) > 128)) {
				return nil, "", invalid()
			}
		}
	}
	return event, head.Type, nil
}

func (s *session) uiEvent(ctx context.Context, e envelope) (any, *rpcError) {
	if !e.HasID {
		return nil, invalid()
	}
	m, err := object(e.Params, []string{"parentRequestId", "viewId", "revision", "event"}, nil)
	var parent, viewID string
	var revision int64
	if err != nil || !stringValue(m["parentRequestId"], &parent) || !stringValue(m["viewId"], &viewID) || !viewIDPattern.MatchString(viewID) || string(m["revision"]) == "null" || json.Unmarshal(m["revision"], &revision) != nil || revision < 0 || revision > 9007199254740991 {
		return nil, invalid()
	}
	event, kind, err := validateUIEvent(m["event"])
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	view, r := s.views[parent], s.active[parent]
	if s.uiTimeout == 0 || view == nil || view.id != viewID || view.closing || r == nil || r.method != "command.execute" || r.ctx.Err() != nil {
		s.mu.Unlock()
		return nil, &rpcError{-32001, "Unknown or stale UI parent/view"}
	}
	if revision != view.revision || view.busy {
		s.mu.Unlock()
		return nil, invalid()
	}
	if kind == "change" {
		var id, value string
		stringValue(event["id"], &id)
		stringValue(event["value"], &value)
		if view.kind != "ui_form" || (id != "name" && id != "target") || (id == "target" && value != "dev" && value != "prod") {
			s.mu.Unlock()
			return nil, invalid()
		}
	}
	var key string
	stringValue(event["key"], &key)
	method := ""
	params := map[string]any{"viewId": viewID}
	if view.kind == "ui_counter" && kind == "key" {
		switch key {
		case "up", "down":
			if key == "up" {
				view.count++
			} else {
				view.count--
			}
			view.revision++
			method = "host.ui.update"
			params["revision"], params["document"] = view.revision, counterDocument(view.count)
		case "enter":
			view.closing = true
			method = "host.ui.close"
			params["result"] = map[string]any{"count": view.count}
		}
	}
	if method == "" {
		s.mu.Unlock()
		return map[string]any{}, nil
	}
	view.busy = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); view.busy = false; s.mu.Unlock() }()
	result, failure := s.reverse(ctx, parent, method, params)
	if failure != nil {
		return nil, failure
	}
	if method == "host.ui.update" {
		response, failure := object(result, []string{"applied"}, nil)
		if failure != nil || string(response["applied"]) != "true" {
			return nil, failed("UI update was not applied")
		}
	} else if _, failure := object(result, nil, nil); failure != nil {
		return nil, failed("Invalid UI close result")
	}
	return map[string]any{}, nil
}
