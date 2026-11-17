# Go external extension example

A standalone implementation of [protocol 0.1](../../docs/protocol.md), with
stdio, HTTP + SSE, and bidirectional gRPC. It uses no Pi SDK, reads no workspace
files, and makes no model calls. The host supplies a workspace path as context;
the example does not use that path to access files.

## Build and test

Requirements: Go **1.23 or later**, `make`, and a C compiler for Go's race detector.
The code supports macOS and Linux. The executable itself does not require CGO.

From this directory:

```sh
make deps
make build
make test
make check
# Optional Linux cross-build (does not run Linux tests):
make linux
```

`make` keeps downloaded dependencies and caches under `examples/go/.cache/`.
It does not run `go install` or change global Go settings. `GOTOOLCHAIN=local`
prevents automatic toolchain installation. The binary is
`examples/go/bin/polyglot-example`. `go.mod` pins dependencies and `go.sum`
records their checksums. Both files must be kept in version control.

Without `make`, first set these directory-local paths:

```sh
export GOPATH="$PWD/.cache/gopath"
export GOMODCACHE="$PWD/.cache/mod"
export GOCACHE="$PWD/.cache/build"
export GOTOOLCHAIN=local

go build -mod=readonly -o bin/polyglot-example .
go test -mod=readonly -race -count=1 -timeout=120s ./...
go vet -mod=readonly ./...
go mod verify
```

Dependencies are standard transport libraries: `google.golang.org/grpc` and
`google.golang.org/protobuf`, plus their transitive dependencies. stdio and HTTP
use the Go standard library. No `protoc` installation or code-generation tool is
needed: `grpc.go` defines a standard protobuf reflection descriptor matching
[`extension.proto`](../../proto/extension.proto). `dynamicpb` uses the normal
protobuf codec, with **`Frame { string json = 1; }`**, not a custom JSON codec.

## Run

### stdio

```sh
./bin/polyglot-example --transport stdio
```

Launch the binary directly with an argument array. Keep stdin open while calls
are pending. stdin and stdout carry only UTF-8 LF-delimited JSON-RPC envelopes.
Diagnostics go to stderr. EOF ends the connection and cancels pending work.
Do not use `echo ... | ...` for a multistep interaction: its immediate EOF is
connection loss, not a request to drain replies.

### HTTP + SSE

Generate a local token, then start the loopback development server:

```sh
export POLYGLOT_TOKEN="$(openssl rand -hex 32)"
./bin/polyglot-example --transport http --port 8787
```

Configure the host with base URL `http://127.0.0.1:8787` and the same bearer token.
Each HTTP request, including session creation, events, messages, and deletion,
must contain `Authorization: Bearer <token>`.

1. `POST /sessions`, body `{}`: receive HTTP 201 and `{"sessionId":"..."}`.
2. `GET /sessions/{sessionId}/events`: open and keep the SSE connection.
   Headers and `: ready` are flushed immediately.
3. `POST /sessions/{sessionId}/messages`: send one JSON-RPC envelope per body.
   HTTP 202 means acceptance only. Read responses and reverse calls from SSE.
4. Post responses to reverse calls to the same messages route.
5. `DELETE /sessions/{sessionId}` ends that session with HTTP 204.

Only one event consumer is allowed per session. Losing the stream deletes the
session and cancels its pending work. Reconnection and replay are not supported.

### gRPC

In another terminal, set the same token value expected by the host:

```sh
export POLYGLOT_TOKEN="<your-local-token>"
./bin/polyglot-example --transport grpc --port 8788
```

Configure the host with target `127.0.0.1:8788`, explicit `tls:false`, and the same
token. Call `pi.polyglot.v1.Extension/Connect` with metadata
`authorization: Bearer <token>`. Each bidirectional stream is an isolated
connection. Each protobuf frame contains one JSON-RPC envelope in `json`.

Both network servers bind **127.0.0.1 only**, require a nonempty `POLYGLOT_TOKEN`,
and authenticate every HTTP request or gRPC stream. These examples do not offer
TLS and must not be exposed to the Internet. A protocol `shutdown` replies `{}`
and closes **only its session/stream**; the server remains available. A process
signal, such as Ctrl-C or SIGTERM, stops the whole server and its connections.

## Catalog and behavior

The host must initialize protocol `0.1`. To use `greet`, it must grant both
`ui.confirm` and `ui.notify`. Its configuration must explicitly allow all three
declared hooks. Contributions have local names below; Pi exposes names such as
`pg_<configured-id>_greet`, rather than the local name `greet`.

- **`greet`**: `{ "name": "Ada" }`, at most 100 Unicode characters.
  Sends `host.ui.confirm`, then `host.ui.notify`, and returns text `Hello, Ada!`.
  A denied confirmation, missing permission, failed UI request, or unsupported
  UI produces an error. Neither callback is fire-and-forget. Each callback uses
  the actual incoming host request ID as `parentRequestId`.
- **`wait`**: `{ "milliseconds": 1000 }`, integer from 0 through 10000.
  Emits progress immediately and every 250 ms while pending. Returns
  `Finished waiting.`. `$/cancelRequest` cooperatively cancels it with `-32800`.
  A completed result can win a cancellation race.
- **`hello`** command: returns `Hello, <arguments>!`; empty arguments use `world`.
- **`session_start`**, **`before_agent_start`**, **`tool_call`**: validate their
  documented event shape and return `{}`. They do not replace prompts, mutate
  events, or veto tools. Tool input remains opaque JSON.

