import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER, Input, decodeKittyPrintable, getKeybindings, isKeyRelease,
  Key, matchesKey, parseKey, renderFakeCursor, setKeybindings, type Keybinding,
  stripTerminalSequences, truncateToWidth, visibleWidth,
  KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { parseDocument, type Document, type Span, type UiEvent } from "./schema.ts";

type Control = Extract<Document, { id: string }>;
type State = { node: Control; input?: Input; value?: string };
type Callbacks = {
  event(event: UiEvent): void;
  submit(result: Record<string, unknown>): void;
  cancel(): void;
  render(): void;
  dimensions(): { height: number };
};
const internalKeybindings = new TuiKeybindingsManager(TUI_KEYBINDINGS);
const forbidden = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
function clean(text: string): string {
  return stripTerminalSequences(text).replace(/\t/g, "    ").replace(forbidden, "").replace(/\p{Surrogate}/gu, "\ufffd");
}
function limit(text: string, length: number): string { return [...text].slice(0, Math.max(0, length)).join(""); }
function dimension(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0; }

/** Synchronous local component. The owner handles wire revisions, event queues and lifetime. */
export class HybridComponent {
  private document!: Document;
  private controls = new Map<string, State>();
  private order: string[] = [];
  private focusId?: string;
  private hasFocus = false;
  private disposed = false;
  private size?: { width: number; height: number };
  private scroll = 0;
  private paste: string | undefined;

  constructor(document: Document, private theme: Theme, private keybindings: KeybindingsManager, private callbacks: Callbacks) {
    this.replace(document);
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) { this.hasFocus = value; this.propagateFocus(); }

  private propagateFocus(): void {
    for (const [id, state] of this.controls) {
      if (state.input) state.input.focused = !this.disposed && this.hasFocus && id === this.focusId;
    }
  }

  private replace(document: Document): void {
    // Keep an independent validated snapshot even if a caller bypasses parseDocument.
    const next = parseDocument(document);
    const controls = new Map<string, State>();
    const visit = (node: Document): void => {
      if (node.type === "column") { node.children.forEach(visit); return; }
      if (!("id" in node)) return;
      const previous = this.controls.get(node.id);
      let state: State;
      if (previous?.node.type === node.type) {
        state = previous;
        state.node = node;
        // A surviving select keeps its value only while that value is still an option.
        // Otherwise the replacement document's declared value (or first option) wins.
        if (node.type === "select" && !node.options.some(option => option.value === state.value)) {
          state.value = node.value ?? node.options[0]!.value;
        }
      } else {
        state = { node };
        if (node.type === "input") {
          state.input = new Input({ prompt: "" });
          state.input.setValue(node.value ?? "");
          // Native setValue leaves the cursor at zero. Internal positioning must not
          // execute a user action that happens to be bound to the default end key.
          this.nativeInput(state.input, "\x05", internalKeybindings);
        } else if (node.type === "select") state.value = node.value ?? node.options[0]!.value;
      }
      controls.set(node.id, state);
    };
    visit(next);
    const old = this.focusId && this.controls.get(this.focusId);
    const surviving = this.focusId ? controls.get(this.focusId) : undefined;
    this.controls = controls;
    this.order = [...controls.keys()];
    if (!old || old.node.type !== surviving?.node.type) this.focusId = this.order[0];
    this.document = next;
    this.propagateFocus();
  }

  update(document: Document): void {
    if (this.disposed) return;
    this.replace(document);
    this.invalidate();
    this.callbacks.render();
  }

  invalidate(): void {
    for (const state of this.controls.values()) state.input?.invalidate();
    // Theme strings are deliberately never cached: the injected theme is read at render time.
  }

