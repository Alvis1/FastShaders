/**
 * The preview RAIL — the sockets either side of the column seam.
 *
 * The vitest env is `node`, so the component itself cannot be rendered; what is
 * executable is the shared DERIVATION the three surfaces agree through, and the
 * rest is pinned at source. That split is the point: the wire, the canvas
 * socket it ends on and the preview socket mirroring it are ONE connection seen
 * three times, and the only thing keeping them from disagreeing is that they
 * ask the same function.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import { resolveWireTargets, wireTargetsKey } from './previewWires';
import { RAIL_EMPTY_KEY } from './PreviewRail';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

const out = (id: string, rank: number, extra: Record<string, unknown> = {}) => {
  const n = makeNode(id, 'output');
  Object.assign(n.data as Record<string, unknown>, { emitOrder: rank, ...extra });
  return n;
};
const state = (nodes: AppNode[], edges: ReturnType<typeof makeEdge>[] = []) => ({
  nodes, edges, previewMesh: null, previewMeshInventory: null, previewShowsModel: false,
});

describe('one derivation, three surfaces', () => {
  it('gives a wire per contributing Output, in emit order', () => {
    const s = state([out('def', 0), out('a', 1, { meshTargets: ['Body'] })]);
    expect(resolveWireTargets(s).map((w) => w.id)).toEqual(['def', 'a']);
  });

  it('a DRIVING Raymarch Output collapses the set to itself', () => {
    // It silences every plain Output, so a wire from one would claim the viewer
    // renders what it does not — and the rail would offer a socket for it.
    const march = makeNode('rm', 'raymarchOutput');
    const nodes = [out('def', 0), march, makeNode('c1', 'color')];
    const s = state(nodes, [makeEdge('c1', 'out', 'rm', 'field')]);
    expect(resolveWireTargets(s).map((w) => w.id)).toEqual(['rm']);
  });

  it('the key moves when a LABEL moves, not just when an id does', () => {
    // The rail shows the label on hover, so a re-targeted material with the
    // same id has to re-render it.
    const a = state([out('def', 0), out('x', 1, { meshTargets: ['Body'] })]);
    const b = state([out('def', 0), out('x', 1, { meshTargets: ['Glass'] })]);
    expect(wireTargetsKey(b)).not.toBe(wireTargetsKey(a));
  });

  it('is memoized — the same store slices answer without re-walking', () => {
    const s = state([out('def', 0), out('a', 1, { meshTargets: ['Body'] })]);
    expect(resolveWireTargets(s)).toBe(resolveWireTargets(s));
  });

  it('an empty graph has no wires — the rail draws its hollow socket instead', () => {
    expect(resolveWireTargets(state([]))).toEqual([]);
    expect(resolveWireTargets(state([makeNode('c1', 'color')]))).toEqual([]);
  });
});

describe('the rail itself (source pins)', () => {
  const RAIL = read('./PreviewRail.tsx');
  const CSS = read('./PreviewRail.css');
  const EVENTS = read('./previewRailEvents.ts');
  const NODE_EDITOR = read('../NodeEditor/NodeEditor.tsx');
  const PREVIEW = read('../Preview/ShaderPreview.tsx');

  it('sits on the CANVAS edge, where the wire ends — and only there', () => {
    expect(NODE_EDITOR).toContain('<PreviewRail />');
    // A mirroring rail on the 3D preview's left edge was built and REMOVED: the
    // two panes are different boxes (the canvas runs the column's full height,
    // the preview body starts under its own control bar and is only the top
    // pane of the right split), so the same FRACTION of each landed at visibly
    // different heights. Aligning them needs cross-pane measurement held in
    // step through split drags, collapse and fullscreen — a third tracking loop
    // for a decorative mirror.
    expect(PREVIEW).not.toContain('PreviewRail');
  });

  it('hovers with the wire’s own wording', () => {
    // `linkLabelText` is what the wire's hover chip uses, so the socket and the
    // wire cannot name one material two ways.
    expect(RAIL).toContain('linkLabelText(w.label, language)');
    expect(RAIL).toContain('title={w.label}');
  });

  it('clicks through the event, from BOTH sides', () => {
    // The preview pane is a sibling React tree with no `fitView`; the canvas
    // rail goes the same way so there is one path rather than two.
    expect(RAIL).toContain('requestFocusNode(w.id)');
    expect(NODE_EDITOR).toContain('window.addEventListener(RAIL_FOCUS_EVENT, onFocus)');
    expect(NODE_EDITOR).toContain('focusNode(fitView, useAppStore.getState().nodes, id)');
    expect(EVENTS).toContain("export const RAIL_FOCUS_EVENT = 'fs:rail-focus-node';");
  });

  it('the empty socket adds the FIRST Output, and never a second', () => {
    expect(RAIL).toContain('requestAddFirstOutput()');
    expect(RAIL).toContain('preview-rail__socket--empty');
    expect(NODE_EDITOR).toContain('window.addEventListener(RAIL_ADD_OUTPUT_EVENT, onAdd)');
    // The guard: a race (two clicks, or a node added between the event and the
    // handler) must not mint an Output the rail was not offering.
    expect(NODE_EDITOR).toContain("if (nodesNow.some((n) => n.data.registryType === 'output')) return;");
    // Through the store's own add — one history entry, and the reviewed
    // node-add telemetry chokepoint that lives there rather than a second one
    // here (the rail must not become a new place study events come from).
    expect(NODE_EDITOR).toMatch(/addNode\(\{\s*id,\s*type: 'output',/);
  });

  it('the container passes the pointer through; only the discs take it', () => {
    // The preview body is the orbit-drag surface — a full-height box down its
    // left edge would eat the start of any drag beginning under one.
    const container = CSS.slice(CSS.indexOf('.preview-rail {'), CSS.indexOf('.preview-rail--canvas'));
    expect(container).toContain('pointer-events: none;');
    const socket = CSS.slice(CSS.indexOf('.preview-rail__socket {'), CSS.indexOf('.preview-rail__socket:hover'));
    expect(socket).toContain('pointer-events: auto;');
  });

  it('a canvas gesture or a seam drag takes the sockets out of hit-testing', () => {
    expect(CSS).toContain(':root.fs-dragging .preview-rail__socket');
    expect(CSS).toContain(':root.fs-canvas-busy .preview-rail__socket');
  });

  it('the empty socket has words of its own', () => {
    expect(RAIL_EMPTY_KEY).toBeTruthy();
    expect(RAIL).toContain('t(RAIL_EMPTY_KEY, language)');
  });
});

describe('the wires end on the rail, not the preview centre', () => {
  const LINK = read('./PreviewLink.tsx');

  it('each wire ends on its OWN rail socket, at the shared fraction', () => {
    expect(LINK).toContain('railY(svgRect.top, svgRect.height, i, count)');
    expect(LINK).toContain('const endX = svgRect.right - RAIL_INSET;');
  });

  it('the preview element it used to aim at is gone', () => {
    // It never reached it: the SVG lives inside `.react-flow` and
    // `.node-editor__canvas` clips it, so the curve was cut at the seam.
    expect(LINK).not.toContain('shader-preview__body');
    expect(LINK).not.toContain('previewEl');
  });
});

describe('the rail socket is the SAME OBJECT as the node socket it connects to', () => {
  const RAIL_CSS = read('./PreviewRail.css');
  const NODE_CSS = read('../NodeEditor/nodes/OutputNode.css');

  /** The size-and-ring declarations of a rule, in source order. */
  const shapeOf = (css: string, selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} not found`).toBeGreaterThan(-1);
    const body = css.slice(at, css.indexOf('}', at));
    return body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^(width|height|padding|border|border-radius|box-shadow):/.test(l))
      .sort();
  };

  it('matches it in size, rim and ring', () => {
    // One wire, two ends: the disc it leaves and the disc it arrives at must
    // read as one kind of thing. They are separate rules because the node's is
    // restyled by the canvas (`--node-cost-text`, the active/parked fill) and
    // the rail's is not — so nothing but a test keeps their SHAPE together.
    //
    // The ring is the part that actually drifted: it adds ~1px of apparent
    // radius all round, so the rail disc read a size smaller without it while
    // every width/height already agreed.
    expect(shapeOf(RAIL_CSS, '.preview-rail__socket'))
      .toEqual(shapeOf(NODE_CSS, '.output-node__preview-socket'));
  });

  it('both read the same tokens, so the coarse-pointer bump reaches both', () => {
    // `--handle-size` is 10px / 12px on a coarse pointer. A literal on either
    // side would leave one of them the wrong size on touch.
    for (const css of [RAIL_CSS, NODE_CSS]) {
      expect(css).toContain('width: calc(var(--handle-size) * 2);');
      expect(css).toContain('border: var(--handle-border) solid white;');
    }
  });
});
