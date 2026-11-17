import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';
import { hooks, identifier, MAX_BYTES } from './protocol.ts';

const common = {
  id: identifier, permissions: z.array(z.enum(['ui.notify', 'ui.confirm', 'ui.custom'])).default([]),
  hooks: z.array(z.enum(hooks)).default([]), timeoutMs: z.number().int().min(100).max(120000).default(30000),
  uiTimeoutMs: z.number().int().min(1000).max(900000).default(300000),
};
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const connectionSchema = z.discriminatedUnion('transport', [
  z.object({ ...common, transport: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).default([]), cwd: z.string().optional(), env: z.record(z.string(), z.string()).default({}) }).strict(),
  z.object({ ...common, transport: z.literal('http'), url: z.string().url(), tokenEnv: envName.optional() }).strict(),
  z.object({ ...common, transport: z.literal('grpc'), address: z.string().min(1), tls: z.boolean().default(true), tokenEnv: envName.optional() }).strict(),
]);
export const configSchema = z.object({ version: z.literal(1), extensions: z.array(connectionSchema).max(32) }).strict().superRefine((v, ctx) => {
  if (new Set(v.extensions.map(e => e.id)).size !== v.extensions.length) ctx.addIssue({ code: 'custom', message: 'Duplicate extension IDs' });
});
export type Connection = z.infer<typeof connectionSchema>;
export function loopback(host: string) {
  const h = host.replace(/^\[|\]$/g, '');
  // Literal addresses only: do not trust DNS names such as localhost for plaintext exemptions.
  return h === '::1' || (isIP(h) === 4 && h.startsWith('127.'));
}
export function validateEndpoint(config: Connection) {
  if (config.transport === 'http') {
    const u = new URL(config.url);
    if (u.username || u.password || u.search || u.hash) throw new Error('HTTP URL must not contain credentials, query or fragment');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback(u.hostname))) throw new Error('Remote HTTP requires HTTPS');
    if (!loopback(u.hostname) && !config.tokenEnv) throw new Error('Remote endpoints require tokenEnv');
  }
  if (config.transport === 'grpc') {
    const match = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):(\d{1,5})$/.exec(config.address);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error('gRPC address must be host:port');
    if (!loopback(match[1]) && !config.tls) throw new Error('Remote gRPC requires TLS');
    if (!loopback(match[1]) && !config.tokenEnv) throw new Error('Remote endpoints require tokenEnv');
  }
}
export function token(config: Connection) {
  if (!('tokenEnv' in config) || !config.tokenEnv) return undefined;
  const value = process.env[config.tokenEnv];
  if (!value || /[\r\n]/.test(value)) throw new Error(`Missing or invalid token environment variable: ${config.tokenEnv}`);
  return value;
}
export async function loadConfig(path: string) {
  const bytes = await readFile(path);
  if (bytes.length > MAX_BYTES) throw new Error('Configuration too large');
  const config = configSchema.parse(JSON.parse(bytes.toString('utf8')));
  const base = dirname(resolve(path));
  for (const entry of config.extensions) {
    validateEndpoint(entry);
    if (entry.transport === 'stdio') {
      entry.cwd = resolve(base, entry.cwd ?? '.');
      if (entry.command.includes('/') && !isAbsolute(entry.command)) entry.command = resolve(base, entry.command);
      // Arguments are passed literally. Relative file arguments resolve in configured cwd.
    }
  }
  return config;
}
