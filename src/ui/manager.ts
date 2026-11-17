import { z } from 'zod';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { inlineHeight } from './viewport.ts';
import type { Peer } from '../rpc.ts';
import { RpcError, type Params } from '../protocol.ts';
import { parseDocument, type Document, type UiEvent } from './schema.ts';
import { HybridComponent } from './component.ts';

const plain = z.string().max(1024).refine(s => !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(s));
const owner = { parentRequestId: z.string().min(1).max(128), viewId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) };
const openParams = z.object({ ...owner, title: plain.min(1), surface: z.enum(['inline', 'overlay']).default('overlay'), document: z.unknown() }).strict();
const updateParams = z.object({ ...owner, revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), document: z.unknown() }).strict();
const resultSchema = z.record(z.string(), z.unknown()).refine(v => Buffer.byteLength(JSON.stringify(v)) <= 16384, 'Result exceeds 16 KiB');
const closeParams = z.object({ ...owner, result: resultSchema.optional() }).strict();
export type UiContext = Pick<ExtensionContext, 'ui' | 'hasUI'> & { mode?: ExtensionContext['mode'] };
export type UiResult = { cancelled: false; result: Record<string, unknown> } | { cancelled: true; reason: string };
type View = {
  parentRequestId: string; viewId: string; revision: number; document: Document;
  component?: HybridComponent; done?: (value: UiResult) => void;
  closed: boolean; finish: (result: UiResult, error?: Error) => void;
  queue: UiEvent[]; sending: boolean; abort: AbortController;
};
// Pi has one interactive focus owner. This slot covers all configured connections.
let slot: View | undefined;

