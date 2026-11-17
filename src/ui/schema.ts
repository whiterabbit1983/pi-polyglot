/** The closed, data-only tui_v1 document contract. No terminal escapes are accepted. */
export type Style = "text" | "accent" | "muted" | "success" | "warning" | "error";
export type Span = { text: string; style?: Style; bold?: boolean; underline?: boolean };
export type Document =
  | { type: "column"; children: Document[] }
  | { type: "text"; text: string; style?: Style; bold?: boolean }
  | { type: "frame"; lines: Span[][] }
  | { type: "input"; id: string; label: string; value?: string; placeholder?: string; maxLength?: number }
  | { type: "select"; id: string; label: string; options: { value: string; label: string }[]; value?: string }
  | { type: "button"; id: string; label: string }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "tree"; items: { label: string; depth: number }[] };
export type UiEvent =
  | { type: "resize"; width: number; height: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string }
  | { type: "change"; id: string; value: string };

// DEL, all C0/C1, and Unicode bidi embedding/override/isolate controls.
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const styles = new Set<string>(["text", "accent", "muted", "success", "warning", "error"]);
function invalid(message: string): never { throw new Error(`Invalid UI document: ${message}`); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("expected record");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid("expected plain record");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) invalid("unknown field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) invalid("expected JSON fields");
  }
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192 || [...value].length > 4096 || unsafeText.test(value) || /\p{Surrogate}/u.test(value)) {
    invalid("unsafe or oversized string");
  }
  return value;
}
function array(value: unknown, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid("array bounds");
  // Reject holes and non-JSON properties as well as accessor elements.
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid("expected JSON array");
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i) || !("value" in Object.getOwnPropertyDescriptor(value, i)!)) invalid("expected JSON array");
  }
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid("integer bounds");
  return value;
}
function styled(value: unknown, isText = false, readString = string): Span {
  const obj = record(value, isText ? ["type", "text", "style", "bold"] : ["text", "style", "bold", "underline"]);
  const result: Span = { text: readString(obj.text) };
  if (Object.hasOwn(obj, "style")) {
    if (typeof obj.style !== "string" || !styles.has(obj.style)) invalid("unknown style");
    result.style = obj.style as Style;
  }
  for (const key of ["bold", "underline"] as const) {
    if (Object.hasOwn(obj, key)) {
      if (typeof obj[key] !== "boolean") invalid("expected boolean");
      result[key] = obj[key];
    }
  }
  return result;
}

/** Validate before rendering and return an independent JSON-only snapshot. Root depth is 1. */
export function parseDocument(value: unknown): Document {
  let nodes = 0;
  let textBytes = 0;
  // Bound text during traversal, before copying/encoding the complete document.
  const readString = (value: unknown): string => {
    const text = string(value);
    textBytes += Buffer.byteLength(text, "utf8") + 2; // At least the JSON string's quotes.
    if (textBytes > 64 * 1024) invalid("document exceeds 64 KiB");
    return text;
  };
  const ids = new Set<string>();
  function control(obj: Record<string, unknown>): { id: string; label: string } {
    const id = readString(obj.id);
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(id) || ids.has(id)) invalid("invalid or duplicate control id");
    ids.add(id);
    return { id, label: readString(obj.label) };
  }
  function visit(value: unknown, depth: number): Document {
    if (++nodes > 128 || depth > 8) invalid("node count or depth exceeded");
    // Validate type without reading an accessor or an inherited property.
    if (!value || typeof value !== "object") invalid("expected node");
    const descriptor = Object.getOwnPropertyDescriptor(value, "type");
    const type: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
    switch (type) {
      case "column": {
        const obj = record(value, ["type", "children"]);
        return { type, children: array(obj.children, 32).map(child => visit(child, depth + 1)) };
      }
      case "text": return { type, ...styled(value, true, readString) };
      case "frame": {
        const obj = record(value, ["type", "lines"]);
        return { type, lines: array(obj.lines, 200).map(line => array(line, 64).map(span => styled(span, false, readString))) };
      }
      case "input": {
        const obj = record(value, ["type", "id", "label", "value", "placeholder", "maxLength"]);
        const result: Extract<Document, { type: "input" }> = { type, ...control(obj) };
        const max = Object.hasOwn(obj, "maxLength") ? integer(obj.maxLength, 1, 4096) : 256;
        if (Object.hasOwn(obj, "maxLength")) result.maxLength = max;
        if (Object.hasOwn(obj, "value")) {
          result.value = readString(obj.value);
          if ([...result.value].length > max) invalid("input value exceeds maxLength");
        }
        if (Object.hasOwn(obj, "placeholder")) result.placeholder = readString(obj.placeholder);
        return result;
      }
      case "select": {
        const obj = record(value, ["type", "id", "label", "options", "value"]);
        const values = new Set<string>();
        const options = array(obj.options, 64, 1).map(option => {
          const entry = record(option, ["value", "label"]);
          const val = readString(entry.value);
          if (values.has(val)) invalid("duplicate option value");
          values.add(val);
          return { value: val, label: readString(entry.label) };
        });
        const result: Extract<Document, { type: "select" }> = { type, ...control(obj), options };
        if (Object.hasOwn(obj, "value")) {
          result.value = readString(obj.value);
          if (!values.has(result.value)) invalid("unknown selected value");
        }
        return result;
      }
      case "button": {
        const obj = record(value, ["type", "id", "label"]);
        return { type, ...control(obj) };
      }
      case "table": {
        const obj = record(value, ["type", "columns", "rows"]);
        const columns = array(obj.columns, 8, 1).map(readString);
        return { type, columns, rows: array(obj.rows, 100).map(row => array(row, columns.length, columns.length).map(readString)) };
      }
      case "tree": {
        const obj = record(value, ["type", "items"]);
        return { type, items: array(obj.items, 100).map(item => {
          const entry = record(item, ["label", "depth"]);
          return { label: readString(entry.label), depth: integer(entry.depth, 0, 8) };
        }) };
      }
      default: return invalid("unknown node type");
    }
  }
  const document = visit(value, 1);
  if (Buffer.byteLength(JSON.stringify(document), "utf8") > 64 * 1024) invalid("document exceeds 64 KiB");
  return document;
}
