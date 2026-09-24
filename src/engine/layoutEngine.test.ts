import { describe, it, expect } from 'vitest';
import { autoLayout, estimateNodeSize } from './layoutEngine';
import { makeNode, makeEdge } from '@/test-utils';
import { COLOR_NODE_SIZE } from '@/components/NodeEditor/nodes/ColorNode';
import type { AppNode, AppEdge } from '@/types';
import { getCostScale } from '@/utils/colorUtils';
import { edgePortRailHeight } from '@/components/NodeEditor/nodes/edgePorts';

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
    // Square, and tied to the component's own constant — a hardcoded number
    // here is what let auto-layout drift from the rendered swatch before.
    const color = estimateNodeSize(makeNode('c', 'color'));
    expect(color).toEqual({ width: COLOR_NODE_SIZE, height: COLOR_NODE_SIZE });
    const clock = estimateNodeSize(makeNode('t', 'time'));
    expect(clock.height).toBeGreaterThan(70);
    const sin = estimateNodeSize(makeNode('s', 'sin'));
    expect(sin.height).toBeGreaterThan(100); // 72px canvas + header + port row
    const out = estimateNodeSize(makeNode('o', 'output'));
    expect(out.width).toBeGreaterThanOrEqual(140);
  });
});

describe('estimateNodeSize — the Output node', () => {
  const output = (data: Record<string, unknown> = {}) => {
    const n = makeNode('o', 'output');
    (n.data as Record<string, unknown>) = { ...n.data, ...data };
    return n;
  };
  const ROW = 18;

  it('counts one row per exposed channel plus ONE for the mesh picker', () => {
    const three = estimateNodeSize(output({ exposedPorts: ['color', 'emissive', 'normal'] })).height;
    const four = estimateNodeSize(output({ exposedPorts: ['color', 'emissive', 'normal', 'opacity'] })).height;
    expect(four - three).toBe(ROW);
    // The picker row is the +1: three channels measure FOUR rows of chrome.
    expect(three).toBe(34 + 4 * ROW);
  });

  it('reserves the mesh row even with no model and no target — dagre overlaps on the short side', () => {
    // A pure estimate cannot see the session's loaded model, and the picker
    // renders for every plain Output once one is. Over-measuring a model-less
    // document by 18px is the safe direction.
    const bare = estimateNodeSize(output({ exposedPorts: ['color'] })).height;
    expect(bare).toBe(34 + 2 * ROW);
  });

  it('is unaffected by a legacy stacked `materials` array — one node is one material', () => {
    const stacked = { exposedPorts: ['color'], materials: [{ meshTargets: ['A'] }, { meshTargets: ['B'] }] };
    expect(estimateNodeSize(output(stacked)).height).toBe(estimateNodeSize(output({ exposedPorts: ['color'] })).height);
  });

  it('floors the channel rows at the incoming-edge count, and the picker sits ON TOP of that floor', () => {
    const one = estimateNodeSize(output({ exposedPorts: ['color'] }), 1).height;
    const five = estimateNodeSize(output({ exposedPorts: ['color'] }), 5).height;
    expect(five - one).toBe(4 * ROW);
    expect(five).toBe(34 + 6 * ROW);
  });
});

describe('estimateNodeSize — the Image node', () => {
  // Restates layoutEngine's private constants on purpose: HEADER_H 20, the
  // thumbnail's 126 and the empty slot's 54 (ShaderNode.css caps), plus the
  // 8px padding. The ROW_H term is GONE: the node draws no port rows since
  // 2026-09-19 — its sockets ride the card's border — so the body is the
  // picture, floored by the rail those sockets need (`edgePortRailHeight`,
  // read from the renderer's own module, never restated here).
  const s = getCostScale(0);
  const RAIL = edgePortRailHeight(6, 5); // the Image node's 6 inputs / 5 outputs
  const withImage = (id = 'i') =>
    makeNode(id, 'imageNode', { imageB64: 'data:image/png;base64,AAAA', fileName: 'x.png' });
  const exposing = (n: AppNode, ports: string[]) => {
    (n.data as { exposedPorts?: string[] }).exposedPorts = ports;
    return n;
  };

  it('counts the thumbnail and its filename, with no row per output', () => {
    // 20 header + max(RAIL, 12 filename + 126 thumb + 8).
    expect(estimateNodeSize(withImage()).height).toBeCloseTo((20 + Math.max(RAIL, 12 + 126 + 8)) * s, 5);
  });

  it('an empty node is floored by the socket rail, and is smaller than one with an image', () => {
    // 54 + 8 is under the rail, so the FLOOR is what the empty node measures —
    // which is the whole point of the floor: five sockets must fit.
    const empty = estimateNodeSize(makeNode('e', 'imageNode')).height;
    expect(empty).toBeCloseTo((20 + RAIL) * s, 5);
    expect(empty).toBeLessThan(estimateNodeSize(withImage()).height);
  });

  it('exposing a param changes nothing — an exposed socket is a rail slot, not a row', () => {
    const base = estimateNodeSize(withImage()).height;
    expect(estimateNodeSize(exposing(withImage(), ['uv', 'tileX', 'tileY'])).height).toBe(base);
    const all = ['uv', 'tileX', 'tileY', 'offsetX', 'offsetY', 'dir'];
    expect(estimateNodeSize(exposing(withImage(), all)).height).toBe(base);
  });

  it('is at least as wide as the thumbnail it will draw', () => {
    expect(estimateNodeSize(withImage()).width).toBeGreaterThanOrEqual(192 * s);
  });
});

