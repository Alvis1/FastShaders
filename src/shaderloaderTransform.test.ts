import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { tslToShaderModule } from './engine/tslToShaderModule';
import { loaderAvailable, transformsOf } from './shaderloaderHarness';

/**
 * Regression guard for the vendored shaderloader's import-rewriting.
 *
 * A FastShaders `.js` export starts with a usage-header comment that contains
 * the word "import" (`(no import map, no shim)`) and — for shaders with
 * properties — a `el.setAttribute('shader', { name: value })` example (a stray
 * `{`). The shaderloader rewrites `import … from 'three/tsl'` into a
 * `const { … } = globalThis.THREE.TSL` destructure. An UNANCHORED regex let the
 * word "import" inside that comment start the match and swallow everything down
 * to the real import, producing a broken `const { … });` — a hard parse error
 * ("Missing initializer in destructuring declaration") that killed the shader
 * on the Podest viewer path. See globalizeBareImports().
 *
 * These tests eval the real vendored file, run the transform, and assert the
 * output parses as a valid ES module.
 */

/**
 * Every ACTIVE loader version, checked identically.
 *
 * 0.6 is a copy of 0.5 plus per-sub-mesh material dispatch, and 0.8 carries
 * 0.6's transforms verbatim (only autoInjectTSLImports reads TSL off the bound
 * three instead of window.THREE) — which is exactly why each needs the same
 * guard rather than an assumption: the files drift the moment anyone edits
 * one. 0.4 is deliberately absent; it is frozen for shaders exported before 0.5
 * and is not a maintained target.
 */
const LOADER_VERSIONS = ['0.5', '0.6', '0.8'] as const;

// src/shaderloaderHarness.ts picks the file — the frozen loaders from the
// SUBMODULE (0.5 exists nowhere else in this repo), the current one from its
// served public/js copy, which vendorSync pins to the submodule — and reaches
// the transforms: up to 0.6 they are top-level functions of the script, and
// 0.8, an IIFE, exposes the same functions as FastShaders.transforms.
const loadTransforms = (version: string) =>
  transformsOf(version, { href: 'https://podest.lv/podest.html' });

const parsesAsModule = (code: string): boolean => {
  try {
    parse(code, { sourceType: 'module', plugins: ['topLevelAwait'] });
    return true;
  } catch {
    return false;
  }
};

// The real usage header a FastShaders property-bearing export ships with,
// followed by the real import, a Fn body, and the trailing project block.
const EXPORT_WITH_PROPERTY = `// TSL Shader Module — for use with a-frame-shaderloader
//
// HTML setup — these two scripts are all you need (no import map, no shim):
//   a-frame-shaderloader-0.5.js rewrites the three/tsl import to that bundle
//   <a-entity shader="src: shader.js; ecomindspeed: 0.5289"></a-entity>
//
// Properties can be updated at runtime:
//   el.setAttribute('shader', { ecomindspeed: value });
//
// Also usable directly with Three.js, or any bundler that resolves 'three/tsl'.

import { color, mul, time, positionGeometry, mx_noise_float } from 'three/tsl';

export const schema = { ecomindspeed: { type: 'number', default: 0.5289 } };

export default function (params) {
  const noise1 = mx_noise_float(positionGeometry.mul(mul(time, params.ecomindspeed)));
  return { colorNode: noise1, emissiveNode: color(0xff8800) };
}

/* FASTSHADERS_PROJECT_V1
{ "version": 1, "shaderName": "x", "ui": { "nodeEditorBgColor": "#FAFAFA" } }
END_FASTSHADERS_PROJECT */
`;

// A CURRENT property-bearing export, built by the real generator, so the usage
// header the app ships TODAY runs through the loader's transforms below.
// EXPORT_WITH_PROPERTY above stands for already-shipped 0.5-era exports and is
// deliberately never updated.
const CURRENT_EXPORT = tslToShaderModule(
  `import { Fn, uniform, mul, positionGeometry } from 'three/tsl';

const shader = Fn(() => {
  const amount = uniform(2.5);
  const mul1 = positionGeometry.mul(amount);

  return mul1;
});

export default shader;
`,
  undefined,
  [{ name: 'amount', type: 'float', defaultValue: 2.5 }],
);
const leadingComments = (code: string): string => {
  const lines = code.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('//')) i++;
  return lines.slice(0, i).join('\n');
};

