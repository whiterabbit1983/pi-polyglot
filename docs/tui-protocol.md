# Hybrid TUI feature `tui_v1` (package 0.2)

This is an additive opt-in feature on base protocol 0.1. It is not raw terminal emulation or Pi RPC UI. Only interactive Pi TUI supports it.

## Negotiation and authority

Local config grants `permissions:["ui.custom"]` (alongside any other grants) and may set `uiTimeoutMs` (default 300000, min 1000, max 900000). Only for such connections, host initialize adds `optionalFeatures:["tui_v1"]` and `ui:{timeoutMs:<configured limit>}`. A supporting service returns `features:["tui_v1"]` in its catalog. An absent features list is legacy/no custom UI. Selecting an unoffered/unknown feature is invalid. All legacy initialization/catalogs remain valid without this permission.

Every service→host custom UI request includes `parentRequestId` and `viewId` (1–64 ASCII letters, digits, `_` or `-`). It requires a live `command.execute` parent, not a tool/hook/initialize/event parent, on the same connection. Custom UIs are command interactions in this milestone. A view cannot survive parent settlement or cancellation. `uiTimeoutMs` applies to commands on negotiated custom-UI connections and to incoming `host.ui.open`. Services must also use the offered UI timeout for their command and open handlers, rather than cancelling after their ordinary 30-second timeout. Hook and tool deadlines do not change.

Only one custom UI is active across this adapter process. A second open returns -32000 (busy); it must not silently replace the first view. RPC/print/headless mode returns -32001 (unavailable). Errors -32602 invalid params, -32001 unauthorized/stale parent, -32000 busy/UI failure, -32800 cancelled apply as in the base contract.

## Requests

Service→host `host.ui.open`:

```json
{"parentRequestId":"pi-3","viewId":"form-1","title":"Deployment","surface":"overlay","document":{"type":"column","children":[{"type":"frame","lines":[[{"text":"Choose a target","style":"accent","bold":true}]]},{"type":"input","id":"name","label":"Name","value":"Ada"},{"type":"select","id":"target","label":"Target","options":[{"value":"dev","label":"Development"},{"value":"prod","label":"Production"}],"value":"dev"},{"type":"button","id":"submit","label":"Deploy"}]}}
```

Surface is `inline` or `overlay` (default `overlay`). Open creates document revision 0 and stays pending until the user submits/cancels or the service closes it. Result is `{cancelled:false,result:<JSON object>}` or `{cancelled:true,reason:<string>}`. A local button submits `{action:<button id>,values:{<input/select id>:<string>}}`. Escape always closes locally as cancelled and is not overridable by a service. Parent/transport cancellation disposes the view; delivery of a result is not promised after transport loss.

Service→host `host.ui.update`: `{parentRequestId,viewId,revision:<positive safe integer>,document:<node>}` → `{applied:<boolean>}`. Revisions must increase; stale/equal updates return false. Documents are full replacements (no patch language). Local field values and focus survive updates for surviving IDs of the same control type; a changed ID/type resets that control. This avoids overwriting a person's typing with a delayed frame. Exception: if a select's chosen option was removed, use the new declared value or first option; this server-driven reconciliation does not emit a change event. Lowering an input's maxLength does not erase existing local typing, but prevents further growth.

Inline views reserve the space occupied by Pi's footer and widgets using the public mounted component tree. Pi has no public allocated-inline-height getter, so fullscreen accounting is conservative: an unusually tall dock can close an inline view with `render_failed` even if Pi could shrink its other widgets. A view with no remaining visible space closes before accepting more input. Use an overlay when dock space is scarce.

Service→host `host.ui.close`: `{parentRequestId,viewId,result?:<JSON object>}` → `{}`. Completes open with `{cancelled:false,result:<object or {}>}`. Late updates/close to a settled view are errors. Result is limited to 16 KiB of encoded JSON.

Host→service `ui.event`: `{parentRequestId,viewId,revision,event:<object>}` → `{}`. Handlers must be fast and concurrent with the command that is awaiting open. They can send `host.ui.update` or `host.ui.close` while handling this request. The request ID of ui.event is NOT the UI parent: preserve `parentRequestId` from params.

Events:

- `{type:"resize",width:<columns>,height:<rows>}` (initial render and changes).
- `{type:"key",key:<normalized name>}` for custom-frame input. Names include `up`, `down`, `left`, `right`, `enter`, `space`, `tab`, `shift+tab`, `backspace`, `delete`, `home`, `end`, `pageUp`, `pageDown`, or a parsed key name such as `ctrl+r`.
- `{type:"text",text:<printable text>}` for custom-frame text/paste.
- `{type:"change",id:<control id>,value:<string>}` after local input/select changes.

Controls consume their own editing/navigation keys locally. Tab/shift-tab move focus. Buttons submit locally on Enter/Space. No remote round trip is needed for field editing or submission. Remote frame-only views get normalized keys/text and can redraw in response. Resize and same-field change events are coalesced; at most 32 pending events, one in flight, each with a short deadline. Event overflow or event failure closes the view rather than leaving unbounded work. No event replay or mouse support in this profile.

## Document nodes

All objects are closed records. Root can be any node; `column` composes arbitrary frame areas and local widgets.

- `column`: `{type:"column",children:[node...]}`; at most 32 children each, total 128 nodes, depth at most 8.
- `text`: `{type:"text",text:<string>,style?:<style>,bold?:boolean}`.
- `frame`: `{type:"frame",lines:[[span...],...]}`; at most 200 lines, 64 spans/line. Span is `{text,style?,bold?,underline?}`.
- `input`: `{type:"input",id,label,value?:string,placeholder?:string,maxLength?:integer}`; maxLength default 256, range 1..4096. Single-line editor.
- `select`: `{type:"select",id,label,options:[{value,label}],value?:string}`; 1..64 unique option values.
- `button`: `{type:"button",id,label}`.
- `table`: `{type:"table",columns:[string...],rows:[[string...],...]}`; 1..8 columns, at most 100 rows; every row matches column count. Read-only.
- `tree`: `{type:"tree",items:[{label,depth}...]}`; flattened read-only tree with at most 100 items, depth 0..8.

IDs match `[a-z][a-z0-9_]{0,47}` and are unique across controls. Styles are `text`, `accent`, `muted`, `success`, `warning`, `error`. Text has no raw ANSI/ESC, C0/C1 controls (including LF/TAB), or bidi override/isolate controls; use frame lines/column children for line breaks. Strings are at most 4096 Unicode code points unless a tighter field bound applies. Encoded document limit is 64 KiB. Whole-screen cropping/layout uses terminal display columns, not UTF-16 length. Unsupported nodes/styles are errors, not executable callbacks.

Local input uses Pi's native input/cursor behavior. Semantic styles are applied at render time so theme invalidation cannot leave baked-in ANSI colors. Server frames do not get raw cursor movement, terminal modes, OSC hyperlinks/clipboard, arbitrary JS, or direct stdin/stdout ownership. This profile does not expose a remote hardware-cursor primitive; use local input nodes for cursor/IME behavior.

## Example behavior

With the feature offered, each language example selects it and adds commands `ui_form` and `ui_counter`. Without it, its old catalog is unchanged. `ui_form` opens the mixed frame/input/select/button document above and returns a text summary of the open result. `ui_counter` opens a frame-only view showing a counter; `up`/`down` adjust its value and send monotonically revisioned documents; Enter closes with `{count:<number>}`. Escape cancels either view. Examples implement ui.event concurrently and retain the actual command parent. These two commands work through all 3 existing transports.
