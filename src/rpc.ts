import { decode, encode, MAX_PENDING, RpcError, type Envelope, type Params } from './protocol.ts';

export interface Transport {
  send(data: string): Promise<void>;
  close(): Promise<void>;
  onMessage?: (data: string) => void;
  onClose?: (error: Error) => void;
}
export type RequestOptions = {
  signal?: AbortSignal; timeoutMs?: number; meta?: unknown;
  onProgress?: (params: Params) => void;
};
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void; options: RequestOptions; controller: AbortController };
export type Handler = (method: string, params: Params, id: string, signal: AbortSignal) => Promise<unknown>;

export class Peer {
  private sequence = 0;
  private pending = new Map<string, Pending>();
  private incoming = new Map<string, AbortController>();
  private ended?: Error;
  private closing?: Promise<void>;
  handler: Handler = async () => { throw new RpcError(-32601, 'Method not found'); };
  constructor(readonly transport: Transport, private prefix = 'pi-', readonly timeoutMs = 30000) {
    transport.onMessage = data => { void this.receive(data).catch(error => this.fail(error)); };
    transport.onClose = error => this.fail(error);
  }
  get isClosed() { return !!this.ended; }
  parent(id: string) { return this.pending.get(id); }
  async request(method: string, params: Params = {}, options: RequestOptions = {}): Promise<unknown> {
    if (this.ended) throw this.ended;
    if (options.signal?.aborted) throw new RpcError(-32800, 'Request cancelled');
    if (this.pending.size >= MAX_PENDING) throw new RpcError(-32000, 'Too many pending requests');
    const id = this.prefix + ++this.sequence;
    // Local serialization errors reject only this call, before granting parent authority.
    const data = encode({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const retire = (error: Error) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id); p.cleanup(); controller.abort(); reject(error);
        void this.notify('$/cancelRequest', { id }).catch(() => {});
      };
      const abort = () => retire(new RpcError(-32800, 'Request cancelled'));
      const timer = setTimeout(() => retire(new RpcError(-32000, 'Request deadline exceeded')), options.timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { resolve, reject, options, controller, cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); } });
      options.signal?.addEventListener('abort', abort, { once: true });
      try { void this.transport.send(data).catch(error => this.fail(error)); }
      catch (error) { this.fail(error as Error); }
    });
  }
  async notify(method: string, params: Params = {}) {
    if (this.ended) throw this.ended;
    await this.send({ jsonrpc: '2.0', method, params });
  }
  private send(message: Envelope) { return this.transport.send(encode(message)); }
  private async receive(data: string) {
    if (this.ended) return;
    const message = decode(data);
    if (!('method' in message)) {
      const p = this.pending.get(message.id);
      if (!p) return; // Late/duplicate responses cannot settle a different call.
      this.pending.delete(message.id); p.cleanup(); p.controller.abort();
      if ('error' in message) p.reject(new RpcError(message.error.code, message.error.message));
      else p.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    if (!('id' in message)) {
      if (message.method === '$/cancelRequest' && typeof params.id === 'string') this.incoming.get(params.id)?.abort();
      if (message.method === 'progress' && typeof params.requestId === 'string') this.pending.get(params.requestId)?.options.onProgress?.(params);
      return;
    }
    if (this.incoming.has(message.id)) throw new Error('Duplicate live request ID');
    if (this.incoming.size >= MAX_PENDING) {
      await this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Too many requests' } });
      return;
    }
    const controller = new AbortController();
    this.incoming.set(message.id, controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Do not await this handler on the transport reader: callbacks are bidirectional.
      const work = this.handler(message.method, params, message.id, controller.signal);
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new RpcError(-32800, 'Request cancelled')), { once: true });
      });
      const result = await Promise.race([work, aborted]);
      if (!this.ended) await this.send({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
    } catch (error) {
      if (!this.ended) await this.send({ jsonrpc: '2.0', id: message.id, error: {
        code: error instanceof RpcError ? error.code : -32000,
        message: error instanceof RpcError ? error.message.slice(0, 4096) : 'Request failed',
      } });
    } finally { clearTimeout(timer); this.incoming.delete(message.id); }
  }
  fail(error: Error) {
    if (this.ended) return;
    this.ended = error instanceof Error ? error : new Error('Connection failed');
    for (const p of this.pending.values()) { p.cleanup(); p.controller.abort(); p.reject(this.ended); }
    this.pending.clear();
    for (const c of this.incoming.values()) c.abort();
    this.incoming.clear();
    void this.closeTransport().catch(() => {});
  }
  private closeTransport() { return this.closing ??= Promise.resolve().then(() => this.transport.close()); }
  async close() {
    this.fail(new Error('Connection closed'));
    await this.closeTransport();
  }
}