for (const version of LOADER_VERSIONS) {
  // Skipped on a NON-RECURSIVE checkout, where the submodule is empty —
  // vendorSync.test.ts guards its own rows the same way. Reading the source
  // rather than a vendored copy is what makes this necessary.
  const srcMissing = !loaderAvailable(version);
  describe.skipIf(srcMissing)(`shaderloader ${version} globalizeBareImports`, () => {
    it('rewrites a real property-bearing export header into a parseable module', () => {
      const { globalizeBareImports } = loadTransforms(version);
      const out = globalizeBareImports(EXPORT_WITH_PROPERTY);
      // The real import is globalized...
      expect(out).toContain('= globalThis.THREE.TSL;');
      // ...no bare `import … from` statement survives...
      expect(/^[ \t]*import\b/m.test(out)).toBe(false);
      // ...and the whole thing still parses (the original bug threw here).
      expect(parsesAsModule(out)).toBe(true);
    });

    it('does not let the word "import" in a comment hijack the real import', () => {
      const { globalizeBareImports } = loadTransforms(version);
      const src = `// example: import { foo } from 'three/tsl' — see the docs
  // you can also import from your own bundler
  import { color } from 'three/tsl';
  export default function () { return { colorNode: color(1) }; }`;
      const out = globalizeBareImports(src);
      expect(out).toContain('const { color } = globalThis.THREE.TSL;');
      expect(parsesAsModule(out)).toBe(true);
    });

    it('handles multi-line, aliased, default and namespace imports', () => {
      const { globalizeBareImports } = loadTransforms(version);
      const cases = [
        `import {\n  add,\n  color as col\n} from 'three/tsl';\nexport default () => col(add(1));`,
        `import Three from 'three';\nimport { vec3 } from 'three/tsl';\nexport default () => vec3(1);`,
        `import * as TSL from 'three/tsl';\nexport default () => TSL.vec3(1);`,
      ];
      for (const c of cases) {
        expect(parsesAsModule(globalizeBareImports(c))).toBe(true);
      }
    });
    it('a CURRENT export header survives the transforms', () => {
      const { globalizeBareImports } = loadTransforms(version);
      const out = globalizeBareImports(CURRENT_EXPORT);
      expect(out).toContain('= globalThis.THREE.TSL;');
      expect(/^[ \t]*import\b/m.test(out)).toBe(false);
      expect(parsesAsModule(out)).toBe(true);
    });
  });

  describe.skipIf(srcMissing)(`shaderloader ${version} autoInjectTSLImports`, () => {
    it('does not leak keys from the trailing FASTSHADERS_PROJECT_V1 JSON block', () => {
      const { autoInjectTSLImports } = loadTransforms(version);
      const out = autoInjectTSLImports(EXPORT_WITH_PROPERTY);
      const importLine = out
        .split('\n')
        .find((l) => /^import \{/.test(l)) as string;
      for (const key of [
        'FASTSHADERS_PROJECT_V1',
        'shaderName',
        'nodeEditorBgColor',
        'version',
      ]) {
        expect(importLine).not.toContain(key);
      }
    });
    it('a CURRENT export header survives the transforms', () => {
      const { autoInjectTSLImports, globalizeBareImports } = loadTransforms(version);
      const out = autoInjectTSLImports(CURRENT_EXPORT);
      // The regex is unanchored and runs on the raw source, comments included:
      // an import brace in the header would be the line it rewrites. It must
      // leave the header byte-identical and land on the module's real import.
      // The header spells the 0.8 core's calls (`FastShaders.apply(…)`); a call
      // inside a `//` comment is safe only because autoInjectTSLImports strips
      // line comments before it scans for calls — which this asserts.
      const hdr = leadingComments(CURRENT_EXPORT);
      expect(hdr).toContain('FastShaders');
      expect(leadingComments(out)).toBe(hdr);
      const importLine = out.split('\n').find((l) => /^import \{/.test(l)) as string;
      expect(importLine).toBeDefined();
      expect(importLine).toContain('positionGeometry');
      for (const word of ['Plain', 'README', 'FastShaders', 'apply', 'load', 'recipe', 'globalThis', 'NodeMaterial']) {
        expect(importLine).not.toContain(word);
      }
      expect(parsesAsModule(globalizeBareImports(out))).toBe(true);
    });
  });
}
