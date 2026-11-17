import type { Transport } from '../rpc.ts';
import { token, type Connection, validateEndpoint } from '../config.ts';
import { MAX_BYTES } from '../protocol.ts';
import { Lines, SerialWriter } from './framing.ts';

export class HttpTransport implements Transport {
  onMessage?: (data: string) => void;
  onClose?: (error: Error) => void;
  private abort = new AbortController();
  private sessionUrl = '';
  private headers: Record<string, string>;
  private writer: SerialWriter;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private closing?: Promise<void>;
  private constructor(private config: Extract<Connection, { transport: 'http' }>) {
    const secret = token(config);
    this.headers = { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) };
    this.writer = new SerialWriter(async data => {
      const response = await fetch(this.sessionUrl + '/messages', {
        method: 'POST', headers: this.headers, body: data, redirect: 'error',
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(config.timeoutMs)]),
      });
      await response.body?.cancel();
      if (response.status !== 202) throw new Error('HTTP message rejected');
    });
  }
  static async connect(config: Extract<Connection, { transport: 'http' }>) {
    validateEndpoint(config);
    const transport = new HttpTransport(config);
    try { await transport.open(); return transport; }
    catch { await transport.close(); throw new Error('HTTP connection failed (check endpoint and authentication)'); }
  }
  private async open() {
    const response = await fetch(this.config.url.replace(/\/$/, '') + '/sessions', {
      method: 'POST', headers: this.headers, body: '{}', redirect: 'error',
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.config.timeoutMs)]),
    });
    if (response.status !== 201) { await response.body?.cancel(); throw new Error('Session creation failed'); }
    const reader = response.body!.getReader();
    const pieces: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length; if (size > 4096) throw new Error('Session response too large'); pieces.push(value);
      }
    } finally { await reader.cancel(); }
    const result = JSON.parse(Buffer.concat(pieces).toString('utf8'));
    if (typeof result.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.sessionId)) throw new Error('Invalid session ID');
    this.sessionUrl = this.config.url.replace(/\/$/, '') + '/sessions/' + result.sessionId;
    // Only opening has a deadline; the established event stream is long-lived.
    const opening = new AbortController();
    const timer = setTimeout(() => opening.abort(), this.config.timeoutMs);
    let events: Response;
    try { events = await fetch(this.sessionUrl + '/events', {
      headers: { ...this.headers, Accept: 'text/event-stream' }, redirect: 'error',
      signal: AbortSignal.any([this.abort.signal, opening.signal]),
    }); } finally { clearTimeout(timer); }
    if (!events.ok || !events.headers.get('content-type')?.startsWith('text/event-stream') || !events.body) {
      await events.body?.cancel(); throw new Error('Invalid SSE stream');
    }
    this.reader = events.body.getReader();
    void this.readEvents().catch(() => { if (!this.abort.signal.aborted) this.onClose?.(new Error('HTTP event stream disconnected')); });
  }
  private async readEvents() {
    let parts: string[] = [], bytes = 0;
    const lines = new Lines(line => {
      if (line === '') {
        if (parts.length) this.onMessage?.(parts.join('\n'));
        parts = []; bytes = 0;
      } else if (line.startsWith('data:')) {
        const data = line.slice(5).replace(/^ /, '');
        bytes += Buffer.byteLength(data) + 1;
        if (bytes > MAX_BYTES) throw new Error('SSE message too large');
        parts.push(data);
      }
    }, MAX_BYTES + 16);
    for (;;) {
      const { done, value } = await this.reader!.read();
      if (done) throw new Error('Event stream ended');
      lines.push(Buffer.from(value));
    }
  }
  send(data: string) { return this.writer.send(data); }
  close() {
    return this.closing ??= (async () => {
      this.abort.abort();
      await this.reader?.cancel().catch(() => {});
      if (this.sessionUrl) {
        await fetch(this.sessionUrl, { method: 'DELETE', headers: this.headers, redirect: 'error', signal: AbortSignal.timeout(1000) })
          .then(r => r.body?.cancel()).catch(() => {});
      }
    })();
  }
}