Unknown methods return `-32601`; invalid parameters return `-32602`; operation
failures return `-32000`. Notifications never receive terminal responses.
Malformed envelopes close the connection rather than generating a forbidden
null-ID response. Late callback responses are ignored. No token or host callback
error details are included in diagnostics, results, or progress.

## Opt-in hybrid TUI (`tui_v1`)

The base wire version stays `0.1`. In the adapter configuration, add
`ui.custom` to this service's permissions. Only then does the host offer
`optionalFeatures: ["tui_v1"]` and `ui: {timeoutMs: ...}` during initialize.
This example selects `features: ["tui_v1"]` and adds two commands only when the
feature is offered. Without opt-in, the legacy handshake/catalog is unchanged.
See the [hybrid TUI contract](../../docs/tui-protocol.md).

- **`ui_form`** opens a mixed frame/input/select/button deployment form.
  Name editing, target selection, focus, and submission happen locally in Pi;
  no server round trip is needed for editing or pressing the Deploy button.
- **`ui_counter`** opens a frame-only counter at 0, revision 0. Up/down change
  the count and send full documents with increasing revisions. Enter sends
  `host.ui.close` with `{count: ...}`. Escape cancels either view locally.
- Both commands await `host.ui.open` until it closes, then return
  `UI result: ` followed by the JSON-encoded open result, including cancellation.

The host sends `ui.event` requests concurrently while the command waits.
`ui.go` retains the actual command ID as `parentRequestId`, generates a separate
view ID, validates event payloads/revisions, and rejects stale or foreign views.
Resize and valid local field-change events return `{}` without redrawing.
Completion, cancellation, timeout, and connection loss remove view state and
pending open callbacks. A close acknowledgement may arrive after open completes.

The offered `ui.timeoutMs` bounds both commands and open requests on negotiated
connections. The host default is 300000 ms, with a supported range of
1000–900000 ms; configure it with `uiTimeoutMs`. Other callback deadlines remain
unchanged. Custom UI requires interactive Pi TUI: RPC/print/headless mode is
unavailable, not an implicit success. The host enforces one active view across
its adapter process. These are document-based demos, not arbitrary terminal
emulation, mouse support, or remote executable widgets. All three transports use
the same handlers.

## Concurrency and limits

Transport readers never wait for tool handlers or UI callbacks. A bounded worker
set handles requests, and one writer serializes each connection's output.
Callbacks use separate buffered response channels. Cancellation, completion,
timeout, and connection loss retire parent requests.

Development limits are explicit:

| Limit | Value |
| --- | --- |
| JSON frame | 1 MiB, validated UTF-8 |
| Concurrent handlers per connection | 32 |
| Outbound frames per connection | 64 |
| HTTP sessions / authenticated gRPC streams | 128 each |
| Unique request IDs per connection | 4096 |
| Reverse-call timeout | 30 seconds; negotiated `host.ui.open` uses `ui.timeoutMs` |
| Commands with negotiated `tui_v1` | `ui.timeoutMs` |
| HTTP session without an event consumer | 30 seconds |
| HTTP SSE write deadline | 10 seconds per write |

A full output queue or oversized/malformed frame closes the connection. Excess
concurrent calls receive an operation error. After 4096 request IDs, establish a
new connection; the bounded ID set detects duplicate IDs without growing forever.
HTTP headers and bodies also have read deadlines. SSE sends heartbeat comments.
An active but unused event stream can remain open until the client disconnects;
these are development servers, not a production multi-tenant service.

## Add a tool or hook

1. Add the tool's static name, description, and JSON Schema to `catalog()` in
   `protocol.go`. Follow the name and catalog-size limits in the protocol.
2. Add a case under `tool.call` in `session.handle()` in `session.go`. Validate the
   outer request and every argument. Return `textContent(...)` with nonempty
   text, or a protocol error. Do not perform work in `session.accept()`.
3. Use the handler context for cooperative cancellation. Use `s.progress()` for
   tool progress and `s.reverse()` for permitted host UI calls. Keep the actual
   incoming request ID; never synthesize a parent ID. Never log credentials.
4. Add tests for valid input, invalid input, cancellation, and concurrent calls.
   Run `make test check build`.

Protocol 0.1 permits only the three declared hooks; do **not** invent a fourth
hook name. To add behavior to a supported hook, change its case under `hook.run`
in `session.go`, preserve event validation, and return only the documented
fields. Any prompt replacement or tool veto must be an explicit, reviewed host
configuration choice. Keep the default handlers safe no-ops. A new hook kind
requires a coordinated protocol and host change, not just an example change.

## Test coverage and limitations

`make test` runs unit tests and live loopback smoke tests. The same behavior
suite exercises stdio, HTTP/SSE, and gRPC, including a pending confirmation while
another command completes, reverse notification, rejection, progress,
cancellation, all hooks, and shutdown. CLI subprocess tests run both network
modes and verify that a second session works after protocol shutdown. Additional
tests cover required authentication, single-consumer SSE, deletion, stream loss,
frame and queue bounds, concurrent-handler limits, session isolation, stale
callbacks, notification silence, invalid parameters, and protobuf wire format.
The race detector checks concurrent access. `ui_test.go` adds a mock UI host:
opt-in/legacy negotiation, concurrent counter events, command parent correlation,
increasing revisions, local form results, invalid/stale events, Escape, timeout,
cancellation, disconnect, unavailable-host errors, and retained-state cleanup.
These unit tests do not render a real terminal; the shared UI matrix and Pi PTY
smoke provide separate integration checks.

These tests do not load Pi itself, call a model, or test deployment TLS. Host
integration with Pi 1.5.2 belongs to the repository's integration runner. Linux
cross-compilation checks build portability only; run the test suite on Linux CI
for Linux runtime coverage.
