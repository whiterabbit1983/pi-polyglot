import { z } from 'zod';

export const MAX_BYTES = 1024 * 1024;
export const MAX_PENDING = 64;
export const VERSION = '0.1';
export const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const id = z.string().min(1).max(128);
const method = z.string().min(1).max(128);
export const envelopeSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id, method, params: z.record(z.string(), z.unknown()).optional() }).strict(),
  z.object({ jsonrpc: z.literal('2.0'), method, params: z.record(z.string(), z.unknown()).optional() }).strict(),
  z.object({ jsonrpc: z.literal('2.0'), id, result: z.unknown() }).strict().refine(v => Object.hasOwn(v, 'result')),
  z.object({ jsonrpc: z.literal('2.0'), id, error: z.object({ code: z.number().int(), message: z.string().max(4096) }).strict() }).strict(),
]);
export type Envelope = z.infer<typeof envelopeSchema>;
export type Params = Record<string, unknown>;
export const hooks = ['session_start', 'before_agent_start', 'tool_call'] as const;
export type Hook = typeof hooks[number];
export const textParts = z.array(z.object({ type: z.literal('text'), text: z.string().max(262144) }).strict()).min(1).max(64);
export const toolResult = z.object({ content: textParts, details: z.record(z.string(), z.unknown()).optional() }).strict();
export const commandResult = z.object({ text: z.string().max(65536).optional() }).strict();
export const catalogSchema = z.object({
  protocolVersion: z.literal(VERSION), name: identifier,
  tools: z.array(z.object({
    name: identifier, description: z.string().min(1).max(4096),
    parameters: z.record(z.string(), z.unknown()).refine(v => v.type === 'object', 'Tool parameters must be an object schema'),
  }).strict()).max(64),
  commands: z.array(z.object({ name: identifier, description: z.string().min(1).max(4096) }).strict()).max(32),
  hooks: z.array(z.enum(hooks)).max(3),
}).strict().superRefine((v, ctx) => {
  for (const [name, values] of [['tools', v.tools.map(x => x.name)], ['commands', v.commands.map(x => x.name)], ['hooks', v.hooks]] as const) {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${name}` });
  }
});
export type Catalog = z.infer<typeof catalogSchema>;
export function parseHookResult(name: Hook, value: unknown): Record<string, unknown> {
  if (name === 'session_start') return z.object({}).strict().parse(value);
  if (name === 'before_agent_start') return z.object({ systemPrompt: z.string().max(262144).optional() }).strict().parse(value);
  return z.object({ block: z.boolean().optional(), reason: z.string().max(4096).optional() }).strict().parse(value);
}
export function decode(data: string): Envelope {
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('Message exceeds 1 MiB');
  return envelopeSchema.parse(JSON.parse(data));
}
export function encode(value: Envelope): string {
  envelopeSchema.parse(value);
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) + 1 > MAX_BYTES) throw new Error('Message exceeds 1 MiB');
  return data;
}
export class RpcError extends Error {
  constructor(public code: number, message: string) { super(message); this.name = 'RpcError'; }
}
