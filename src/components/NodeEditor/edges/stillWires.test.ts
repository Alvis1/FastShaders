import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * "Marching only animated" (owner, 2026-10-11). A wire whose source changes on
 * its own (Time or Sound upstream — getLiveUpstreamSet, liveUpstreamSet.test.ts)
 * keeps React Flow's marching ants; every other wire is drawn SOLID with
 * direction chevrons (bezierGeometry.test.ts holds their geometry). The idle
 * canvas then repaints nothing: one marching SVG path anywhere forces Chrome's
 * per-frame layerization (static 150-node graph: ~7 ms/frame with 280 marching
 * paths, ~0.3 with none).
 *
 * The node env has no DOM and no cascade, so the contracts the browser
 * enforces are SOURCE-pinned here: every edge is stored `animated: true`, and
 * React Flow's `.react-flow__edge.animated path` rule dashes and animates EVERY
 * path inside an edge — so a still path without the inline opt-out marches
 * again with every test green (as it did in node-editor.html's GraphModal
 * while the opt-out was a canvas-scoped CSS rule).
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const EDGE = read('./TypedEdge.tsx');
const NODE_EDITOR_CSS = read('../NodeEditor.css');
const RESET_CSS = read('../../../styles/reset.css');
const LINK = read('../../Layout/PreviewLink.tsx');
const LINK_CSS = read('../../Layout/PreviewLink.css');
const PREVIEW_CSS = read('../../Preview/ShaderPreview.css');
const DESIGNER = read('../../../nodeDesigner/designerApp.ts');

