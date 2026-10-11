import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { graphToCode } from './graphToCode';
import { buildShaderModule } from './tslCodeProcessor';
import { MODULE_HELPERS } from './moduleHelpers';
import { ACTIVE_LOADERS, loaderAvailable, transformsOf, type LoaderTransforms } from '@/shaderloaderHarness';
import { withRecordingThree } from '@/lutHelperHarness';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * The BINDING pin for the plain-JS helper text (`tslTokenHits` in
 * moduleHelpers.test.ts is only a lint: it re-implements one regex and misses
 * the real scan's quirks). Every active loader runs its own transforms over a
 * real module carrying the helpers: `autoInjectTSLImports` must inject
 * nothing (a helper token that is a three/tsl export would be imported — or
 * shadowed), `fixTSLShadowing` must change nothing, and the result must
 * EXECUTE with real three/tsl.
 *
 * Phase 1 carries fsLut through a hand-placed call; each LUT node extends the
 * graph with its real emission as it lands. Every run swaps `globalThis.THREE`
 * through `withRecordingThree` (lutHelperHarness.ts — restored in `finally`,
 * sync only), the THREE the loader sandbox is given too.
 */

/** The loader's transforms leave `mod` alone (nothing injected, nothing renamed, no schema), then it RUNS under
 *  `three` (the recording namespace `withRecordingThree` installed); returns the material's node keys, sorted. */
const runThroughLoader = (v: string, mod: string, three: typeof THREE): string[] => {
  const tr: LoaderTransforms = transformsOf(v, { THREE: three });
  const tslLine = (s: string) => s.split('\n').find((l) => l.includes("from 'three/tsl'"));
  const injected = tr.autoInjectTSLImports(mod);
  expect(tslLine(injected)).toBe(tslLine(mod));
  expect(tr.fixTSLShadowing(injected)).toBe(injected);
  expect(tr.autoDetectSchema(mod)).toEqual({});
  const run = tr.globalizeBareImports(tr.fixTSLShadowing(injected))
    .replace(/^export const threeRevision/m, 'const threeRevision')
    .replace(/^export default function/m, '__cap.fn = function');
  const cap: { fn?: () => Record<string, unknown> } = {};
  new Function('__cap', run)(cap);
  return Object.keys(cap.fn!()).sort();
};

const lutModule = (): string => {
  const editor = graphToCode([makeNode('f', 'float'), makeNode('out', 'output')], [makeEdge('f', 'out', 'out', 'roughness')]).code;
  const withHelper = editor
    .replace("import { Fn, float } from 'three/tsl';", "import { Fn, float, texture, vec2 } from 'three/tsl';")
    .replace('\nconst shader = Fn(', `\n${MODULE_HELPERS.get('fsLut')!.lines.join('\n')}\n\nconst shader = Fn(`)
    .replace(
      'return { roughness: float1 };',
      "return { roughness: fsLut.at(fsLut.make('k', false, () => ({ vals: new Float32Array(1028), slopes: null })).tex, float1).x };",
    );
  expect(withHelper).toContain('const fsLut = (() => {');
  expect(withHelper).toContain('fsLut.at(');
  return buildShaderModule(withHelper);
};

describe('plain-JS helpers survive every active loader\'s transforms', () => {
  for (const v of ACTIVE_LOADERS) {
    it(`loader ${v}: nothing injected, nothing renamed, and the module runs`, () => {
      if (!loaderAvailable(v)) return; // a non-recursive checkout has no frozen loaders
      const mod = lutModule();
      // buildShaderModule bound the namespace the helper reaches three through
      expect(mod).toContain("import * as THREE from 'three/webgpu';");
      expect(mod).not.toContain('globalThis.THREE');
      withRecordingThree((three) => {
        expect(runThroughLoader(v, mod, three)).toEqual(['roughnessNode']);
      });
    });
  }
});

/** A graph using Fresnel — both sockets, one of them through the scalar→vec3 widening. */
const fresnelModule = (): string => {
  const editor = graphToCode(
    [makeNode('fr', 'fresnel', { ior: 1.33 }), makeNode('out', 'output')],
    [makeEdge('fr', 'facing', 'out', 'emissive'), makeEdge('fr', 'out', 'out', 'opacity')],
  ).code;
  expect(editor).toContain('const fsFresnel = Fn(([eta, n, pw]) => {');
  expect(editor).toContain('const fresnel1 = fsFresnel(1.33, normalWorld, positionWorld);');
  return buildShaderModule(editor);
};

describe('the Fresnel helper survives every active loader\'s transforms', () => {
  for (const v of ACTIVE_LOADERS) {
    it(`loader ${v}: nothing injected, nothing renamed, and the module runs`, () => {
      if (!loaderAvailable(v)) return; // a non-recursive checkout has no frozen loaders
      const mod = fresnelModule();
      // `eta`, not `ior` (a three/tsl export the scan would import and the
      // shadowing fix would rename): the helper's parameters are local — the
      // runner's "nothing injected, nothing renamed" holds that.
      withRecordingThree((three) => {
        expect(runThroughLoader(v, mod, three)).toEqual(['emissiveNode', 'opacityNode']);
      });
    });
  }
});

/** Fresnel's Facing through TWO equal Color Ramps (Constant, so the Nearest path) — Color on Color, Alpha on
 *  Opacity, the second ramp's Color on Emissive — plus a Linear ramp on Roughness. The equal pair must share ONE
 *  baked texture; the Linear one gets its own. */
const colorRampModule = (): string => {
  const stops = '0 #ff0000 1,0.5 #0000ff 0.25';
  const editor = graphToCode(
    [
      makeNode('fr', 'fresnel'),
      makeNode('a', 'colorRamp', { fac: 0.5, stops, interp: 'constant' }),
      makeNode('b', 'colorRamp', { fac: 0.5, stops, interp: 'constant' }),
      makeNode('c', 'colorRamp', { fac: 0.5 }),
      makeNode('out', 'output'),
    ],
    [
      makeEdge('fr', 'facing', 'a', 'fac'),
      makeEdge('fr', 'facing', 'b', 'fac'),
      makeEdge('a', 'out', 'out', 'color'),
      makeEdge('a', 'alpha', 'out', 'opacity'),
      makeEdge('b', 'out', 'out', 'emissive'),
      makeEdge('c', 'alpha', 'out', 'roughness'),
    ],
  ).code;
  expect(editor).toContain('const fsLut = (() => {');
  expect(editor).toContain('const fsColorRamp = (fac, stops, interp) => {');
  expect(editor.split(`fsColorRamp(fresnel1.y, "${stops}", "constant");`)).toHaveLength(3);
  expect(editor).toMatch(/const colorRamp\d = fsColorRamp\(0\.5, "0 #000000 1,1 #ffffff 1", "linear"\);/);
  return buildShaderModule(editor);
};

describe('the Color Ramp helper survives every active loader\'s transforms', () => {
  for (const v of ACTIVE_LOADERS) {
    it(`loader ${v}: nothing injected, nothing renamed, the module runs, equal ramps share one texture`, () => {
      if (!loaderAvailable(v)) return; // a non-recursive checkout has no frozen loaders
      const mod = colorRampModule();
      expect(mod).toContain("import * as THREE from 'three/webgpu';");
      expect(mod).not.toContain('globalThis.THREE');
      withRecordingThree((three, made) => {
        expect(runThroughLoader(v, mod, three)).toEqual(['colorNode', 'emissiveNode', 'opacityNode', 'roughnessNode']);
        // The module re-imports nothing it already baked: equal ramps, ONE texture; the Linear ramp its own.
        expect(made).toHaveLength(2);
        expect(made.map((tx) => tx.minFilter).sort()).toEqual([THREE.LinearFilter, THREE.NearestFilter].sort());
        for (const tx of made) {
          expect([tx.image.width, tx.image.height, tx.type, tx.format]).toEqual([257, 1, THREE.HalfFloatType, THREE.RGBAFormat]);
          expect([tx.wrapS, tx.wrapT]).toEqual([THREE.ClampToEdgeWrapping, THREE.ClampToEdgeWrapping]);
        }
      });
    });
  }
});

/** RGB Curves: Fresnel's Facing through an IDENTITY curves node (a bare vec3(), no texture) into an S-curve
 *  node on Color, and an EQUAL S-curve node fed by a Color Ramp on Emissive. The two equal curve nodes must
 *  share ONE baked texture; the identity one bakes none; the ramp bakes its own. */
const rgbCurvesModule = (): string => {
  const s = '0 0,0.25 0.15,0.75 0.85,1 1';
  const editor = graphToCode(
    [
      makeNode('fr', 'fresnel'),
      makeNode('id', 'rgbCurves', { color: 1, fac: 1 }),
      makeNode('a', 'rgbCurves', { color: 1, fac: 1, curveC: s, curveR: '0 0.1,1 1' }),
      makeNode('b', 'rgbCurves', { color: 1, fac: 0.75, curveC: s, curveR: '0 0.1,1 1' }),
      makeNode('ramp', 'colorRamp', { fac: 0.5 }),
      makeNode('out', 'output'),
    ],
    [
      makeEdge('fr', 'facing', 'id', 'color'),
      makeEdge('id', 'out', 'a', 'color'),
      makeEdge('ramp', 'out', 'b', 'color'),
      makeEdge('a', 'out', 'out', 'color'),
      makeEdge('b', 'out', 'out', 'emissive'),
    ],
  ).code;
  expect(editor).toContain('const fsRgbCurves = (col, fac, curveC, curveR, curveG, curveB, extend) => {');
  expect(editor.split('const fsLut = (() => {')).toHaveLength(2);
  expect(editor).toMatch(/fsRgbCurves\(fresnel1\.y, 1, "0 0,1 1", "0 0,1 1", "0 0,1 1", "0 0,1 1", "extrapolate"\);/);
  expect(editor.split(`"${s}", "0 0.1,1 1", "0 0,1 1", "0 0,1 1", "extrapolate");`)).toHaveLength(3);
  return buildShaderModule(editor);
};

describe('the RGB Curves helper survives every active loader\'s transforms', () => {
  for (const v of ACTIVE_LOADERS) {
    it(`loader ${v}: nothing injected, nothing renamed, the module runs, equal curves share one texture, identity bakes none`, () => {
      if (!loaderAvailable(v)) return; // a non-recursive checkout has no frozen loaders
      const mod = rgbCurvesModule();
      expect(mod).toContain("import * as THREE from 'three/webgpu';");
      expect(mod).not.toContain('globalThis.THREE');
      withRecordingThree((three, made) => {
        expect(runThroughLoader(v, mod, three)).toEqual(['colorNode', 'emissiveNode']);
        // The ramp's texture and ONE curves texture: the equal pair shares it, the identity node bakes nothing.
        expect(made).toHaveLength(2);
        for (const tx of made) {
          expect([tx.image.width, tx.image.height, tx.type, tx.format]).toEqual([257, 1, THREE.HalfFloatType, THREE.RGBAFormat]);
          expect([tx.minFilter, tx.magFilter]).toEqual([THREE.LinearFilter, THREE.LinearFilter]);
          expect([tx.wrapS, tx.wrapT]).toEqual([THREE.ClampToEdgeWrapping, THREE.ClampToEdgeWrapping]);
        }
      });
    });
  }
});
