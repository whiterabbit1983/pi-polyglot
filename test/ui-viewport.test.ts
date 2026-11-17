import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container, CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, TuiMainScreen, TuiAltScreen, type Component } from '@earendil-works/pi-tui';
import { VStack } from '@earendil-works/pi-tui/dist/components/v-stack.js';
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js';
import { UiManager, type UiContext } from '../src/ui/manager.ts';
import type { Peer } from '../src/rpc.ts';
import { testTheme, until } from './helpers/tui.ts';

for (const mode of ['regular', 'fullscreen'] as const) {
  test(`inline viewport accounts for the footer and widgets (${mode})`, async () => {
    let footerRows = 2;
    const fixed = (lines: string[]): Component => ({ render: () => lines, invalidate() {} });
    const terminal = { columns: 40, rows: 10, write() {}, hideCursor() {} } as any;
    const tui = mode === 'regular' ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const document = fixed(['transcript']), above = fixed(['widget above']);
    const editor = new Container(), below = fixed(['widget below']);
    const footer: Component = { render: () => Array(footerRows).fill('footer'), invalidate() {} };
    for (const child of [document, above, editor, below, footer]) tui.addChild(child);
    const dock = new VStack([above, editor, below, footer].map(component => ({ component, shrink: 1, minSize: component === editor ? 3 : 0 })));
    const layout = new VStack([{ component: document, basis: 0, grow: 1, minSize: 1 }, { component: dock, shrink: 1, minSize: 1 }]);
    const events: any[] = [];
    const manager = new UiManager({ request: async (_method: string, params: any) => { events.push(params); return {}; } } as unknown as Peer, 1000);
    let wrapper: (Component & { focused: boolean; dispose(): void }) | undefined;
    const ctx: UiContext = { hasUI: true, mode: 'tui', ui: { custom: (factory: any) => new Promise(resolve => {
      const done = (value: unknown) => { const current = wrapper; wrapper = undefined; editor.clear(); current?.dispose(); resolve(value); };
      wrapper = factory(tui, testTheme, new KeybindingsManager(TUI_KEYBINDINGS), done);
      editor.addChild(wrapper!); wrapper!.focused = true;
    }) } as any };
    const opened = manager.handle('host.ui.open', {
      parentRequestId: 'command', viewId: 'view', title: 'Inline', surface: 'inline',
      document: { type: 'column', children: [
        { type: 'input', id: 'name', label: 'Name', value: 'Ada' },
        { type: 'frame', lines: Array.from({ length: 20 }, (_, i) => [{ text: `row ${i}` }]) },
      ] },
    }, ctx, new AbortController().signal);
    const render = () => mode === 'regular' ? tui.render(40).slice(-10) : renderLayoutFrame(layout, 40, 10, () => {}).lines;
    try {
      await until(() => !!wrapper);
      assert.ok(render().some(line => line.includes(CURSOR_MARKER) && line.includes('Ada')));
      wrapper!.handleInput!('B');
      assert.ok(render().some(line => line.includes('AdaB')));
      footerRows = 4;
      assert.ok(render().some(line => line.includes(CURSOR_MARKER) && line.includes('AdaB')));
      // A widget can grow after the last frame but before input. No hidden edit.
      footerRows = 10;
      const changes = events.filter(e => e.event.type === 'change').length;
      wrapper!.handleInput!('X');
      assert.deepEqual(await opened, { cancelled: true, reason: 'render_failed' });
      assert.equal(events.filter(e => e.event.type === 'change').length, changes);
      assert.equal(wrapper, undefined);
    } finally { manager.dispose(); }
  });
}
