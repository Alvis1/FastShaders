import { describe, it, expect, afterEach } from 'vitest';
import { getBaseCosts, getCost, setCostOverrides } from './costTable';
import { computeReachableCost, nodeCostPoints } from './nodeCost';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * The cost table is indexed by `node.data.registryType`, which arrives verbatim
 * from a `.fastshader`, a shared `.js` or a tampered `fs:graph` —
 * `sanitizeGraphShape` validates id/data/position and nothing on any restore
 * path checks the type against the registry.
 *
 * On a plain object `ACTIVE['constructor']` resolves through `Object.prototype`
 * to a FUNCTION, so `?? 0` never fires. MEASURED before the fix: a single node
 * typed `constructor` made `computeReachableCost` return the STRING
 * "0function Object() { [native code] }", which `useSyncEngine` wrote into
 * `totalCost` and each sink's `data.cost`; `getCostColor` then produced
 * `#NaNNaNNaN` and `getCostScale` a `scale(NaN)` transform. Nothing threw.
 *
 * The fix is structural — both maps are `Object.create(null)` — so this pins
 * the PROPERTY (no inherited key is ever reachable) rather than one guard at
 * one reader. `Object.create(null)` and not a `Map`, because `getBaseCosts()`
 * is consumed as a plain record and `costTable.ts` must stay a leaf.
 */

const INHERITED = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

afterEach(() => {
  setCostOverrides(null);
});

describe('cost table is null-prototype, so an adversarial node type prices as 0', () => {
  it.each(INHERITED)('getCost(%s) is 0', (key) => {
    expect(getCost(key)).toBe(0);
  });

  it('stays null-prototype once a measured override is layered on', () => {
    setCostOverrides({ voronoi: 12 });
    expect(getCost('voronoi')).toBe(12);
    for (const key of INHERITED) expect(getCost(key)).toBe(0);
  });

  it('exposes the authored table without a prototype either', () => {
    expect(Object.getPrototypeOf(getBaseCosts())).toBeNull();
    // Real keys are untouched by the change.
    expect(getBaseCosts().voronoi).toBeGreaterThan(0);
  });

  it('keeps the graph total a number when a graph carries such a node', () => {
    const bad = makeNode('bad', 'constructor');
    const out = makeNode('out', 'output');
    const total = computeReachableCost([bad, out], [makeEdge('bad', 'out', 'out', 'color')]);
    expect(typeof total).toBe('number');
    expect(Number.isFinite(total)).toBe(true);
    expect(typeof nodeCostPoints(bad, [])).toBe('number');
  });
});
