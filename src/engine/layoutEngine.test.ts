import { describe, it, expect } from 'vitest';
import { autoLayout, estimateNodeSize } from './layoutEngine';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge } from '@/types';

/** Top edge of a node in the laid-out graph. */
function topOf(nodes: AppNode[], id: string): number {
  const n = nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n.position.y;
}

/** Group laid-out nodes into ranks by their x (left edge), left→right. */
function ranks(nodes: AppNode[]): AppNode[][] {
  const byX = new Map<number, AppNode[]>();
  for (const n of nodes) {
    const key = Math.round(n.position.x);
    (byX.get(key) ?? byX.set(key, []).get(key)!).push(n);
  }
  return [...byX.keys()].sort((a, b) => a - b).map((k) => byX.get(k)!);
}

describe('autoLayout — top-edge alignment', () => {
  it('lays a straight chain on one flat top baseline', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => makeNode(id, 'mul'));
    const edges = [
      makeEdge('a', 'out', 'b', 'a'),
      makeEdge('b', 'out', 'c', 'a'),
      makeEdge('c', 'out', 'd', 'a'),
    ];
    const laid = autoLayout(nodes, edges, 'LR');
    const tops = ['a', 'b', 'c', 'd'].map((id) => topOf(laid, id));
    // Every node on the single path shares one top baseline.
    for (const t of tops) expect(t).toBeCloseTo(tops[0], 5);
  });

  it('keeps the spine top flat even when node heights differ along it', () => {
    // uv is a tall designer-sized node (~105px body); mul is a compact operator.
    const nodes: AppNode[] = [
      makeNode('a', 'mul'),
      makeNode('b', 'uv'),
      makeNode('c', 'mul'),
      makeNode('d', 'mul'),
      makeNode('branch', 'mul'),
    ];
    const edges: AppEdge[] = [
      makeEdge('a', 'out', 'b', 'a'),
      makeEdge('b', 'out', 'c', 'a'),
      makeEdge('c', 'out', 'd', 'a'),
      makeEdge('branch', 'out', 'c', 'b'), // side branch feeding the spine
    ];
    const laid = autoLayout(nodes, edges, 'LR');
    const spineTops = ['a', 'b', 'c', 'd'].map((id) => topOf(laid, id));
    for (const t of spineTops) expect(t).toBeCloseTo(spineTops[0], 5);
    // The branch is not on the spine, so it stacks below the top baseline.
    expect(topOf(laid, 'branch')).toBeGreaterThan(spineTops[0]);
  });

  it('never vertically overlaps nodes that share a rank', () => {
    // A hub fanning into several consumers stacks them without overlap.
    const nodes: AppNode[] = [
      makeNode('src', 'mul'),
      makeNode('x', 'uv'),
      makeNode('y', 'mul'),
      makeNode('z', 'mul'),
    ];
    const edges: AppEdge[] = [
      makeEdge('src', 'out', 'x', 'a'),
      makeEdge('src', 'out', 'y', 'a'),
      makeEdge('src', 'out', 'z', 'a'),
    ];
    const laid = autoLayout(nodes, edges, 'LR');
    for (const rank of ranks(laid)) {
      const sorted = [...rank].sort((p, q) => p.position.y - q.position.y);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const prevBottom = prev.position.y + estimateNodeSize(prev).height;
        expect(sorted[i].position.y).toBeGreaterThanOrEqual(prevBottom - 1e-6);
      }
    }
  });

  it('is deterministic across runs', () => {
    const build = () => {
      const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => makeNode(id, 'mul'));
      const edges = [
        makeEdge('a', 'out', 'c', 'a'),
        makeEdge('b', 'out', 'c', 'b'),
        makeEdge('c', 'out', 'd', 'a'),
        makeEdge('c', 'out', 'e', 'a'),
      ];
      return autoLayout(nodes, edges, 'LR');
    };
    const first = build();
    const second = build();
    expect(second.map((n) => n.position)).toEqual(first.map((n) => n.position));
  });

  it('flows left-to-right: a feeds b so a sits left of b', () => {
    const nodes = [makeNode('a', 'mul'), makeNode('b', 'mul')];
    const edges = [makeEdge('a', 'out', 'b', 'a')];
    const laid = autoLayout(nodes, edges, 'LR');
    expect(topOf(laid, 'a')).toBeCloseTo(topOf(laid, 'b'), 5); // one baseline
    expect(laid.find((n) => n.id === 'a')!.position.x).toBeLessThan(
      laid.find((n) => n.id === 'b')!.position.x,
    );
  });

  it('returns the input unchanged for an empty graph', () => {
    expect(autoLayout([], [], 'LR')).toEqual([]);
  });
});

describe('estimateNodeSize', () => {
  it('gives a tall designer-sized node a larger footprint than a compact op', () => {
    const uv = estimateNodeSize(makeNode('uv', 'uv'));
    const mul = estimateNodeSize(makeNode('m', 'mul'));
    expect(uv.height).toBeGreaterThan(mul.height);
  });

  it('grows a chainable node once it has three or more operands', () => {
    const base = estimateNodeSize(makeNode('a', 'add'), 2);
    const grown = estimateNodeSize(makeNode('a', 'add'), 5);
    expect(grown.height).toBeGreaterThan(base.height);
  });

  it('sizes noise nodes as PreviewNodes (96px canvas), not compact shader cards', () => {
    // The registry def drives the flow type, so even a stub with type 'shader'
    // resolves perlin → the PreviewNode footprint.
    const perlin = estimateNodeSize(makeNode('p', 'perlin'));
    expect(perlin.height).toBeGreaterThanOrEqual(120);
    expect(perlin.width).toBeGreaterThanOrEqual(100);
    const voronoi = estimateNodeSize(makeNode('v', 'voronoi'));
    expect(voronoi.height).toBeGreaterThanOrEqual(120);
  });

  it('sizes the fixed-footprint component types', () => {
    const color = estimateNodeSize(makeNode('c', 'color'));
    expect(color).toEqual({ width: 28, height: 28 });
    const clock = estimateNodeSize(makeNode('t', 'time'));
    expect(clock.height).toBeGreaterThan(70);
    const sin = estimateNodeSize(makeNode('s', 'sin'));
    expect(sin.height).toBeGreaterThan(100); // 72px canvas + header + port row
    const out = estimateNodeSize(makeNode('o', 'output'));
    expect(out.width).toBeGreaterThanOrEqual(140);
  });
});
