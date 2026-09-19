import { describe, it, expect } from 'vitest';
import * as TSL from 'three/tsl';
import { TSL_EXPORT_NAMES } from './tslExportNames';

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
