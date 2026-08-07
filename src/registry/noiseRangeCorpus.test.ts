import { describe, it, expect } from 'vitest';
import { getBuiltinTextures } from './builtinTextures';
import { getBuiltinPresets } from './builtinPresets';
import { graphToCode } from '@/engine/graphToCode';
import { getNodeValues } from '@/types';
import { hasNoiseRangeFlag } from '@/utils/noiseRange';
import type { AppNode, AppEdge } from '@/types';

/**
 * The scope guard for the noise range flag: NOTHING shipped may carry it.
 *
 * The whole backwards-compatibility story is that an absent flag means the
 * legacy signed range, and that only `newNodeValues` — the one shared path for a
 * USER-added node — ever stamps it. The built-in textures and presets are built
 * from authored TSL through `codeGroupBuilder` → `codeToGraph`, which is
 * deliberately not that path. If a flag ever appears here, every shipped asset
 * silently changed what it renders.
 */
describe('built-in assets never carry the noise range flag', () => {
  const groups = [...getBuiltinTextures(), ...getBuiltinPresets()];

  it('has assets to check (guards against an empty sweep passing vacuously)', () => {
    expect(groups.length).toBeGreaterThan(15);
  });

  it('no noise member stores a `signed` value', () => {
    let noiseMembers = 0;
    for (const g of groups) {
      for (const n of g.nodes as AppNode[]) {
        if (!hasNoiseRangeFlag(n.data.registryType)) continue;
        noiseMembers++;
        expect(getNodeValues(n), `${g.name} / ${n.data.registryType}`)
          .not.toHaveProperty('signed');
      }
    }
    // The sweep must actually see noise nodes, or it proves nothing.
    expect(noiseMembers).toBeGreaterThan(0);
  });

  it('no built-in emits the 0-1 remap', () => {
    for (const g of groups) {
      const { code } = graphToCode(g.nodes as AppNode[], g.edges as AppEdge[]);
      expect(code, g.name).not.toContain('.mul(0.5).add(0.5)');
    }
  });
});
