import { describe, it, expect } from 'vitest';
import { getAllDefinitions, getFlowNodeType } from '@/registry/nodeRegistry';
import { hasNodeGlyph } from '@/components/NodeEditor/nodes/glyphs/NodeGlyph';
import { CUSTOM_GLYPHS } from '@/components/NodeEditor/nodes/glyphs/customGlyphs';

/**
 * Every ShaderNode-rendered node should carry a glyph, because the glyph IS its
 * visual identity — on the canvas, in the content browser, and in the
 * node-editor overview page. Nodes added without one render as a bare titled
 * box and are indistinguishable from each other at a glance, which is exactly
 * how a batch of recently-added nodes ended up looking unfinished.
 *
 * Live-canvas nodes (noise / sin / cos / time / colour / output) paint
 * themselves and are excluded by construction — `getFlowNodeType(def) !==
 * 'shader'` — the same rule the Node Designer's data layer
 * (src/nodeDesigner/ndData.ts) derives its designable set from.
 *
 * The allow-list below is the set that is glyph-less ON PURPOSE. Adding to it is
 * a design decision, not a shortcut: state the reason.
 */
const DELIBERATELY_GLYPHLESS = new Set([
  // NODE_DESIGN_REQUIREMENTS #15: float/int render as plain number rows like
  // vec2/vec3 — no knob. Their value IS the visualization; an icon on top would
  // only crowd the number.
  'float', 'int', 'vec2', 'vec3', 'vec4',
  // Carry a user-authored name/value in the header or a slider track, which
  // identifies them better than any icon could.
  'property_float', 'slider',
  // 3+ input nodes whose rows fill the body — the port names are the identity.
  'mix', 'smoothstep', 'remap', 'select',
  // Structural vector plumbing: the socket set (x/y/z/w) is the whole meaning.
  'split', 'append',
  // Draws its actual colour ramp instead of an icon, which is strictly more
  // informative than a generic ramp glyph. The ramp is the node's ART: every
  // preview surface renders it through the ONE shared replica (NodeVisual —
  // asset cards, node-editor overview, and the Node Designer's stage), and
  // the canvas node draws the same .shader-node__colormap-strip in
  // ShaderNode. The designer's dx/dy/scale apply to the strip via
  // nodeArtStyle — which relies on this exemption: art nodes have no glyph,
  // so dx/dy can mean CSS px here without colliding with glyph-space units.
  'colormap',
]);

describe('glyph coverage', () => {
  const shaderRendered = getAllDefinitions().filter((d) => getFlowNodeType(d) === 'shader');

  it('every shader-rendered node has a glyph, or is deliberately exempt', () => {
    const missing = shaderRendered
      .filter((d) => !hasNodeGlyph(d.type) && !DELIBERATELY_GLYPHLESS.has(d.type))
      .map((d) => d.type);
    expect(missing, `these nodes render as a bare box — draw a glyph in customGlyphs.ts, or add them to DELIBERATELY_GLYPHLESS with a reason: ${missing.join(', ')}`).toEqual([]);
  });

  it('the exempt list has no stale entries', () => {
    // A node that gained a glyph, was removed, or stopped being ShaderNode-
    // rendered must drop off the list, or it silently excuses a future gap.
    const types = new Set(shaderRendered.map((d) => d.type));
    const stale = [...DELIBERATELY_GLYPHLESS].filter((t) => !types.has(t) || hasNodeGlyph(t));
    expect(stale).toEqual([]);
  });

  it('custom glyph SVGs are well-formed and use the centred glyph space', () => {
    for (const [type, entry] of Object.entries(CUSTOM_GLYPHS)) {
      if (!entry.svg) continue;
      // The art is injected with dangerouslySetInnerHTML into a `0 0 56 56`
      // <svg>, so a stray unclosed tag would corrupt the surrounding DOM rather
      // than just look wrong.
      const opens = (entry.svg.match(/<(?!\/)[a-zA-Z]/g) ?? []).length;
      const closes = (entry.svg.match(/<\/[a-zA-Z]/g) ?? []).length;
      const selfClosing = (entry.svg.match(/\/>/g) ?? []).length;
      expect(opens, `${type}: unbalanced tags`).toBe(closes + selfClosing);
      expect(entry.svg, `${type}: must not carry its own <svg> wrapper`).not.toMatch(/<svg/);
      expect(entry.svg, `${type}: must not reference external URLs`).not.toMatch(/https?:/);
    }
  });
});
