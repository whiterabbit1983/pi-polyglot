import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect as connectSocket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Bridge, type HostContext } from '../src/bridge.ts';
import { connectionSchema } from '../src/config.ts';
import { fakeTui, until } from '../test/helpers/tui.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const withUi = process.argv.includes('--ui');
const selected = process.argv.slice(2).filter(arg => arg !== '--ui');
const languages = selected.length ? selected : ['typescript', 'python', 'go', 'rust'];
process.env.POLYGLOT_TOKEN = randomBytes(24).toString('hex');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port as number;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function ready(port: number, child: ChildProcess) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Example server exited before readiness');
    const ok = await new Promise<boolean>(resolve => {
      const socket = connectSocket(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
    if (ok) return; await pause(50);
  }
  throw new Error('Server readiness timed out');
}
function executable(language: string): [string, string[]] {
  switch (language) {
    case 'typescript': return [process.execPath, ['--import', 'tsx', resolve(root, 'examples/typescript/server.ts')]];
    case 'python': return [resolve(root, 'examples/python/.venv/bin/python'), [resolve(root, 'examples/python/server.py')]];
    case 'go': return [resolve(root, 'examples/go/bin/polyglot-example'), []];
    case 'rust': return [resolve(root, 'examples/rust/target/debug/polyglot-example'), []];
    default: throw new Error(`Unknown language: ${language}`);
  }
}
async function stop(child: ChildProcess) {
  if (!child.pid) return;
  const kill = (signal: NodeJS.Signals) => { try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid!, signal); } catch {} };
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  kill('SIGTERM'); await Promise.race([exited, pause(500)]); kill('SIGKILL');
  child.stdout?.destroy(); child.stderr?.destroy();
}
let cases = 0;
for (const language of languages) {
  const [command, args] = executable(language);
  if (!existsSync(command)) throw new Error(`Build example first: ${command}`);
  for (const transport of ['stdio', 'http', 'grpc'] as const) {
    let server: ChildProcess | undefined;
    let stderr = '';
    const bridges: Bridge[] = [];
    try {
      const port = await freePort();
      if (transport !== 'stdio') {
        server = spawn(command, [...args, '--transport', transport, '--port', String(port)], { cwd: root, env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        server.stdout?.on('data', () => {});
        server.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
        await ready(port, server);
      }
      const config = connectionSchema.parse({
        id: language, transport, permissions: ['ui.notify', 'ui.confirm', ...(withUi ? ['ui.custom'] : [])], hooks: ['session_start', 'before_agent_start', 'tool_call'], timeoutMs: 4000, uiTimeoutMs: 5000,
        ...(transport === 'stdio' ? { command, args: [...args, '--transport', 'stdio'], cwd: root }
          : transport === 'http' ? { url: `http://127.0.0.1:${port}`, tokenEnv: 'POLYGLOT_TOKEN' }
          : { address: `127.0.0.1:${port}`, tls: false, tokenEnv: 'POLYGLOT_TOKEN' }),
      });
      const bridge = await Bridge.connect(config, root); bridges.push(bridge);
      let confirmations = 0, notifications = 0;
      const ctx: HostContext = { cwd: root, hasUI: true, ui: {
        confirm: async () => { confirmations++; return true; }, notify: () => { notifications++; },
      } as any };
      assert.equal((await bridge.callTool('greet', { name: 'Маша\u2028🌍' }, ctx)).content[0].text, 'Hello, Маша\u2028🌍!');
      assert.equal(confirmations, 1); assert.equal(notifications, 1);
      assert.equal((await bridge.command('hello', 'reader', ctx)).text, 'Hello, reader!');
      assert.deepEqual(await bridge.hook('session_start', { reason: 'startup' }, ctx), {});
      assert.deepEqual(await bridge.hook('before_agent_start', { prompt: 'hello', systemPrompt: 'You are a test agent.' }, ctx), {});
      assert.deepEqual(await bridge.hook('tool_call', { toolName: 'test', toolCallId: 'test-1', input: {} }, ctx), {});
      let progress = 0;
      assert.equal((await bridge.callTool('wait', { milliseconds: 20 }, ctx, { onProgress: () => { progress++; } })).content[0].text, 'Finished waiting.');
      assert.ok(progress > 0);
      const controller = new AbortController();
      const waiting = bridge.callTool('wait', { milliseconds: 3000 }, ctx, { signal: controller.signal });
      setTimeout(() => controller.abort(), 30);
      await assert.rejects(waiting, /cancelled/i);
      await assert.rejects(bridge.callTool('greet', { name: 4 }, ctx), /Invalid tool arguments/);
      // Validate the service too, bypassing host-side argument validation.
      await assert.rejects(bridge.peer.request('tool.call', { name: 'greet', arguments: { name: 4 } }), /./);
      await assert.rejects(bridge.peer.request('unknown.method', {}), /./);
      const declined = { ...ctx, ui: { ...ctx.ui, confirm: async () => false } } as HostContext;
      await assert.rejects(bridge.callTool('greet', { name: 'No' }, declined));
      assert.equal((await bridge.command('hello', 'healthy', ctx)).text, 'Hello, healthy!');
      if (withUi) {
        assert.equal(bridge.customUiEnabled, true);
        const tui = fakeTui();
        const form = bridge.command('ui_form', '', tui.ctx); void form.catch(() => {});
        await until(() => tui.active);
        tui.input('X'); tui.input('\t'); tui.input('\x1b[B'); tui.input('\t'); tui.input('\r');
        const result = JSON.parse((await form).text!.slice('UI result: '.length));
        assert.deepEqual(result, { cancelled: false, result: { action: 'submit', values: { name: 'AdaX', target: 'prod' } } });
        const counter = bridge.command('ui_counter', '', tui.ctx); void counter.catch(() => {});
        await until(() => tui.active);
        tui.input('\x1b[A');
        await until(() => tui.lines.some(line => /Count(?:er)?: 1\b/.test(line)));
        tui.resize(20, 12); tui.input('\r');
        assert.deepEqual(JSON.parse((await counter).text!.slice(11)), { cancelled: false, result: { count: 1 } });
        const cancelled = bridge.command('ui_counter', '', tui.ctx); void cancelled.catch(() => {});
        await until(() => tui.active); tui.input('\x1b');
        assert.equal(JSON.parse((await cancelled).text!.slice(11)).cancelled, true);
        await assert.rejects(bridge.command('ui_form', '', { ...tui.ctx, mode: 'rpc' }));
      }
      if (transport !== 'stdio') {
        const other = await Bridge.connect(config, root); bridges.push(other);
        await bridge.shutdown();
        assert.equal((await other.command('hello', 'isolated', ctx)).text, 'Hello, isolated!');
        process.env.POLYGLOT_BAD_TOKEN = 'invalid-test-token';
        await assert.rejects(Bridge.connect({ ...config, tokenEnv: 'POLYGLOT_BAD_TOKEN' } as typeof config, root),
          error => error instanceof Error && !error.message.includes('deadline'));
      }
      cases++; console.log(`PASS ${language}/${transport}${withUi ? ' + hybrid UI' : ''}: handshake, Unicode, callbacks, command, hooks, progress, cancellation, validation, health${transport === 'stdio' ? '' : ', isolation, auth'}`);
    } catch (error) {
      // The runner uses only synthetic credentials; diagnostics are useful for local test failures.
      console.error(`FAIL ${language}/${transport}: ${error instanceof Error ? error.message : error}`);
      if (stderr) console.error(stderr.replaceAll(process.env.POLYGLOT_TOKEN!, '[redacted]'));
      throw error;
    } finally {
      await Promise.allSettled(bridges.map(bridge => bridge.shutdown()));
      if (server) await stop(server);
    }
  }
}
console.log(`Matrix passed: ${cases} combinations.`);
