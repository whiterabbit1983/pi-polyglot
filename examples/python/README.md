# Python external-extension example

An independent implementation of [protocol 0.1](../../docs/protocol.md), with
stdio, HTTP + SSE, and bidirectional gRPC transports. It does not import a Pi SDK,
read workspace files, call models, or execute shell commands on behalf of requests.
All transports use the same asynchronous connection implementation.

## Setup

Use Python 3.11 or newer on Linux or macOS. From the repository root:

```sh
cd examples/python
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
```

`requirements.lock` pins every runtime and development dependency. Runtime
libraries are `aiohttp`, `grpcio`, and `protobuf`; `grpcio-tools` regenerates
bindings, and `build`/`setuptools` build the package. Everything is installed into
this example's virtual environment, never globally. stdio itself uses only the
Python standard library and does not import network libraries.

The generated gRPC bindings are included. To regenerate them from the shared,
unchanged `proto/extension.proto`, run inside `examples/python`:

```sh
.venv/bin/python scripts/generate_proto.py
```

The generator only writes to `examples/python/polyglot_example/generated/`.
The wire type is exactly `Frame { string json = 1; }`, and the RPC is
`/pi.polyglot.v1.Extension/Connect`.

## Run

These commands run from the **repository root**. The stable script also works
with an absolute path and a different working directory.

### stdio

```sh
examples/python/.venv/bin/python examples/python/server.py --transport stdio
```

The host must launch this executable with an argument array, not a shell string.
stdin/stdout contain only LF-delimited JSON-RPC envelopes. EOF ends the connection.
`--port` is accepted but unused for stdio. Do not send multiple commands and then
immediately close stdin when testing a pending operation: EOF cancels outstanding
work. Wait for replies before closing, or use the `shutdown` request.

### HTTP + SSE

```sh
export POLYGLOT_TOKEN="$(examples/python/.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(32))')"
examples/python/.venv/bin/python examples/python/server.py --transport http --port 8765
```

Configure the host base URL as `http://127.0.0.1:8765` and its bearer token to the
same value. Every request requires `Authorization: Bearer <token>`, including
session creation, SSE GET, message POST, and session DELETE.

1. `POST /sessions` with `{}` returns HTTP 201 and `{sessionId}`.
2. `GET /sessions/{sessionId}/events` immediately flushes SSE headers and
   `: ready\n\n`. Open this stream **before** sending initialize.
3. `POST /sessions/{sessionId}/messages` accepts one envelope and returns HTTP 202.
   Responses, progress, and reverse requests arrive on SSE as `data: <JSON>\n\n`.
4. `DELETE /sessions/{sessionId}` returns HTTP 204 and cancels the connection.

There is exactly one event consumer per session. There is no replay, reconnect,
or automatic request retry. Stream loss removes its session. Unopened sessions
expire after 30 seconds, checked every 5 seconds.

### gRPC

```sh
# Use the same token setup as the HTTP example.
export POLYGLOT_TOKEN="$(examples/python/.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(32))')"
examples/python/.venv/bin/python examples/python/server.py --transport grpc --port 8766
```

Connect to `127.0.0.1:8766` with a plaintext gRPC client (`tls:false` in the host
transport configuration). Each `Connect` stream requires metadata
`authorization: Bearer <token>` and has independent connection state. A client
must keep its sending side open while waiting for reverse requests and replies.

Both development servers bind **only `127.0.0.1`** and require a nonempty ASCII
`POLYGLOT_TOKEN` without spaces. They do not implement TLS or gRPC-Web. Do not
expose them to the Internet. Tokens and incoming error messages are not logged.
A JSON-RPC `shutdown` replies `{}` and closes only that connection. The network
listener and other sessions stay available. SIGINT/SIGTERM stop the network
process. Port defaults to 8765 and can be set to 1–65535.

## Contributions

Initialize with protocol version `0.1`, a client name/version, permissions, and
`context: {cwd}` as specified by the shared contract. The static catalog has:

