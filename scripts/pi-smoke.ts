import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Lines } from '../src/transports/framing.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'pi-polyglot-smoke-'));
let child: ReturnType<typeof spawn> | undefined;
try {
  const config = join(temp, 'config.json');
  const probe = join(temp, 'probe.ts');
  await writeFile(config, JSON.stringify({ version: 1, extensions: [{
    id: 'smoke', transport: 'stdio', command: process.execPath,
    args: ['--import', 'tsx', join(root, 'examples/typescript/server.ts')], cwd: root,
    permissions: ['ui.notify', 'ui.confirm'], hooks: ['session_start', 'before_agent_start', 'tool_call'],
  }] }));
  await writeFile(probe, `export default function(pi) { pi.registerCommand('polyglot_probe', {description:'Test tool catalog', handler:async (_,ctx)=>{ctx.ui.notify(JSON.stringify(pi.getAllTools().map(t=>t.name)), 'info');}}); }`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: temp, TMPDIR: process.env.TMPDIR,
    PI_CODING_AGENT_DIR: join(temp, 'agent'), PI_OFFLINE: '1', PI_POLYGLOT_CONFIG: config,
  };
  child = spawn(process.execPath, [join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
    '--mode', 'rpc', '--no-session', '--offline', '--no-extensions', '--no-skills', '--no-mcp',
    '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-builtin-tools',
    '-e', join(root, 'src/index.ts'), '-e', probe,
  ], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages: any[] = []; let stderr = '';
  const lines = new Lines(line => { messages.push(JSON.parse(line)); });
  child.stdout!.on('data', chunk => lines.push(chunk));
  child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  let counter = 0;
  async function wait(predicate: (m: any) => boolean) {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const result = messages.find(predicate); if (result) return result;
      if (child!.exitCode !== null) throw new Error(`Pi exited: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Pi smoke timed out: ${stderr}`);
  }
  async function command(type: string, data: Record<string, unknown> = {}) {
    const id = `smoke-${++counter}`;
    child!.stdin!.write(JSON.stringify({ id, type, ...data }) + '\n');
    const response = await wait(m => m.type === 'response' && m.id === id);
    assert.equal(response.success, true, JSON.stringify(response)); return response;
  }
  const commands = await command('get_commands');
  assert.ok(commands.data.commands.some((c: any) => c.name === 'pg_smoke_hello'), JSON.stringify(commands));
  await command('prompt', { message: '/pg_smoke_hello Pi' });
  await wait(m => m.type === 'extension_ui_request' && m.message === 'Hello, Pi!');
  await command('prompt', { message: '/polyglot_probe' });
  const catalog = await wait(m => m.type === 'extension_ui_request' && typeof m.message === 'string' && m.message.includes('pg_smoke_greet'));
  assert.ok(JSON.parse(catalog.message).includes('pg_smoke_wait'));
  const exited = new Promise<number | null>(resolve => child!.once('exit', resolve));
  child.stdin!.end();
  const timer = setTimeout(() => child?.kill('SIGKILL'), 10000);
  const code = await exited; clearTimeout(timer); assert.equal(code, 0, stderr);
  console.log('PASS actual Pi 1.5.2 RPC: extension loaded, tools registered, command executed, UI notification received, clean EOF shutdown. No model request.');
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  // Only the private temporary directory created by this smoke is removed.
  await rm(temp, { recursive: true, force: true });
}
