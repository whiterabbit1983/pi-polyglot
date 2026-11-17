# Pi Polyglot

[Русская инструкция](README.ru.md) · [Verification report](docs/verification.md)

Write external [Pi](https://pi.dev) extensions in **Python, Go, TypeScript, Rust, or any language** that can implement the protocol. One native Pi adapter connects them over **stdio**, **HTTP + SSE**, or **bidirectional gRPC**.

**v0.2 is an experimental, explicitly scoped bridge**, not full compatibility with Pi's TypeScript extension API. It is not MCP, Octet's protocol, or Pi's client RPC mode. Tested host: **Pi 1.5.2**. Adapter: **Node.js 22+**. MIT licensed; no Pi SDK is needed in external programs. gRPC does require your language's transport libraries.

```text
Pi → native TypeScript adapter ┬─ stdio ───── local process
                              ├─ HTTP/SSE ── service
                              └─ gRPC ────── service
```

## What works

- Static tools with bounded object JSON Schemas and text results.
- Namespaced slash commands.
- Opt-in hooks: `session_start`, `before_agent_start`, `tool_call`.
- Progress, cooperative cancellation, deadlines, bounded pending requests.
- Permission-gated reverse UI notifications and confirmation dialogs.
- Per-connection isolation, authenticated network transports, TLS for remote endpoints.
- Opt-in hybrid TUI: custom safe text frames mixed with native local input, selectors, buttons, read-only tables and trees.
- Four example implementations, each with all three transports: **12 combinations**, with both legacy and hybrid-UI suites.

Not supported: executing arbitrary existing TypeScript TUI components, synchronous remote callbacks, provider plugins, dynamic catalogs, media results, filesystem synchronization, durable reconnection/replay, gRPC-Web, or arbitrary remote access to Pi's API. See [security and limitations](docs/security.md).

## Quick start: local development

Review the source before executing it. Prerequisites: installed Pi 1.5.2, Node.js 22+ and npm.

```sh
git clone https://github.com/whiterabbit1983/pi-polyglot.git
cd pi-polyglot
npm ci

PI_POLYGLOT_CONFIG="$PWD/examples/configs/stdio.json" \
  pi -e ./src/index.ts
```

In Pi:

```text
/pg_demo_hello reader
```

Ask the model to use `pg_demo_greet` with `{ "name": "reader" }`. The service asks Pi to show a confirmation before returning a greeting. `pg_demo_wait` accepts `{ "milliseconds": 3000 }` and demonstrates progress/cancellation. Model use needs your normal provider setup; the slash command does not.

The TypeScript example uses `tsx` from development dependencies. Production external processes must have their own installed runtime/dependencies or a compiled executable; a production-only installation of the adapter does not install every example toolchain.

### Install the adapter as a Pi package

Pi can install a reviewed Git repository (no npm registry package is published):

```sh
pi install git:github.com/whiterabbit1983/pi-polyglot
```

For a reproducible install, append `@<reviewed-commit-sha>` to that source. Set `PI_POLYGLOT_CONFIG` to your own **absolute configuration-file path** before starting Pi. Without it the adapter registers nothing and starts no processes. Do not also pass `-e` for the same adapter.

The adapter has runtime dependencies declared in `package.json`. Pi supplies its own API/types. Example programs are not automatically launched, compiled or installed by `pi install`. Clone/build the chosen example separately, or point configuration at your own program/service.

## HTTP + SSE

In a service terminal, choose a fresh test token and keep it out of shell history if it is sensitive:

```sh
export POLYGLOT_TOKEN="$(openssl rand -hex 24)"
npm run example:ts -- --transport http --port 8765
```

In the Pi terminal, set `POLYGLOT_TOKEN` to the **same value**, then:

```sh
PI_POLYGLOT_CONFIG="$PWD/examples/configs/http.json" pi -e ./src/index.ts
```

Pi opens all connections. It does not need an inbound port. POST carries outgoing messages; SSE carries responses, events and reverse requests. Network examples bind `127.0.0.1` and require a token. They are development services, not Internet-ready hosting configurations. For a remote service, use HTTPS with a certificate trusted by Node and an authenticated TLS termination layer implementing the same routes. Redirects are refused.

## gRPC

```sh
# Set the same POLYGLOT_TOKEN in both terminals.
npm run example:ts -- --transport grpc --port 8766
```

```sh
PI_POLYGLOT_CONFIG="$PWD/examples/configs/grpc.json" pi -e ./src/index.ts
```

The connection is a bidirectional `pi.polyglot.v1.Extension/Connect` stream. [`proto/extension.proto`](proto/extension.proto) wraps the **same JSON-RPC envelope** in `Frame.json`; it intentionally does not generate static types for dynamically declared tool arguments. This is real gRPC, not HTTP JSON relabeled as gRPC. Remote endpoints require TLS and `tokenEnv`; `tls:false` is permitted only for literal loopback addresses. Use TLS termination or a TLS-enabled production service; example listeners are loopback plaintext only.

## Hybrid TUI: remote rendering + local controls

Start an **interactive** Pi terminal with the opt-in example config:

```sh
PI_POLYGLOT_CONFIG="$PWD/examples/configs/tui-stdio.json" pi -e ./src/index.ts
```

Then run:

```text
/pg_demo_ui_form
/pg_demo_ui_counter
```

The form mixes a server-defined frame with Pi's native single-line input, a local selector and a submit button. Tab/Shift-Tab move focus; arrow keys select; Enter on the button submits. The counter is remotely rendered: Up/Down changes its value, Enter completes it. Escape always closes locally. Local field edits and submission do not wait for the network.

`examples/configs/tui-http.json` and `tui-grpc.json` enable the same examples over network transports. Start the corresponding server first and share its `POLYGLOT_TOKEN` with Pi. Each language example offers both UI commands when the feature is negotiated.

Grant `ui.custom` explicitly. The adapter offers `tui_v1`; the service must select it. Base protocol remains `0.1`, and old services/catalogs are unchanged when this permission is absent. UI is command-scoped and **TUI-only**: RPC/print/headless clients get an explicit unavailable error. Tools/hooks cannot acquire a custom view in this milestone.

A document can combine `column`, `text`, styled `frame`, `input`, `select`, `button`, `table` and `tree` nodes. Remote updates have increasing revisions; surviving local fields retain edits/focus. Plain text and semantic styles are validated; remote ANSI/terminal control sequences are refused. Pi owns Unicode width, focus and cursor handling. Only one view can be active across this adapter; cancellation, deadline, disconnect and session teardown close it. Inline screens reserve footer/widget space; a crowded dock can close them rather than accept hidden input. Fullscreen sizing is conservative because Pi exposes no allocated-inline-height getter.

`uiTimeoutMs` defaults to 5 minutes and is capped at 15 minutes. It applies to commands on negotiated UI connections and to open requests; ordinary tool/hook deadlines are unchanged. Frame views have keyboard/text events and resize notifications. Mouse, remote cursor primitives, multiline editors, persistent widgets, PTYs and direct curses/Bubble Tea compatibility are not provided. Read-only tables/trees are bounded and cropped; custom scrolling can be implemented by updating remote frames.

See the exact [hybrid TUI protocol](docs/tui-protocol.md) before implementing a UI service.

## Configuration

Configuration is explicit, JSON, and versioned. Paths below are examples, not files included in the repository:

```json
{
  "version": 1,
  "extensions": [
    {
      "id": "weather",
      "transport": "stdio",
      "command": "python3",
      "args": ["server.py", "--transport", "stdio"],
      "cwd": "./my-weather-extension",
      "permissions": ["ui.notify"],
      "hooks": [],
      "timeoutMs": 30000
    }
  ]
}
```

- `id` is a stable local namespace. Tools/commands become `pg_<id>_<name>`, e.g. `pg_weather_forecast`. Combined names must fit 64 characters and must not collide.
- `permissions` defaults to `[]`; supported entries are `ui.notify`, `ui.confirm` and `ui.custom`.
- `hooks` defaults to `[]`. Every hook the service declares must be allowed here; otherwise initialization fails. No silent filtering.
- `timeoutMs` defaults to 30,000; range 100–120,000. `uiTimeoutMs` defaults to 300,000; range 1,000–900,000. Cancellation is cooperative and is not rollback.
- Stdio `cwd` resolves against the config directory. Relative executable paths containing `/` also resolve against that directory. Arguments are literal; relative file arguments resolve in the child cwd. No shell interpolation.
- Stdio `env` can override environment variables. Children otherwise inherit the Pi environment: they are **trusted local code**, not sandboxed services. Never commit secrets in config.
- HTTP: `url`, optional loopback `tokenEnv`; remote `tokenEnv` is required. No credentials/query/fragment in the URL.
- gRPC: `address: "host:port"`, `tls` (default `true`), `tokenEnv`. No custom roots, client certificates or gRPC-Web in v0.1.
- Authentication values come from the named environment variable, never from the JSON file. Do not use a hostname such as `localhost` to request plaintext: use `127.0.0.1` or `[::1]`.
- Changes take effect when Pi reloads the adapter or starts a new session. Active connection catalogs do not mutate.

Enable only the hooks you trust. `before_agent_start` exposes the current prompt and system prompt. `tool_call` exposes the attempted tool name and arguments and can block execution. Remote workspace paths are metadata, not mounted files.

## Write an external extension

1. Implement the [protocol](docs/protocol.md) and one transport.
2. Return your tool/command/hook catalog from `initialize`.
3. Handle `tool.call`, `command.execute`, and `hook.run`.
4. Keep reading while a handler runs, so cancellation and reverse replies cannot deadlock.
5. Return errors with the original ID; implement `shutdown` and connection-loss cleanup.

| Language | Recipe | Runtime dependencies |
|---|---|---|
| Python | [examples/python](examples/python/README.md) | See its pinned requirements; no Pi SDK |
| Go | [examples/go](examples/go/README.md) | Standard library + gRPC/Protobuf modules |
| TypeScript | [examples/typescript](examples/typescript/README.md) | Node, transport dependencies; no Pi SDK |
| Rust | [examples/rust](examples/rust/README.md) | Tokio, HTTP and tonic/Protobuf dependencies |

All examples implement the same greeting, interruptible wait, slash command and no-op hooks. Change the catalog and dispatcher to add domain behavior. They illustrate the wire, not complete production server hardening.

## Verification

```sh
npm ci
npm run typecheck
npm test
npm run test:matrix -- typescript
npm run test:pi
```

Follow each language README to build its example, then run:

```sh
npm run test:matrix
npm run test:ui
npm run test:tui
```

`test:ui` runs the same 12 combinations with negotiated hybrid UI, local form edits/submission, remote counter updates, resize, Escape and explicit RPC-mode rejection. `test:tui` uses Python's standard-library POSIX PTY to exercise **actual interactive Pi** with the TypeScript stdio example, without inference. It is not a mocked rendering test. It checks an overlay counter, an inline form at 10 rows, resize, Escape and shutdown in regular and fullscreen modes; it does not qualify every terminal emulator or language/transport in a real PTY.

The base matrix tests all 12 combinations: initialization, Unicode, confirmation/notification callbacks, command, hooks, progress, cancellation, invalid arguments, unknown method, post-cancellation health, and (network) concurrent connection isolation and wrong-token rejection. Tests bind loopback and use a fresh synthetic token.

`test:pi` starts the **actual pinned Pi CLI** with an isolated temporary agent directory and offline mode. It checks tool registration, command execution, UI delivery and EOF shutdown without model inference or provider credentials. It does not claim live-provider, remote TLS deployment, Windows, or Pi-version-matrix qualification. Interactive TUI has the separate bounded PTY check above. GitHub Actions runs the build/test workflow; local success is not a claim that hosted CI has already passed.

## Repository map

```text
src/                  Pi binding, RPC peer, validation, configuration
src/transports/       stdio, HTTP/SSE, gRPC
src/ui/               safe documents, hybrid component and view lifecycle
proto/                gRPC transport frame definition
examples/             Python, Go, TypeScript, Rust and configs
test/                 protocol and boundary tests
scripts/              transport matrix and real Pi smoke
docs/                 wire contract and security notes
PLAN.md               implementation plan agreed before coding
```

See [CHANGELOG.md](CHANGELOG.md) and [MIT license](LICENSE).
