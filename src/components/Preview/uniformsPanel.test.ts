import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The Uniforms overlay must SCROLL inside the 3D pane, never grow past it —
 * a shader with many connected properties otherwise pushed the panel through
 * the pane's bottom edge and over (or past) the play/fullscreen pills, which
 * matters doubly because the panel is z-index 5 over the bottom bar's 2, so
 * an overlap OCCLUDES the controls rather than merely shading them.
 *
 * Source pins because the vitest env is `node` and every one of these is a
 * rendered fact that fails silently: deleting the max-height "cleanup" style
 * simply regrows the panel. Measured in Chromium (1500×950, previewSplitRatio
 * 0.28, 8 uniforms): panel bottom 243 vs bar top 250 — scrolling, clear of
 * the bar.
 */
describe('the Uniforms overlay height cap', () => {
  const css = readFileSync(path.resolve(__dirname, 'ShaderPreview.css'), 'utf8');
  // Anchored at line start: a bare indexOf would land on the stats variant's
  // selector TAIL (`.shader-preview__body--stats .shader-preview__uniforms`),
  // which appears first in the file.
  const block = (sel: string) => {
    const i = css.indexOf(`\n${sel}`);
    return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  };
  const base = block('.shader-preview__uniforms {');

  it('caps the panel to the pane and scrolls internally', () => {
    // 65 = the 6px top offset + 59px bottom reserve (10px bar inset + the
    // measured 43px single-row bar). The exact number may be re-derived, but
    // a cap and an internal scroll must both exist.
    expect(base).toMatch(/max-height:\s*calc\(100% - \d+px\)/);
    expect(base).toMatch(/overflow-y:\s*auto/);
  });

  it('re-derives the cap for the stats variant (its top edge sits 30px lower)', () => {
    // .shader-preview__body--stats drops the panel to top: 36px; without its
    // own max-height the base cap lets the panel run 30px past the reserve.
    const stats = block('.shader-preview__body--stats .shader-preview__uniforms {');
    expect(stats).toMatch(/max-height:\s*calc\(100% - \d+px\)/);
    const px = (b: string) => Number(/max-height:\s*calc\(100% - (\d+)px\)/.exec(b)?.[1] ?? NaN);
    // The two caps must differ by exactly the top-offset difference (36 - 6),
    // or one of them stopped reserving the same space below.
    expect(px(stats) - px(base)).toBe(30);
  });
});