- `greet`: `{name: string}` with a maximum of 100 characters. It requires both
  `ui.confirm` and `ui.notify`. It sends `host.ui.confirm`, waits for explicit
  approval, sends `host.ui.notify`, and returns `Hello, <name>!`. Missing permission,
  unsupported UI, a failed callback, or rejected confirmation is an error.
- `wait`: `{milliseconds: integer}` in 0–10000. It emits progress immediately and
  about every 250 ms, then returns `Finished waiting.`. `$/cancelRequest` answers
  the original request with error `-32800` if cancellation wins.
- `hello`: returns `{text: "Hello, <arguments or world>!"}`.
- `session_start`, `before_agent_start`, `tool_call`: validate their events and
  return `{}`. They never replace the system prompt or block a tool call.

Host configuration must explicitly allow all 3 declared hooks. Protocol-local
names differ from Pi's exposed `pg_<configured-id>_<contribution-name>` names.
The example does not infer permission from the presence of a UI or implicitly
approve a confirmation.

## Opt-in hybrid TUI

The additive [`tui_v1` contract](../../docs/tui-protocol.md) keeps base protocol
version `0.1`. These commands require **interactive Pi TUI** and a host adapter
that supports this feature. They do not work in Pi RPC, print, or headless mode;
the host returns an unavailable error in those modes. The Python service never
owns the terminal or sends raw ANSI sequences.

Save this configuration outside the repository, replacing `/absolute/pi-polyglot`
with your checkout path:

```json
{
  "version": 1,
  "extensions": [
    {
      "id": "python",
      "transport": "stdio",
      "command": "/absolute/pi-polyglot/examples/python/.venv/bin/python",
      "args": ["/absolute/pi-polyglot/examples/python/server.py", "--transport", "stdio"],
      "permissions": ["ui.notify", "ui.confirm", "ui.custom"],
      "hooks": ["session_start", "before_agent_start", "tool_call"],
      "uiTimeoutMs": 300000
    }
  ]
}
```

From the repository root, start interactive Pi:

```sh
PI_POLYGLOT_CONFIG=/absolute/python-ui.json pi -e ./src/index.ts
```

Then run:

```text
/pg_python_ui_form
/pg_python_ui_counter
```

- `ui_form` combines a styled frame with a local name input, target selector,
  and Deploy button. Tab/shift-tab move focus. The host handles typing,
  selection, and button submission without a remote editing round trip.
- `ui_counter` starts at 0. Up/down send remote key requests and replace the
  frame with increasing revisions. Enter closes with `{count:<number>}`.
- Escape cancels either view locally. Both commands return
  `UI result: ` followed by JSON of the open result, including cancellation.

The same opt-in commands are available over HTTP/SSE and gRPC. Keep the existing
transport settings and add `ui.custom` and, optionally, `uiTimeoutMs`.
The host default is 300000 ms; the allowed range is 1000–900000 ms.
The service uses the offered timeout only for command execution and
`host.ui.open`; ordinary reverse callbacks keep their 30-second limit.

Only a host with the `ui.custom` grant sends `optionalFeatures:["tui_v1"]` and
`ui:{timeoutMs:...}` during initialization. The example selects the offered
feature with `features:["tui_v1"]` and adds these 2 commands to its catalog.
Without that offer, the legacy catalog stays unchanged, even if the permission
is present. The catalog never changes after initialization.

## Concurrency, bounds, and failure handling

`polyglot_example/core.py` owns a connection's permissions, pending requests,
reverse callbacks, and output queue. Each transport has an independent reader
and serialized writer. A confirmation never blocks input processing or other
handlers. Every callback uses the actual incoming request ID as
`parentRequestId`; service IDs use the `ext-` prefix. Settlement, cancellation,
timeout, and connection loss retire callback state.

