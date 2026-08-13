/**
 * Pricing guards for node costs no other suite covers.
 *
 * `unknown` is the load-bearing one. An unrecognised TSL function still RUNS:
 * shaderloader 0.5's `autoInjectTSLImports`
 * (public/js/a-frame-shaderloader-0.5.js:573, called at :88) injects any called
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
  getBaseCosts, getCost, computeReachableCost, nodeCostPoints, setCostOverrides,
} from './nodeCost';
import { makeNode, makeEdge } from '@/test-utils';

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
