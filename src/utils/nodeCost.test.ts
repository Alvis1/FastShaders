/**
 * Pricing guards for node costs no other suite covers.
 *
 * `unknown` is the load-bearing one. An unrecognised TSL function still RUNS:
 * the shaderloader's `autoInjectTSLImports`
 * (a-frame-shaderloader/js/a-frame-shaderloader-0.8.js) injects any called
 * name that exists in `THREE.TSL`, so a shader pasted from the three.js TSL
 * editor using a function outside the 74-node registry compiles and renders.
 * On top of that, codeToGraph's unknown branch wires no argument edges, so the
 * node's whole upstream subtree also drops out of `computeReachableCost`'s
 * reverse BFS. Pricing the node itself at 0 therefore made the most expensive
 * thing in such a graph read as free, in a tool whose only job is budgeting.
 * Any non-zero number is a guess; zero is a wrong one.
 *
 * The DATA pins read `getBaseCosts()` (the authored complexity.json), never
 * `getCost()` (the override-aware ACTIVE table): vite.config.ts sets
 * `isolate: false`, so nodeCost's ACTIVE singleton is shared with every other
 * suite in the worker and two of them call `setCostOverrides`
 * (costOverride.test.ts, costProfiles.test.ts via the store). The afterEach
 * below mirrors costOverride.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getBaseCosts, getCost, computeReachableCost, costSeeds,
  sinkCosts, nodeCostPoints, setCostOverrides,
} from './nodeCost';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';

afterEach(() => setCostOverrides(null));

const BASE = getBaseCosts();

describe('unknown-node pricing', () => {
  it('never prices an unrecognised TSL function as free', () => {
    expect(BASE.unknown).toBeGreaterThan(0);
  });

  it('counts an unknown node in the reachable total', () => {
    const out = makeNode('out', 'output');
    const u = makeNode('u', 'unknown', {
      functionName: 'triNoise3D',
      rawExpression: 'triNoise3D(positionWorld, 0.1, time)',
    });
    const edges = [makeEdge('u', 'out', 'out', 'color')];
    expect(nodeCostPoints(u, edges)).toBe(getCost('unknown'));
    // Compared against the AUTHORED table so this cannot pass vacuously at 0.
    expect(computeReachableCost([out, u], edges)).toBe(BASE.unknown);
  });
});

describe('the ACTIVE sink seeds the reachable-cost walk', () => {
  // Several output nodes may coexist with exactly ONE active
  // (utils/sdfPartition.ts `activeSink`): the total is the price of what the
  // shader RENDERS, so only the active node's chain is walked; every sink also
  // gets its own figure (`sinkCosts`) for the badges.
  const targeted = (id: string, name?: string) => {
    const n = makeNode(id, 'output');
    if (name) (n.data as Record<string, unknown>).meshTarget = { name };
    return n;
  };

  it('prices a chain hanging off a TARGETED Output', () => {
    const out = targeted('o1', 'Glass');
    const u = makeNode('u', 'unknown', { functionName: 'f', rawExpression: 'f()' });
    const edges = [makeEdge('u', 'out', 'o1', 'color')];
    expect(computeReachableCost([out, u], edges)).toBe(BASE.unknown);
  });

  it('prices ONLY the active output — an inactive one is not on the meter', () => {
    const a = targeted('o1');
    const b = targeted('o2');
    const u1 = makeNode('u1', 'unknown', { functionName: 'f', rawExpression: 'f()' });
    const u2 = makeNode('u2', 'unknown', { functionName: 'g', rawExpression: 'g()' });
    const edges = [makeEdge('u1', 'out', 'o1', 'color'), makeEdge('u2', 'out', 'o2', 'color')];
    // No flag: array order, o1 drives.
    expect(computeReachableCost([a, b, u1, u2], edges)).toBe(BASE.unknown);
    // Flag o2: its chain is the price now.
    const b2 = { ...b, data: { ...b.data, activeOutput: true } } as AppNode;
    expect(computeReachableCost([a, b2, u1, u2], edges)).toBe(BASE.unknown);
    // Each sink priced on its own for its badge.
    const per = sinkCosts([a, b2, u1, u2], edges);
    expect([...per.entries()]).toEqual([['o1', BASE.unknown], ['o2', BASE.unknown]]);
  });

  it('a node feeding the active output is counted ONCE however many materials use it', () => {
    // Per pixel the total is an UPPER bound: a pixel runs one material, and the
    // shared node is counted once across the summed sections. What it
    // under-counts is compile work, pipelines and memory — each material
    // compiles the shared node into its own pipeline.
    const out = targeted('o1');
    const u = makeNode('u', 'unknown', { functionName: 'f', rawExpression: 'f()' });
    const edges = [makeEdge('u', 'out', 'o1', 'color'), makeEdge('u', 'out', 'o1', 'm1:color')];
    expect(computeReachableCost([out, u], edges)).toBe(BASE.unknown);
  });

  it('sections are SUMMED — per pixel the total is an upper bound', () => {
    // Two materials, each with its own chain: the one total carries both, though
    // any single pixel runs only one of them.
    const out = targeted('o1');
    const u1 = makeNode('u1', 'unknown', { functionName: 'f', rawExpression: 'f()' });
    const u2 = makeNode('u2', 'unknown', { functionName: 'g', rawExpression: 'g()' });
    const edges = [makeEdge('u1', 'out', 'o1', 'color'), makeEdge('u2', 'out', 'o1', 'm1:color')];
    expect(computeReachableCost([out, u1, u2], edges)).toBe(2 * BASE.unknown);
  });

  it('a single-Output document — every document before this feature — is unchanged', () => {
    const out = makeNode('o1', 'output');
    const u = makeNode('u', 'unknown', { functionName: 'f', rawExpression: 'f()' });
    const dead = makeNode('d', 'unknown', { functionName: 'h', rawExpression: 'h()' });
    const edges = [makeEdge('u', 'out', 'o1', 'color')];
    expect(computeReachableCost([out, u, dead], edges)).toBe(BASE.unknown);
  });
});

/**
 * SEVERAL SEEDS ARE ONE WALK. Per-material Output nodes make several sinks
 * contribute at once, so the seed is a LIST — and the reason it is a list and
 * not a loop over `computeReachableCost` is the shared feeder: a node wired
 * into two Outputs is compiled into two pipelines but runs once per pixel, and
 * summing per-sink totals would charge it twice. Today the list holds exactly
 * one element (`costSeeds` = the active sink), so every existing number above
 * is unchanged; these pin the rule so widening the seed set cannot silently
 * start double-counting.
 */
