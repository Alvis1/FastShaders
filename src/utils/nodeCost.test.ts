/**
 * Pricing guards for node costs no other suite covers.
 *
 * `unknown` is the load-bearing one. An unrecognised TSL function still RUNS:
 * the shaderloader's `autoInjectTSLImports`
 * (a-frame-shaderloader/js/a-frame-shaderloader-0.6.js) injects any called
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
import {
  getBaseCosts, getCost, computeReachableCost,
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
    // A lower bound, deliberately: the GPU compiles the shared node into both
    // pipelines, but real per-part pricing needs a calibration entry.
    const out = targeted('o1');
    const u = makeNode('u', 'unknown', { functionName: 'f', rawExpression: 'f()' });
    const edges = [makeEdge('u', 'out', 'o1', 'color'), makeEdge('u', 'out', 'o1', 'm1:color')];
    expect(computeReachableCost([out, u], edges)).toBe(BASE.unknown);
  });

  it('a single-Output document — every document before this feature — is unchanged', () => {
    const out = makeNode('o1', 'output');
    const u = makeNode('u', 'unknown', { functionName: 'f', rawExpression: 'f()' });
    const dead = makeNode('d', 'unknown', { functionName: 'h', rawExpression: 'h()' });
    const edges = [makeEdge('u', 'out', 'o1', 'color')];
    expect(computeReachableCost([out, u, dead], edges)).toBe(BASE.unknown);
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
