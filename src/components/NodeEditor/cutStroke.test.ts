/**
 * The cut stroke's pure parts: the polyline-versus-curve crossing test
 * (cutStroke.ts) and the choice of wires it cuts (edgeHit.ts
 * `edgesCrossedByStroke`), measured against the curve each wire is DRAWN as —
 * its one cubic (routing points were removed, 2026-11-24), the Color node's
 * radial exit, hidden and collapsed wires, and inputs a file can make huge or
 * degenerate.
 * docs/dev/canvas-interaction.md, "Cut stroke".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Position, type InternalNode } from '@xyflow/react';
import type { AppEdge } from '@/types';
import { makeTypedEdge } from '@/utils/edgeUtils';
import { edgeBezier, catmullRomToBeziers, type BezierSegment } from './edges/bezierGeometry';
import { MAX_CUT_POINTS, prepareStroke, segmentsIntersect, strokeCrossesSegments } from './cutStroke';
import { edgesCrossedByStroke, type GetInternalNode } from './edgeHit';

const P = (x: number, y: number) => ({ x, y });
const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

/** A 100×30 box at (x, y), `in` on its left edge and `out` on its right. */
function fakeNode(id: string, x: number, y: number, type = 'shader'): InternalNode {
  return {
    id,
    type,
    position: P(x, y),
    data: {},
    measured: { width: 100, height: 30 },
    internals: {
      positionAbsolute: P(x, y),
      z: 0,
      userNode: {} as never,
      handleBounds: {
        source: [{ id: 'out', type: 'source', nodeId: id, x: 100, y: 10, width: 0, height: 10, position: Position.Right }],
        target: [{ id: 'in', type: 'target', nodeId: id, x: 0, y: 10, width: 0, height: 10, position: Position.Left }],
      },
    },
  } as unknown as InternalNode;
}

const stroke = (...pts: [number, number][]) => pts.map(([x, y]) => P(x, y));

describe('segmentsIntersect', () => {
  it('crossing, touching and collinear-overlapping segments meet', () => {
    expect(segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0)).toBe(true);
    expect(segmentsIntersect(0, 0, 10, 0, 5, 0, 5, 5)).toBe(true); // T at an end
    expect(segmentsIntersect(0, 0, 10, 0, 5, 0, 15, 0)).toBe(true); // collinear overlap
  });
  it('parallel, disjoint and collinear-apart segments do not', () => {
    expect(segmentsIntersect(0, 0, 10, 0, 0, 1, 10, 1)).toBe(false);
    expect(segmentsIntersect(0, 0, 10, 0, 11, -5, 11, 5)).toBe(false);
    expect(segmentsIntersect(0, 0, 10, 0, 11, 0, 20, 0)).toBe(false);
  });
  it('a zero-length segment meets only what it lies on', () => {
    expect(segmentsIntersect(5, 0, 5, 0, 0, 0, 10, 0)).toBe(true);
    expect(segmentsIntersect(5, 1, 5, 1, 0, 0, 10, 0)).toBe(false);
  });
});

describe('prepareStroke', () => {
  it('needs two distinct finite points', () => {
    expect(prepareStroke([])).toBeNull();
    expect(prepareStroke([P(1, 1)])).toBeNull();
    expect(prepareStroke([P(1, 1), P(1, 1), P(1, 1)])).toBeNull();
    expect(prepareStroke([P(1, 1), P(NaN, 2), P(Infinity, 3)])).toBeNull();
    expect(prepareStroke([P(1, 1), P(NaN, 2), P(4, 4)])?.pts).toEqual([P(1, 1), P(4, 4)]);
  });
  it('is capped at MAX_CUT_POINTS, keeping the first', () => {
    const many = Array.from({ length: MAX_CUT_POINTS * 3 }, (_, i) => P(i, i % 2));
    const s = prepareStroke(many)!;
    expect(s.pts).toHaveLength(MAX_CUT_POINTS);
    expect(s.pts[0]).toEqual(P(0, 0));
  });
});