export class UiManager {
  private view?: View;
  constructor(private peer: Peer, private eventTimeoutMs: number) {}
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new RpcError(-32602, 'Invalid custom UI parameters');
    return parsed.data;
  }
  private document(value: unknown) {
    try { return parseDocument(value); } catch { throw new RpcError(-32602, 'Invalid custom UI document'); }
  }
  async handle(method: string, params: Params, ctx: UiContext, signal: AbortSignal): Promise<unknown> {
    if (ctx.mode !== 'tui' || !ctx.hasUI) throw new RpcError(-32001, 'Custom UI requires interactive TUI mode');
    if (method === 'host.ui.open') {
      const p = this.parse(openParams, params);
      const document = this.document(p.document);
      if (signal.aborted) throw new RpcError(-32800, 'UI parent ended');
      if (slot) throw new RpcError(-32000, 'Another custom UI is active');
      return this.open(p, document, ctx, signal);
    }
    if (method === 'host.ui.update') {
      const p = this.parse(updateParams, params), view = this.active(p);
      const document = this.document(p.document);
      if (p.revision <= view.revision) return { applied: false };
      view.component?.update(document);
      view.document = document; view.revision = p.revision;
      return { applied: true };
    }
    if (method === 'host.ui.close') {
      const p = this.parse(closeParams, params), view = this.active(p);
      view.finish({ cancelled: false, result: p.result ?? {} }); return {};
    }
    throw new RpcError(-32601, 'Unknown custom UI method');
  }
  private active(p: { parentRequestId: string; viewId: string }) {
    const view = this.view;
    if (!view || view.closed || view.parentRequestId !== p.parentRequestId || view.viewId !== p.viewId) throw new RpcError(-32001, 'UI view is no longer active');
    return view;
  }
  private async open(p: z.infer<typeof openParams>, document: Document, ctx: UiContext, signal: AbortSignal): Promise<UiResult> {
    let resolve!: (result: UiResult) => void, reject!: (error: Error) => void;
    const result = new Promise<UiResult>((yes, no) => { resolve = yes; reject = no; });
    const view: View = {
      parentRequestId: p.parentRequestId, viewId: p.viewId, document, revision: 0,
      queue: [], sending: false, closed: false, abort: new AbortController(),
      finish: (value, error) => {
        if (view.closed) return;
        view.closed = true; view.abort.abort(); view.queue = [];
        signal.removeEventListener('abort', cancelled);
        view.component?.dispose();
        if (slot === view) slot = undefined;
        if (this.view === view) this.view = undefined;
        try { view.done?.(value); } catch { /* The terminal is already retiring. */ }
        if (error) reject(error); else resolve(value);
      },
    };
    const cancelled = () => view.finish({ cancelled: true, reason: 'cancelled' });
    this.view = view; slot = view;
    signal.addEventListener('abort', cancelled, { once: true });
    try {
      // Start the Pi interaction, but keep request processing and events independent.
      const interaction = ctx.ui.custom<UiResult>((tui, theme, keybindings, done) => {
        view.done = done;
        let renderedWidth = tui.terminal.columns;
        const component = new HybridComponent(view.document, theme, keybindings, {
          event: event => this.event(view, event),
          submit: value => {
            try { view.finish({ cancelled: false, result: this.parse(resultSchema, value) }); }
            catch { view.finish({ cancelled: true, reason: 'invalid_result' }); }
          },
          cancel: () => view.finish({ cancelled: true, reason: 'escape' }),
          render: () => { if (!view.closed) tui.requestRender(); },
          dimensions: () => ({ height: p.surface === 'inline' ? inlineHeight(tui, wrapper, renderedWidth) : tui.terminal.rows }),
        });
        view.component = component;
        if (view.closed) { component.dispose(); queueMicrotask(() => done({ cancelled: true, reason: 'cancelled' })); }
        const failed = () => view.finish({ cancelled: true, reason: 'render_failed' });
        const wrapper: Component & { focused: boolean; dispose(): void } = {
          capturesViewportInput: true,
          get focused() { return component.focused; },
          set focused(value: boolean) { component.focused = value; },
          render: (width: number) => { try { renderedWidth = width; return component.render(width); } catch { failed(); return []; } },
          handleInput: (data: string) => {
            try {
              // Resize/widgets can change before the next render. Never accept
              // hidden input when the inline slot has no remaining space.
              if (p.surface === 'inline') inlineHeight(tui, wrapper, tui.terminal.columns);
              component.handleInput(data);
            } catch { failed(); }
          },
          invalidate: () => { try { component.invalidate(); } catch { failed(); } },
          dispose: () => view.finish({ cancelled: true, reason: 'disposed' }),
        };
        return wrapper;
      }, { overlay: p.surface === 'overlay', blocked: { kind: 'question', message: p.title } });
      void interaction.then(value => {
        if (!view.closed) view.finish(value ?? { cancelled: true, reason: 'dismissed' });
      }, () => view.finish({ cancelled: true, reason: 'ui_failed' }, new RpcError(-32000, 'Custom UI failed')));
    } catch {
      view.finish({ cancelled: true, reason: 'ui_failed' }, new RpcError(-32000, 'Custom UI failed'));
    }
    return result;
  }
  private event(view: View, event: UiEvent) {
    if (view.closed) return;
    const key = event.type === 'resize' ? 'resize' : event.type === 'change' ? `change:${event.id}` : undefined;
    const index = key === undefined ? -1 : view.queue.findIndex(e => (e.type === 'resize' ? 'resize' : e.type === 'change' ? `change:${e.id}` : undefined) === key);
    if (index >= 0) view.queue[index] = event;
    else if (view.queue.length < 32) view.queue.push(event);
    else { view.finish({ cancelled: true, reason: 'event_overflow' }); return; }
    void this.pump(view);
  }
  private async pump(view: View) {
    if (view.sending || view.closed) return;
    view.sending = true;
    try {
      while (view.queue.length && !view.closed) {
        const event = view.queue.shift()!;
        const result = await this.peer.request('ui.event', {
          parentRequestId: view.parentRequestId, viewId: view.viewId, revision: view.revision, event,
        }, { signal: view.abort.signal, timeoutMs: Math.min(2000, this.eventTimeoutMs) });
        if (result === null || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length) throw new Error('Invalid UI event acknowledgement');
      }
    } catch {
      if (!view.closed) view.finish({ cancelled: true, reason: 'event_failed' });
    } finally { view.sending = false; }
  }
  dispose() { this.view?.finish({ cancelled: true, reason: 'shutdown' }); }
}
