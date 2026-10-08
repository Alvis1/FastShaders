import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { graphToCode } from './graphToCode';
import { buildShaderModule } from './tslCodeProcessor';
import { MODULE_HELPERS } from './moduleHelpers';
import { ACTIVE_LOADERS, loaderAvailable, transformsOf } from '@/shaderloaderHarness';
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
 * graph with its real emission as it lands.
 */

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

      const fake = { ...THREE };
      const tr = transformsOf(v, { THREE: fake });
      const tslLine = (s: string) => s.split('\n').find((l) => l.includes("from 'three/tsl'"));
      const injected = tr.autoInjectTSLImports(mod);
      expect(tslLine(injected)).toBe(tslLine(mod));
      expect(tr.fixTSLShadowing(injected)).toBe(injected);
      expect(tr.autoDetectSchema(mod)).toEqual({});

      const run = tr.globalizeBareImports(tr.fixTSLShadowing(injected))
        .replace(/^export const threeRevision/m, 'const threeRevision')
        .replace(/^export default function/m, '__cap.fn = function');
      const g = globalThis as Record<string, unknown>;
      const had = Object.prototype.hasOwnProperty.call(g, 'THREE');
      const prev = g.THREE;
      g.THREE = fake;
      try {
        const cap: { fn?: () => Record<string, unknown> } = {};
        new Function('__cap', run)(cap);
        const res = cap.fn!();
        expect(Object.keys(res)).toEqual(['roughnessNode']);
      } finally {
        if (had) g.THREE = prev;
        else delete g.THREE;
      }
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
      const fake = { ...THREE };
      const tr = transformsOf(v, { THREE: fake });
      const tslLine = (s: string) => s.split('\n').find((l) => l.includes("from 'three/tsl'"));
      const injected = tr.autoInjectTSLImports(mod);
      // `eta`, not `ior` (a three/tsl export the scan would import and the
      // shadowing fix would rename): the helper's parameters are local.
      expect(tslLine(injected)).toBe(tslLine(mod));
      expect(tr.fixTSLShadowing(injected)).toBe(injected);
      expect(tr.autoDetectSchema(mod)).toEqual({});

      const run = tr.globalizeBareImports(tr.fixTSLShadowing(injected))
        .replace(/^export const threeRevision/m, 'const threeRevision')
        .replace(/^export default function/m, '__cap.fn = function');
      const g = globalThis as Record<string, unknown>;
      const had = Object.prototype.hasOwnProperty.call(g, 'THREE');
      const prev = g.THREE;
      g.THREE = fake;
      try {
        const cap: { fn?: () => Record<string, unknown> } = {};
        new Function('__cap', run)(cap);
        const res = cap.fn!();
        expect(Object.keys(res).sort()).toEqual(['emissiveNode', 'opacityNode']);
      } finally {
        if (had) g.THREE = prev;
        else delete g.THREE;
      }
    });
  }
});