/** The body of the first rule whose selector text contains `selector`. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('TypedEdge — the live flag', () => {
  it('rides the existing count selector (no second per-edge subscription)', () => {
    expect(EDGE).toContain('getLiveUpstreamSet(s.nodes, s.edges).has(e.source) ? LIVE_BIT : 0');
    expect(EDGE).toContain('const count = packed % LIVE_BIT;');
    expect(EDGE).toContain('const live = packed >= LIVE_BIT;');
    // LIVE_BIT must sit above every channel count, or a 4-channel wire reads live.
    const bit = Number(/const LIVE_BIT = (\d+);/.exec(EDGE)![1]);
    expect(bit).toBeGreaterThan(4);
    // Asked of the UNWRAPPED source, so a collapsed frame changes nothing.
    expect(EDGE).toContain('const e = { source: un?.source ?? source,');
  });

  it('tags every still path — ribbon lines and the chevron path alike', () => {
    expect(EDGE).toContain("className={live ? undefined : 'fs-edge-still'}");
    expect(EDGE).toContain('className="fs-edge-still fs-edge-arrows"');
    expect(EDGE).toContain('style={live ? LIVE_PATH_STYLE : STILL_PATH_STYLE}');
    expect(EDGE).toMatch(/className="fs-edge-still fs-edge-arrows"[\s\S]{0,300}style=\{STILL_PATH_STYLE\}/);
    // The chevrons are ONE path per edge, computed only for a still wire.
    expect(EDGE).toMatch(/const arrows = live\s*\?\s*''/);
    expect(EDGE.match(/<path/g)).toHaveLength(3); // hit area, ribbon map, chevrons
  });

  it('carries no dash of its own (the old ribbon dash never rendered)', () => {
    expect(EDGE).not.toContain('RIBBON_DASH');
    // The one `strokeDasharray` left is STILL_PATH_STYLE's `'none'` opt-out.
    expect(EDGE.match(/strokeDasharray/g)).toHaveLength(1);
    expect(EDGE).toContain("strokeDasharray: 'none'");
  });

  it('finds the disconnect socket through the ESCAPED one-copy selectors', () => {
    expect(EDGE).toContain("handleEl(nodeEl(source), 'source', sourceHandleId ?? 'out')");
    expect(EDGE).not.toContain('document.querySelector');
  });
});

describe('a still path neither dashes nor marches — on EVERY surface that draws TypedEdge', () => {
  it('opts out INLINE, which beats React Flow\'s `.animated path` rule without a stylesheet', () => {
    // React Flow's rule is not !important, so an inline declaration wins
    // wherever the edge renders.
    const style = /const STILL_PATH_STYLE: CSSProperties = \{([^}]*)\};/.exec(EDGE);
    expect(style, 'STILL_PATH_STYLE').not.toBeNull();
    expect(style![1]).toMatch(/strokeDasharray:\s*'none'/);
    expect(style![1]).toMatch(/animation:\s*'none'/);
    expect(style![1]).toMatch(/pointerEvents:\s*'none'/);
  });

  it('does not lean on a canvas-scoped rule: GraphModal draws TypedEdge with no `.node-editor` and no NodeEditor.css', () => {
    // A `.node-editor …fs-edge-still` rule was the first cut; in node-editor.html's
    // GraphModal (measured in Chrome) every still ribbon and chevron kept
    // React Flow's 5px dash and `dashdraw`.
    const modal = read('../../Graphs/GraphModal.tsx');
    expect(modal).toContain("import { nodeTypes, edgeTypes } from '@/components/NodeEditor/flowTypes';");
    expect(modal).not.toContain('NodeEditor.css');
    expect(modal).not.toContain('node-editor"');
    expect(NODE_EDITOR_CSS).not.toMatch(/fs-edge-still\s*\{/);
  });

  it('rounds every visible edge path\'s caps — the inline-dash exclusion is retired with the dash', () => {
    expect(NODE_EDITOR_CSS).toContain('.node-editor .react-flow__edge.animated path:not(.react-flow__edge-interaction) {');
    expect(NODE_EDITOR_CSS).not.toContain(':not([stroke-dasharray])');
  });
});

describe('the Output→preview wire', () => {
  it('marches only under data-live, set from the same live set', () => {
    expect(LINK).toContain('getLiveUpstreamSet(s.nodes, s.edges)');
    expect(LINK).toContain("data-live={liveKey[i] === '1' ? '' : undefined}");
    const base = ruleBody(LINK_CSS, '.preview-link__path {');
    expect(base).not.toMatch(/animation:/);
    expect(base).not.toMatch(/stroke-dasharray/);
    const live = ruleBody(LINK_CSS, '.preview-link__wire[data-live] .preview-link__path {');
    expect(live).toMatch(/animation:\s*preview-link-flow/);
    expect(live).toMatch(/stroke-dasharray:\s*6 3/);
  });

  it('carries direction chevrons like a canvas wire — and no arrowhead at the rail end', () => {
    // Owner, 2026-10-12: the arrow "should not be at the end … and should
    // follow the same rules as other edges". The chevrons come from the canvas
    // wires' own arrowMarks + chevronPath (previewLinkGeometry.test.ts holds
    // where they land); a live wire hides them, as TypedEdge draws none.
    expect(LINK).not.toContain('<marker');
    expect(LINK_CSS).not.toMatch(/marker-end/);
    expect(LINK).toContain('<path className="preview-link__arrows" fill="none" d="" />');
    expect(LINK).toContain('linkArrows(ends.start, ends.end)');
    expect(ruleBody(LINK_CSS, '.preview-link__wire[data-live] .preview-link__arrows {')).toMatch(/display:\s*none/);
    // The tick and the hover index wires by CLASS, so the chevron paths can
    // never shift which wire a `path` index names.
    expect(LINK).not.toMatch(/querySelectorAll<[^>]+>\('path'\)/);
  });

  it('still freezes under reduced motion — at the LIVE rule\'s own specificity', () => {
    // A bare `.preview-link__path { animation: none }` loses to the
    // `[data-live]` rule (measured in Chrome: the animation stayed named).
    const rm = LINK_CSS.slice(LINK_CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(rm).toMatch(/\.preview-link__wire\[data-live\] \.preview-link__path\s*\{\s*animation:\s*none/);
  });
});

describe('reset.css — reduced motion', () => {
  const block = RESET_CSS.slice(RESET_CSS.indexOf('@media (prefers-reduced-motion: reduce)'));

  it('gives transitions 0s, never a tiny nonzero duration', () => {
    // With the initial `transition-property: all`, any nonzero duration on `*`
    // made every SVG write a real transition: ~11k per drag, 1.5x slower.
    const durations = [...block.matchAll(/transition-duration:\s*([^;!]+)/g)].map((m) => m[1].trim());
    expect(durations).toEqual(['0s']);
    // Animations still collapse to a frame, so `animationend` listeners fire.
    expect(block).toMatch(/animation-duration:\s*0\.01ms !important/);
  });

  it('carries no rule for selectors no wire wears', () => {
    expect(block).not.toContain('.react-flow__edge-path');
    expect(block).not.toContain('.react-flow__connection-path');
  });
});

describe('opaque panels — no backdrop blur anywhere it was', () => {
  it.each([
    ['NodeEditor.css', NODE_EDITOR_CSS],
    ['ShaderPreview.css', PREVIEW_CSS],
  ])('%s has no backdrop-filter', (_, css) => {
    expect(css).not.toMatch(/backdrop-filter/);
  });

  it('fills each former glass surface from a theme token', () => {
    expect(ruleBody(NODE_EDITOR_CSS, '.node-editor__cost-overlay .cost-bar {')).toMatch(/background:\s*var\(--bg-raised\)/);
    for (const sel of ['.shader-preview__display-controls {\n  display', '.shader-preview__timeline-thumb {', '.shader-preview__uniforms {\n  position']) {
      expect(ruleBody(PREVIEW_CSS, sel), sel).toMatch(/background:\s*var\(--bg-panel\)/);
    }
    // The dark overrides existed only to darken a hard-coded translucent white.
    expect(NODE_EDITOR_CSS).not.toContain('[data-theme="dark"] .node-editor__cost-overlay');
    expect(PREVIEW_CSS).not.toContain('[data-theme="dark"] .shader-preview__uniforms {');
    expect(PREVIEW_CSS).not.toContain('[data-theme="dark"] .shader-preview__timeline-thumb');
  });
});

describe('Node Designer edge stubs mirror the STILL wire', () => {
  it('draws solid lines and its chevron from the shared geometry', () => {
    const stubs = DESIGNER.slice(DESIGNER.indexOf('function renderEdges()'), DESIGNER.indexOf('/* ---------------- stage gestures'));
    expect(stubs).not.toContain('stroke-dasharray');
    expect(stubs).toContain('chevronPath(arrowMarks([seg]), ribbonHalfWidth(ch) + ARROW_FLARE)');
  });

  it('downloads through the one-copy helper', () => {
    expect(DESIGNER).toContain("downloadBlob(new Blob([stamp + fileContent(savedGlyphs)], { type: 'text/plain' }), 'customGlyphs.ts')");
    expect(DESIGNER).not.toContain('function downloadFile');
  });
});
