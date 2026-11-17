import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Peer, type Transport } from '../src/rpc.ts';
import { Bridge } from '../src/bridge.ts';
import { connectionSchema } from '../src/config.ts';
import { RpcError } from '../src/protocol.ts';
import { UiDemo, uiCommands } from '../examples/typescript/ui-demo.ts';
import { fakeTui, until } from './helpers/tui.ts';

async function harness(options: { permissions?: string[]; select?: boolean; timeoutMs?: number; uiTimeoutMs?: number } = {}) {
  let lastOpen: any;
  const a: Transport = { send: async data => { queueMicrotask(() => b.onMessage?.(data)); }, close: async () => {} };
  const b: Transport = { send: async data => {
    const message = JSON.parse(data); if (message.method === 'host.ui.open') lastOpen = message.params;
    queueMicrotask(() => a.onMessage?.(data));
  }, close: async () => {} };
  const host = new Peer(a, 'pi-', options.timeoutMs ?? 1000), service = new Peer(b, 'ext-');
  const demo = new UiDemo(service);
  const config = connectionSchema.parse({ id: 'ui', transport: 'stdio', command: 'unused', permissions: options.permissions ?? ['ui.custom'], timeoutMs: options.timeoutMs ?? 1000, uiTimeoutMs: options.uiTimeoutMs ?? 3000 });
  const bridge = new Bridge(config, host);
  service.handler = async (method, params, id, signal) => {
    if (method === 'initialize') {
      demo.configure(params);
      return { protocolVersion: '0.1', name: 'ui_demo', tools: [], commands: uiCommands, hooks: [], ...(options.select === false ? {} : demo.enabled ? { features: ['tui_v1'] } : {}) };
    }
    if (method === 'command.execute') return demo.command(String(params.name), id, signal);
    if (method === 'ui.event') return demo.event(params);
    return {};
  };
  await bridge.initialize('/workspace');
  return { bridge, host, service, demo, get open() { return lastOpen; }, close: async () => { await bridge.shutdown(); await service.close(); } };
}
const frame = (text: string) => ({ type: 'frame', lines: [[{ text }]] });

test('hybrid form edits/selects/submits locally and remote counter updates', async () => {
  const h = await harness(); const tui = fakeTui();
  try {
    const form = h.bridge.command('ui_form', '', tui.ctx);
    await until(() => tui.active);
    tui.input('X'); tui.input('\t'); tui.input('\x1b[B'); tui.input('\t'); tui.input('\r');
    const result = JSON.parse((await form).text!.slice('UI result: '.length));
    assert.deepEqual(result, { cancelled: false, result: { action: 'submit', values: { name: 'AdaX', target: 'prod' } } });
    assert.equal(tui.active, false);
    const counter = h.bridge.command('ui_counter', '', tui.ctx);
    await until(() => tui.active);
    tui.input('\x1b[A');
    await until(() => tui.lines.some(line => line.includes('Count: 1')));
    tui.resize(12, 10);
    tui.input('\r');
    assert.deepEqual(JSON.parse((await counter).text!.slice(11)), { cancelled: false, result: { count: 1 } });
    assert.equal(tui.completions, 2);
  } finally { await h.close(); }
});

test('monotonic revisions, strict ownership, bad frames and cleanup', async () => {
  const h = await harness(); const tui = fakeTui();
  try {
    const call = h.bridge.command('ui_counter', '', tui.ctx);
    await until(() => tui.active);
    const owner = { parentRequestId: h.open.parentRequestId, viewId: h.open.viewId };
    assert.deepEqual(await h.service.request('host.ui.update', { ...owner, revision: 7, document: frame('fresh') }), { applied: true });
    assert.deepEqual(await h.service.request('host.ui.update', { ...owner, revision: 6, document: frame('stale') }), { applied: false });
    assert.ok(tui.render().join('').includes('fresh'));
    await assert.rejects(h.service.request('host.ui.update', { ...owner, revision: 8, document: frame('\x1b]52;c;evil\x07') }), /Invalid custom UI document/);
    await assert.rejects(h.service.request('host.ui.close', { ...owner, parentRequestId: 'pi-forged' }), /live command parent/);
    await assert.rejects(h.service.request('host.ui.close', { ...owner, viewId: 'wrong' }), /no longer active/);
    tui.input('\x1b');
    assert.equal(JSON.parse((await call).text!.slice(11)).cancelled, true);
    await assert.rejects(h.service.request('host.ui.update', { ...owner, revision: 9, document: frame('late') }), /live command parent/);
    assert.equal(tui.active, false);
  } finally { await h.close(); }
});

