# Security, authority and limitations

## Trust model

The native adapter runs inside Pi with the user's OS permissions. Local stdio programs inherit that environment and can access files, network and credentials independently of the protocol. Capability settings are **not an OS sandbox**. Review local code and use external process/container isolation for untrusted work.

`PI_POLYGLOT_CONFIG` is an explicit opt-in. The adapter never searches arbitrary project folders for executable manifests. Anyone who can modify the selected configuration can change which programs or services run; protect it like executable code. Child commands use an executable plus literal argument array, never a shell string. Relative paths are anchored to the config/cwd rules in the README.

Network services have only the bridge operations the local config permits. This does not make their returned text safe: model-facing text, prompts and notifications may contain misleading instructions. Do not disclose sensitive prompts to a service you do not trust.

## Exposed data

- Initialization: adapter identity/version, granted UI permissions and workspace path.
- Tool call: tool arguments and workspace path.
- Command: argument string and workspace path.
- `session_start`: reason and workspace path.
- `before_agent_start`: current user prompt and chained system prompt (explicit hook opt-in).
- `tool_call`: tool name, call ID and arguments (explicit hook opt-in).

No automatic filesystem reads, shell execution, credential broker, message history access, provider registration or generic Pi API reflection is exposed. A path sent to a remote service does not grant access to that path.

## Reverse requests

Only `host.ui.notify` and `host.ui.confirm` exist. Each requires a configured permission and the ID of an active request on the same connection. Pending IDs expire on result, error, cancellation, timeout and disconnect. A confirmation receives a combined cancellation signal from the parent and reverse request. Missing UI returns an error, not consent. A service cannot use an old parent to show a new dialog after completion.

Pi's own extension UI semantics still apply: supported RPC dialogs work; arbitrary terminal components do not. Notifications do not constitute approvals for OS effects.

## Network boundaries

HTTP rejects redirects, URL credentials and non-loopback plaintext. gRPC rejects plaintext remote addresses and custom resolver schemes. Plaintext exemptions accept literal loopback IPs, not DNS names. Remote services require a bearer token named by `tokenEnv`; the value comes from the Pi environment. HTTPS/gRPC TLS use Node's system/default trusted certificate store. Custom CA configuration, mTLS, token refresh, OAuth and gRPC-Web are not first-class v0.1 configuration features.

Example servers bind loopback and require `POLYGLOT_TOKEN` for both network transports. They are development examples with different language-level resource controls, not hardened multi-tenant public services. For production add TLS termination, rate limiting, a per-user authentication/authorization model, operational deadlines and observability. Do not put a shared bearer token in a public config or URL.

Each HTTP session/gRPC stream creates a distinct RPC peer. A shared bearer token authorizes the whole service; session IDs are opaque routing tokens, not separate per-user identities. HTTP streams do not resume/replay on disconnect. Orphan session cleanup and idle policies are server responsibilities.

## Failure and execution semantics

- No retry or reconnect replays an invocation. Disconnect is an ambiguous outcome, not proof that no effect happened.
- Timeout/cancellation retires the host request and sends cooperative cancellation. It does not roll back an external effect and cannot force a malicious remote server to stop.
- Invalid/failed `tool_call` hook responses block the attempted tool call (fail closed). With an explicitly selected config, any configuration/startup failure retains a local guard that blocks all model tool calls until a successful reload. The adapter does not throw away that guard when a service cannot start. This does not block a person's independent shell commands or other extensions' direct OS access.
- A failed observation hook reports an error; it cannot roll back the Pi lifecycle. A failing `before_agent_start` hook throws to Pi; Pi owns the host's ultimate hook-failure behavior. Do not use that hook as an authorization gate.
- Static catalogs are validated at connection initialization. Unsupported hooks or denied hook declarations reject initialization. Contributions receive a `pg_` namespace; user-selected names must remain unique and bounded.
- Shutdown has a bounded acknowledgement window, then closes the transport. On POSIX the adapter terminates its owned stdio process group; processes that deliberately escape the group require OS isolation. Windows only has direct-child fallback cleanup and is not qualified.

## Resource and schema limits

Frames: 1 MiB including stdio LF; pending outgoing and incoming requests: 64 each; writer queues: 64. Catalogs: 64 tools, 32 commands, 3 hooks. Schema text: 64 KiB/tool and depth 24. Supported schema keywords are a deliberately narrow subset listed in the protocol. Regex schemas, `$ref`, `$async`, combinators and custom executable validators are not accepted. This reduces attack surface but is not a CPU/memory isolation guarantee.

Text results support at most 64 text parts and 262,144 characters per part, additionally bounded by frame bytes. Tool details are JSON objects. Media and resource references are not supported. Diagnostics from child stderr are drained and discarded to avoid blocking or accidental credential disclosure; use deliberate service-side logging when debugging.

## Validation scope

Local tests exercise loopback transports and a real Pi 1.5.2 RPC session without inference. They do not certify Internet deployment, malicious-server resistance under sustained load, interactive TUI behavior, Windows cleanup, remote TLS certificates/proxies or other Pi versions. The language examples have independent transport implementations; passing shared happy/error-path tests is not a complete formal conformance suite.

When reporting a vulnerability, avoid attaching bearer tokens, real user prompts, filesystem contents or credentials. Do not publish a live exploit against someone else's service.
