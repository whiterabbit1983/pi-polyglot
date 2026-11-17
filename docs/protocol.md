# Pi Polyglot protocol 0.1

This is a new protocol, not Octet, MCP or Pi RPC. External programs require no Pi SDK. JSON-RPC 2.0 messages use string IDs (1–128 characters), exactly one of result/error in a response, and LF framing on stdio. Errors have integer code and string message. Notifications omit id. UTF-8 frames are limited to 1 MiB. A connection handles both directions concurrently. Unknown methods return -32601, invalid params -32602, cancelled requests -32800, failed operations -32000. Do not send results for notifications. IDs are unique per sending peer, with host IDs prefixed `pi-` and service IDs prefixed `ext-`.

## Initialization

Host sends `initialize` with `{protocolVersion:"0.1", client:{name:"pi-polyglot",version:"0.1.0"}, permissions:["ui.notify","ui.confirm"], context:{cwd:"..."}}`. Context exposes the workspace path only, not files. Server returns:

```json
{"protocolVersion":"0.1","name":"demo","tools":[{"name":"greet","description":"Greet a person","parameters":{"type":"object","properties":{"name":{"type":"string","maxLength":100}},"required":["name"],"additionalProperties":false}}],"commands":[{"name":"hello","description":"Show a greeting"}],"hooks":["session_start","before_agent_start","tool_call"]}
```

Names match `[a-z][a-z0-9_]{0,47}`. At most 64 tools, 32 commands, 3 hooks. Catalog names must be unique within their category. The catalog is static for a connection generation. Host configuration must explicitly allow declared hooks or initialization fails. Names exposed in Pi are `pg_<configured-id>_<contribution-name>`; these names differ from local protocol names. Unsupported hooks are rejected.

Tool schemas use this deliberately restricted JSON Schema subset: `type`, `description`, `title`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `minProperties`, `maxProperties`. Each tool schema is at most 64 KiB, with depth at most 24 and at most 128 properties per object. Boolean subschemas are accepted. References, regex patterns, async validators, combinators and arbitrary custom keywords are refused. The host does not coerce external arguments itself; Pi may already have applied its own input normalization.

## Host → service requests

- `tool.call`: `{name, arguments, context:{cwd}}`. Returns `{content:[{type:"text",text:"..."}],details?:<JSON object>}`. Nonempty text content only in v0.1. Tool failure uses JSON-RPC error. `details` defaults to `{}`.
- `command.execute`: `{name,arguments:<string>,context:{cwd}}`. Returns `{text?:<string>}`. Host displays text as an informational notification when UI exists.
- `hook.run`: `{name,event:<object>,context:{cwd}}`. `session_start` event exposes only `{reason}` and returns `{}`. `before_agent_start` exposes `{prompt,systemPrompt}` and returns `{systemPrompt?:<string>}`. `tool_call` exposes `{toolName,toolCallId,input}` and returns `{block?:<boolean>,reason?:<string>}`. System-prompt replacement requires explicitly enabling that hook. Tool-call policy failures block the attempted tool call. Hook handlers run in configured order.
- `shutdown`: `{}` → `{}`. Close this connection after replying; stdio exits, network services remain available for other connections.

## Notifications

- Host → service `$/cancelRequest`: `{id:<original host request ID>}`. Cooperative cancellation answers the original request with error -32800 if cancellation wins. An already-completed result may win the race. Cancellation is not rollback.
- Service → host `progress`: `{requestId:<live host request ID>,content:[{type:"text",text:"..."}]}`. Only tool requests with an update callback accept progress. Progress is not a terminal result.

## Service → host requests

Both require the corresponding local permission and a live parent request. They may occur while a host request is pending, so neither side may block its reader waiting for a callback.

- `host.ui.notify`: `{parentRequestId,message,level?:"info"|"warning"|"error"}` → `{}`.
- `host.ui.confirm`: `{parentRequestId,title,message}` → `{confirmed:<boolean>}`. Unsupported UI or missing permission is an error, never implicit approval.

Reverse calls must use the actual incoming request ID as parentRequestId. Settlement, cancellation, timeout and connection loss retire the parent. The host rejects stale IDs. Extensions must not expose credentials in results, errors or progress.

## stdio

Host launches executable with an argument array (never a shell string). stdin/stdout contain only LF-delimited envelopes; stderr contains bounded diagnostics. EOF means connection loss. One serialized writer prevents interleaved frames. Concurrent handlers are required for long operations and reverse requests.

## HTTP + SSE

All routes below are relative to the configured base URL (no trailing slash). Session creation and subsequent requests carry `Authorization: Bearer <token>` when configured. Example servers bind loopback and require `POLYGLOT_TOKEN` for HTTP/gRPC; do not expose these development servers to the Internet.

1. `POST /sessions` (empty JSON object) → HTTP 201, JSON `{sessionId:<random opaque token>}`.
2. `GET /sessions/{sessionId}/events` → `text/event-stream`. Open before sending initialize. Write/flush headers immediately. Every envelope is `data: <compact JSON>\n\n`. Send `: ready\n\n` initially; periodic SSE comments are allowed. One live event consumer per session.
3. `POST /sessions/{sessionId}/messages` with one envelope → HTTP 202 (acceptance only). Every response and reverse request goes through SSE. Process requests asynchronously; a pending confirmation must not prevent receipt of its response.
4. `DELETE /sessions/{sessionId}` → HTTP 204; cancel outstanding work, close the event stream and discard session state. Session IDs must not cross connections.

No automatic reconnection, Last-Event-ID replay or at-least-once invocation retry is supported. A lost stream fails pending calls. Bound orphan-session lifetimes on production servers. The adapter forbids redirects and non-loopback cleartext HTTP. It uses system TLS trust for HTTPS.

## gRPC

Use `proto/extension.proto`: service `pi.polyglot.v1.Extension`, bidirectional method `Connect`, `Frame { string json = 1; }`. Each frame contains exactly one of the same JSON-RPC envelopes. Each stream is a separate connection, no HTTP-style session creation. Metadata `authorization: Bearer <token>` authenticates the stream. The adapter uses TLS with system trust for non-loopback addresses; plaintext requires explicit `tls:false` and a loopback address. gRPC-Web is not supported.

## Example behavior (all four languages)

All examples have the same catalog: tools `greet` (required name string, max 100) and `wait` (milliseconds integer 0..10000), command `hello`, hooks `session_start`, `before_agent_start`, `tool_call`. `greet` requests a confirmation through host.ui.confirm, emits a host.ui.notify, and returns `Hello, <name>!`; a rejected confirmation returns an error. `wait` emits progress, waits cooperatively, returns `Finished waiting.`, or errors -32800 on cancellation. `hello` returns `{text:"Hello, <arguments or world>!"}`. Hooks return `{}` by default (no mutation/veto). Request shape and tool arguments must be checked. CLI: `--transport stdio|http|grpc --port <port>`; network examples use loopback and `POLYGLOT_TOKEN`. Dependencies are language transport libraries, not a Pi SDK.
