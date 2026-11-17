# Rust external extension example

A standalone implementation of [Pi Polyglot 0.1](../../docs/protocol.md).
It uses no Pi SDK and makes no model calls. The same protocol handler supports
stdio, HTTP + SSE, and bidirectional gRPC. Network transports are **loopback-only
development servers**, not production deployments.

## Build and test

Run these commands from `examples/rust/`:

```sh
# Keep downloaded crates and build artifacts inside this example.
export CARGO_HOME="$PWD/.cargo-home"
export CARGO_TARGET_DIR="$PWD/target"
cargo build --locked
cargo test --locked --all-targets
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
```

Use a current stable Rust toolchain with Cargo and a native linker. This example
was built and tested on macOS with Rust 1.99.0. It uses portable Tokio networking
and process APIs for Linux CI; Linux execution was not tested during development.
No global package installation is needed. `Cargo.lock` pins the dependency graph.
Crate downloads need network access on the first build; running the tests needs
only local processes and loopback sockets.

Dependencies:

- Tokio and `tokio-util`: tasks, bounded channels, I/O, cancellation.
- Axum: HTTP routes and SSE.
- Tonic and Prost: standard gRPC transport and protobuf messages.
- `tonic-build` and `protoc-bin-vendored`: build-time code generation from the
  shared `../../proto/extension.proto`, with a locally downloaded `protoc` binary.
- `serde_json`, `uuid`, `async-stream`, `futures-util`, `tokio-stream`:
  JSON, session/callback IDs, and asynchronous streams.
- Reqwest: test-only HTTP client, without TLS dependencies.

Generated bindings are in `target/`, not checked in. The proto remains unchanged:
`pi.polyglot.v1.Extension/Connect`, with `Frame { string json = 1; }`.
The generated client's transport convenience constructor is disabled because its
name would collide with the `Connect` RPC. Use `ExtensionClient::new(channel)`.

## Run

The executable is `examples/rust/target/debug/polyglot-example` relative to the
repository root. The package name is `polyglot-example`.

### stdio

```sh
./target/debug/polyglot-example --transport stdio
```

Configure the host to launch that executable with the argument array
`["--transport", "stdio"]`. Do not launch it through a shell command string.
Only LF-delimited JSON-RPC envelopes go to stdin/stdout. Bounded, fixed diagnostic
messages go to stderr. `POLYGLOT_TOKEN` is not needed for stdio.

### HTTP + SSE

```sh
export POLYGLOT_TOKEN="$(openssl rand -hex 32)"
./target/debug/polyglot-example --transport http --port 8787
```

Base URL: `http://127.0.0.1:8787`. Supply the same token through the host's secret
configuration; never place the token in a URL. Every route requires exactly one
`Authorization: Bearer <token>` header, including the SSE GET and DELETE.

1. `POST /sessions` with `{}` creates a session (201).
2. `GET /sessions/{sessionId}/events` opens SSE before sending initialize.
   Headers and an initial `: ready` comment are sent immediately. Keepalive
   comments follow every 15 seconds. A second event consumer gets 409.
3. `POST /sessions/{sessionId}/messages` submits one envelope (202). Results,
   progress, and reverse requests arrive only through SSE. Submit reverse
   responses through this same messages route.
4. `DELETE /sessions/{sessionId}` closes the session (204).

Use `Content-Type: application/json` for JSON POSTs. A messages POST before the
SSE connection opens gets 409. A full input queue gets 429, not acceptance.
Do not automatically retry accepted requests or reconnect/replay an SSE stream.
A session ID is an opaque random identifier, not a replacement for authorization.
All clients with the shared development token are trusted; this is not a
multi-tenant authorization scheme.

### gRPC

```sh
export POLYGLOT_TOKEN="$(openssl rand -hex 32)"
./target/debug/polyglot-example --transport grpc --port 8788
```

Address: `127.0.0.1:8788`, explicit plaintext (`tls: false`) in the host
configuration. Every `Connect` stream requires metadata
`authorization: Bearer <token>`. Each stream is an independent connection, even
when streams share an HTTP/2 channel. gRPC-Web is not supported.

