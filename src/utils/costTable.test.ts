import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getBaseCosts, getCost, sanitizeCostMap, setCostOverrides } from './costTable';
// STATIC, not a dynamic `await import()` inside the test. Pulling nodeCost in
// drags the whole store graph with it, which under load can take longer than the
// 5s test timeout — and a timed-out test is not cancelled, so the override this
// test sets would land (and be restored) at some arbitrary later moment. With
// `isolate: false` the module singletons are shared across the worker's suites,
// so that stray window reprices nodes underneath whatever else is running:
// codeGroupBuilder's note-band geometry reads node footprints, which scale with
// cost, and failed exactly that way. No await, no window.
import * as viaNodeCost from './nodeCost';

/**
 * `costTable.ts` must stay a LEAF module, and the store must reach it directly.
 *
 * This is a source pin because the thing it protects fails in a way no
 * behavioural test can see: `useAppStore` calls `sanitizeCostMap` and
 * `setCostOverrides` at MODULE SCOPE, and `nodeCost.ts` — where they used to
 * live — sits in a real import cycle that runs back through the store
 * (nodeCost → outputMaterials → exposedPorts → edgeUtils → useAppStore). A
 * cycle is harmless until something evaluates across it during initialisation;
 * those two calls did, so whichever module the entry point reached first got
 * re-entered mid-body and threw a TDZ ReferenceError on a binding that had not
 * been initialised yet.
 *
 * MEASURED before the split: 5–11 of 152 test files failed, DIFFERENTLY on every
 * run (`vite.config.ts` sets `isolate: false`, so module instances are shared
 * across a worker's suites and vitest's file→worker assignment decides who wins
 * the race). `release.yml` runs `npm test` before building binaries, so it could
 * fail a release for no reason at all.
 *
 * Two ways to silently undo it, both pinned below: give `costTable.ts` an import
 * that can suspend it mid-initialisation, or point the store's module-scope
 * calls back at `nodeCost`.
 */

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

describe('costTable stays a leaf', () => {
  it('imports nothing that could suspend it mid-initialisation', () => {
    const src = read('./costTable.ts');
    const specifiers = [...src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    // The JSON is data with no module graph of its own, so it cannot re-enter
    // anything. Anything else can, and that is the whole failure mode.
    expect(
      specifiers.filter((s) => !s.endsWith('.json')),
      'costTable.ts must import nothing but the cost JSON — see its header. An ' +
        'import here can leave the module half-initialised while the store calls ' +
        'into it at boot, which is the random-TDZ bug this file exists to prevent',
    ).toEqual([]);
  });

  it('the store reaches the table directly, not through nodeCost', () => {
    const store = read('../store/useAppStore.ts');
    // The two the store calls during its OWN module evaluation.
    expect(store).toMatch(/import \{[^}]*setCostOverrides[^}]*\} from '@\/utils\/costTable'/);
    expect(store).toMatch(/import \{[^}]*sanitizeCostMap[^}]*\} from '@\/utils\/costTable'/);
    // nodeCost may still be imported for the graph-aware readers — they are only
    // ever called from inside store actions, never at module scope — but these
    // two must not come from there.
    const viaNodeCost = store.match(/import \{([^}]*)\} from '@\/utils\/nodeCost'/);
    if (viaNodeCost) {
      expect(viaNodeCost[1]).not.toMatch(/setCostOverrides|sanitizeCostMap/);
    }
  });
});

describe('costTable behaviour survived the move out of nodeCost', () => {
  it('re-exports from nodeCost still resolve to the same singleton', () => {
    setCostOverrides({ voronoi: 231 });
    try {
      expect(viaNodeCost.getCost('voronoi')).toBe(231);
      expect(getCost('voronoi')).toBe(231);
    } finally {
      setCostOverrides(null);
    }
    expect(viaNodeCost.getCost('voronoi')).toBe(getBaseCosts().voronoi);
  });

  it('still drops unknown keys and clamps hostile values', () => {
    expect(sanitizeCostMap({ voronoi: 230, bogus: 1, perlin: -1 })).toEqual({ voronoi: 230 });
    expect(sanitizeCostMap({ mul: 1e308 }).mul).toBe(1_000_000);
  });
});
