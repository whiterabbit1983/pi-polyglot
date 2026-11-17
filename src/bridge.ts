import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Ajv, type ValidateFunction } from 'ajv';
import { z } from 'zod';
import type { Connection } from './config.ts';
import { Peer, type RequestOptions } from './rpc.ts';
import { catalogSchema, commandResult, parseHookResult, RpcError, textParts, toolResult, VERSION, type Catalog, type Hook, type Params } from './protocol.ts';
import { StdioTransport } from './transports/stdio.ts';
import { HttpTransport } from './transports/http.ts';
import { GrpcTransport } from './transports/grpc.ts';

const reverseBase = { parentRequestId: z.string().min(1).max(128) };
const notifyParams = z.object({ ...reverseBase, message: z.string().max(65536), level: z.enum(['info', 'warning', 'error']).default('info') }).strict();
const confirmParams = z.object({ ...reverseBase, title: z.string().max(1024), message: z.string().max(65536) }).strict();
export type HostContext = Pick<ExtensionContext, 'cwd' | 'hasUI' | 'ui'> & { signal?: AbortSignal };

export class Bridge {
  catalog!: Catalog;
  private validators = new Map<string, ValidateFunction>();
  private stopping?: Promise<void>;
  constructor(readonly config: Connection, readonly peer: Peer) {
    peer.handler = (method, params, _id, signal) => this.reverse(method, params, signal);
  }
  static async connect(config: Connection, cwd: string) {
    const transport = config.transport === 'stdio' ? new StdioTransport(config)
      : config.transport === 'http' ? await HttpTransport.connect(config) : new GrpcTransport(config);
    const bridge = new Bridge(config, new Peer(transport, 'pi-', config.timeoutMs));
    try { await bridge.initialize(cwd); return bridge; }
    catch (error) { await bridge.peer.close(); throw error; }
  }
  async initialize(cwd: string) {
    this.catalog = catalogSchema.parse(await this.peer.request('initialize', {
      protocolVersion: VERSION, client: { name: 'pi-polyglot', version: '0.1.0' },
      permissions: this.config.permissions, context: { cwd },
    }));
    for (const hook of this.catalog.hooks) {
      if (!this.config.hooks.includes(hook)) throw new Error(`Hook ${hook} requires explicit permission for ${this.config.id}`);
    }
    const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
    for (const tool of this.catalog.tools) {
      // Do not compile enormous/deep schemas from a service into executable validators.
      const json = JSON.stringify(tool.parameters);
      if (Buffer.byteLength(json) > 65536) throw new Error('Tool schema exceeds 64 KiB');
      const allowed = new Set(['type', 'description', 'title', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']);
      const walk = (value: unknown, depth: number) => {
        if (depth > 24) throw new Error('Tool schema nesting exceeds limit');
        if (typeof value === 'boolean') return;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid schema node');
        for (const [key, child] of Object.entries(value)) {
          if (!allowed.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
          if (key === 'properties') {
            if (!child || typeof child !== 'object' || Array.isArray(child) || Object.keys(child).length > 128) throw new Error('Invalid schema properties');
            for (const schema of Object.values(child)) walk(schema, depth + 1);
          }
          if (key === 'items' || key === 'additionalProperties') walk(child, depth + 1);
        }
      };
      walk(tool.parameters, 0);
      this.validators.set(tool.name, ajv.compile(tool.parameters));
    }
  }
  name(local: string) { return `pg_${this.config.id}_${local}`; }
  async callTool(name: string, args: unknown, ctx: HostContext, options: RequestOptions = {}) {
    const validate = this.validators.get(name);
    if (!validate || !validate(args)) throw new RpcError(-32602, 'Invalid tool arguments');
    const result = await this.peer.request('tool.call', { name, arguments: args, context: { cwd: ctx.cwd } }, {
      ...options, meta: ctx,
      onProgress: options.onProgress ? params => {
        const parsed = textParts.safeParse(params.content);
        if (!parsed.success) throw new Error('Invalid progress');
        options.onProgress!({ content: parsed.data });
      } : undefined,
    });
    const parsed = toolResult.parse(result);
    return { ...parsed, details: parsed.details ?? {} };
  }
  async command(name: string, args: string, ctx: HostContext) {
    return commandResult.parse(await this.peer.request('command.execute', { name, arguments: args, context: { cwd: ctx.cwd } }, { meta: ctx, signal: ctx.signal }));
  }
  async hook(name: Hook, event: Params, ctx: HostContext) {
    return parseHookResult(name, await this.peer.request('hook.run', { name, event, context: { cwd: ctx.cwd } }, { meta: ctx, signal: ctx.signal }));
  }
  private async reverse(method: string, params: Params, signal: AbortSignal) {
    if (method !== 'host.ui.notify' && method !== 'host.ui.confirm') throw new RpcError(-32601, 'Unknown host method');
    const permission = method.slice(5) as 'ui.notify' | 'ui.confirm';
    if (!this.config.permissions.includes(permission)) throw new RpcError(-32001, 'Host permission denied');
    const parsed = (method === 'host.ui.notify' ? notifyParams : confirmParams).safeParse(params);
    if (!parsed.success) throw new RpcError(-32602, 'Invalid host request');
    const parent = this.peer.parent(parsed.data.parentRequestId);
    if (!parent || parent.controller.signal.aborted) throw new RpcError(-32001, 'Parent request is no longer active');
    const ctx = parent.options.meta as HostContext | undefined;
    if (!ctx?.hasUI) throw new RpcError(-32001, 'UI is unavailable');
    if (method === 'host.ui.notify') {
      const value = notifyParams.parse(params);
      ctx.ui.notify(value.message, value.level); return {};
    }
    const value = confirmParams.parse(params);
    const confirmed = await ctx.ui.confirm(value.title, value.message, {
      signal: AbortSignal.any([signal, parent.controller.signal]), timeout: this.config.timeoutMs,
    });
    if (parent.controller.signal.aborted || signal.aborted) throw new RpcError(-32800, 'Parent request ended');
    return { confirmed: confirmed === true };
  }
  shutdown() {
    return this.stopping ??= (async () => {
      try { if (!this.peer.isClosed) await this.peer.request('shutdown', {}, { timeoutMs: 1000 }); }
      catch { /* Cleanup is mandatory even without acknowledgement. */ }
      finally { await this.peer.close(); }
    })();
  }
}