Both network commands reject a missing/empty token before binding. Tokens must
contain 1–4096 visible ASCII characters. The servers bind specifically to
`127.0.0.1`, never to wildcard interfaces. They do not implement TLS. Do not
forward their ports to untrusted networks. The default port is 8787; explicit
ports must be in 1..65535. Ctrl+C stops a development network server.

## Contributions and host permissions

Initialize with protocol version `0.1`, client metadata, `context: {cwd: "..."}`,
and permissions `ui.confirm` and `ui.notify`. Explicitly allow all 3 declared
hooks in the host configuration, as required by the shared contract. The tools
use local names below; the adapter exposes `pg_<configured-id>_<local-name>` in Pi.

- `greet({name})`: validates a string of at most 100 Unicode characters, asks
  `host.ui.confirm`, then requests `host.ui.notify`, then returns `Hello, <name>!`.
  Both requests use the actual incoming host ID as `parentRequestId`. Missing
  permissions, rejected confirmation, failed UI requests, and malformed callback
  results fail closed. UI absence never means approval.
- `wait({milliseconds})`: validates an integer from 0 through 10000, sends an
  initial `progress` notification, waits cooperatively, then returns
  `Finished waiting.`. A winning `$/cancelRequest` returns error -32800.
- `hello`: returns `Hello, <arguments>!`, or `Hello, world!` for an empty argument
  string.
- `session_start`, `before_agent_start`, `tool_call`: validate the event shape
  and return `{}`. They do not replace prompts, veto tools, read files, or execute
  commands. The context path is validated but not used to access the filesystem.

Notifications never receive terminal results. Unknown request methods return
-32601, invalid params -32602, cancellation -32800, and operation failures -32000.
Malformed envelopes close their connection; this avoids emitting invalid null-ID
responses under the string-ID contract. Unknown or late reverse responses are
ignored after envelope validation. Peer-controlled UI error text is not reflected
into results, and credentials are never included in protocol output.

## Opt-in hybrid TUI (`tui_v1`)

The base wire version stays `0.1`. Add `ui.custom` to this service's permissions
in the adapter configuration. Only then does the host add
`optionalFeatures: ["tui_v1"]` and `ui: {timeoutMs: ...}` to initialize.
This example selects `features: ["tui_v1"]` and adds two commands only when the
feature is offered. The legacy handshake/catalog stays unchanged without opt-in.
See the [hybrid TUI contract](../../docs/tui-protocol.md).

- **`ui_form`** combines a styled frame, Name input, Target select, and Deploy
  button. Pi handles field editing, focus, selection, and submission locally;
  editing and submission do not wait for a server round trip.
- **`ui_counter`** starts at count 0, revision 0. Up/down send full replacement
  documents with increasing revisions. Enter sends `host.ui.close` with
  `{count: ...}`. Escape cancels either view locally.
- Both commands await `host.ui.open` until the view closes, then return
  `UI result: ` plus the JSON-encoded open result, including cancellation.

`src/ui.rs` handles concurrent `ui.event` requests while the command awaits open.
Each view gets a generated ID and retains the actual command `parentRequestId`,
never the event request ID. Event payloads/revisions are validated; stale or
foreign views are rejected. Resize and valid local field-change events receive
`{}` without redrawing. View/callback guards clean state on completion, timeout,
cancellation, or disconnect. A close acknowledgement can follow open completion.

The offered `ui.timeoutMs` bounds both command and open handlers on negotiated
connections. Configure the host's `uiTimeoutMs` (default 300000 ms, supported
range 1000–900000 ms). Tool and hook deadlines do not change. Custom UI requires
interactive Pi TUI; RPC/print/headless mode returns unavailable. The host enforces
one active view across its adapter process. All three transports share the same
UI handlers. These demos do not provide terminal emulation, mouse support, or
remote executable widgets.

## Concurrency, limits, and shutdown

`src/protocol.rs` owns the connection state. Its reader dispatches independent
handlers and resolves callback responses without awaiting a handler. One bounded
output queue serializes all writes. Each connection has its own permissions,
active requests, cancellation tokens, and callback map. No session shares these
objects with another session.

Limits are intentional and can be changed in the Rust sources:

