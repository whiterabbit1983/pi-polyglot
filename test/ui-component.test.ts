import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager as NativeBindings, TUI_KEYBINDINGS, getKeybindings, stripTerminalSequences, visibleWidth, type KeybindingsConfig } from "@earendil-works/pi-tui";
import { HybridComponent } from "../src/ui/component.ts";
import { parseDocument, type Document, type UiEvent } from "../src/ui/schema.ts";

const field = (id = "name", value = "Ada"): Document => ({ type: "input", id, label: "Name", value });
const button: Document = { type: "button", id: "submit", label: "Deploy" };
const select: Document = { type: "select", id: "target", label: "Target", options: [{ value: "dev", label: "Development" }, { value: "prod", label: "Production" }] };
const form = (): Document => ({ type: "column", children: [{ type: "frame", lines: [[{ text: "Deploy", style: "accent", bold: true }]] }, field(), select, button] });
function harness(document: Document, bindings: KeybindingsConfig = {}) {
  let height = 24;
  let color = 31;
  let renders = 0;
  let cancelled = 0;
  const events: UiEvent[] = [];
  const submitted: Record<string, unknown>[] = [];
  const theme = {
    fg: (_token: string, text: string) => `\x1b[${color}m${text}\x1b[39m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
  } as Theme;
  const keybindings = new NativeBindings(TUI_KEYBINDINGS, bindings) as KeybindingsManager;
  const component = new HybridComponent(document, theme, keybindings, {
    event: event => events.push(event), submit: result => submitted.push(result),
    cancel: () => cancelled++, render: () => renders++, dimensions: () => ({ height }),
  });
  component.focused = true;
  return { component, events, submitted, get cancelled() { return cancelled; }, get renders() { return renders; },
    height: (value: number) => { height = value; }, color: (value: number) => { color = value; } };
}
const changes = (events: UiEvent[]) => events.filter(event => event.type === "change");

test("schema accepts every node and creates independent snapshots", () => {
  const document: Document = { type: "column", children: [form(), { type: "text", text: "Hi", bold: false },
    { type: "table", columns: ["A", "B"], rows: [["界", "🙂"]] }, { type: "tree", items: [{ label: "root", depth: 0 }, { label: "leaf", depth: 8 }] }] };
  const copy = parseDocument(document);
  assert.deepEqual(copy, document);
  assert.notEqual(copy, document);
  document.children.length = 0;
  assert.equal(copy.type === "column" && copy.children.length, 4);
});

test("schema rejects terminal escapes, control and bidi text in every string field", () => {
  for (const text of ["\x1b[31mred", "\x1b]52;c;secret\x07", "\n", "\t", "\x00", "\x7f", "\x85", "\u202e", "\u2066", "\ud800"]) {
    for (const document of [
      { type: "text", text }, { type: "frame", lines: [[{ text }]] },
      { type: "input", id: "a", label: text }, { type: "input", id: "a", label: "A", placeholder: text },
      { type: "input", id: "a", label: "A", value: text }, { type: "button", id: "a", label: text },
      { ...select, options: [{ label: "x", value: text }] }, { ...select, options: [{ label: text, value: "x" }] },
      { type: "table", columns: [text], rows: [] }, { type: "table", columns: ["x"], rows: [[text]] },
      { type: "tree", items: [{ label: text, depth: 0 }] },
    ]) assert.throws(() => parseDocument(document), /Invalid UI document/);
  }
});

test("schema closed records, ids, types, booleans and option/table shape", () => {
  const bad: unknown[] = [null, [], {}, { type: "javascript" }, { type: "text", text: "x", style: "blue" },
    { type: "text", text: "x", underline: true }, { type: "text", text: "x", bold: 1 },
    { type: "frame", lines: [[{ text: "x", bold: undefined }]] }, { type: "frame", lines: [[{ text: "x", raw: true }]] },
    { ...field(), extra: true }, { ...field(), id: "A" }, { ...field(), id: "__proto__" }, { ...field(), id: "a".repeat(49) },
    { type: "column", children: [field(), { ...button, id: "name" }] }, { ...select, options: [] },
    { ...select, options: [{ value: "x", label: "x" }, { value: "x", label: "y" }] }, { ...select, value: "missing" },
    { type: "table", columns: [], rows: [] }, { type: "table", columns: ["A"], rows: [["a", "b"]] },
    { type: "tree", items: [{ label: "a", depth: -1 }] }, { type: "tree", items: [{ label: "a", depth: 9 }] },
    { ...field(), maxLength: 1.5 }, { ...field(), maxLength: 0 }, { ...field(), maxLength: 4097 },
    { ...field(), maxLength: 2 }, { ...field(), value: undefined }, Object.assign(Object.create({}), field()),
    { type: "column", children: Array(1) },
  ];
  for (const document of bad) assert.throws(() => parseDocument(document));
  let accessed = false;
  assert.throws(() => parseDocument({ type: "text", get text() { accessed = true; return "x"; } }));
  assert.equal(accessed, false);
});

test("schema checks code points, encoded bytes, all collection limits, nodes and depth", () => {
  assert.doesNotThrow(() => parseDocument({ type: "text", text: "🙂".repeat(4096) }));
  assert.throws(() => parseDocument({ type: "text", text: "a".repeat(4097) }));
  assert.doesNotThrow(() => parseDocument({ ...field(), value: "🙂🙂", maxLength: 2 }));
  const nest = (depth: number): Document => depth === 1 ? { type: "text", text: "x" } : { type: "column", children: [nest(depth - 1)] };
  assert.doesNotThrow(() => parseDocument(nest(8)));
  assert.throws(() => parseDocument(nest(9)));
  const leaf: Document = { type: "text", text: "" };
  const count: Document = { type: "column", children: Array.from({ length: 4 }, () => ({ type: "column", children: Array(30).fill(leaf) })) };
  assert.doesNotThrow(() => parseDocument(count)); // 125 nodes
  if (count.type === "column") count.children.push({ type: "column", children: [leaf, leaf, leaf] });
  assert.throws(() => parseDocument(count)); // 129 nodes
  for (const document of [
    { type: "column", children: Array(33).fill(leaf) },
    { type: "frame", lines: Array(201).fill([]) }, { type: "frame", lines: [Array(65).fill({ text: "" })] },
    { ...select, options: Array.from({ length: 65 }, (_, i) => ({ value: `${i}`, label: "" })) },
    { type: "table", columns: Array(9).fill(""), rows: [] }, { type: "table", columns: [""], rows: Array(101).fill([""]) },
    { type: "tree", items: Array(101).fill({ label: "", depth: 0 }) },
    { type: "frame", lines: [Array(4).fill({ text: "🙂".repeat(4096) })] },
  ]) assert.throws(() => parseDocument(document));
});

test("native form editing, cursor movement, paste, selection and local submit", () => {
  const h = harness(form());
  assert.ok(h.component.render(50).join("").includes(CURSOR_MARKER));
  h.component.handleInput("!");
  h.component.handleInput("\x1b[D");
  h.component.handleInput("🙂");
  h.component.handleInput("\x1b[200~Z\n\t");
  h.component.handleInput("Q\x1b[201~");
  h.component.handleInput("\t");
  h.component.handleInput("\x1b[B");
  h.component.handleInput("\t");
  h.component.handleInput(" ");
  assert.deepEqual(h.submitted, [{ action: "submit", values: { name: "Ada🙂Z    Q!", target: "prod" } }]);
  assert.equal(changes(h.events).length, 4);
  assert.equal(h.cancelled, 0);
  assert.ok(h.renders > 0);
  assert.deepEqual(h.component.render(20), []);
});

test("cyclic Tab and Shift-Tab, focus propagation and Escape cannot be rebound", () => {
  const h = harness(form(), { "tui.select.cancel": "ctrl+x" });
  h.component.handleInput("\x1b[Z"); // first -> last
  assert.match(stripTerminalSequences(h.component.render(40).join("\n")), /> \[ Deploy \]/);
  h.component.handleInput("\t"); // last -> first
  assert.ok(h.component.render(40).join("").includes(CURSOR_MARKER));
  h.component.focused = false;
  assert.ok(!h.component.render(40).join("").includes(CURSOR_MARKER));
  h.component.focused = true;
  h.component.handleInput("\x1b");
  h.component.handleInput("\x1b");
  assert.equal(h.cancelled, 1);
  assert.deepEqual(h.component.render(40), []);
});

test("updates preserve values, native cursor, undo and focus by id/type across reordering", () => {
  const h = harness(form(), { "tui.editor.undo": "alt+z" });
  h.component.handleInput("!");
  h.component.handleInput("\x1b[D");
  h.component.update({ type: "column", children: [button, { type: "text", text: "new frame" }, field("name", "remote overwrite"), select] });
  h.component.handleInput("X");
  assert.equal(changes(h.events).at(-1)?.value, "AdaX!");
  h.component.handleInput("\x1bz"); // native undo
  assert.equal(changes(h.events).at(-1)?.value, "Ada!");
  h.component.handleInput("\t");
  h.component.handleInput("\x1b[B");
  h.component.update(form());
  assert.match(stripTerminalSequences(h.component.render(60).join("\n")), /> Target: ‹ Production ›/);
  h.component.handleInput("\t");
  h.component.handleInput("\r");
  assert.deepEqual(h.submitted[0], { action: "submit", values: { name: "Ada!", target: "prod" } });
});

test("changed id/type resets controls; removed focus falls back to first control", () => {
  const h = harness(form());
  h.component.handleInput("!");
  h.component.update({ type: "column", children: [{ ...select, id: "name" }, field("new_name", "New"), button] });
  h.component.handleInput("\x1b[B");
  h.component.update({ type: "column", children: [field("new_name", "ignored"), button] });
  h.component.handleInput("!");
  h.component.handleInput("\t");
  h.component.handleInput("\r");
  assert.deepEqual(h.submitted[0], { action: "submit", values: { new_name: "New!" } });
});

test("frame-only keys, Unicode text, Kitty, paste, release and resize notifications", () => {
  const h = harness({ type: "frame", lines: [[{ text: "Counter" }]] });
  h.component.render(20); h.component.render(20);
  h.height(10); h.component.render(20); h.component.render(3);
  h.component.handleInput("\x1b[A"); h.component.handleInput("\r"); h.component.handleInput(" ");
  h.component.handleInput("\t"); h.component.handleInput("\x1b[Z"); h.component.handleInput("\x12");
  h.component.handleInput("界é🙂"); h.component.handleInput("\x1b[97u");
  h.component.handleInput("\x1b[97;1:3u");
  h.component.handleInput("\x1b[200~a\x1b[31mb\x1b[0m\u202e\n\x1b[201~");
  assert.deepEqual(h.events, [
    { type: "resize", width: 20, height: 24 }, { type: "resize", width: 20, height: 10 }, { type: "resize", width: 3, height: 10 },
    ...["up", "enter", "space", "tab", "shift+tab", "ctrl+r"].map(key => ({ type: "key", key })),
    { type: "text", text: "界é🙂" }, { type: "text", text: "a" }, { type: "text", text: "ab" },
  ]);
});

test("all render lines fit narrow widths; focus remains visible under height cropping", () => {
  const h = harness({ type: "column", children: [
    { type: "text", text: "界🙂é", style: "success", bold: true },
    { type: "frame", lines: [[{ text: "🙂", underline: true }, { text: "界é", style: "warning" }]] },
    { type: "table", columns: ["界", "🙂"], rows: [["é", "long"]] },
    { type: "tree", items: [{ label: "🙂界é", depth: 8 }] }, field("name", "🙂界é"), button,
  ] });
  for (const width of [80, 12, 4, 3, 2, 1, 0, 30]) {
    const lines = h.component.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
  }
  h.height(1);
  assert.equal(h.component.render(8).length, 1);
  assert.ok(h.component.render(8)[0]!.includes(CURSOR_MARKER));
  h.component.handleInput("\t");
  assert.match(stripTerminalSequences(h.component.render(30)[0]!), /Deploy/);
});

test("theme invalidation and placeholder updates do not bake ANSI into state", () => {
  const h = harness({ type: "input", id: "a", label: "Label", placeholder: "first" });
  assert.ok(h.component.render(30).join("").includes("\x1b[31m"));
  h.color(32); h.component.invalidate();
  const changed = h.component.render(30).join("");
  assert.ok(changed.includes("\x1b[32m")); assert.ok(!changed.includes("\x1b[31m"));
  h.component.update({ type: "input", id: "a", label: "New", placeholder: "second" });
  assert.match(stripTerminalSequences(h.component.render(30).join("\n")), /second/);
  h.component.handleInput("🙂");
  assert.equal(changes(h.events).at(-1)?.value, "🙂");
});

test("local maxLength is code-point based; unsafe paste cannot inject terminal output", () => {
  const h = harness({ type: "input", id: "a", label: "A", maxLength: 3 });
  h.component.handleInput("🙂élong");
  assert.equal(changes(h.events).at(-1)?.value, "🙂é");
  h.component.handleInput("x");
  assert.equal(changes(h.events).length, 1);
  h.component.handleInput("\x7f"); // native grapheme deletion removes e + combining acute
  assert.equal(changes(h.events).at(-1)?.value, "🙂");
  h.component.handleInput("\x1b[200~\x1b]52;c;c2VjcmV0\x07\u202eZ\x00Q\x1b[201~");
  assert.equal(changes(h.events).at(-1)?.value, "🙂ZQ");
  const rendered = h.component.render(30).join("");
  assert.ok(!rendered.includes("52;c")); assert.ok(!rendered.includes("\u202e"));
});

test("injected editing bindings are scoped and dispose suppresses late work", () => {
  const global = getKeybindings();
  const h = harness(field(), { "tui.editor.deleteCharBackward": "ctrl+b" });
  h.component.handleInput("\x02");
  assert.equal(changes(h.events).at(-1)?.value, "Ad");
  assert.equal(getKeybindings(), global);
  h.component.dispose(); h.component.dispose();
  const count = h.events.length;
  h.component.update(form()); h.component.handleInput("x"); h.component.render(30);
  assert.equal(h.events.length, count); assert.equal(h.cancelled, 0);
});

test("initial cursor positioning ignores rebound user actions but editing honors them", () => {
  const global = getKeybindings();
  const h = harness(form(), {
    "tui.editor.cursorLineEnd": "ctrl+l",
    "tui.editor.deleteToLineEnd": "ctrl+e",
  });
  assert.equal(getKeybindings(), global);
  assert.match(stripTerminalSequences(h.component.render(40).join("\n")), /Ada/);
  assert.deepEqual(changes(h.events), []);
  h.component.handleInput("!");
  assert.equal(changes(h.events).at(-1)?.value, "Ada!");
  h.component.handleInput("\x1b[H");
  h.component.handleInput("\x0c"); // User-bound cursorLineEnd.
  h.component.handleInput("\x1b[D");
  h.component.handleInput("\x05"); // User-bound deleteToLineEnd.
  assert.equal(changes(h.events).at(-1)?.value, "Ada");
  assert.equal(getKeybindings(), global);
  // Newly introduced inputs during update use the same safe initialization path.
  h.component.update({ type: "column", children: [field("new_name", "Grace"), button] });
  h.component.handleInput("!");
  h.component.handleInput("\t"); h.component.handleInput("\r");
  assert.deepEqual(h.submitted[0], { action: "submit", values: { new_name: "Grace!" } });
  assert.equal(getKeybindings(), global);
});

test("hybrid controls consume local keys but forward unowned shortcuts", () => {
  const h = harness(form());
  h.component.handleInput("\x12");
  h.component.handleInput("\x1b[D");
  h.component.handleInput("\t");
  h.component.handleInput("\x12");
  h.component.handleInput("\x1b[B");
  h.component.handleInput("\t");
  h.component.handleInput("\x12");
  assert.deepEqual(h.events.filter(event => event.type === "key"), Array(3).fill({ type: "key", key: "ctrl+r" }));
  assert.deepEqual(changes(h.events), [{ type: "change", id: "target", value: "prod" }]);
});

test("updates preserve input values when limits shrink but reset removed select options", () => {
  const h = harness(form());
  h.component.handleInput("!");
  h.component.handleInput("\t");
  h.component.handleInput("\x1b[B");
  h.component.update({ type: "column", children: [
    { type: "input", id: "name", label: "Name", maxLength: 1 },
    { type: "select", id: "target", label: "Target", options: [{ value: "new", label: "New" }] }, button,
  ] });
  assert.match(stripTerminalSequences(h.component.render(40).join("\n")), /> Target: ‹ New ›/);
  h.component.handleInput("\t"); h.component.handleInput("\r");
  assert.deepEqual(h.submitted[0], { action: "submit", values: { name: "Ada!", target: "new" } });
});

test("a removed selection falls back to the declared value without losing focus", () => {
  const h = harness(form());
  h.component.handleInput("\t");
  h.component.handleInput("\x1b[B");
  const before = h.events.length;
  h.component.update({ type: "column", children: [field(), {
    type: "select", id: "target", label: "Target", value: "declared",
    options: [{ value: "first", label: "First" }, { value: "declared", label: "Declared" }],
  }, button] });
  // A server document replacement does not synthesize a local change event.
  assert.equal(h.events.length, before);
  assert.match(stripTerminalSequences(h.component.render(40).join("\n")), /> Target: ‹ Declared ›/);
  h.component.handleInput("\t"); h.component.handleInput("\r");
  assert.deepEqual(h.submitted[0], { action: "submit", values: { name: "Ada", target: "declared" } });
});

test("unfinished paste is bounded and Escape closes it locally", () => {
  const h = harness(field());
  h.component.handleInput("\x1b[200~abc"); h.component.handleInput("\x1b");
  assert.equal(h.cancelled, 1);
  const huge = harness(field());
  huge.component.handleInput("\x1b[200~" + "x".repeat(32769));
  assert.equal(huge.cancelled, 1);
});
