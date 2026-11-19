import { describe, it, expect } from 'vitest';
import * as TSL from 'three/tsl';
import { TSL_EXPORT_NAMES, TSL_NODE_VALUE_NAMES } from './tslExportNames';

/**
 * `TSL_EXPORT_NAMES` is GENERATED (scripts/gen-tsl-exports.mjs) from the
 * installed three's `three.tsl.js` export clause, and buildShaderModule
 * completes a module's `three/tsl` import from it. A stale list either misses
 * a function a module calls (plain three.js throws a ReferenceError on import)
 * or names one three no longer exports (the import itself is a SyntaxError).
 *
 * So the list must equal what `three/tsl` actually exports. A three bump fails
 * here until the generator is re-run — in the same change that moves
 * THREE_REVISION (engine/threeRevision.ts).
 *
 * The same generator writes `TSL_NODE_VALUE_NAMES`, the exports whose value is
 * a NODE — the names a noise node's stored position may hold
 * (utils/sdfPartition.ts `noisePosIdentifier`). It is pinned the same way, so
 * a three bump shows its diff for review.
 */
describe('TSL_EXPORT_NAMES — the generated three/tsl export list', () => {
  it('equals the installed three/tsl exports, name for name', () => {
    const live = Object.keys(TSL).sort();
    expect([...TSL_EXPORT_NAMES].sort()).toEqual(live);
  });

  it('is stored sorted, so a regeneration is a readable diff', () => {
    const stored = [...TSL_EXPORT_NAMES];
    expect(stored).toEqual([...stored].sort());
    expect(stored.length).toBeGreaterThan(600);
  });
});

describe('TSL_NODE_VALUE_NAMES — the exports that are nodes, not functions', () => {
  it('equals the installed exports whose value is a node', () => {
    // An OBJECT that is a node. `Fn` proxies are functions that also answer
    // `isNode` (property reads forward to the shader node), and a function is
    // exactly what may never stand where three would call one.
    const live = Object.entries(TSL)
      .filter(([, v]) => v !== null && typeof v === 'object' && (v as { isNode?: unknown }).isNode === true)
      .map(([k]) => k)
      .sort();
    expect([...TSL_NODE_VALUE_NAMES]).toEqual(live);
    expect(live).toContain('positionGeometry');
    expect(live).toContain('time');
  });

  it('holds no function — a value name may stand where three would CALL a function', () => {
    for (const n of TSL_NODE_VALUE_NAMES) expect(typeof (TSL as Record<string, unknown>)[n], n).not.toBe('function');
  });
});
