/**
 * `/evalp` (`?points=off`) removes EVERY point figure (docs/dev/eval-mode.md).
 * Badges and the cost bar go through eval.css's `[data-fs-points='off']`
 * sweep, but a MENU ROW's price is prose inside a row, which that sweep does
 * not reach — so each one gates on `evalTask().pointsVisible` in code. The
 * intro's insert slide (shown in every study arm, /evalp included) printed its
 * row's price with no gate until 2026-10-23.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('/evalp: no point figure in a menu row', () => {
  it('the Add-node menu and the intro\'s copy of it both gate the row price', () => {
    for (const file of ['../components/NodeEditor/menus/AddNodeMenu.tsx', '../intro/InsertScene.tsx']) {
      expect(read(file), file).toMatch(/cost > 0 && evalTask\(\)\.pointsVisible && \(\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<span\s+className="context-menu__item-cost"/);
    }
  });

  it('the points-off sweep still hides the badges and the bar', () => {
    const css = read('./eval.css');
    expect(css).toMatch(/\[data-fs-points=['"]off['"]\][^{]*\.node-base__cost-badge/);
    expect(css).toMatch(/\[data-fs-points=['"]off['"]\][^{]*\.cost-bar/);
  });
});
