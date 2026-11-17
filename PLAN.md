# Pi Polyglot — implementation plan

## Agreed deliverable

- Public repository: `whiterabbit1983/pi-polyglot`.
- MIT license. No npm publication or GitHub release is implied by repository publication.
- One native TypeScript extension for Pi; external extensions can use any language capable of the documented protocol.
- Three transports: local subprocess JSONL, HTTP POST + SSE, bidirectional gRPC.
- Runnable examples in Python, Go, TypeScript and Rust, each supporting all three transports (12 combinations).
- Target and test against Pi 1.5.2 / Node.js >=22. Runtime and API compatibility are stated separately.

## 1. Architecture

Separate the Pi binding, transport implementations, JSON-RPC peer, protocol validation, configuration and examples. The Pi binding alone imports Pi types. External programs have no dependency on a Pi SDK.

A versioned JSON-RPC 2.0 contract defines initialization, tools, commands, hooks, progress, cancellation, host UI requests and shutdown. It is not Octet, MCP or Pi's own RPC protocol. gRPC carries the same JSON envelope inside a Protobuf frame: explicit trade-off for one contract, dynamic tool arguments and independent language implementations, rather than three divergent APIs.

## 2. Supported API in v0.1

- Static tools with object JSON Schemas, text results and JSON details.
- Static slash commands with string arguments and optional text responses.
- Explicit hook allowlist: `session_start` (observation), `before_agent_start` (systemPrompt replacement), `tool_call` (deny with reason). Pi still owns execution and policy.
- Request-scoped progress and cooperative cancellation.
- Reverse `host.ui.notify` and `host.ui.confirm`, gated by local configuration and correlated to a live parent request. No arbitrary execution, filesystem, credentials, full session history or generic API reflection.
- Explicit namespacing for contributed tools and commands, duplicate validation and bounded catalogs.
- Session/process teardown; no automatic replay of failed or disconnected requests.

Not in v0.1: arbitrary TUI rendering, provider plugins, synchronous JS callbacks, dynamic catalogs, durable reconnect/replay, automatic filesystem synchronization, full Pi/Octet API compatibility, browser gRPC-Web, server discovery, package marketplace or OS sandboxing.

## 3. Transports

### stdio

Spawn an explicit executable with argument array (no shell), resolve relative paths against the configuration directory, use stdin/stdout exclusively for LF-delimited JSON, bound stderr diagnostics, close/terminate owned processes on shutdown. Validate framing, cap messages and queued writes, honor backpressure and process exit.

### HTTP/SSE

Pi creates a connection with `POST /sessions`, opens `GET /sessions/{id}/events`, sends envelopes with `POST /sessions/{id}/messages`, and releases with `DELETE /sessions/{id}`. SSE carries complete JSON envelopes. No inbound listener is required on the user's computer. Authorization uses a bearer token from an environment variable; non-loopback plaintext is rejected. Session IDs isolate transport connections. No automatic stream resume or invocation replay.

### gRPC

`pi.polyglot.v1.Extension/Connect` is a bidirectional stream of `Frame { string json = 1; }`. A stream is an isolated connection. Bearer metadata and TLS protect remote connections. Local loopback plaintext is an explicit supported development case. Cancellations and protocol errors use the same JSON contract.

## 4. Protocol and safety

- Exact version handshake and supported capability subset; fail on unknown contributions.
- Unique correlation IDs, concurrent requests, bounded pending requests, deadlines and cancellation notifications.
- Every extension-to-host UI request names its live parent; stale/foreign parents are rejected.
- Strict parsing and closed envelopes, payload/catalog bounds, schema and result validation.
- Missing UI permission or missing UI support returns an error; never auto-approve.
- A failed `tool_call` policy hook must block rather than silently bypass policy.
- Config is explicit (environment-selected file), not silently discovered in arbitrary projects. Example configuration is not enabled automatically.
- Config does not contain literal authentication secrets; environment-variable references only. Remote endpoints receive only the data documented for enabled hooks/tools.
- Neither a local child nor a network service is an OS sandbox. Untrusted local code requires external isolation.

## 5. Implementation order

1. Freeze protocol, configuration examples and directory structure.
2. Implement common RPC peer and validators with unit tests.
3. Implement stdio, HTTP/SSE and gRPC clients; test transport failures.
4. Implement native Pi adapter and a fake-host contract test suite.
5. Implement four independent example services in parallel, each supporting 3 transports and greeting/confirmation/progress/cancellation demos.
6. Add integration runner for all 12 language/transport combinations.
7. Run actual Pi RPC smoke with the adapter and example command, without a paid provider call.
8. Document installation, protocol, capabilities/security and language-specific recipes; add CI and license.
9. Review repository content, lockfiles and secret exposure. Commit only project files, then create the public repository and push.

## 6. Verification gates

- TypeScript typecheck, unit tests, package entrypoint/load checks.
- Parsing, invalid envelopes, unsupported versions, catalog collisions, timeout, cancellation, unknown methods, progress, disconnect and pending-request cleanup.
- Authorization denial, stale parent rejection, unsafe remote plaintext rejection, invalid hook/result rejection.
- All four example builds and all 12 transport integrations: initialization, tool call, command, hook, reverse confirmation/notification, progress, cancellation, subsequent health, teardown.
- Real installed Pi: load extension, observe namespaced command/tool availability, run command through RPC and shut down. Model/tool execution is tested independently of provider access; no live model inference is claimed unless actually run.
- Git status/content review and public repository URL verification after push.

## 7. Documentation and publication

`README.md` gives installation, transport choice and quick start. `docs/protocol.md` is normative for v0.1. `docs/security.md` states trust and failure behavior. `examples/{python,go,typescript,rust}/README.md` provide build/run commands, dependencies and how to write a new tool or hook. `CHANGELOG.md` records the initial scope. GitHub Actions builds and tests the matrix where practical.

The final report lists the repository URL, completed test results, exact known limitations and anything not tested. A public push is publication, not proof of production hardening.
