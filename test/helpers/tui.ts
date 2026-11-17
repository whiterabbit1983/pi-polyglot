import { KeybindingsManager, TUI_KEYBINDINGS, type Component } from '@earendil-works/pi-tui';
import type { HostContext } from '../../src/bridge.ts';

export const testTheme = {
  fg: (_style: string, value: string) => value,
  bg: (_style: string, value: string) => value,
  bold: (value: string) => value,
  underline: (value: string) => value,
  style: (value: string) => value,
  appearance: 'dark',
};
export function fakeTui() {
  let component: (Component & { dispose?: () => void; focused?: boolean }) | undefined;
  let width = 60, height = 20;
  let renderCount = 0, doneCount = 0, latest: string[] = [];
  let pendingRender = false;
  const render = () => { if (component) { latest = component.render(width); renderCount++; } return latest; };
  const ctx: HostContext = {
    cwd: '/workspace', hasUI: true, mode: 'tui',
    ui: {
      notify() {}, confirm: async () => true,
      custom: (factory: any) => new Promise((resolve, reject) => {
        const done = (value: unknown) => { doneCount++; const current = component; component = undefined; current?.dispose?.(); resolve(value); };
        const tui = {
          mode: 'regular',
          get children() { return component ? [component] : []; },
          terminal: { get rows() { return height; }, get columns() { return width; } },
          requestRender: () => {
            if (pendingRender) return;
            pendingRender = true;
            queueMicrotask(() => { pendingRender = false; render(); });
          },
        };
        Promise.resolve(factory(tui, testTheme, new KeybindingsManager(TUI_KEYBINDINGS), done)).then(value => {
          component = value; component!.focused = true; render();
        }, reject);
      }),
    } as any,
  };
  return {
    ctx, render,
    input: (data: string) => component?.handleInput?.(data),
    resize: (w: number, h: number) => { width = w; height = h; component?.invalidate(); return render(); },
    get active() { return !!component; },
    get lines() { return latest; },
    get renders() { return renderCount; },
    get completions() { return doneCount; },
  };
}
export async function until(predicate: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Test condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