describe('computeReachableCost takes a seed LIST', () => {
  const unk = (id: string) => makeNode(id, 'unknown', { functionName: id, rawExpression: `${id}()` });

  it('a feeder shared by two seeds is counted ONCE', () => {
    const a = makeNode('o1', 'output');
    const b = makeNode('o2', 'output');
    const shared = unk('s');
    const edges = [makeEdge('s', 'out', 'o1', 'color'), makeEdge('s', 'out', 'o2', 'color')];
    const nodes = [a, b, shared];
    expect(computeReachableCost(nodes, edges, [a, b])).toBe(BASE.unknown);
    // Per-seed totals would have said 2 x — the union is the whole point.
    expect(computeReachableCost(nodes, edges, a) + computeReachableCost(nodes, edges, b))
      .toBe(2 * BASE.unknown);
  });

  it('the union never exceeds the sum of the per-sink prices', () => {
    const a = makeNode('o1', 'output');
    const b = makeNode('o2', 'output');
    const own = unk('x');
    const shared = unk('s');
    const edges = [
      makeEdge('x', 'out', 'o1', 'color'),
      makeEdge('s', 'out', 'o1', 'emissive'),
      makeEdge('s', 'out', 'o2', 'color'),
    ];
    const nodes = [a, b, own, shared];
    const union = computeReachableCost(nodes, edges, [a, b]);
    const per = sinkCosts(nodes, edges);
    expect(union).toBe(2 * BASE.unknown);
    expect(union).toBeLessThanOrEqual([...per.values()].reduce((s, v) => s + v, 0));
  });

  it('one node, a one-element list and the omitted form all agree', () => {
    const out = makeNode('o1', 'output');
    const u = unk('u');
    const edges = [makeEdge('u', 'out', 'o1', 'color')];
    const nodes = [out, u];
    expect(computeReachableCost(nodes, edges, out)).toBe(BASE.unknown);
    expect(computeReachableCost(nodes, edges, [out])).toBe(BASE.unknown);
    expect(computeReachableCost(nodes, edges)).toBe(BASE.unknown);
    // `null` still means "no sink", and an EMPTY list is not "resolve one".
    expect(computeReachableCost(nodes, edges, null)).toBe(0);
    expect(computeReachableCost(nodes, edges, [])).toBe(0);
  });

  it('`costSeeds` is what the omitted form resolves, so both call sites follow it', () => {
    // useSyncEngine's per-graph pass and the store's device selection both omit
    // the seed. If one of them passed its own (the active sink, say) a headset
    // change would reprice against a different set from the meter's last pass.
    const a = makeNode('o1', 'output');
    const b = { ...makeNode('o2', 'output'), data: { ...makeNode('o2', 'output').data, activeOutput: true } } as AppNode;
    expect(costSeeds([a, b], []).map((n) => n.id)).toEqual(['o2']);
    expect(costSeeds([makeNode('c', 'color')], [])).toEqual([]);

    const sync = readFileSync(resolve(__dirname, '../hooks/useSyncEngine.ts'), 'utf8');
    expect(sync).toContain('const total = computeReachableCost(nodes, unwrapped);');
    // The pre-seeded `sinkCosts` map is gone: it claimed the total IS one
    // sink's subtree, which a union total is not.
    expect(sync).toContain('const perSink = sinkCosts(nodes, unwrapped);');
    const store = readFileSync(resolve(__dirname, '../store/useAppStore.ts'), 'utf8');
    expect(store).toContain('const total = computeReachableCost(nodes, unwrapped);');
  });

  it('the march term is per march SEED and still fires from a list', () => {
    // A per-step multiplier belongs to one node's own loop, so it is added per
    // march seed rather than over the union. One element today either way.
    const pos = makeNode('p', 'positionLocal');
    const sd = makeNode('sd', 'sdCircle');
    const march = makeNode('rm', 'raymarchOutput');
    const nodes = [pos, sd, march];
    const edges = [makeEdge('p', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field')];
    const one = computeReachableCost(nodes, edges, march);
    expect(computeReachableCost(nodes, edges, [march])).toBe(one);
    // The march overhead alone is far below a 64-step field body.
    expect(one).toBeGreaterThan(getCost('raymarchOutput') + getCost('sdCircle'));
  });
});

describe('sinkCosts builds the sink set ONCE, as it already does the adjacency', () => {
  const unk = (id: string) => makeNode(id, 'unknown', { functionName: id, rawExpression: `${id}()` });

  it('prices N sinks with ONE nodes.filter pass, not N', () => {
    const nodes = [makeNode('o1', 'output'), makeNode('o2', 'output'), makeNode('o3', 'output'), unk('m')];
    let filters = 0;
    const counted = new Proxy(nodes, {
      get(t, p, r) {
        if (p === 'filter') { filters++; return Array.prototype.filter.bind(t); }
        const v = Reflect.get(t, p, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as AppNode[];
    sinkCosts(counted, []);
    // One for the hoisted set. Before, `computeReachableCost` rebuilt it per
    // sink — three identical O(N) passes and three Set allocations for a value
    // that is a function of `nodes` alone.
    expect(filters).toBe(1);
  });

  it('the hoisted set IS read — a wrong one changes the answer', () => {
    const nodes = [makeNode('o', 'output'), unk('m')];
    const edges = [makeEdge('m', 'out', 'o', 'color')];
    const right = computeReachableCost(nodes, edges, nodes[0], undefined, new Set(['o']));
    expect(right).toBe(computeReachableCost(nodes, edges, nodes[0]));
    // Claiming the feeder is a sink excludes it from the sum (a sink is not a
    // priced operation), so the number moves — which is what proves the
    // parameter is not silently ignored.
    const wrong = computeReachableCost(nodes, edges, nodes[0], undefined, new Set(['o', 'm']));
    expect(wrong).not.toBe(right);
  });

  it('the retired `known` shortcut has not come back in disguise', () => {
    // It handed in an ANSWER for one seed and stopped being true the moment the
    // total became a UNION of several; `sinks` is a function of `nodes` alone.
    const src = readFileSync(resolve(__dirname, 'nodeCost.ts'), 'utf8');
    expect(src).not.toMatch(/\bknown\s*\?:/);
    expect(src).toContain('const sinks = new Set(nodes.filter(isSinkNode).map((n) => n.id));');
  });
});

describe('Image nodes: points are per node', () => {
  // 2048 px on purpose: the 2 px fixtures used elsewhere price at the x0.5
  // floor (imageNodeCost), which would pin 5s instead of the full entry.
  const IMG = { imageB64: 'data:image/webp;base64,YWJj', width: 2048, height: 2048, fileName: 'x.webp', colorSpace: 'color' };

  it('precondition: the authored Image price is 10', () => {
    expect(BASE.imageNode).toBe(10);
  });

  it('one node wired to two channels is priced once', () => {
    const out = makeNode('o1', 'output');
    const img = makeNode('i1', 'imageNode', IMG);
    const edges = [makeEdge('i1', 'out', 'o1', 'color'), makeEdge('i1', 'out', 'o1', 'emissive')];
    expect(computeReachableCost([out, img], edges)).toBe(10);
  });

  it('two nodes holding the SAME image are two samples: 2 x 10 (plus the mul)', () => {
    const out = makeNode('o1', 'output');
    const a = makeNode('i1', 'imageNode', IMG);
    const b = makeNode('i2', 'imageNode', IMG);
    const m = makeNode('m1', 'mul');
    const edges = [
      makeEdge('i1', 'out', 'm1', 'a'),
      makeEdge('i2', 'out', 'm1', 'b'),
      makeEdge('m1', 'out', 'o1', 'color'),
    ];
    expect(computeReachableCost([out, a, b, m], edges) - BASE.mul).toBe(20);
  });

  it('the same image sampled through different UVs is still 2 x 10', () => {
    const out = makeNode('o1', 'output');
    const a = makeNode('i1', 'imageNode', IMG);
    const b = makeNode('i2', 'imageNode', { ...IMG, tileX: 2, flipX: 1 });
    const m = makeNode('m1', 'mul');
    const edges = [
      makeEdge('i1', 'out', 'm1', 'a'),
      makeEdge('i2', 'out', 'm1', 'b'),
      makeEdge('m1', 'out', 'o1', 'color'),
    ];
    expect(computeReachableCost([out, a, b, m], edges) - BASE.mul).toBe(20);
  });
});

describe('noise prices track the measured Quest 3 run', () => {
  // ShaderCarousel/benchData/quest3-20260723/
  //   shadercarousel-static-complexity-suggestion-2026-07-22T2143.json
  // (Adreno 740, gpu-timestamp, 2064x2208, budgetMs 8.33, resolutionScale 1):
  // suggestedPoints = round(marginalMsAtRef / 8.33 * 100). The MicroPlane run of
  // the same session agrees within its own noise floor; cellNoise sits BELOW
  // that floor there (marginalMs -0.0075 -> 0 pts), so the static number is the
  // conservative one. The 10% band is what catches a repricing pass that leaves
  // a straggler behind - which is exactly how cellNoise and perlinVec3 survived
  // the 2026-07-23 recalibration on hand-guessed values. It is TIGHT on purpose:
  // perlinVec3's old 75 against a measured 68 is a 10.29% error, so widening the
  // band past 10% would stop catching the very defect this block was written
  // for. Do not loosen it without a new measured run to justify the number.
  const MEASURED_STATIC: Record<string, number> = {
    cellNoise: 7,
    perlin: 36,
    perlinVec3: 68,
    fbm: 106,
    fbmVec3: 191,
    voronoi: 232,
    voronoiVec2: 237,
    voronoiVec3: 246,
  };

  for (const [type, measured] of Object.entries(MEASURED_STATIC)) {
    it(`${type} stays within 10% of its measured price`, () => {
      expect(Math.abs(BASE[type] - measured) / measured).toBeLessThanOrEqual(0.1);
    });
  }
});
