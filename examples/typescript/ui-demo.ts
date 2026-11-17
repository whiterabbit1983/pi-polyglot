import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Peer } from '../../src/rpc.ts';
import { RpcError, type Params } from '../../src/protocol.ts';

export const uiCommands = [
  { name: 'ui_form', description: 'Open a hybrid form with local controls' },
  { name: 'ui_counter', description: 'Open a remotely rendered counter' },
];
const counterDocument = (count: number) => ({ type: 'frame', lines: [
  [{ text: 'Remote counter', style: 'accent', bold: true }],
  [{ text: `Count: ${count}` }],
  [{ text: 'Up/Down change, Enter submits, Escape cancels', style: 'muted' }],
] });
const formDocument = { type: 'column', children: [
  { type: 'frame', lines: [[{ text: 'Choose a target', style: 'accent', bold: true }]] },
  { type: 'input', id: 'name', label: 'Name', value: 'Ada' },
  { type: 'select', id: 'target', label: 'Target', options: [
    { value: 'dev', label: 'Development' }, { value: 'prod', label: 'Production' },
  ], value: 'dev' },
  { type: 'button', id: 'submit', label: 'Deploy' },
] };

export class UiDemo {
  enabled = false;
  timeoutMs = 300000;
  private views = new Map<string, { parent: string; count: number; revision: number; counter: boolean; signal: AbortSignal }>();
  constructor(private peer: Peer) {}
  configure(params: Params) {
    const features = params.optionalFeatures;
    if (features === undefined && params.ui === undefined) return;
    if (!Array.isArray(features) || features.some(v => v !== 'tui_v1') || new Set(features).size !== features.length
      || !Array.isArray(params.permissions) || !params.permissions.includes('ui.custom')) throw new RpcError(-32602, 'Invalid UI feature offer');
    const ui = z.object({ timeoutMs: z.number().int().min(1000).max(900000) }).strict().safeParse(params.ui);
    if (!ui.success) throw new RpcError(-32602, 'Invalid UI timeout');
    this.enabled = features.includes('tui_v1'); this.timeoutMs = ui.data.timeoutMs;
    this.peer.incomingTimeout = method => this.enabled && method === 'command.execute' ? this.timeoutMs : this.peer.timeoutMs;
  }
  async command(name: string, parent: string, signal: AbortSignal) {
    if (!this.enabled || !uiCommands.some(c => c.name === name)) throw new RpcError(-32602, 'Unknown UI command');
    const viewId = randomUUID();
    this.views.set(viewId, { parent, count: 0, revision: 0, counter: name === 'ui_counter', signal });
    try {
      const result = await this.peer.request('host.ui.open', {
        parentRequestId: parent, viewId, title: name === 'ui_counter' ? 'Counter' : 'Deployment', surface: name === 'ui_counter' ? 'overlay' : 'inline',
        document: name === 'ui_counter' ? counterDocument(0) : formDocument,
      }, { signal, timeoutMs: this.timeoutMs });
      return { text: `UI result: ${JSON.stringify(result)}` };
    } finally { this.views.delete(viewId); }
  }
  async event(params: Params) {
    const view = typeof params.viewId === 'string' ? this.views.get(params.viewId) : undefined;
    if (!view || params.parentRequestId !== view.parent || view.signal.aborted) throw new RpcError(-32001, 'UI view is no longer active');
    if (!Number.isSafeInteger(params.revision) || (params.revision as number) < 0 || !params.event || typeof params.event !== 'object') throw new RpcError(-32602, 'Invalid UI event');
    const event = params.event as Params;
    if (!['resize', 'key', 'text', 'change'].includes(String(event.type))) throw new RpcError(-32602, 'Invalid event type');
    if (!view.counter || event.type !== 'key') return {};
    if (event.key === 'enter') {
      await this.peer.request('host.ui.close', { parentRequestId: view.parent, viewId: params.viewId, result: { count: view.count } }, { signal: view.signal });
    } else if (event.key === 'up' || event.key === 'down') {
      view.count += event.key === 'up' ? 1 : -1;
      await this.peer.request('host.ui.update', {
        parentRequestId: view.parent, viewId: params.viewId, revision: ++view.revision, document: counterDocument(view.count),
      }, { signal: view.signal });
    }
    return {};
  }
}
