import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import polyglot from '../src/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
test('Pi adapter: tools, commands, hooks, reverse UI, cancellation and fail-closed policy', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'polyglot-test-'));
  const previous = process.env.PI_POLYGLOT_CONFIG;
  const tools = new Map<string, any>(), commands = new Map<string, any>(), events = new Map<string, Function[]>();
  const fakePi = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    on(event: string, callback: Function) { events.set(event, [...events.get(event) ?? [], callback]); },
  };
  const notifications: string[] = [];
  const ctx = { cwd: temp, hasUI: true, ui: { notify: (text: string) => notifications.push(text), confirm: async () => true } };
  try {
    const config = join(temp, 'config.json');
    await writeFile(config, JSON.stringify({ version: 1, extensions: [{
      id: 'test', transport: 'stdio', command: process.execPath,
      args: ['--import', 'tsx', join(root, 'examples/typescript/server.ts')], cwd: root,
      permissions: ['ui.notify', 'ui.confirm'], hooks: ['session_start', 'before_agent_start', 'tool_call'],
    }] }));
    process.env.PI_POLYGLOT_CONFIG = config;
    await polyglot(fakePi as any);
    assert.deepEqual([...tools.keys()], ['pg_test_greet', 'pg_test_wait']);
    const greet = await tools.get('pg_test_greet').execute('a', { name: 'Ada' }, undefined, undefined, ctx);
    assert.equal(greet.content[0].text, 'Hello, Ada!');
    assert.ok(notifications.includes('Greeting approved'));
    await commands.get('pg_test_hello').handler('friend', ctx);
    assert.ok(notifications.includes('Hello, friend!'));
    for (const fn of events.get('session_start')!) await fn({ reason: 'startup' }, ctx);
    assert.deepEqual(await events.get('before_agent_start')![0]({ prompt: 'hello', systemPrompt: 'system' }, ctx), {});
    const signal = new AbortController(); let progress = 0;
    const pending = tools.get('pg_test_wait').execute('b', { milliseconds: 3000 }, signal.signal, () => { progress++; signal.abort(); }, ctx);
    await assert.rejects(pending, /cancelled/i); assert.ok(progress > 0);
    for (const fn of events.get('session_shutdown')!) await fn({}, ctx);
    const denied = await events.get('tool_call')![0]({ toolName: 'bash', toolCallId: 'c', input: {} }, ctx);
    assert.equal(denied.block, true);
    assert.match(denied.reason, /failed/);
    // A configured policy still blocks when a new adapter cannot start its service.
    await writeFile(config, JSON.stringify({ version: 1, extensions: [{
      id: 'broken', transport: 'stdio', command: join(temp, 'does-not-exist'), hooks: ['tool_call'],
    }] }));
    const failedEvents = new Map<string, Function[]>();
    await polyglot({
      ...fakePi,
      on(event: string, callback: Function) { failedEvents.set(event, [...failedEvents.get(event) ?? [], callback]); },
    } as any);
    const blocked = await failedEvents.get('tool_call')![0]({ toolName: 'bash', toolCallId: 'd', input: {} }, ctx);
    assert.equal(blocked.block, true);
    for (const fn of failedEvents.get('session_start')!) await fn({}, ctx);
    assert.ok(notifications.some(text => text.includes('startup failed')));
    for (const fn of failedEvents.get('session_shutdown')!) await fn({}, ctx);
    // Cleanup is idempotent.
    for (const fn of events.get('session_shutdown')!) await fn({}, ctx);
  } finally {
    for (const fn of events.get('session_shutdown') ?? []) await fn({}, ctx);
    if (previous === undefined) delete process.env.PI_POLYGLOT_CONFIG; else process.env.PI_POLYGLOT_CONFIG = previous;
    await rm(temp, { recursive: true, force: true });
  }
});
