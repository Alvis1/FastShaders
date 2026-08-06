import { describe, it, expect } from 'vitest';
import {
  nodeArtStyle,
  nodeBox,
  nodeJustify,
  nodeSockets,
  nodeScale,
  nodeTextScale,
  hasNodeGlyph,
  type GlyphDesign,
} from './NodeGlyph';
import { CUSTOM_GLYPHS } from './customGlyphs';

/**
 * The design-override contract every preview surface relies on:
 * `design` (the Node Designer's draft) REPLACES the saved CUSTOM_GLYPHS entry
 * outright; absent, the helpers read the saved table — so the designer's
 * stage, the asset cards and the canvas node all resolve one design the same
 * way. Plus nodeArtStyle, the "movable node art" rule (the colormap ramp):
 * dx/dy/scale become a purely visual CSS transform in px.
 */
describe('nodeArtStyle — movable node art (colormap ramp)', () => {
  it('returns undefined for a default design (no useless transform on every strip)', () => {
    expect(nodeArtStyle('colormap', {})).toBeUndefined();
    expect(nodeArtStyle('colormap', { dx: 0, dy: 0, scale: 1 })).toBeUndefined();
  });

  it('translates by dx/dy in CSS px and scales the art', () => {
    expect(nodeArtStyle('colormap', { dx: 4, dy: -6 })).toEqual({ transform: 'translate(4px, -6px) scale(1)' });
    expect(nodeArtStyle('colormap', { scale: 1.5 })).toEqual({ transform: 'translate(0px, 0px) scale(1.5)' });
  });

  it('ignores a non-positive or non-numeric scale (same rule as nodeScale)', () => {
    expect(nodeArtStyle('colormap', { dx: 2, scale: 0 } as GlyphDesign)).toEqual({
      transform: 'translate(2px, 0px) scale(1)',
    });
  });

  it('falls back to the saved CUSTOM_GLYPHS entry when no draft is given', () => {
    const saved = CUSTOM_GLYPHS['colormap'];
    const expected = saved && ((saved.dx ?? 0) !== 0 || (saved.dy ?? 0) !== 0 || (saved.scale ?? 1) !== 1)
      ? { transform: `translate(${saved.dx ?? 0}px, ${saved.dy ?? 0}px) scale(${saved.scale && saved.scale > 0 ? saved.scale : 1})` }
      : undefined;
    expect(nodeArtStyle('colormap')).toEqual(expected);
  });
});

describe('design-override helpers — draft replaces saved, never merges', () => {
  // A type guaranteed to have a saved design with several fields.
  const savedType = Object.keys(CUSTOM_GLYPHS).find((t) => CUSTOM_GLYPHS[t].width) ?? Object.keys(CUSTOM_GLYPHS)[0];

  it('an EMPTY draft yields registry defaults even when a saved design exists', () => {
    expect(savedType, 'need at least one saved design for this test').toBeTruthy();
    const draft: GlyphDesign = {};
    expect(nodeBox(savedType, draft)).toEqual({ width: undefined, height: undefined });
    expect(nodeJustify(savedType, draft)).toBe('center');
    expect(nodeSockets(savedType, draft)).toEqual({});
    expect(nodeScale(savedType, draft)).toBe(1);
    expect(nodeTextScale(savedType, draft)).toBe(1);
  });

  it('draft fields win over saved ones', () => {
    expect(nodeBox('mul', { width: 200, height: 64 })).toEqual({ width: 200, height: 64 });
    expect(nodeJustify('mul', { justify: 'left' })).toBe('left');
    expect(nodeSockets('mul', { sockets: { a: -8 } })).toEqual({ a: -8 });
    expect(nodeTextScale('mul', { text: 9 })).toBe(2.5); // clamp still applies
    expect(nodeBox('mul', { width: 10 })).toEqual({ width: 24, height: undefined }); // floor still applies
  });

  it('hasNodeGlyph with a draft is decided by the draft svg alone', () => {
    // mul has built-in art, but a cleared draft previews as glyph-less…
    expect(hasNodeGlyph('mul')).toBe(true);
    expect(hasNodeGlyph('mul', {})).toBe(false);
    // …and a draft svg makes any node preview as a glyph node.
    expect(hasNodeGlyph('colormap', { svg: '<g/>' })).toBe(true);
  });
});
