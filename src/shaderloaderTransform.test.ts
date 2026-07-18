import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
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

const LOADER = path.resolve(
  __dirname,
  '../public/js/a-frame-shaderloader-0.5.js',
);

// Eval the vendored A-Frame component file in a sandbox that stubs the browser
// globals it touches, then expose the internal transform helpers.
function loadTransforms(): {
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
  const src = readFileSync(LOADER, 'utf8');
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

describe('shaderloader globalizeBareImports', () => {
  it('rewrites a real property-bearing export header into a parseable module', () => {
    const { globalizeBareImports } = loadTransforms();
    const out = globalizeBareImports(EXPORT_WITH_PROPERTY);
    // The real import is globalized...
    expect(out).toContain('= globalThis.THREE.TSL;');
    // ...no bare `import … from` statement survives...
    expect(/^[ \t]*import\b/m.test(out)).toBe(false);
    // ...and the whole thing still parses (the original bug threw here).
    expect(parsesAsModule(out)).toBe(true);
  });

  it('does not let the word "import" in a comment hijack the real import', () => {
    const { globalizeBareImports } = loadTransforms();
    const src = `// example: import { foo } from 'three/tsl' — see the docs
// you can also import from your own bundler
import { color } from 'three/tsl';
export default function () { return { colorNode: color(1) }; }`;
    const out = globalizeBareImports(src);
    expect(out).toContain('const { color } = globalThis.THREE.TSL;');
    expect(parsesAsModule(out)).toBe(true);
  });

  it('handles multi-line, aliased, default and namespace imports', () => {
    const { globalizeBareImports } = loadTransforms();
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

describe('shaderloader autoInjectTSLImports', () => {
  it('does not leak keys from the trailing FASTSHADERS_PROJECT_V1 JSON block', () => {
    const { autoInjectTSLImports } = loadTransforms();
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
