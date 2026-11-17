# Verification report — initial implementation

## Executed locally

Environment: macOS, Node.js 24.18.0, Pi 1.5.2, Python 3.14.6, Go 1.27.4, Rust 1.99.0. Supported minimum versions in recipes are not a claim that every minimum was independently exercised locally.

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | 14 adapter/core regression tests passed |
| `npm run test:matrix` | All 12 language/transport combinations passed |
| `npm run test:pi` | Actual Pi RPC load, tool registration, command, UI notification and EOF shutdown passed; no inference |
| Python `unittest discover -s tests -v` | 29 tests passed, including live stdio/HTTP/gRPC |
| Python `pip check` | No broken requirements |
| Go `make build test check` | Build, race-enabled tests, vet and module verification passed |
| Rust `cargo test --locked --all-targets` | 6 unit + 4 subprocess smoke tests passed |
| Rust `cargo fmt --all -- --check` | Passed |
| Rust `cargo clippy --locked --all-targets -- -D warnings` | Passed |
| `npm audit` during dependency installation | 0 reported vulnerabilities at that time |

Example authors also ran Python compileall/package builds and a Go Linux amd64 cross-build. These are build checks, not publication or Linux execution evidence.

## Integration matrix

| Language | stdio | HTTP/SSE | gRPC |
|---|---|---|---|
| Python | Passed | Passed | Passed |
| Go | Passed | Passed | Passed |
| TypeScript | Passed | Passed | Passed |
| Rust | Passed | Passed | Passed |

Each combination checks protocol initialization, Unicode text (including a Unicode line separator), confirmation/notification reverse calls, command execution, all declared hooks, progress, cancellation, invalid arguments, unknown methods, rejected confirmation and subsequent responsiveness. Network cases also check independent concurrent connections and rejection of an incorrect token without waiting for an invocation timeout.

## Review and regression fixes

An independent read-only core review found and reproduced initialization fail-open, a stale parent after serialization failure, missing hook/command cancellation, delayed gRPC authentication rejection, eviction of live idle SSE sessions, ignored stdout EOF, and request dispatch after peer closure. Fixes were applied and the reviewer verified the original reproductions no longer occurred. Follow-up review found that serialization/write failures needed separate local-error versus transport-failure treatment; the final implementation validates before admitting a parent and closes failed transports idempotently. Regression tests cover both outcomes.

The startup policy fix was additionally checked with Pi's real extension loader: a failed configured process leaves a loaded extension with a blocking tool-call handler. An HTTP 307 probe confirmed that no request was sent to the redirect destination.

## Not claimed

- No paid/live model inference was performed.
- No interactive TUI acceptance test, Windows process-tree qualification, multi-version Pi test matrix or Internet deployment test was performed.
- TLS policy is validated in configuration tests; actual remote HTTPS/gRPC certificate/proxy deployments were not exercised.
- Example servers are development implementations, not a security-audited multi-tenant hosting platform.
- GitHub Actions is configured for Linux. See the repository's live Actions status for hosted-run results; the local table above is not proof of a completed hosted run.
- Secret scanning before publication is a best-effort check of tracked content, not a guarantee that arbitrary future changes cannot contain secrets.
