import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { graphToCode } from './graphToCode';
import { bakeEditorModule as runModule } from '@/lutHelperHarness';
import { fromHalfFloat } from '@/utils/binaryCodec';
import { srgbToLinear01 } from '@/utils/colorUtils';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * EXECUTE the generated Color Ramp module (the dataVizExecution.test.ts idea):
 * string assertions prove the emitter agrees with itself, not that the module
 * RUNS. `bakeEditorModule` (lutHelperHarness.ts) rewrites the `three/tsl`
 * import into a destructure of the real namespace, supplies a
 * `globalThis.THREE` whose DataTexture records every instance, runs the
 * editor's module and the shader's BODY (which is what calls `fsColorRamp` and
 * bakes the table); this decodes the half floats: texel 0 and texel 256 must
 * be the end stops, linearised, alpha carried.
 */

const texel = (tex: THREE.DataTexture, i: number): number[] =>
  [0, 1, 2, 3].map((ch) => fromHalfFloat((tex.image.data as Uint16Array)[i * 4 + ch]));
const lin = (hex: string): number[] => [1, 3, 5].map((o) => srgbToLinear01(parseInt(hex.slice(o, o + 2), 16) / 255));

describe('the generated Color Ramp module actually runs', () => {
  for (const interp of ['linear', 'constant', 'ease', 'bspline', 'cardinal']) {
    it(`${interp}: the end texels are the end stops in linear light, alpha carried`, () => {
      const stops = '0.1 #ff8000 0.75,0.6 #2040c0 1,0.9 #10e0a0 0.25';
      const code = graphToCode(
        [makeNode('c', 'colorRamp', { fac: 0.5, stops, interp }), makeNode('out', 'output')],
        [makeEdge('c', 'out', 'out', 'color'), makeEdge('c', 'alpha', 'out', 'opacity')],
      ).code;
      const made = runModule(code);
      expect(made).toHaveLength(1);
      const tex = made[0];
      expect([tex.image.width, tex.image.height, tex.type, tex.format]).toEqual([257, 1, THREE.HalfFloatType, THREE.RGBAFormat]);
      expect(tex.minFilter).toBe(interp === 'constant' ? THREE.NearestFilter : THREE.LinearFilter);
      const f16 = 2e-3;
      const first = texel(tex, 0);
      const last = texel(tex, 256);
      // The splines blend toward the neighbours even at the ends (Blender has no early-out for them), so they
      // are pinned to the transcription in colorRamp.test.ts instead; here, the held end colours.
      if (interp === 'bspline' || interp === 'cardinal') {
        for (const v of [...first, ...last]) expect(v >= 0 && v <= 1).toBe(true);
        return;
      }
      [...lin('#ff8000'), 0.75].forEach((v, k) => expect(Math.abs(first[k] - v), `texel 0 ch ${k}`).toBeLessThan(f16));
      [...lin('#10e0a0'), 0.25].forEach((v, k) => expect(Math.abs(last[k] - v), `texel 256 ch ${k}`).toBeLessThan(f16));
    });
  }

  it('the default ramp runs through the whole module, black to white', () => {
    const made = runModule(graphToCode([makeNode('c', 'colorRamp'), makeNode('out', 'output')], [makeEdge('c', 'out', 'out', 'color')]).code);
    expect(texel(made[0], 0)).toEqual([0, 0, 0, 1]);
    expect(texel(made[0], 256)).toEqual([1, 1, 1, 1]);
    expect(texel(made[0], 128)[0]).toBeCloseTo(0.5, 3);
  });
});