  private style(span: Span): string {
    let text = this.theme.fg(span.style ?? "text", span.text);
    if (span.bold) text = this.theme.bold(text);
    if (span.underline) text = this.theme.underline(text);
    return text;
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    width = dimension(width);
    const height = dimension(this.callbacks.dimensions().height);
    if (!this.size || this.size.width !== width || this.size.height !== height) {
      this.size = { width, height };
      this.callbacks.event({ type: "resize", width, height });
      if (this.disposed) return [];
    }
    this.propagateFocus();
    const lines: string[] = [];
    let focusLine: number | undefined;
    const visit = (node: Document): void => {
      switch (node.type) {
        case "column": node.children.forEach(visit); break;
        case "text": lines.push(this.style(node)); break;
        case "frame": lines.push(...node.lines.map(line => line.map(span => this.style(span)).join(""))); break;
        case "input": {
          const input = this.controls.get(node.id)!.input!;
          lines.push(this.theme.fg(node.id === this.focusId ? "accent" : "muted", node.label));
          if (node.id === this.focusId) focusLine = lines.length;
          if (!input.getValue() && node.placeholder && width > 0) {
            // Placeholder metadata can change without replacing the native editor/undo/cursor state.
            const placeholder = truncateToWidth(node.placeholder, width, "");
            const first = [...new Intl.Segmenter().segment(placeholder)][0]?.segment ?? " ";
            lines.push((input.focused ? CURSOR_MARKER + renderFakeCursor(this.theme.fg("muted", first)) : this.theme.fg("muted", first))
              + this.theme.fg("muted", placeholder.slice(first.length)));
          } else if (input.focused) lines.push(...input.render(width));
          else lines.push(this.theme.fg("text", input.getValue()));
          break;
        }
        case "select": {
          const value = this.controls.get(node.id)!.value!;
          const label = node.options.find(option => option.value === value)?.label ?? value;
          if (node.id === this.focusId) focusLine = lines.length;
          lines.push(this.theme.fg(node.id === this.focusId ? "accent" : "text", `${node.id === this.focusId ? ">" : " "} ${node.label}: ‹ ${label} ›`));
          break;
        }
        case "button":
          if (node.id === this.focusId) focusLine = lines.length;
          lines.push(this.theme.fg(node.id === this.focusId ? "accent" : "text", `${node.id === this.focusId ? ">" : " "} [ ${node.label} ]`));
          break;
        case "table": {
          const widths = node.columns.map((title, i) => Math.max(visibleWidth(title), ...node.rows.map(row => visibleWidth(row[i]!))));
          const row = (cells: string[]): string => cells.map((cell, i) => cell + " ".repeat(widths[i]! - visibleWidth(cell))).join(" │ ");
          lines.push(this.theme.bold(this.theme.fg("muted", row(node.columns))), ...node.rows.map(cells => this.theme.fg("text", row(cells))));
          break;
        }
        case "tree": lines.push(...node.items.map(item => this.theme.fg("text", `${"  ".repeat(item.depth)}${item.depth ? "└ " : ""}${item.label}`))); break;
      }
    };
    visit(this.document);
    if (focusLine !== undefined && height > 0) {
      if (focusLine < this.scroll) this.scroll = focusLine;
      if (focusLine >= this.scroll + height) this.scroll = focusLine - height + 1;
    }
    this.scroll = Math.min(this.scroll, Math.max(0, lines.length - height));
    return lines.slice(this.scroll, this.scroll + height).map(line => width ? truncateToWidth(line, width, "") : "");
  }

  private nativeInput(input: Input, data: string, keybindings: TuiKeybindingsManager = this.keybindings): void {
    // Input uses Pi's module-level manager. Scope the selected manager to this synchronous call.
    const previous = getKeybindings();
    try { setKeybindings(keybindings); input.handleInput(data); }
    finally { setKeybindings(previous); }
  }

  private text(text: string): void {
    const state = this.focusId ? this.controls.get(this.focusId) : undefined;
    text = clean(text);
    if (state?.input && state.node.type === "input") {
      const remaining = (state.node.maxLength ?? 256) - [...state.input.getValue()].length;
      text = limit(text, remaining);
      if (text) this.editInput(state, `\x1b[200~${text}\x1b[201~`);
    } else if (text) this.callbacks.event({ type: "text", text: limit(text, 4096) });
  }

  private editInput(state: State, data: string): void {
    const input = state.input!;
    const before = input.getValue();
    this.nativeInput(input, data);
    // Also constrain undo/yank. A smaller maxLength in an update must not erase existing typing.
    const max = Math.max([...before].length, state.node.type === "input" ? state.node.maxLength ?? 256 : 256);
    const safe = limit(clean(input.getValue()), max);
    if (safe !== input.getValue()) input.setValue(safe);
    if (before !== input.getValue()) this.callbacks.event({ type: "change", id: state.node.id, value: input.getValue() });
    this.callbacks.render();
  }

