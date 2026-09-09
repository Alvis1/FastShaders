/**
 * What a LIFTED canvas node does — hovered, selected, or with its menu open.
 *
 * It deepens its shadow and grows very slightly. It does NOT move, and the
 * distinction is the whole point of this file.
 *
 * The 3px translate this replaced had a defect it could not avoid: React Flow
 * computes wire endpoints from stored positions and knows nothing about a CSS
 * translate, so every wire on a lifted node was offset by the same 3px to stay
 * on its socket — a PREDICTION that holds only while React Flow measured the
 * sockets with the card at rest. Selecting a node also thickens its border,
 * which changes its SIZE, which fires React Flow's per-node ResizeObserver and
 * re-measures the handles while the card is displaced. The displacement was
 * then baked into the bounds AND added again by the edge. Hover was exempt for
 * the one reason that made it hard to place: hover does not thicken the border,
 * so it triggers no re-measure.
 *
 * The GROWTH is not a smaller version of the same bug, and the size is why.
 * A transform changes no layout, so it fires no observer of its own; it does
 * move the sockets (getBoundingClientRect includes transforms), but at 1.02 on
 * a 50px node the extreme socket moves 0.5px — against the 3px that was
 * reported as wires hanging off their ports — and nothing predicts it in JS any
 * more, so the worst case is a stale sub-pixel offset rather than a doubled
 * visible one. Raising the scale materially brings the defect back at a size
 * people can see.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const base = read('./nodes/NodeBase.css');
const tokens = read('../../styles/tokens.css');
const edge = read('./edges/TypedEdge.tsx');

describe('a lifted node', () => {
  it('does not move — nothing publishes or reads a shift any more', () => {
    for (const f of ['./nodes/NodeBase.css', './nodes/ColorNode.css', './nodes/GroupNode.css',
                     './nodes/NoteNode.css', './nodes/OutputNode.css']) {
      expect(read(f), `${f} still shifts a canvas node`).not.toContain('--fs-node-shift');
    }
  });

  it('grows instead, by a scale small enough to stay under the old defect', () => {
    expect(base).toContain('--fs-node-scale: var(--fs-node-grow);');
    expect(base).toContain('transform: scale(var(--fs-node-scale, 1));');
    const m = /--fs-node-grow:\s*([\d.]+);/.exec(tokens);
    expect(m, 'the growth token is gone').toBeTruthy();
    const grow = Number(m![1]);
    // The bound that keeps a socket's movement sub-pixel on a typical node.
    expect(grow).toBeGreaterThan(1);
    expect(grow).toBeLessThanOrEqual(1.03);
  });

  it('carries the multi-channel stack layers with it', () => {
    // They are absolute siblings of the card; left at the resting size, a
    // lifted stacked node visibly comes apart.
    const stack = base.slice(base.indexOf('.node-base__stack {'), base.indexOf('.node-base__stack {') + 700);
    expect(stack).toContain('transform: scale(var(--fs-node-scale, 1));');
  });

  it('exempts an expanded group frame, which must not move OR grow', () => {
    // Its members are separate nodes that stay put, so a frame that changed
    // size would visibly detach from the cluster it encloses.
    const rule = base.slice(base.indexOf('.react-flow__node-group:not(:has('));
    expect(rule.slice(0, 120)).toContain('--fs-node-scale: 1;');
  });

  it('gives the ASSET TILES the same lift, not the retired one', () => {
    // A tile that lifted differently from the node it depicts is the drift
    // assetCardGeometry.test.ts exists to stop. The scale also suits that
    // surface better: the strip is drawn through a computed zoom, so a
    // translate had to be sized to survive being multiplied by it, where a
    // scale is scale-invariant.
    const card = read('./NodePreviewCard.css');
    const browser = read('./ContentBrowser.css');
    expect(card).toContain('transform: scale(var(--fs-node-grow));');
    expect(browser).toContain('transform: scale(var(--fs-node-grow));');
    for (const f of [card, browser]) expect(f).not.toContain('--fs-node-rise');
  });

  it('has retired the rise token everywhere, not just stopped reading it', () => {
    // A declared-but-unused token invites the next reader to wire it back up.
    expect(tokens).not.toMatch(/^\s*--fs-node-rise:/m);
  });

  it('leaves the edges with nothing to compensate for', () => {
    // The prediction, its two per-edge store subscriptions and nodeRisePx are
    // all gone; React Flow's reported endpoints are simply used.
    expect(edge).not.toContain('nodeRisePx');
    expect(edge).not.toContain('liftedBySelection');
    expect(edge).toContain('const sourceX = rawSourceX;');
  });
});

describe('a wire under the pointer', () => {
  const edgeSrc = read('./edges/TypedEdge.tsx');

  it('thickens on hover, by LESS than selection does', () => {
    // Hover says "this is the wire under your pointer"; selection says "this is
    // the one you are working on, and its data is open". Matching them would
    // make sweeping the canvas look like it was selecting everything it passed
    // — the same passing-vs-committed distinction the nodes draw.
    expect(edgeSrc).toContain('const HOVER_EDGE_BOOST = 1.35;');
    expect(edgeSrc).toContain('const boost = selected ? SELECTED_EDGE_BOOST : hovered ? HOVER_EDGE_BOOST : 1;');
    const sel = /const SELECTED_EDGE_BOOST = ([\d.]+);/.exec(edgeSrc);
    const hov = /const HOVER_EDGE_BOOST = ([\d.]+);/.exec(edgeSrc);
    expect(Number(hov![1])).toBeGreaterThan(1);
    expect(Number(hov![1])).toBeLessThan(Number(sel![1]));
  });

  it('scales the whole ribbon, never the stroke alone', () => {
    // Multi-channel lines sit GAP apart and are already up to 1.2px wide, so
    // thickening strokes on their own closes those gaps and fuses a 4-channel
    // ribbon into one band — the highlight would destroy the channel count it
    // is highlighting. `boost` feeds both widths and offsets.
    expect(edgeSrc).toContain('const offsets = getOffsets(count).map((d) => d * boost);');
    // …and no CSS shortcut has grown beside it. The edge rules live in
    // NodeEditor.css (there is no TypedEdge.css), and a `:hover` stroke-width
    // there would be exactly the fuse-the-ribbon bug, invisible on the
    // single-channel wires most graphs are made of.
    expect(read('./NodeEditor.css')).not.toMatch(/edge[^{]*:hover[^{]*\{[^}]*stroke-width/);
  });

  it('keeps hover LOCAL to the edge, not a hovered-edge id in the store', () => {
    // A global one would re-render every edge on every hover to tell all but
    // one of them nothing.
    expect(edgeSrc).toContain('const [hovered, setHovered] = useState(false);');
    expect(edgeSrc).toContain('onPointerLeave={() => setHovered(false)}');
    // Cleared when the wire is pulled off its port: the hit path it was
    // hovering is replaced by the connection line mid-gesture.
    expect(edgeSrc).toMatch(/setHovered\(false\);\s*\n\s*\/\/ Start a new connection/);
  });
});

describe('dark mode reaches the node ART and the canvas ink', () => {
  it('re-maps each GREYSCALE glyph role, and leaves the accents alone', () => {
    // This was a `filter: invert(1) hue-rotate(180deg)` for a few hours, and it
    // was wrong in a way the test should keep stating: an invert maps L to 1-L,
    // which is right at the extremes and useless in the middle. The palette's
    // greys are a RAMP — Ink #2B2B2B, Construct #8A8F9C, Axis #B4B7C0 — so
    // Construct inverted to another mid-grey ("the greys inverted are the
    // same") and Axis, the lightest of the three, became the darkest thing in
    // the art. Re-mapping each role fixes the span as well as the order.
    expect(base, 'the blanket filter is back').not.toMatch(/\.node-glyph \{\s*filter:/);
    for (const grey of ['#2B2B2B', '#8A8F9C', '#B4B7C0', '#FFFFFF']) {
      expect(base, `${grey} has no dark mapping`).toContain(`.node-glyph [fill="${grey}" i]`);
      expect(base, `${grey} has no dark stroke mapping`).toContain(`.node-glyph [stroke="${grey}" i]`);
    }
    // The chromatic roles are the art's identity and read on either card.
    // Comments stripped first: the block above NAMES these hexes to say it
    // leaves them alone, and a raw search would fail for that reason — the
    // same false positive the node-graphics sweep hit against its own prose.
    const code = base.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const accent of ['#F57C00', '#FF9800', '#2D6CDF', '#2E9E5B', '#1796A0']) {
      expect(code, `${accent} is being re-mapped`).not.toContain(accent);
    }
  });

  it('keeps the grey ramp in order, strongest role first', () => {
    // Ink is the silhouette and must be the lightest on a dark card; Axis is a
    // faint plot rule and must stay faint, which means DARKER. Getting the
    // order wrong is exactly what the filter did.
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
      return 0.299 * r + 0.587 * g + 0.114 * b;
    };
    const dark = (src: string) =>
      /:\s*(#[0-9a-f]{6})/.exec(base.slice(base.indexOf(`[fill="${src}" i]`)))![1];
    expect(lum(dark('#2B2B2B'))).toBeGreaterThan(lum(dark('#8A8F9C')));
    expect(lum(dark('#8A8F9C'))).toBeGreaterThan(lum(dark('#B4B7C0')));
  });

  it("re-maps only the GLYPH — never a reading, never the user's own picture", () => {
    for (const cls of ['colormap-strip', 'image-thumb', 'preview-node__canvas', 'clock-node__canvas']) {
      expect(base, `${cls} is being re-coloured`).not.toMatch(
        new RegExp(`data-theme="dark"[^{]*\\.${cls}`),
      );
    }
  });

  it('eases the canvas ink at the WHITE end only', () => {
    // Pure white wires on a dark backdrop glare and read as brighter than the
    // nodes they connect. The black end is left alone: on a light canvas a
    // softened black just looks washed out.
    const utils = read('../../utils/colorUtils.ts');
    expect(utils).toContain('export function canvasInkColor(');
    expect(utils).toMatch(/=== '#000000' \? '#000000' : '#[0-9a-f]{6}'/);
    expect(utils).not.toMatch(/canvasInkColor[\s\S]{0,300}'#ffffff'/);
    // …and the canvas uses it, rather than the binary swatch-text version.
    const editor = read('./NodeEditor.tsx');
    expect(editor).toContain('const contrastColor = canvasInkColor(nodeEditorBgColor);');
  });

  it('keeps getContrastColor binary for text ON a swatch', () => {
    // Header text sits on a saturated cost colour and note colour, where every
    // bit of contrast counts — that caller must not inherit the easing.
    const shader = read('./nodes/ShaderNode.tsx');
    expect(shader).toContain('getContrastColor(costColor)');
  });
});
