# Changelog

## [0.2.0]

Hybrid TUI, opt-in through `ui.custom` and negotiated `tui_v1`:

- Safe remote text frames and native local input/select/button controls in the same document, plus bounded read-only tables and trees.
- Temporary inline screens and overlays, keyboard/paste, local focus/cursor, resize events and semantic theme styles.
- Command-scoped `host.ui.open/update/close`, revision fencing, local Escape and separate interaction deadlines.
- One global custom-view slot, bounded/coalesced event dispatch, teardown on parent cancellation, disconnect, timeout or UI failure.
- Form and remote-counter demos in Python, Go, TypeScript and Rust, over every transport; legacy catalogs are unchanged without opt-in.
- Component, security, lifetime and transport integration tests; real Pi interactive PTY smoke without inference.

Base wire remains 0.1. Custom UI requires interactive TUI mode and a command parent; it is unavailable in RPC/print/headless modes and from tools/hooks. This does not execute arbitrary TypeScript components or terminal applications. Mouse, remote cursor primitives, multiline editors and persistent UI surfaces remain out of scope.

## [0.1.0]

Initial experimental implementation:

- Native Pi adapter, tested with Pi 1.5.2.
- Versioned, language-neutral JSON-RPC 2.0 contract.
- Stdio, HTTP POST/SSE and bidirectional gRPC transports.
- Static tools, slash commands and three explicit hook kinds.
- Permission-gated, live-parent-scoped UI notification/confirmation callbacks.
- Progress, cancellation, deadlines, bounded framing and connection cleanup.
- Startup fail-closed guard and fail-closed tool-call policy errors.
- Independent Python, Go and Rust examples, plus a TypeScript example using common wire helpers; all support every transport.
- Unit/regression tests, 12-combination integration runner and real Pi RPC smoke without inference.
- MIT license, protocol/security documentation and Linux GitHub Actions workflow.

Not a full Pi API implementation, OS sandbox, production Internet server package, npm release or Octet-compatible runtime.