describe('strokeCrossesSegments — one wire\'s drawn curve', () => {
  // A level wire from (100, 15) to (500, 15), drawn as React Flow draws it.
  const level: BezierSegment[] = [edgeBezier(100, 15, Position.Right, 500, 15, Position.Left)];

  it('a stroke across the wire cuts it; one beside it or short of it does not', () => {
    expect(strokeCrossesSegments(prepareStroke(stroke([300, 0], [300, 30]))!, level, 0.5)).toBe(true);
    expect(strokeCrossesSegments(prepareStroke(stroke([200, 20], [400, 20]))!, level, 0.5)).toBe(false);
    expect(strokeCrossesSegments(prepareStroke(stroke([300, 0], [300, 14]))!, level, 0.5)).toBe(false);
  });

  it('a curved stroke crosses where any of its pieces does', () => {
    const hook = stroke([250, -40], [260, -20], [280, -5], [310, 30], [330, 60]);
    expect(strokeCrossesSegments(prepareStroke(hook)!, level, 0.5)).toBe(true);
  });

  it('follows a curve, not its chord: a stroke under the chord but off the curve misses', () => {
    // An S from (0, 0) to (400, 200): its chord passes (200, 100), and so does
    // the S (it is point-symmetric there) — but at x = 100 the curve sits near
    // y ≈ 23 while the chord is at 50.
    const s: BezierSegment[] = [edgeBezier(0, 0, Position.Right, 400, 200, Position.Left)];
    expect(strokeCrossesSegments(prepareStroke(stroke([95, 45], [105, 55]))!, s, 0.5)).toBe(false);
    expect(strokeCrossesSegments(prepareStroke(stroke([100, 0], [100, 60]))!, s, 0.5)).toBe(true);
  });

  it('non-finite segments and tolerances are survived, never thrown on', () => {
    const s = prepareStroke(stroke([300, 0], [300, 30]))!;
    const bad = [[NaN, 0, 1, 1, 2, 2, 3, 3] as BezierSegment, ...level];
    expect(strokeCrossesSegments(s, bad, 0.5)).toBe(true);
    expect(strokeCrossesSegments(s, level, 0)).toBe(true);
    expect(strokeCrossesSegments(s, level, NaN)).toBe(true);
    expect(strokeCrossesSegments(s, [], 0.5)).toBe(false);
  });

  it('a wire a million units long is cut where the stroke is, and quickly', () => {
    const huge: BezierSegment[] = [edgeBezier(-1e6, 15, Position.Right, 1e6, 15, Position.Left)];
    const t0 = performance.now();
    expect(strokeCrossesSegments(prepareStroke(stroke([300, 0], [300, 30]))!, huge, 0.01)).toBe(true);
    expect(strokeCrossesSegments(prepareStroke(stroke([300, 20], [301, 40]))!, huge, 0.01)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('a long zig-zag chain of segments, with a canvas-long stroke, stays bounded', () => {
    const zig: [number, number][] = [[0, 0]];
    for (let i = 1; i <= 64; i++) zig.push([i * 100, i % 2 ? 1000 : 0]);
    zig.push([6600, 0]);
    const segs = catmullRomToBeziers(zig);
    // A stroke of the full point cap running alongside, never touching (the
    // last spline segment overshoots below y = 0, so it runs well below).
    const along = Array.from({ length: MAX_CUT_POINTS }, (_, i) => P(i * 7, -500 - (i % 2)));
    const t0 = performance.now();
    expect(strokeCrossesSegments(prepareStroke(along)!, segs, 0.05)).toBe(false);
    expect(strokeCrossesSegments(prepareStroke(stroke([-10, 500], [7000, 500]))!, segs, 0.05)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('edgesCrossedByStroke — which wires a stroke cuts', () => {
  const nodes = new Map<string, InternalNode>([
    ['s', fakeNode('s', 0, 0)], ['t', fakeNode('t', 500, 0)], // y = 15
    ['u', fakeNode('u', 0, 200)], ['v', fakeNode('v', 500, 200)], // y = 215
    ['p', fakeNode('p', 0, 600)], ['q', fakeNode('q', 500, 600)], // y = 615
  ]);
  const get: GetInternalNode = (id) => nodes.get(id);
  const top = makeTypedEdge('s', 'out', 't', 'in');
  const mid = makeTypedEdge('u', 'out', 'v', 'in');
  const low = makeTypedEdge('p', 'out', 'q', 'in');
  const tol = 0.5;

  it('cuts exactly the wires the stroke crosses, in edge order', () => {
    const down = stroke([300, -10], [300, 250]);
    expect(edgesCrossedByStroke(down, [top, mid, low], get, tol)).toEqual([top.id, mid.id]);
    // Between the two level wires: nothing.
    expect(edgesCrossedByStroke(stroke([300, 50], [300, 120]), [top, mid, low], get, tol)).toEqual([]);
    expect(edgesCrossedByStroke(stroke([300, 600], [300, 630]), [low], get, tol)).toEqual([low.id]);
  });

  it('an older file\'s routing points draw nothing, so they are never cut along', () => {
    // An unsanitized wire still carrying points is measured as its plain curve.
    const old = { ...low, data: { dataType: 'any', waypoints: [P(300, 100)] } } as AppEdge;
    expect(edgesCrossedByStroke(stroke([300, 50], [300, 120]), [old], get, tol)).toEqual([]);
    expect(edgesCrossedByStroke(stroke([300, 600], [300, 630]), [old], get, tol)).toEqual([old.id]);
  });

  it('never cuts what is not drawn: hidden, a collapsed pill\'s insides, an unmounted socket', () => {
    const across = stroke([300, -10], [300, 40]);
    expect(edgesCrossedByStroke(across, [{ ...top, hidden: true }], get, tol)).toEqual([]);
    expect(edgesCrossedByStroke(across, [{ ...top, className: 'fs-collapsed-edge' } as AppEdge], get, tol)).toEqual([]);
    expect(edgesCrossedByStroke(across, [makeTypedEdge('s', 'out', 't', 'roughness')], get, tol)).toEqual([]);
    expect(edgesCrossedByStroke(across, [makeTypedEdge('s', 'out', 'gone', 'in')], get, tol)).toEqual([]);
  });

  it('a degenerate stroke cuts nothing, and a junk edge entry is skipped', () => {
    expect(edgesCrossedByStroke([], [top], get, tol)).toEqual([]);
    expect(edgesCrossedByStroke([P(300, 15)], [top], get, tol)).toEqual([]);
    expect(edgesCrossedByStroke(stroke([300, -10], [300, 40]), [null as unknown as AppEdge, top], get, tol)).toEqual([top.id]);
  });

  it('wires into and out of a Branch (a pass-through node) are cut like any wire', () => {
    const knot = fakeNode('k', 250, 300, 'knot');
    const both = new Map(nodes);
    both.set('k', knot);
    // The Branch's sockets sit at its centre (passThroughGeometry): fake that.
    (knot.internals.handleBounds as { source: unknown[]; target: unknown[] }).source = [
      { id: 'out', type: 'source', nodeId: 'k', x: 50, y: 15, width: 0, height: 0, position: Position.Right },
    ];
    (knot.internals.handleBounds as { source: unknown[]; target: unknown[] }).target = [
      { id: 'in', type: 'target', nodeId: 'k', x: 50, y: 15, width: 0, height: 0, position: Position.Left },
    ];
    const feed = makeTypedEdge('s', 'out', 'k', 'in');
    const outA = makeTypedEdge('k', 'out', 't', 'in');
    const outB = makeTypedEdge('k', 'out', 'v', 'in');
    // A stroke across both outputs right of the Branch, below the feed.
    const cut = edgesCrossedByStroke(stroke([420, -20], [420, 400]), [feed, outA, outB], (id) => both.get(id), tol);
    expect(cut).toEqual([outA.id, outB.id]);
  });

  it('a Color node\'s wire is cut along its RADIAL exit, not a cardinal one', () => {
    // A 28×28 Color circle whose output sits at the circle's BOTTOM: the wire
    // leaves straight down before turning right, so it dips below y = 28.
    const colorAt = (type: string) => {
      const n = fakeNode('c', 0, 0, type);
      (n as { measured: unknown }).measured = { width: 28, height: 28 };
      (n.internals.handleBounds as { source: unknown[] }).source = [
        { id: 'out', type: 'source', nodeId: 'c', x: 12, y: 26, width: 4, height: 4, position: Position.Right },
      ];
      return n;
    };
    const target = fakeNode('t', 300, 0);
    const wire = makeTypedEdge('c', 'out', 't', 'in');
    const below = stroke([10, 32], [40, 32]);
    const color = new Map([['c', colorAt('color')], ['t', target]]);
    const plain = new Map([['c', colorAt('shader')], ['t', target]]);
    expect(edgesCrossedByStroke(below, [wire], (id) => color.get(id), tol)).toEqual([wire.id]);
    expect(edgesCrossedByStroke(below, [wire], (id) => plain.get(id), tol)).toEqual([]);
  });
});

describe('the gesture (source pins)', () => {
  const hook = read('useCutStroke.ts');
  const editor = read('NodeEditor.tsx');

  it('cuts through the ONE plural store path, once per release', () => {
    expect(hook).toContain('if (ids.length) store.removeEdges(ids);');
    expect(hook).not.toMatch(/removeEdge\(/);
  });

  it('never binds Alt+Shift, and an Alt press must start on empty canvas or a wire', () => {
    expect(hook).toContain('if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;');
    expect(hook).toContain("const CUT_FROM = '.react-flow__pane, .react-flow__edge, .react-flow__background';");
    expect(hook).toMatch(/NOT_CUT = '\.react-flow__node, \.react-flow__handle/);
  });

  it('brackets the stroke with pointer capture, the busy refcount and the drag chrome', () => {
    const start = hook.slice(hook.indexOf('const startStroke'), hook.indexOf('const teardown'));
    expect(start).toContain('el.setPointerCapture(pointerId)');
    expect(start).toContain('setCanvasBusy(true)');
    expect(start).toContain('beginDragChrome(null)');
    const tear = hook.slice(hook.indexOf('const teardown'), hook.indexOf('const reset'));
    expect(tear).toContain('setCanvasBusy(false)');
    expect(tear).toContain('endChrome?.()');
  });

  it('Escape and a window blur drop the stroke', () => {
    expect(hook).toContain("e.key === 'Escape'");
    expect(hook).toContain("window.addEventListener('blur', onBlur)");
  });

  it('the draw handler and the double-press pan stand aside for it', () => {
    expect(editor).toContain('if (store.drawCut) return;');
    expect(editor).toContain('if (e.altKey) { lastDownAt = 0; return; }');
    expect(editor).toContain('useCutStroke({');
  });
});
