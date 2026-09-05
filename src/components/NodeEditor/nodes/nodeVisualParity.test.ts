import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The NodeVisual replica must render a node the way the canvas does WHATEVER
 * page draws it — asset cards, the node-editor.html overview, the Node
 * Designer stage. Measured 2026-09-03 across all 67 designable types: the
 * designer differed from the overview on 15, for three reasons pinned here.
 * None fails loudly — a socket too many or 2px of width is only ever noticed
 * by eye, which is how the owner found Data Stripes.
 */
const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('node-visual parity across surfaces', () => {
  it('NodeVisual hides the opt-in ramp sockets itself, so no surface can show sockets a fresh node lacks', () => {
    const src = read('./NodeVisual.tsx');
    expect(src).toMatch(/const def = effectiveRampDef\(rawDef, NO_EXPOSED\);/);
    // The card used to do it by hand; a second copy would let the two drift.
    expect(read('../NodePreviewCard.tsx')).not.toContain('effectiveRampDef(');
  });

  it('the card owns its font size — page bodies differ (app 14px, designer 13px, overview 10px)', () => {
    const css = read('./NodeBase.css');
    const rule = css.slice(css.indexOf('.node-base {'), css.indexOf('}', css.indexOf('.node-base {')));
    expect(rule).toContain('font-size: var(--font-size-md);');
  });

  it('the Slider range input zeroes its UA margin itself — the designer page loads no reset', () => {
    const css = read('./ShaderNode.css');
    const rule = css.slice(css.indexOf('.shader-node__slider {'), css.indexOf('}', css.indexOf('.shader-node__slider {')));
    expect(rule).toContain('margin: 0;');
  });
});
