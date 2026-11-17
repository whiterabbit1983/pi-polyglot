# TypeScript external extension

This is a separate Node process, not a Pi TypeScript extension. It does not import the Pi SDK. It reuses this repository's transport-neutral RPC/framing helpers; you can instead implement the documented wire independently.

## Run

From the repository root, with Node 22+:

```sh
npm ci
npm run example:ts -- --transport stdio
```

Stdio expects protocol input, not human prompts. Use `examples/configs/stdio.json` to have Pi launch it.

HTTP/SSE:

```sh
export POLYGLOT_TOKEN="$(openssl rand -hex 24)"
npm run example:ts -- --transport http --port 8765
```

Use the same token in the Pi process and select `examples/configs/http.json`. For gRPC:

```sh
npm run example:ts -- --transport grpc --port 8766
```

Select `examples/configs/grpc.json`. Network listeners bind loopback only and require the token. TLS termination and production authentication policy are deployment concerns; do not expose the example directly.

## Add a tool

Add its JSON Schema to `catalog.tools` in `server.ts` and a branch in the `tool.call` handler. Validate arguments even though Pi also validates them. Return text parts, for example:

```ts
return { content: [{ type: 'text', text: '42' }], details: {} };
```

Throw `new RpcError(-32602, 'Invalid input')` for malformed arguments. Long operations must observe the handler's `signal`. Use `peer.notify('progress', {requestId: id, content: [...]})` for updates. Never write diagnostic logs to stdout in stdio mode.

The `greet` tool demonstrates reverse `host.ui.confirm` and `host.ui.notify` requests. Pass the live handler ID as `parentRequestId` and the handler signal to the outgoing request. Do not save a parent ID for use after the handler returns.

## Commands and hooks

Declare a command in `catalog.commands`, then implement `command.execute`. The returned optional `text` appears as a notification in Pi.

Declare supported hooks in `catalog.hooks` and explicitly permit them in the host configuration. The example returns `{}` for all 3 hooks. To add context, `before_agent_start` can return `{systemPrompt: '...'}`. This **replaces** the chained system prompt; use the incoming `event.systemPrompt` deliberately. `tool_call` can return `{block:true,reason:'...'}`. The bridge exposes no general JavaScript evaluation or filesystem API.

## Hybrid TUI

Use `examples/configs/tui-stdio.json`, `tui-http.json` or `tui-grpc.json` instead of the base config. These grant `ui.custom`; normal initialization without that permission and feature offer retains the old catalog.

```sh
PI_POLYGLOT_CONFIG="$PWD/examples/configs/tui-stdio.json" pi -e ./src/index.ts
```

Run `/pg_demo_ui_form` or `/pg_demo_ui_counter` in interactive Pi. RPC/print/headless is intentionally unsupported. The form combines a server frame, local native input, select and button. Tab moves focus; Enter on the button submits. The counter handles remote Up/Down events and updates frames; Enter closes with a count. Escape always cancels locally.

`ui-demo.ts` implements both commands using the [TUI protocol](../../docs/tui-protocol.md). There is no Pi TUI import in the service. To build your own interface:

1. Select `tui_v1` only when offered. Use `ui.timeoutMs` for UI commands/open calls, not unbounded waits.
2. Inside a command, allocate a view ID and retain the actual command ID.
3. Send `host.ui.open` with a document; keep handling `ui.event` requests while it waits.
4. For server-side state changes, send a new document with a strictly increasing revision. Do not overwrite local fields by changing their IDs unless a reset is intended.
5. Close with `host.ui.close`, or use a local button. Remove service-side state in `finally`, even on cancellation/disconnect.

The open response is returned as `UI result: <JSON>` for easy inspection. Events contain the actual command `parentRequestId`; their own RPC ID is not authority to open another view. Semantic spans are plain text plus styles, never raw ANSI. Remote applications do not own terminal modes or stdin.

## Test

```sh
npm run typecheck
npm test
npm run test:matrix -- typescript
npm run test:matrix -- --ui typescript
npm run test:pi
npm run test:tui
```

The HTTP example limits sessions, queued writes and request sizes, and expires orphan sessions with no SSE consumer after 30 seconds. A connected idle SSE consumer stays valid. This is a development policy, not a durable reconnect mechanism. Every gRPC stream is a separate connection. Shutdown closes that connection, not the whole network server.
