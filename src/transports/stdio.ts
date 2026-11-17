import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Connection } from '../config.ts';
import type { Transport } from '../rpc.ts';
import { Lines, SerialWriter } from './framing.ts';

export class StdioTransport implements Transport {
  onMessage?: (data: string) => void;
  onClose?: (error: Error) => void;
  readonly child: ChildProcessWithoutNullStreams;
  private writer: SerialWriter;
  private closing?: Promise<void>;
  private exited: Promise<void>;
  constructor(config: Extract<Connection, { transport: 'stdio' }>) {
    this.child = spawn(config.command, config.args, {
      cwd: config.cwd, env: { ...process.env, ...config.env }, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    this.writer = new SerialWriter(data => new Promise((resolve, reject) => {
      this.child.stdin.write(data + '\n', error => error ? reject(error) : resolve());
    }));
    const lines = new Lines(data => this.onMessage?.(data));
    this.child.stdout.on('data', chunk => {
      try { lines.push(chunk); } catch { this.onClose?.(new Error('Invalid stdio framing')); void this.close(); }
    });
    this.child.stdout.on('end', () => {
      try { lines.end(); this.onClose?.(new Error('Child stdout EOF')); }
      catch { this.onClose?.(new Error('Truncated stdio frame at EOF')); }
    });
    this.child.stdin.on('error', () => this.onClose?.(new Error('Child stdin closed')));
    this.child.stdout.on('error', () => this.onClose?.(new Error('Child stdout failed')));
    // Drain all stderr to avoid deadlock; expose none automatically (it may contain secrets).
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.onClose?.(new Error(`Could not start extension ${config.id}`)));
    this.exited = new Promise(resolve => {
      this.child.once('close', () => { this.onClose?.(new Error('Extension process exited')); resolve(); });
    });
  }
  send(data: string) { return this.writer.send(data); }
  private kill(signal: NodeJS.Signals) {
    if (!this.child.pid) return;
    try {
      if (process.platform === 'win32') this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch { /* Already stopped. */ }
  }
  close() {
    return this.closing ??= (async () => {
      this.child.stdin.end();
      let timer: NodeJS.Timeout;
      const wait = (ms: number) => new Promise<void>(resolve => { timer = setTimeout(resolve, ms); });
      await Promise.race([this.exited, wait(300)]); clearTimeout(timer!);
      // Kill the owned group even if its leader already exited; descendants can retain pipes.
      this.kill('SIGTERM');
      await Promise.race([this.exited, wait(500)]); clearTimeout(timer!);
      this.kill('SIGKILL');
      this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.stdin.destroy();
    })();
  }
}
