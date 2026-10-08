import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildRows } from './ShaderNode';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { effectiveNodeDef } from '@/utils/exposedPorts';

/**
 * The NodeVisual replica must render a node the way the canvas does WHATEVER
 * page draws it — asset cards, the node-editor.html overview, the Node
 * Designer stage. Measured 2026-09-03 across all 67 designable types: the
 * designer differed from the overview on 15, for four reasons pinned here.
 * None fails loudly — a socket too many or 2px of width is only ever noticed
 * by eye, which is how the owner found Data Stripes.
 *
 * The fourth is the CANVAS class, and it was the worst of them: two branches of
 * ShaderNode read the RAW definition while the rows layout filtered, so a
 * freshly dropped Data Stripes carried all three input sockets with its two
 * colours drawn as number boxes (NaN for a hex) — on the main editing surface,
 * beside tiles that correctly hid them. It went unpinned when the other three
 * were written, so reverting either branch to `def` left the whole suite green.
 */
const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('node-visual parity across surfaces', () => {
  it('NodeVisual hides the opt-in ramp sockets itself, so no surface can show sockets a fresh node lacks', () => {
    const src = read('./NodeVisual.tsx');
    expect(src).toMatch(/const def = effectiveNodeDef\(rawDef, NO_EXPOSED\);/);
    // The card used to do it by hand; a second copy would let the two drift.
    expect(read('../NodePreviewCard.tsx')).not.toContain('effectiveRampDef(');
    expect(read('../NodePreviewCard.tsx')).not.toContain('effectiveNodeDef(');
  });

  it('ShaderNode filters the canvas the same way — both branches read effDef, not def', () => {
    const src = read('./ShaderNode.tsx');
    // The filter itself: Data Stripes / Data Viz hide their opt-in ramp ends.
    expect(src).toMatch(/effectiveNodeDef\(def, exposedInputs\)/);
    // The OPERATOR branch — these two are glyph nodes, so they never reach the
    // rows layout that was already filtering.
    expect(src).toMatch(/effectiveInputs\(effDef,/);
    expect(src).toMatch(/growsOperands\(effDef\)/);
    // The DETACHED-socket loop of the rows layout: their designer moved every
    // socket out of its row, so this loop is the one that actually drew them.
    expect(src).toMatch(/\{effDef\.inputs\.map\(/);
    // The exact reverted form, spelled out so the diff that reintroduces it
    // fails here rather than being noticed by eye months later.
    expect(src, 'the operator branch must not read the unfiltered def')
      .not.toMatch(/effectiveInputs\(def,/);
  });

  it('the Image node\'s opt-in params are filtered by the SHARED helper, not inline in ShaderNode', () => {
    // NodeVisual never ran ShaderNode's old inline image filter, so a palette
    // tile drew six param rows with number boxes beside a canvas node that
    // showed none (GLB Phase 4). One function now serves both surfaces.
    expect(read('./ShaderNode.tsx')).not.toContain("registryType !== 'imageNode') return def");
    const rows = buildRows(effectiveNodeDef(NODE_REGISTRY.get('imageNode')!, []));
    expect(rows.map((r) => r.output?.id)).toEqual(['out', 'r', 'g', 'b', 'alpha']);
    for (const r of rows) {
      expect(r.input).toBeNull();
      expect(r.settingKey).toBeNull();
    }
  });

  it('the card owns its font size — page bodies differ (app 14px, designer 13px, overview 10px)', () => {
    const css = read('./NodeBase.css');
    const rule = css.slice(css.indexOf('.node-base {'), css.indexOf('}', css.indexOf('.node-base {')));
    expect(rule).toContain('font-size: var(--font-size-md);');
  });

  // WebKit drops an intrinsic `min-width` when sizing the parent, so the old
  // `width: <authored>; min-width: min-content` left the fit-content wrapper
  // (which the multi-channel stack layers fill, and React Flow measures) at
  // the bare authored width while the card grew past it — stacked layers drew
  // short on 25 of 69 cards in Safari. Chrome never showed it.
  it('the authored width is the FLOOR and min-content the WIDTH, on both renderers (WebKit)', () => {
    for (const file of ['./ShaderNode.tsx', './NodeVisual.tsx']) {
      const src = read(file);
      expect(src).toContain("nodeStyle.width = 'min-content';");
      expect(src).toContain('nodeStyle.minWidth = box.width;');
      expect(src).not.toMatch(/minWidth\s*[=:]\s*'min-content'/);
    }
  });

  it('the Slider range input zeroes its UA margin itself — the designer page loads no reset', () => {
    const css = read('./ShaderNode.css');
    const rule = css.slice(css.indexOf('.shader-node__slider {'), css.indexOf('}', css.indexOf('.shader-node__slider {')));
    expect(rule).toContain('margin: 0;');
  });

  // Blender's hide_value (Fresnel's Normal): a box forgotten on ONE of the five
  // value sites would only ever show on that surface — the parity class above.
  it('hideValue is honoured on every value cell of both renderers', () => {
    for (const file of ['./ShaderNode.tsx', './NodeVisual.tsx']) {
      const src = read(file);
      const cells = src.match(/<PortValueCell\b/g)?.length ?? 0;
      expect(cells, file).toBeGreaterThan(0);
      // `hideValue={` appears only at call sites (the definition destructures it), one per `<PortValueCell`.
      expect(src.match(/hideValue=\{/g)?.length ?? 0, file).toBe(cells);
      expect(src, file).toMatch(/const showInlineValue = [^;]*hideValue !== true/);
    }
    expect(read('./ShaderNode.tsx')).toMatch(/if \(!connected && hideValue\) return null;/);
  });
});
