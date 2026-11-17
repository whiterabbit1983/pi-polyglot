#!/usr/bin/env node
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import * as grpc from '@grpc/grpc-js';
import { z } from 'zod';
import { Peer, type Transport } from '../../src/rpc.ts';
import { MAX_BYTES, RpcError, VERSION } from '../../src/protocol.ts';
import { Lines, SerialWriter } from '../../src/transports/framing.ts';
import { grpcDefinition } from '../../src/transports/grpc.ts';
import { UiDemo, uiCommands } from './ui-demo.ts';

export const catalog = {
  protocolVersion: VERSION, name: 'typescript_demo',
  tools: [
    { name: 'greet', description: 'Ask permission and greet a person', parameters: { type: 'object', properties: { name: { type: 'string', maxLength: 100 } }, required: ['name'], additionalProperties: false } },
    { name: 'wait', description: 'Wait with progress and cooperative cancellation', parameters: { type: 'object', properties: { milliseconds: { type: 'integer', minimum: 0, maximum: 10000 } }, required: ['milliseconds'], additionalProperties: false } },
  ],
  commands: [{ name: 'hello', description: 'Show a greeting' }],
  hooks: ['session_start', 'before_agent_start', 'tool_call'],
};
const text = (value: string) => ({ content: [{ type: 'text', text: value }], details: {} });
function service(transport: Transport) {
  const peer = new Peer(transport, 'ext-');
  let initialized = false;
  const ui = new UiDemo(peer);
  peer.handler = async (method, params, id, signal) => {
    if (method === 'initialize') {
      if (initialized || params.protocolVersion !== VERSION) throw new RpcError(-32602, 'Unsupported initialization');
      ui.configure(params);
      initialized = true;
      return ui.enabled ? { ...catalog, features: ['tui_v1'], commands: [...catalog.commands, ...uiCommands] } : catalog;
    }
    if (!initialized) throw new RpcError(-32000, 'Initialize first');
    if (method === 'ui.event') return ui.event(params);
    if (method === 'tool.call') {
      if (params.name === 'greet') {
        const parsed = z.object({ name: z.string().max(100) }).strict().safeParse(params.arguments);
        if (!parsed.success) throw new RpcError(-32602, 'Expected a short name');
        const confirmation = await peer.request('host.ui.confirm', { parentRequestId: id, title: 'Greeting', message: `Greet ${parsed.data.name}?` }, { signal }) as { confirmed: boolean };
        if (confirmation.confirmed !== true) throw new RpcError(-32000, 'Greeting declined');
        await peer.request('host.ui.notify', { parentRequestId: id, message: 'Greeting approved', level: 'info' }, { signal });
        return text(`Hello, ${parsed.data.name}!`);
      }
      if (params.name === 'wait') {
        const parsed = z.object({ milliseconds: z.number().int().min(0).max(10000) }).strict().safeParse(params.arguments);
        if (!parsed.success) throw new RpcError(-32602, 'Expected milliseconds from 0 to 10000');
        await peer.notify('progress', { requestId: id, content: [{ type: 'text', text: 'Waiting…' }] });
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) { reject(new RpcError(-32800, 'Cancelled')); return; }
          const abort = () => { clearTimeout(timer); reject(new RpcError(-32800, 'Cancelled')); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, parsed.data.milliseconds);
          signal.addEventListener('abort', abort, { once: true });
        });
        return text('Finished waiting.');
      }
      throw new RpcError(-32602, 'Unknown tool');
    }
    if (method === 'command.execute') {
      if (typeof params.arguments !== 'string') throw new RpcError(-32602, 'Invalid command');
      if (params.name === 'ui_form' || params.name === 'ui_counter') return ui.command(params.name, id, signal);
      if (params.name !== 'hello' || typeof params.arguments !== 'string') throw new RpcError(-32602, 'Invalid command');
      return { text: `Hello, ${params.arguments || 'world'}!` };
    }
    if (method === 'hook.run') {
      if (!catalog.hooks.includes(params.name as string)) throw new RpcError(-32602, 'Invalid hook');
      return {};
    }
    if (method === 'shutdown') { setTimeout(() => { void peer.close(); }, 25); return {}; }
    throw new RpcError(-32601, 'Method not found');
  };
  return peer;
}
function authorized(actual: string | undefined, expected: string) {
  const a = Buffer.from(actual ?? ''), b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const piece of req) {
    size += piece.length;
    if (size > MAX_BYTES) throw new Error('Request too large');
    chunks.push(piece);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function stdio() {
  const writer = new SerialWriter(data => new Promise((resolve, reject) => process.stdout.write(data + '\n', error => error ? reject(error) : resolve())));
  const transport: Transport = { send: data => writer.send(data), close: async () => { process.stdin.destroy(); } };
  const peer = service(transport);
  const lines = new Lines(data => transport.onMessage?.(data));
  process.stdin.on('data', chunk => { try { lines.push(chunk); } catch { void peer.close(); } });
  process.stdin.on('end', () => { void peer.close(); });
  process.stdin.on('error', () => { void peer.close(); });
  process.stdout.on('error', () => { void peer.close(); });
}
function http(port: number, secret: string) {
  type Session = { transport: Transport; peer: Peer; stream?: ServerResponse; queue: string[]; lastActive: number };
  const sessions = new Map<string, Session>();
  const server = createServer((req, res) => { void (async () => {
    if (!authorized(req.headers.authorization, secret)) { res.writeHead(401).end(); return; }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/sessions') {
      await body(req);
      if (sessions.size >= 32) { res.writeHead(503).end(); return; }
      const id = randomUUID();
      let session: Session;
      const writer = new SerialWriter(data => new Promise((resolve, reject) => {
        if (session.stream) session.stream.write(`data: ${data}\n\n`, error => error ? reject(error) : resolve());
        else if (session.queue.length < 64) { session.queue.push(data); resolve(); }
        else reject(new Error('Session queue full'));
      }));
      const transport: Transport = {
        send: data => writer.send(data),
        close: async () => { sessions.delete(id); session.stream?.end(); },
      };
      session = { transport, peer: service(transport), queue: [], lastActive: Date.now() };
      sessions.set(id, session);
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ sessionId: id })); return;
    }
    const match = /^\/sessions\/([a-zA-Z0-9_-]+)(?:\/(events|messages))?$/.exec(url.pathname);
    const session = match ? sessions.get(match[1]) : undefined;
    if (!session) { res.writeHead(404).end(); return; }
    session.lastActive = Date.now();
    if (req.method === 'GET' && match![2] === 'events') {
      if (session.stream) { res.writeHead(409).end(); return; }
      session.stream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': ready\n\n');
      for (const data of session.queue.splice(0)) await session.transport.send(data);
      res.on('close', () => { void session.peer.close(); }); return;
    }
    if (req.method === 'POST' && match![2] === 'messages') {
      const data = await body(req);
      res.writeHead(202).end(); session.transport.onMessage?.(data); return;
    }
    if (req.method === 'DELETE' && !match![2]) {
      await session.peer.close(); res.writeHead(204).end(); return;
    }
    res.writeHead(405).end();
  })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); }); });
  const sweep = setInterval(() => { for (const s of sessions.values()) if (!s.stream && Date.now() - s.lastActive > 30000) void s.peer.close(); }, 10000);
  sweep.unref();
  server.requestTimeout = 15000;
  server.listen(port, '127.0.0.1', () => console.error(`HTTP listening on 127.0.0.1:${port}`));
}
function grpcServer(port: number, secret: string) {
  const server = new grpc.Server({ 'grpc.max_receive_message_length': MAX_BYTES + 16, 'grpc.max_send_message_length': MAX_BYTES + 16 });
  server.addService(grpcDefinition().service, {
    Connect(call: grpc.ServerDuplexStream<{ json: string }, { json: string }>) {
      if (!authorized(call.metadata.get('authorization')[0]?.toString(), secret)) {
        call.emit('error', Object.assign(new Error('Unauthenticated'), { code: grpc.status.UNAUTHENTICATED })); return;
      }
      const writer = new SerialWriter(data => new Promise((resolve, reject) => call.write({ json: data }, (error: Error | undefined) => error ? reject(error) : resolve())));
      const transport: Transport = { send: data => writer.send(data), close: async () => { call.end(); } };
      const peer = service(transport);
      call.on('data', frame => { if (typeof frame.json === 'string') transport.onMessage?.(frame.json); else void peer.close(); });
      call.on('end', () => { void peer.close(); });
      call.on('error', () => { void peer.close(); });
      call.on('cancelled', () => { void peer.close(); });
    },
  });
  server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), error => {
    if (error) { console.error('Could not bind gRPC server'); process.exitCode = 1; }
    else console.error(`gRPC listening on 127.0.0.1:${port}`);
  });
}
const { values } = parseArgs({ options: { transport: { type: 'string', default: 'stdio' }, port: { type: 'string', default: '8765' } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
if (values.transport === 'stdio') stdio();
else {
  const secret = process.env.POLYGLOT_TOKEN;
  if (!secret) throw new Error('Set POLYGLOT_TOKEN for network examples');
  if (values.transport === 'http') http(port, secret);
  else if (values.transport === 'grpc') grpcServer(port, secret);
  else throw new Error('Unknown transport');
}
