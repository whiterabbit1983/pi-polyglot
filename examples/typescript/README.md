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

## Test

```sh
npm run typecheck
npm test
npm run test:matrix -- typescript
npm run test:pi
```

The HTTP example limits sessions, queued writes and request sizes, and expires orphan sessions with no SSE consumer after 30 seconds. A connected idle SSE consumer stays valid. This is a development policy, not a durable reconnect mechanism. Every gRPC stream is a separate connection. Shutdown closes that connection, not the whole network server.
