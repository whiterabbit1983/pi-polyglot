import type { Component, TUI } from '@earendil-works/pi-tui';

/** Measure the public mounted tree, never Pi's private editor/footer fields. */
export function inlineHeight(tui: TUI, target: Component, width: number): number {
  const seen = new Set<Component>();
  type Step = { siblings: Component[]; index: number };
  const locate = (siblings: Component[]): Step[] | undefined => {
    for (const [index, component] of siblings.entries()) {
      if (component === target) return [{ siblings, index }];
      if (seen.has(component)) continue;
      seen.add(component);
      const children = (component as Component & { children?: Component[] }).children;
      if (Array.isArray(children)) {
        const path = locate(children);
        if (path) return [{ siblings, index }, ...path];
      }
    }
    return undefined;
  };
  const path = locate(tui.children);
  if (!path) throw new Error('Inline view is not mounted in the public component tree');
  const height = (components: Component[]) => components.reduce((sum, c) => sum + c.render(width).length, 0);
  let reserved = 0;
  for (const [depth, { siblings, index }] of path.entries()) {
    // Regular mode displays the last terminal.rows lines. Anything after this
    // slot (including a dynamically sized footer/widget) reduces its viewport.
    reserved += height(siblings.slice(index + 1));
    if (tui.mode === 'fullscreen') {
      // Pi 1.5's fullscreen dock follows the document root. Conservatively
      // reserve its preceding fixed content and the transcript's minimum row.
      // This avoids relying on private layout state or accepting invisible input.
      reserved += height(siblings.slice(depth === 0 ? 1 : 0, index));
    }
  }
  if (tui.mode === 'fullscreen') reserved++;
  const available = tui.terminal.rows - reserved;
  if (available < 1) throw new Error('No visible space for inline UI; use an overlay');
  return available;
}
