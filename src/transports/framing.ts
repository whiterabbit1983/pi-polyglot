import { MAX_BYTES } from '../protocol.ts';

/** LF only; Unicode paragraph/line separators remain part of JSON strings. */
export class Lines {
  private buffer = Buffer.alloc(0);
  constructor(private emit: (line: string) => void, private limit = MAX_BYTES) {}
  push(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) break;
      if (newline + 1 > this.limit) throw new Error('Frame exceeds size limit');
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      const data = new TextDecoder('utf-8', { fatal: true }).decode(line);
      this.emit(data.endsWith('\r') ? data.slice(0, -1) : data);
    }
    if (this.buffer.length >= this.limit) throw new Error('Unterminated frame exceeds size limit');
  }
  end() { if (this.buffer.length) throw new Error('Truncated frame'); }
}

export class SerialWriter {
  private tail: Promise<void> = Promise.resolve();
  private count = 0;
  constructor(private write: (data: string) => Promise<void>) {}
  send(data: string): Promise<void> {
    if (++this.count > 64) { this.count--; return Promise.reject(new Error('Writer queue full')); }
    const next = this.tail.then(() => this.write(data));
    this.tail = next.catch(() => {});
    return next.finally(() => { this.count--; });
  }
}