test('feature cannot be selected without an offer, and non-command parents cannot open', async () => {
  const a: Transport = { send: async data => { queueMicrotask(() => b.onMessage?.(data)); }, close: async () => {} };
  const b: Transport = { send: async data => { queueMicrotask(() => a.onMessage?.(data)); }, close: async () => {} };
  const host = new Peer(a), service = new Peer(b, 'ext-');
  service.handler = async () => ({ protocolVersion: '0.1', name: 'bad', tools: [], commands: [], hooks: [], features: ['tui_v1'] });
  const bridge = new Bridge(connectionSchema.parse({ id: 'bad', transport: 'stdio', command: 'unused' }), host);
  try { await assert.rejects(bridge.initialize('/workspace'), /unoffered/); }
  finally { await host.close(); await service.close(); }
  const h = await harness();
  h.service.handler = async (_method, _params, id) => h.service.request('host.ui.open', { parentRequestId: id, viewId: 'wrong-parent', title: 'No', document: frame('No') });
  try { await assert.rejects(h.host.request('tool.call', {}, { meta: fakeTui().ctx }), /live command parent/); }
  finally { await h.close(); }
});

test('one slot across bridges; normal request deadline does not end UI early', async () => {
  const first = await harness({ timeoutMs: 100, uiTimeoutMs: 1500 }), second = await harness();
  const tui = fakeTui();
  try {
    const call = first.bridge.command('ui_form', '', tui.ctx);
    await until(() => tui.active);
    await assert.rejects(second.bridge.command('ui_form', '', fakeTui().ctx), /Another custom UI/);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(tui.active, true);
    tui.input('\x1b'); await call;
    const nextTui = fakeTui(), next = second.bridge.command('ui_counter', '', nextTui.ctx);
    await until(() => nextTui.active); nextTui.input('\x1b'); await next;
  } finally { await first.close(); await second.close(); }
});

test('wrong mode, denied or unselected capability cannot open TUI', async () => {
  for (const options of [{}, { select: false }]) {
    const h = await harness(options);
    try {
      const ctx = fakeTui().ctx;
      if (options.select !== false) ctx.mode = 'rpc';
      await assert.rejects(h.bridge.command('ui_form', '', ctx), /TUI mode|not granted and negotiated/);
    } finally { await h.close(); }
  }
  const denied = await harness({ permissions: [] });
  try { assert.equal(denied.bridge.customUiEnabled, false); await assert.rejects(denied.bridge.command('ui_form', '', fakeTui().ctx)); }
  finally { await denied.close(); }
});

test('parent cancellation, disconnect and UI deadline dispose view', async () => {
  for (const cause of ['abort', 'disconnect', 'deadline']) {
    const h = await harness({ uiTimeoutMs: 1000 }); const tui = fakeTui();
    const controller = new AbortController();
    try {
      const command = h.bridge.command('ui_form', '', { ...tui.ctx, signal: controller.signal });
      const rejection = assert.rejects(command, /cancelled|Disconnected|deadline/i);
      await until(() => tui.active);
      if (cause === 'abort') controller.abort();
      if (cause === 'disconnect') h.host.fail(new Error('Disconnected'));
      await rejection;
      await until(() => !tui.active);
      assert.equal(tui.completions, 1);
    } finally { await h.close(); }
  }
});

test('input stays local while events wait; overflow closes remote frame safely', async () => {
  const h = await harness(); const tui = fakeTui();
  const original = h.service.handler;
  h.service.handler = async (...args) => { if (args[0] === 'ui.event') return new Promise(() => {}); return original(...args); };
  try {
    const form = h.bridge.command('ui_form', '', tui.ctx);
    await until(() => tui.active);
    for (let i = 0; i < 40; i++) tui.input('x'); // change events coalesce, no network editing dependency.
    tui.input('\t'); tui.input('\t'); tui.input('\r');
    const result = JSON.parse((await form).text!.slice(11));
    assert.equal(result.result.values.name, 'Ada' + 'x'.repeat(40));
    const counter = h.bridge.command('ui_counter', '', tui.ctx);
    await until(() => tui.active);
    for (let i = 0; i < 40; i++) tui.input('\x1b[A');
    const overflow = JSON.parse((await counter).text!.slice(11));
    assert.equal(overflow.reason, 'event_overflow'); assert.equal(tui.active, false);
  } finally { await h.close(); }
});

test('remote event errors close view and do not leave slot locked', async () => {
  const h = await harness(); const tui = fakeTui();
  const original = h.service.handler;
  h.service.handler = async (...args) => { if (args[0] === 'ui.event') throw new RpcError(-32000, 'Event failed'); return original(...args); };
  try {
    const call = h.bridge.command('ui_counter', '', tui.ctx);
    const result = JSON.parse((await call).text!.slice(11));
    assert.equal(result.cancelled, true); assert.equal(result.reason, 'event_failed');
    assert.equal(tui.active, false);
    h.service.handler = original;
    const next = h.bridge.command('ui_form', '', tui.ctx);
    await until(() => tui.active); tui.input('\x1b'); await next;
  } finally { await h.close(); }
});