Custom views have generated IDs, a command parent, and per-view event locks.
`host.ui.open` stays pending while independent `ui.event` **requests** run;
notifications cannot modify a view. Counter updates and close callbacks retain
the command ID, never the event request ID. Invalid revisions, foreign parents,
and late events fail. Command completion/cancellation retires the view in a
`finally` block; disconnect clears view and negotiated connection state.

Limits are explicit:

- 1 MiB of UTF-8 JSON per frame, excluding stdio LF or the SSE wrapper;
- 32 active handlers and 32 queued outgoing frames per connection;
- 128 HTTP sessions or active gRPC streams per server;
- 30-second reverse-callback timeout, except negotiated custom UI open;
- offered `ui.timeoutMs` for commands and custom UI open on opted-in connections;
- 5-second output queue/write timeout; slow consumers lose their connection.

Malformed framing or envelopes close a connection; request parameter failures
return `-32602`, unknown methods return `-32601`, and operation failures return
`-32000`. Notifications never receive terminal results. Already-settled results
can win cancellation races. Shutdown flushes its response before closing the
transport. Connection loss cancels outstanding work and reverse futures.

These are development limits, not a production resource-isolation guarantee.
There is no distributed session store, restart recovery, request replay, or
rate limiting. Live authenticated connections can remain open indefinitely.

## Add a tool

1. Add a static tool entry to `CATALOG["tools"]` in `polyglot_example/core.py`.
   Use a unique name matching `[a-z][a-z0-9_]{0,47}` and a JSON parameter schema.
2. Add its `tool.call` branch in `Connection.dispatch`. Validate the complete
   argument shape with `shape`/`require`, including bounds and types. In Python,
   check `type(value) is int` when booleans must not count as integers.
3. Return nonempty text content, for example:

   ```python
   return {"content": [{"type": "text", "text": "Done."}], "details": {}}
   ```

4. Use cancellable `await` operations. Do not block the event loop. Bound any
   additional queues or work you introduce. Raise `RPCError` for expected failure.
5. Use `host_call(request_id, ...)` for allowed UI callbacks, never a fabricated
   parent ID. Do not put credentials in results, errors, progress, or diagnostics.
6. Add core tests and an all-transport smoke assertion. The catalog must stay
   static during a connection. No transport or protobuf change is needed.

## Add or change a hook

Protocol 0.1 permits only the 3 existing hook names. To implement behavior for
one of them, edit its validated branch in `Connection.dispatch`, keep the event
and result shape from the shared contract, and add tests. Do not declare a fourth
hook or modify the shared contract. A system-prompt replacement requires explicit
host configuration. Keep this demonstration's default behavior as `{}`; a tool
policy should never silently allow an operation after its own failure.

## Checks

Run from `examples/python`:

```sh
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m compileall -q server.py polyglot_example tests scripts
.venv/bin/python -m build --no-isolation
.venv/bin/python -m pip check
```

The unittest suite includes unit tests and real subprocess/socket smoke tests
for all 3 transports. It covers the catalog, argument validation, reverse-call
success/rejection/failure/timeout, concurrent requests during confirmation,
progress, cancellation races, all no-op hooks, auth, frame/queue limits, EOF,
SSE stream loss, session isolation, and per-connection shutdown. It makes no
model calls. The UI tests also cover opt-in negotiation, exact legacy catalog
preservation, fake-host form submission and counter open/update/close exchanges
over all 3 transports, request concurrency, invalid/late events, cancellation,
deadlines, and cleanup. These are protocol-host tests, not a real Pi terminal or
PTY rendering check. Tests use ephemeral loopback ports; a rare port-allocation
race with another process is possible.

The build writes a wheel and source archive to `dist/` without publishing them.
`python -m polyglot_example` is an alternative entry point from this directory;
a locally installed wheel also provides `polyglot-python`.

Local verification uses macOS and Python 3.14.6. Linux and other supported Python
versions need CI verification. Pi 1.5.2 adapter compatibility requires the parent
project's integration runner; these example tests emulate the protocol host.