| Resource | Limit / behavior |
| --- | --- |
| UTF-8 JSON frame | 1 MiB on every transport, including output |
| Input / output queues | 32 frames each per connection |
| Concurrent handlers | 32 per connection; excess requests receive -32000 |
| Host request ID history | 4096 per connection; duplicate IDs or exhaustion close it |
| HTTP sessions / gRPC streams | 32 per server; excess gets HTTP 503 / gRPC RESOURCE_EXHAUSTED |
| Queue/output I/O wait | 5 seconds; a stalled connection is closed |
| Reverse UI request | 10 seconds; negotiated `host.ui.open` uses `ui.timeoutMs` |
| Tool / command / hook handler | 30 seconds; commands with negotiated `tui_v1` use `ui.timeoutMs` |
| HTTP session without SSE | 30 seconds |
| HTTP session total lifetime | 15 minutes |

The stdio reader counts bytes before allocating a full line. HTTP request bodies
have a 1 MiB limit. gRPC has a protobuf decode/encode cap (1 MiB + 16 bytes for
protobuf overhead), plus the exact 1 MiB JSON check. These are bounded development
limits, not a full defense against connection floods or slow HTTP clients.

`shutdown` queues `{}` before closing that connection and cancelling its pending
handlers. The writer drains queued output, including the shutdown response.
stdio then exits, even if the host keeps stdin open. HTTP/gRPC servers remain
available to other sessions and future connections. EOF, transport loss, SSE
body disposal, and DELETE cancel the affected connection. Callback guards remove
pending callbacks when their parent settles, times out, or is cancelled. There
is no rollback, implicit approval, invocation retry, or reconnection.

## Add a tool or hook

### Tool

1. Add its static schema to `catalog()` in `src/protocol.rs`. Keep the shared
   naming and catalog-size limits. The catalog cannot change within a connection.
2. Add a branch under `handle()` / `tool.call`. Validate the complete request,
   context, and arguments before doing work. Return a nonempty text `content`
   array and, optionally, object `details`. Return `RpcError` for failures.
3. Keep work asynchronous and cooperatively cancellable. Do not block a Tokio
   worker or hold a mutex guard over `.await`. For CPU-heavy work, use bounded
   worker capacity and an explicit cancellation design.
4. Use `state.reverse()` for permitted host UI calls, with the incoming `id` as
   the parent. Never invent a parent ID, and never bypass permission checks.
5. Add protocol unit tests and real-transport coverage in `tests/smoke.rs`.

### Hook

Version 0.1 permits only `session_start`, `before_agent_start`, and `tool_call`;
all are already declared. To customize one, change its `hook.run` branch after
validating the prescribed event fields. Keep `{}` for a safe no-op. Only return
fields allowed for that hook by the contract. System-prompt replacement requires
explicit host opt-in. Adding a fourth hook requires a coordinated protocol
change, not just a catalog edit.

## Test coverage and limitations

`src/ui_tests.rs` adds mock UI host tests for opt-in/legacy negotiation,
concurrent counter events, parent correlation, increasing revisions, local form
results, invalid/stale events, Escape, timeout, cancellation, disconnect,
unavailable-host errors, and retained-state cleanup. These do not render a real
terminal; the shared UI matrix and Pi PTY smoke are separate integration checks.

`cargo test --locked --all-targets` runs protocol/unit tests plus real-process
smoke tests for all 3 transports. Coverage includes the catalog, reverse confirm
and notify, requests while confirmation is pending, progress, cancellation,
late replies, rejected confirmation, absent UI permissions, active-handler
capacity, malformed/oversized frames, validated no-op hooks, per-route/per-stream
authentication, HTTP body limits, gRPC frame limits, separate-session callback
maps, DELETE, and connection-only shutdown. stdio shutdown is tested with stdin
still open. Network tests require local socket binding permission.

These tests speak the shared protocol directly, not the Pi 1.5.2 adapter. The
repository-level integration runner must check adapter compatibility. No Linux
execution, model calls, production load test, or TLS deployment is claimed.
The default timeouts and orphan-session timers are development safeguards, not
an SLA. The example deliberately has no persistence, automatic replay, TLS,
filesystem access, command execution, or custom Pi integration dependency.