  handleInput(data: string): void {
    if (this.disposed || isKeyRelease(data)) return;
    // Escape is always local, including during an unfinished paste, regardless of user bindings.
    if (matchesKey(data, Key.escape)) { this.dispose(); this.callbacks.cancel(); return; }
    if (this.paste !== undefined) {
      const raw = this.paste + data;
      const end = raw.indexOf("\x1b[201~");
      if (end >= 0) {
        this.paste = undefined;
        this.text(raw.slice(0, end));
        const rest = raw.slice(end + 6);
        if (rest) this.handleInput(rest);
      } else if (raw.length > 32768) {
        // Bound incomplete terminal paste buffers; never retain unbounded input.
        this.dispose(); this.callbacks.cancel();
      } else this.paste = raw;
      return;
    }
    const start = data.indexOf("\x1b[200~");
    if (start >= 0) {
      if (start) this.handleInput(data.slice(0, start));
      if (this.disposed) return;
      this.paste = "";
      this.handleInput(data.slice(start + 6));
      return;
    }
    if (this.order.length && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
      const direction = matchesKey(data, Key.tab) ? 1 : -1;
      this.focusId = this.order[(this.order.indexOf(this.focusId!) + direction + this.order.length) % this.order.length];
      this.propagateFocus();
      this.callbacks.render();
      return;
    }
    const state = this.focusId ? this.controls.get(this.focusId) : undefined;
    if (state?.node.type === "input") {
      const ownsKey = Object.keys(this.keybindings.getResolvedBindings()).some(action =>
        (action.startsWith("tui.editor.") || action === "tui.input.submit" || action === "tui.select.cancel")
        && this.keybindings.matches(data, action as Keybinding));
      if (ownsKey || data === "\n") { this.editInput(state, data); return; }
      const printable = decodeKittyPrintable(data) ?? (!/[\u0000-\u001f\u007f-\u009f]/u.test(data) ? data : undefined);
      if (printable !== undefined) {
        const remaining = (state.node.maxLength ?? 256) - [...state.input!.getValue()].length;
        const safe = limit(clean(printable), remaining);
        if (safe) this.editInput(state, safe);
        return;
      }
      this.remoteInput(data);
      return;
    }
    if (state?.node.type === "select") {
      let step = 0;
      if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.left)) step = -1;
      if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.right)) step = 1;
      const options = state.node.options;
      const index = options.findIndex(option => option.value === state.value);
      let next = index;
      if (step) next = (Math.max(0, index) + step + options.length) % options.length;
      const first = matchesKey(data, Key.home) || this.keybindings.matches(data, "tui.select.pageUp");
      const last = matchesKey(data, Key.end) || this.keybindings.matches(data, "tui.select.pageDown");
      if (first) next = 0;
      if (last) next = options.length - 1;
      if (!step && !first && !last) {
        if (!this.keybindings.matches(data, "tui.select.confirm")) this.remoteInput(data);
        return;
      }
      if (next >= 0 && state.value !== options[next]!.value) {
        state.value = options[next]!.value;
        this.callbacks.event({ type: "change", id: state.node.id, value: state.value });
        this.callbacks.render();
      }
      return;
    }
    if (state?.node.type === "button") {
      if (matchesKey(data, Key.space) || matchesKey(data, Key.enter) || this.keybindings.matches(data, "tui.select.confirm")) {
        const values: Record<string, string> = {};
        for (const [id, field] of this.controls) {
          if (field.input) values[id] = field.input.getValue();
          else if (field.node.type === "select") values[id] = field.value!;
        }
        const action = state.node.id;
        this.dispose();
        this.callbacks.submit({ action, values });
      } else this.remoteInput(data);
      return;
    }
    this.remoteInput(data);
  }

  private remoteInput(data: string): void {
    const key = parseKey(data);
    const printable = decodeKittyPrintable(data);
    if (key === "space") this.callbacks.event({ type: "key", key });
    else if (printable !== undefined) this.text(printable);
    else if (!/[\u0000-\u001f\u007f-\u009f]/u.test(data)) this.text(data);
    else if (key) this.callbacks.event({ type: "key", key });
  }

  dispose(): void {
    this.disposed = true;
    this.paste = undefined;
    this.hasFocus = false;
    this.propagateFocus();
    this.controls.clear();
    this.order = [];
  }
}
