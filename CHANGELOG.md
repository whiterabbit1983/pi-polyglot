# Changelog

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
