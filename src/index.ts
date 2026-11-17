import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { loadConfig } from './config.ts';
import { Bridge } from './bridge.ts';
import type { Params } from './protocol.ts';

/** Configuration is deliberately opt-in; never auto-run a project's arbitrary executable. */
export default async function polyglot(pi: ExtensionAPI) {
  const path = process.env.PI_POLYGLOT_CONFIG;
  if (!path) return;
  const bridges: Bridge[] = [];
  let ready = false;
  const unavailable = 'Polyglot configuration or startup failed; tool calls are blocked. Fix the configuration and reload Pi.';
  // Pi discards extensions whose factory throws. Retain this guard even when
  // configuration/connection fails, so a failed policy service cannot fail open.
  pi.on('tool_call', async () => ready ? undefined : { block: true, reason: unavailable });
  pi.on('session_start', async (_event, ctx) => { if (!ready && ctx.hasUI) ctx.ui.notify(unavailable, 'error'); });
  pi.on('session_shutdown', async () => { ready = false; await Promise.allSettled(bridges.map(b => b.shutdown())); });
  const safeError = (bridge: Bridge, ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.notify(`Polyglot ${bridge.config.id}: operation failed; check the service and configuration.`, 'error');
  };
  try {
    const config = await loadConfig(path);
    for (const item of config.extensions) bridges.push(await Bridge.connect(item, process.cwd()));
    const names = new Set<string>();
    for (const bridge of bridges) {
      for (const [kind, contributions] of [['tool', bridge.catalog.tools], ['command', bridge.catalog.commands]] as const) {
        for (const contribution of contributions) {
          const name = bridge.name(contribution.name), key = `${kind}:${name}`;
          if (names.has(key) || name.length > 64) throw new Error('Conflicting or oversized contribution name');
          names.add(key);
        }
      }
    }
    for (const bridge of bridges) {
      for (const tool of bridge.catalog.tools) {
        pi.registerTool({
          name: bridge.name(tool.name), label: `${bridge.config.id}: ${tool.name}`,
          description: tool.description, parameters: tool.parameters as TSchema,
          async execute(_callId, params, signal, onUpdate, ctx) {
            if (!ready) throw new Error(unavailable);
            return bridge.callTool(tool.name, params, ctx, {
              signal, onProgress: onUpdate ? p => onUpdate({ content: p.content as any, details: {} }) : undefined,
            });
          },
        });
      }
      for (const command of bridge.catalog.commands) {
        pi.registerCommand(bridge.name(command.name), {
          description: command.description,
          async handler(args, ctx) {
            if (!ready) { if (ctx.hasUI) ctx.ui.notify(unavailable, 'error'); return; }
            try {
              const result = await bridge.command(command.name, args, ctx);
              if (result.text && ctx.hasUI) ctx.ui.notify(result.text, 'info');
            } catch { safeError(bridge, ctx); }
          },
        });
      }
      if (bridge.catalog.hooks.includes('session_start')) pi.on('session_start', async (event, ctx) => {
        if (!ready) return;
        try { await bridge.hook('session_start', { reason: event.reason }, ctx); }
        catch { safeError(bridge, ctx); }
      });
      if (bridge.catalog.hooks.includes('before_agent_start')) pi.on('before_agent_start', async (event, ctx) => {
        if (!ready) return;
        return await bridge.hook('before_agent_start', { prompt: 'prompt' in event ? event.prompt : '', systemPrompt: event.systemPrompt }, ctx) as { systemPrompt?: string };
      });
      if (bridge.catalog.hooks.includes('tool_call')) pi.on('tool_call', async (event, ctx) => {
        if (!ready) return { block: true, reason: unavailable };
        try { return await bridge.hook('tool_call', { toolName: event.toolName, toolCallId: event.toolCallId, input: event.input } as Params, ctx) as { block?: boolean; reason?: string }; }
        catch { return { block: true, reason: `Polyglot policy hook ${bridge.config.id} failed; tool call blocked.` }; }
      });
    }
    ready = true;
  } catch {
    // Keep the registered startup guard. Do not leak endpoint errors or tokens.
    await Promise.allSettled(bridges.map(b => b.shutdown()));
  }
}
