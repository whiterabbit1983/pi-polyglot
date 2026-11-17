import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Peer, type Transport } from '../src/rpc.ts';
import { Bridge, type HostContext } from '../src/bridge.ts';
import { decode, encode, MAX_BYTES, catalogSchema, RpcError, parseHookResult } from '../src/protocol.ts';
import { connectionSchema, validateEndpoint } from '../src/config.ts';
import { Lines } from '../src/transports/framing.ts';
import { StdioTransport } from '../src/transports/stdio.ts';

function pair() {
  const a: Transport = { send: async data => { queueMicrotask(() => b.onMessage?.(data)); }, close: async () => {} };
  const b: Transport = { send: async data => { queueMicrotask(() => a.onMessage?.(data)); }, close: async () => {} };
  return [new Peer(a, 'pi-', 1000), new Peer(b, 'ext-', 1000)] as const;
}
const catalog = { protocolVersion: '0.1', name: 'test', tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }], commands: [], hooks: [] };
function context(): HostContext {
  return { cwd: '/workspace', hasUI: true, ui: { notify() {}, confirm: async () => true } as any };
}

test('strict envelopes and bounded payloads', () => {
  assert.equal(decode('{"jsonrpc":"2.0","id":"1","result":null}').jsonrpc, '2.0');
  for (const raw of [
    '{"jsonrpc":"2.0","id":"1","result":1,"error":{"code":0,"message":"x"}}',
    '{"jsonrpc":"2.0","id":"1"}', '{"jsonrpc":"2.0","id":1,"method":"x"}',
    '{"jsonrpc":"2.0","id":"1","method":"x","extra":true}',
  ]) assert.throws(() => decode(raw));
  assert.throws(() => encode({ jsonrpc: '2.0', method: 'x', params: { x: 'a'.repeat(MAX_BYTES) } }));
});
test('LF framing preserves Unicode separators and split UTF-8', () => {
  const received: string[] = []; const lines = new Lines(line => received.push(line));
  const bytes = Buffer.from('"Маша\u2028строка"\n{}\r\n');
  for (const byte of bytes) lines.push(Buffer.from([byte]));
  lines.end(); assert.deepEqual(received, ['"Маша\u2028строка"', '{}']);
  assert.throws(() => new Lines(() => {}, 8).push(Buffer.from('12345678')));
  const truncated = new Lines(() => {}); truncated.push(Buffer.from('{}')); assert.throws(() => truncated.end());
});
test('catalog rejects duplicate names and unsupported hooks/results', () => {
  assert.throws(() => catalogSchema.parse({ ...catalog, tools: [catalog.tools[0], catalog.tools[0]] }));
  assert.throws(() => catalogSchema.parse({ ...catalog, hooks: ['arbitrary_code'] }));
  assert.throws(() => parseHookResult('tool_call', { systemPrompt: 'hack' }));
});
test('remote plaintext and credentials-in-URL are rejected', () => {
  for (const c of [
    { transport: 'http', url: 'http://example.com' },
    { transport: 'http', url: 'https://secret@example.com', tokenEnv: 'TOKEN' },
    { transport: 'grpc', address: 'example.com:5000', tls: false, tokenEnv: 'TOKEN' },
    { transport: 'grpc', address: 'dns:///example.com:5000', tls: true, tokenEnv: 'TOKEN' },
    { transport: 'http', url: 'https://example.com' },
  ]) assert.throws(() => validateEndpoint(connectionSchema.parse({ id: 'test', ...c })));
  validateEndpoint(connectionSchema.parse({ id: 'test', transport: 'http', url: 'http://127.0.0.1:1234' }));
});
test('bidirectional correlation while original request is pending', async () => {
  const [host, service] = pair();
  host.handler = async (method, params) => { assert.equal(method, 'callback'); assert.equal(params.value, 2); return 3; };
  service.handler = async () => service.request('callback', { value: 2 });
  assert.equal(await host.request('work'), 3);
  await Promise.all([host.close(), service.close()]);
});
test('timeouts and cancellation retire parent and keep connection usable', async () => {
  const [host, service] = pair(); let cancelled = false;
  service.handler = async (method, _params, _id, signal) => {
    if (method === 'fast') return 'ok';
    return new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new RpcError(-32800, 'Cancelled')); }, { once: true }));
  };
  await assert.rejects(host.request('slow', {}, { timeoutMs: 20 }), /deadline/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, true);
  const controller = new AbortController(); const request = host.request('slow', {}, { signal: controller.signal });
  controller.abort(); await assert.rejects(request, /cancelled/);
  assert.equal(await host.request('fast'), 'ok');
  await Promise.all([host.close(), service.close()]);
});
test('disconnect fails pending calls', async () => {
  const [host, service] = pair(); service.handler = async () => new Promise(() => {});
  const call = host.request('slow'); host.fail(new Error('Disconnected'));
  await assert.rejects(call, /Disconnected/); await Promise.all([host.close(), service.close()]);
});
test('bridge validates args, gates permissions and rejects stale reverse requests', async () => {
  const [host, service] = pair();
  const config = connectionSchema.parse({ id: 'test', transport: 'stdio', command: 'unused', permissions: ['ui.confirm'] });
  const bridge = new Bridge(config, host);
  let parent = '';
  service.handler = async (method, params, id) => {
    if (method === 'initialize') return catalog;
    if (method === 'tool.call') {
      parent = id;
      const reply = await service.request('host.ui.confirm', { parentRequestId: id, title: 'Hi', message: 'Continue?' }) as any;
      assert.equal(reply.confirmed, true);
      await assert.rejects(service.request('host.ui.notify', { parentRequestId: id, message: 'No permission' }), /denied/);
      return { content: [{ type: 'text', text: (params.arguments as any).value }] };
    }
    return {};
  };
  await bridge.initialize('/workspace');
  await assert.rejects(bridge.callTool('echo', { value: 12 }, context()), /Invalid tool arguments/);
  assert.equal((await bridge.callTool('echo', { value: 'Маша' }, context())).content[0].text, 'Маша');
  await assert.rejects(service.request('host.ui.confirm', { parentRequestId: parent, title: 'Late', message: 'Bad' }), /no longer active/);
  await bridge.shutdown(); await service.close();
});
test('serialization failure retires parent immediately; closed peers ignore input', async () => {
  const [host, service] = pair();
  let ran = false;
  host.handler = async () => { ran = true; return {}; };
  await assert.rejects(host.request('large', { text: 'x'.repeat(MAX_BYTES) }), /exceeds/);
  assert.equal(host.parent('pi-1'), undefined);
  service.handler = async () => 'healthy';
  assert.equal(await host.request('next'), 'healthy');
  await host.close();
  host.transport.onMessage?.('{"jsonrpc":"2.0","id":"ext-late","method":"late"}');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(ran, false);
  await Promise.all([host.close(), service.close()]);
});
test('transport write failure closes the transport exactly once', async () => {
  let closes = 0;
  const peer = new Peer({ send: async () => { throw new Error('Write failed'); }, close: async () => { closes++; } });
  await assert.rejects(peer.request('work'), /Write failed/);
  await peer.close();
  assert.equal(closes, 1);
});
test('Pi context cancellation retires hook and command parents', async () => {
  const [host, service] = pair(); let id = '';
  service.handler = async (method, _params, requestId) => {
    if (method === 'initialize') return catalog;
    id = requestId; return new Promise(() => {});
  };
  const bridge = new Bridge(connectionSchema.parse({ id: 'test', transport: 'stdio', command: 'unused', permissions: ['ui.notify'] }), host);
  await bridge.initialize('/workspace');
  for (const kind of ['hook', 'command']) {
    const controller = new AbortController(); const ctx = { ...context(), signal: controller.signal };
    const pending = kind === 'hook' ? bridge.hook('tool_call', {}, ctx) : bridge.command('hello', '', ctx);
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort(); await assert.rejects(pending, /cancelled/i);
    assert.equal(host.parent(id), undefined);
    await assert.rejects(service.request('host.ui.notify', { parentRequestId: id, message: 'late' }), /no longer active/);
  }
  await Promise.all([host.close(), service.close()]);
});
test('stdout EOF fails requests before their deadline even while child remains alive', async () => {
  const config = connectionSchema.parse({ id: 'eof', transport: 'stdio', command: process.execPath, args: ['-e', 'process.stdout.end();process.stdin.resume();setInterval(()=>{},1000)'] });
  assert.equal(config.transport, 'stdio');
  const peer = new Peer(new StdioTransport(config as any), 'pi-', 4000);
  const start = Date.now();
  await assert.rejects(peer.request('initialize'), /EOF/);
  assert.ok(Date.now() - start < 2000);
  await peer.close();
});
test('bridge rejects unapproved hooks and asynchronous/regex schemas', async () => {
  for (const response of [
    { ...catalog, hooks: ['tool_call'] },
    { ...catalog, tools: [{ ...catalog.tools[0], parameters: { type: 'object', $async: true } }] },
    { ...catalog, tools: [{ ...catalog.tools[0], parameters: { type: 'object', properties: { s: { type: 'string', pattern: '(a+)+$' } } } }] },
  ]) {
    const [host, service] = pair(); service.handler = async () => response;
    const bridge = new Bridge(connectionSchema.parse({ id: 'test', transport: 'stdio', command: 'unused' }), host);
    await assert.rejects(bridge.initialize('/workspace'));
    await Promise.all([host.close(), service.close()]);
  }
});
