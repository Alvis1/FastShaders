import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import vm from 'vm';
import { parse } from '@babel/parser';

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
 * 0.6 is a copy of 0.5 plus per-sub-mesh material dispatch, so its transforms
 * are the same code — which is exactly why it needs the same guard rather than
 * an assumption: the two files drift the moment anyone edits one. 0.4 is
 * deliberately absent; it is frozen for shaders exported before 0.5 and is not
 * a maintained target.
 */
const LOADER_VERSIONS = ['0.5', '0.6'] as const;

// The SUBMODULE is the source of truth, and since 2026-08-31 it is also the
// only place 0.5 exists in this repo: it is frozen and CDN-only, so it is no
// longer vendored into public/js (see NOT_VENDORED in vendorSync.test.ts).
// 0.6 is vendored too, and vendorSync pins the copy byte-for-byte, so reading
// both from here keeps this suite reading ONE file per version.
const loaderPath = (version: string) =>
  path.resolve(__dirname, `../a-frame-shaderloader/js/a-frame-shaderloader-${version}.js`);

// Eval the vendored A-Frame component file in a sandbox that stubs the browser
// globals it touches, then expose the internal transform helpers.
function loadTransforms(version: string): {
  globalizeBareImports: (s: string) => string;
  autoInjectTSLImports: (s: string) => string;
} {
  const sandbox: Record<string, unknown> = {
    console: { log() {}, error() {}, warn() {} },
    URL,
    location: { href: 'https://podest.lv/podest.html' },
    AFRAME: { registerComponent() {}, registerShader() {}, utils: {} },
    window: { THREE: null },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox.window;
  vm.createContext(sandbox);
  const src = readFileSync(loaderPath(version), 'utf8');
  vm.runInContext(
    src +
      '\n;globalThis.__t = { globalizeBareImports, autoInjectTSLImports };',
    sandbox,
  );
  return (sandbox as { __t: ReturnType<typeof loadTransforms> }).__t;
}

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

for (const version of LOADER_VERSIONS) {
  // Skipped on a NON-RECURSIVE checkout, where the submodule is empty —
  // vendorSync.test.ts guards its own rows the same way. Reading the source
  // rather than a vendored copy is what makes this necessary.
  const srcMissing = !existsSync(loaderPath(version));
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
  });
}
