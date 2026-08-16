import { describe, it, expect } from 'vitest';
import { hasTimeUpstream, buildTimeUpstreamSet } from './graphTraversal';
import { makeNode } from '@/test-utils';

const node = makeNode;

/**
 * Every graph shape the per-node walk is pinned on below, so the set builder
 * can be asserted EQUIVALENT to it rather than merely plausible — that
 * equivalence is the whole licence for replacing the hot call sites.
 */
const SHAPES: Array<{
  name: string;
  nodes: ReturnType<typeof makeNode>[];
  edges: { source: string; target: string }[];
  ask: string[];
}> = [
  { name: 'isolated non-time node', nodes: [node('a', 'add')], edges: [], ask: ['a'] },
  { name: 'the node itself is time', nodes: [node('t', 'time')], edges: [], ask: ['t'] },
  {
    name: 'direct ancestor',
    nodes: [node('t', 'time'), node('a', 'add')],
    edges: [{ source: 't', target: 'a' }],
    ask: ['t', 'a'],
  },
  {
    name: 'multi-hop ancestor',
    nodes: [node('t', 'time'), node('m', 'mul'), node('o', 'output')],
    edges: [{ source: 't', target: 'm' }, { source: 'm', target: 'o' }],
    ask: ['t', 'm', 'o'],
  },
  {
    name: 'no time anywhere',
    nodes: [node('uv', 'uv'), node('m', 'mul'), node('o', 'output')],
    edges: [{ source: 'uv', target: 'm' }, { source: 'm', target: 'o' }],
    ask: ['uv', 'm', 'o'],
  },
  {
    name: 'time is DOWNSTREAM (direction matters)',
    nodes: [node('a', 'add'), node('t', 'time')],
    edges: [{ source: 'a', target: 't' }],
    ask: ['a', 't'],
  },
  {
    name: 'cycle with no time',
    nodes: [node('a', 'add'), node('b', 'mul')],
    edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
    ask: ['a', 'b'],
  },
  {
    name: 'cycle WITH time (both members are fed)',
    nodes: [node('t', 'time'), node('a', 'add'), node('b', 'mul')],
    edges: [
      { source: 't', target: 'a' },
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ],
    ask: ['t', 'a', 'b'],
  },
  {
    name: 'diamond — one arm time-fed, the join is fed',
    nodes: [node('t', 'time'), node('uv', 'uv'), node('m', 'mul'), node('o', 'output')],
    edges: [
      { source: 't', target: 'm' },
      { source: 'uv', target: 'o' },
      { source: 'm', target: 'o' },
    ],
    ask: ['t', 'uv', 'm', 'o'],
  },
  {
    name: 'two independent Time nodes',
    nodes: [node('t1', 'time'), node('t2', 'time'), node('a', 'add'), node('b', 'mul')],
    edges: [{ source: 't1', target: 'a' }, { source: 't2', target: 'b' }],
    ask: ['t1', 't2', 'a', 'b'],
  },
  {
    name: 'edge referencing a node that is not in the array',
    nodes: [node('a', 'add')],
    edges: [{ source: 'ghost', target: 'a' }],
    ask: ['a', 'ghost'],
  },
  { name: 'empty graph', nodes: [], edges: [], ask: ['missing'] },
];

describe('hasTimeUpstream', () => {
  it('returns false on an isolated non-time node', () => {
    const nodes = [node('a', 'add')];
    expect(hasTimeUpstream('a', nodes, [])).toBe(false);
  });

  it('returns true when the node itself is a time node', () => {
    const nodes = [node('t', 'time')];
    expect(hasTimeUpstream('t', nodes, [])).toBe(true);
  });

  it('finds a direct time ancestor through one edge', () => {
    const nodes = [node('t', 'time'), node('a', 'add')];
    const edges = [{ source: 't', target: 'a' }];
    expect(hasTimeUpstream('a', nodes, edges)).toBe(true);
  });

  it('finds a multi-hop time ancestor', () => {
    const nodes = [node('t', 'time'), node('m', 'mul'), node('o', 'output')];
    const edges = [
      { source: 't', target: 'm' },
      { source: 'm', target: 'o' },
    ];
    expect(hasTimeUpstream('o', nodes, edges)).toBe(true);
  });

  it('returns false when no time ancestor exists', () => {
    const nodes = [node('uv', 'uv'), node('m', 'mul'), node('o', 'output')];
    const edges = [
      { source: 'uv', target: 'm' },
      { source: 'm', target: 'o' },
    ];
    expect(hasTimeUpstream('o', nodes, edges)).toBe(false);
  });

  it('only walks upstream (a downstream time node does not count)', () => {
    const nodes = [node('a', 'add'), node('t', 'time')];
    const edges = [{ source: 'a', target: 't' }];
    expect(hasTimeUpstream('a', nodes, edges)).toBe(false);
  });

  it('terminates on a cycle without recursing forever', () => {
    const nodes = [node('a', 'add'), node('b', 'mul')];
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ];
    expect(hasTimeUpstream('a', nodes, edges)).toBe(false);
  });

  it('returns false for an unknown node id', () => {
    expect(hasTimeUpstream('missing', [], [])).toBe(false);
  });
});

describe('buildTimeUpstreamSet', () => {
  // The licence for swapping the render layer's per-node walk for one shared
  // set: same predicate, opposite direction. If these ever disagree, a card
  // silently stops ticking (or starts ticking on a static wire).
  it.each(SHAPES)('agrees with hasTimeUpstream on: $name', ({ nodes, edges, ask }) => {
    const set = buildTimeUpstreamSet(nodes, edges);
    for (const id of ask) {
      expect(set.has(id)).toBe(hasTimeUpstream(id, nodes, edges));
    }
  });

  it('terminates on a cycle whose members are all time-fed', () => {
    // `reached` doubles as the visited set; without that this walk would not
    // return at all, which is reachable from a hand-edited .fastshader
    // (topologicalSort only WARNS on cycles).
    const nodes = [node('t', 'time'), node('a', 'add'), node('b', 'mul')];
    const edges = [
      { source: 't', target: 'a' },
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ];
    expect([...buildTimeUpstreamSet(nodes, edges)].sort()).toEqual(['a', 'b', 't']);
  });

  it('is EMPTY, and skips the adjacency build, when the graph holds no Time node', () => {
    // The asymmetry that makes this worth doing: the backward walk only
    // short-circuits when it FINDS Time, so a Time-free graph was its WORST
    // case (full ancestor closure per node, measured at 82-96% of the
    // per-notify budget). Here it is the cheapest — O(N), no Map allocated.
    const nodes = [node('uv', 'uv'), node('m', 'mul'), node('o', 'output')];
    const edges = [{ source: 'uv', target: 'm' }, { source: 'm', target: 'o' }];
    expect(buildTimeUpstreamSet(nodes, edges).size).toBe(0);
  });

  it('reports a Time node as feeding itself (so a Time card ticks)', () => {
    expect(buildTimeUpstreamSet([node('t', 'time')], []).has('t')).toBe(true);
  });
});
