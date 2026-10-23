import { describe, it, expect } from 'vitest';
import { getBuiltinTextures } from './builtinTextures';
import { getBuiltinPresets, isRecipe } from './builtinPresets';
import { graphToCode } from '@/engine/graphToCode';
import { getNodeValues } from '@/types';
import { hasNoiseRangeFlag } from '@/utils/noiseRange';
import type { AppNode, AppEdge } from '@/types';

/**
 * The scope guard for the noise range flag: nothing shipped BEFORE the flag may
 * carry it.
 *
 * The whole backwards-compatibility story is that an absent flag means the
 * legacy signed range, and that only `newNodeValues` — the one shared path for a
 * USER-added node — ever stamps it. The built-in textures and the original
 * presets are built from authored TSL through `codeGroupBuilder` →
 * `codeToGraph`, which is deliberately not that path. If a flag ever appears
 * there, every shipped asset silently changed what it renders.
 *
 * The beginner RECIPES are the one exception, and the opposite rule: they are
 * new, so there is no older render to keep, and they exist to be rebuilt from
 * the palette — so their Perlins must be the 0–1 node a palette add makes.
 */
describe('built-in assets never carry the noise range flag', () => {
  const groups = [...getBuiltinTextures(), ...getBuiltinPresets().filter((p) => !isRecipe(p))];

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

describe('the beginner recipes use the palette\'s 0–1 noise', () => {
  it('every recipe Perlin is the 0–1 node a palette add makes', () => {
    let perlins = 0;
    for (const r of getBuiltinPresets().filter(isRecipe)) {
      for (const n of r.nodes as AppNode[]) {
        if (n.data.registryType !== 'perlin') continue;
        perlins++;
        expect(getNodeValues(n).signed, r.id).toBe(0);
      }
    }
    expect(perlins).toBeGreaterThan(0);
  });
});
