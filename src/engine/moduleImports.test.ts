import { describe, it, expect, beforeAll } from 'vitest';
import { parse } from '@babel/parser';
import * as TSL from 'three/tsl';
import { graphToCode } from './graphToCode';
import { tslToShaderModule } from './tslToShaderModule';
import { buildShaderModule, maskNonCode } from './tslCodeProcessor';
import { collectShaderProperties, marchMaterialSettings } from './exportShader';
import { inlineImageAssetsFromNodes } from './imageAssets';
import { loadUnknownExpressionValidator } from './unknownExpression';
import { MODULE_HELPER_NAMES } from './moduleHelpers';
import { TSL_EXPORT_NAMES } from './tslExportNames';
import { THREE_REVISION } from './threeRevision';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import { findDefaultOutput } from '@/utils/outputMaterials';
import { makeDataNodeData } from '@/utils/dataNode';
import { makeNode, makeEdge } from '@/test-utils';
import { ACTIVE_LOADERS, loaderAvailable, transformsOf } from '@/shaderloaderHarness';
import type { AppNode, AppEdge, OutputNodeData } from '@/types';

/**
 * The three MODULE-only fields the loader switch added to buildShaderModule
 * (integration §2g). Nothing here reaches graphToCode — the code panel and the
 * byte-stability snapshots never see them — so this is the one suite that
 * pins what they do to the module a recipient's page imports:
 *
 *   - `export const threeRevision` once (threeRevision.test.ts pins placement);
 *   - C2: `import * as THREE from 'three/webgpu'` exactly when a baked texture
 *     reads the THREE global in CODE position, with those reads rewritten;
 *   - C3: the three/tsl import completed with every TSL function the module
 *     calls but neither imports nor declares.
 *
 * Together they make a module import standalone on plain three.js; on the
 * loaders `globalizeBareImports` must still turn every import into a global
 * read, which the parse sweep at the end checks against the real transforms.
 */

const THREE_IMPORT = "import * as THREE from 'three/webgpu';";
const count = (text: string, needle: string) => text.split(needle).length - 1;

/** The names on a module's `import { … } from 'three/tsl'` line. */
function tslImportNames(module: string): string[] {
  const m = /^import \{([^}]*)\} from 'three\/tsl';$/m.exec(module);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

const parsesAsModule = (code: string): boolean => {
  try {
    parse(code, { sourceType: 'module', plugins: ['topLevelAwait'] });
    return true;
  } catch {
    return false;
  }
};

interface Graph { nodes: AppNode[]; edges: AppEdge[] }

/** `buildShaderBundle`'s module step, fed a graph instead of the store (moduleBaseline's). */
function exportModule({ nodes, edges }: Graph): string {
  const output = findDefaultOutput(nodes);
  return tslToShaderModule(
    inlineImageAssetsFromNodes(graphToCode(nodes, edges).code, nodes),
    marchMaterialSettings(nodes, edges, (output?.data as OutputNodeData | undefined)?.materialSettings),
    collectShaderProperties(nodes),
  );
}

const IMG = 'data:image/webp;base64,' + btoa('abc');
const out = () => makeNode('out', 'output');

const TEXTURE_GRAPHS: Record<string, Graph> = {
  image: {
    nodes: [
      makeNode('i1', 'imageNode', { imageB64: IMG, width: 2, height: 2, fileName: 'x.webp', colorSpace: 'color' }),
      out(),
    ],
    edges: [makeEdge('i1', 'out', 'out', 'color')],
  },
  data: {
    nodes: [
      makeNode(
        'd1',
        'dataNode',
        makeDataNodeData({ columnNames: ['ramp'], columns: [[0, 1, 2, 3, 4]], rowCount: 5 }, 1).values,
      ),
      makeNode('n1', 'dataRange', { mode: 'minmax' }),
      out(),
    ],
    edges: [makeEdge('d1', 'col0', 'n1', 'value'), makeEdge('n1', 'out', 'out', 'color')],
  },
  colormap: {
    nodes: [makeNode('f1', 'float', { value: 0.3 }), makeNode('c1', 'colormap', { map: 'viridis' }), out()],
    edges: [makeEdge('f1', 'out', 'c1', 'value'), makeEdge('c1', 'out', 'out', 'color')],
  },
};

function unknownGraph(rawExpression: string): Graph {
  return {
    nodes: [makeNode('u', 'unknown', { functionName: rawExpression.split('(')[0], rawExpression }), out()],
    edges: [makeEdge('u', 'out', 'out', 'color')],
  };
}

const RAYMARCH: Graph = {
  nodes: [
    makeNode('pos', 'positionLocal'),
    makeNode('sd', 'sdCircle'),
    makeNode('rm', 'raymarchOutput'),
  ],
  edges: [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field')],
};

// The unknown node's validator loads lazily and fails CLOSED while cold
// (`float(0)` instead of the raw expression); every real export runs warm.
beforeAll(() => loadUnknownExpressionValidator());

describe('threeRevision', () => {
  it('every module declares it exactly once', () => {
    for (const [key, g] of Object.entries(TEXTURE_GRAPHS)) {
      expect(count(exportModule(g), `export const threeRevision = '${THREE_REVISION}';`), key).toBe(1);
    }
  });
});

describe('C2 — the THREE namespace import', () => {
  for (const [key, g] of Object.entries(TEXTURE_GRAPHS)) {
    it(`${key}: imports THREE once and reads no THREE global in code`, () => {
      const m = exportModule(g);
      expect(count(m, THREE_IMPORT)).toBe(1);
      // Before the three/tsl import, so the namespace is bound first.
      expect(m.indexOf(THREE_IMPORT)).toBeLessThan(m.indexOf("from 'three/tsl'"));
      expect(maskNonCode(m)).not.toContain('globalThis.THREE');
      expect(m).toMatch(/\bnew THREE\.\w+Texture\(/);
    });
  }

  it('a module with no texture gets no THREE import', () => {
    const plain = exportModule({
      nodes: [makeNode('c1', 'color', { hex: '#2d6cdf' }), out()],
      edges: [makeEdge('c1', 'out', 'out', 'color')],
    });
    expect(plain).not.toContain(THREE_IMPORT);
    // The usage header mentions THREE in prose; the CODE must not.
    expect(maskNonCode(plain)).not.toMatch(/\bTHREE\b/);
  });

  it('a string literal or a comment spelling the global is left alone', () => {
    const m = buildShaderModule(`import { Fn, float } from 'three/tsl';

const note = 'globalThis.THREE.Texture';
// see globalThis.THREE in the docs

const shader = Fn(() => {
  const a = float(1);

  return a;
});

export default shader;
`);
    expect(m).toContain("const note = 'globalThis.THREE.Texture';");
    expect(m).toContain('// see globalThis.THREE in the docs');
    expect(m).not.toContain(THREE_IMPORT);
  });

  it('a module that already imports THREE gets no second binding and no rewrite', () => {
    const m = buildShaderModule(`${THREE_IMPORT}
import { Fn, texture, uv } from 'three/tsl';

const tex = new globalThis.THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);

const shader = Fn(() => {
  const t1 = texture(tex, uv()).rgb;

  return t1;
});

export default shader;
`);
    expect(count(m, THREE_IMPORT)).toBe(1);
    expect(m).toContain('new globalThis.THREE.DataTexture');
    expect(parsesAsModule(m)).toBe(true);
  });

  it('a module that DECLARES THREE gets no import either', () => {
    const m = buildShaderModule(`import { Fn, texture, uv } from 'three/tsl';

const THREE = globalThis.THREE;
const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);

const shader = Fn(() => {
  const t1 = texture(tex, uv()).rgb;

  return t1;
});

export default shader;
`);
    expect(m).not.toContain(THREE_IMPORT);
    expect(m).toContain('const THREE = globalThis.THREE;');
    expect(parsesAsModule(m)).toBe(true);
  });
});

describe('C3 — the completed three/tsl import', () => {
  it("imports an unknown node's three/tsl function", () => {
    const m = exportModule(unknownGraph('triNoise3D(vec3(1, 2, 3), 1, 1)'));
    expect(m).toContain('triNoise3D(vec3(1, 2, 3), 1, 1)');
    expect(tslImportNames(m)).toContain('triNoise3D');
    expect(tslImportNames(m)).toContain('vec3');
  });

  it('never imports a function three/tsl does not export', () => {
    const m = exportModule(unknownGraph('mysteryFn(1, 2, 3)'));
    expect(m).toContain('mysteryFn(1, 2, 3)');
    expect(m).not.toMatch(/import \{[^}]*\bmysteryFn\b/);
  });

  it('never imports a name the module declares', () => {
    // `hue` IS a three/tsl export; a module-scope helper of that name is a
    // declaration, and importing it too would be a redeclaration SyntaxError.
    const m = buildShaderModule(`import { Fn, float } from 'three/tsl';

const hue = Fn(([c]) => c);

const shader = Fn(() => {
  const a = hue(float(1));

  return a;
});

export default shader;
`);
    expect(tslImportNames(m)).not.toContain('hue');
    expect(parsesAsModule(m)).toBe(true);
  });

  it("appends SORTED after the existing names, so an import line's order never moves", () => {
    const m = buildShaderModule(`import { Fn, vec3 } from 'three/tsl';

const shader = Fn(() => {
  const a = sin(abs(vec3(1, 2, 3)));

  return a;
});

export default shader;
`);
    expect(tslImportNames(m)).toEqual(['vec3', 'abs', 'sin']);
  });

  it("a Raymarch Output's IIFE gets the Fn it calls", () => {
    const m = exportModule(RAYMARCH);
    expect(m).toMatch(/\bFn\(/);
    expect(tslImportNames(m)).toContain('Fn');
  });

  it('no module-scope helper name is a three/tsl export (it would be redeclared)', () => {
    const clash = [...MODULE_HELPER_NAMES].filter((n) => TSL_EXPORT_NAMES.has(n));
    expect(clash).toEqual([]);
  });
});

/**
 * Every shipped texture and preset, plus the graphs above, through the export
 * builder. The corpus is where a regression in the declaration scan would show:
 * a name imported although the module declares it is a SyntaxError on EVERY
 * loader, not only on plain three.js.
 */
describe('the built-in corpus', () => {
  function corpus(): Record<string, { code: string; module: string }> {
    const outMap: Record<string, { code: string; module: string }> = {};
    for (const asset of [...getBuiltinTextures(), ...getBuiltinPresets()]) {
      const code = graphToCode(asset.nodes, asset.edges).code;
      outMap[asset.id] = { code, module: tslToShaderModule(code) };
    }
    for (const [key, g] of Object.entries({ ...TEXTURE_GRAPHS, raymarch: RAYMARCH })) {
      const code = inlineImageAssetsFromNodes(graphToCode(g.nodes, g.edges).code, g.nodes);
      outMap[key] = { code, module: exportModule(g) };
    }
    return outMap;
  }

  // Names the MODULE's import line may carry that the editor code's import
  // line does not. Each is emitted by buildShaderModule itself — before the
  // switch (displacement's positionLocal/normalLocal, the __pixel wrapper's
  // Fn/Discard, its vec3 fallback) or by C3 for a call graphToCode leaves
  // unimported. A name outside this list means the declaration scan let a
  // local through, or graphToCode stopped importing something it calls.
  const ALLOWED_GAINS = new Set(['Fn', 'Discard', 'vec3', 'positionLocal', 'normalLocal']);

  it('gains no import beyond the allow-list', () => {
    const gains: Record<string, string[]> = {};
    for (const [key, { code, module }] of Object.entries(corpus())) {
      const before = new Set(tslImportNames(code));
      const extra = tslImportNames(module).filter((n) => !before.has(n) && !ALLOWED_GAINS.has(n));
      if (extra.length) gains[key] = extra;
    }
    expect(gains).toEqual({});
  });

  it('imports only names three/tsl really exports', () => {
    const live = new Set(Object.keys(TSL));
    for (const [key, { module }] of Object.entries(corpus())) {
      expect(tslImportNames(module).filter((n) => !live.has(n)), key).toEqual([]);
    }
  });

  it('parses as a module as emitted', () => {
    for (const [key, { module }] of Object.entries(corpus())) expect(parsesAsModule(module), key).toBe(true);
  });

  for (const v of ACTIVE_LOADERS) {
    it.skipIf(!loaderAvailable(v))(`parses after loader ${v}'s globalizeBareImports, with no import left`, () => {
      const { globalizeBareImports } = transformsOf(v);
      for (const [key, { module }] of Object.entries(corpus())) {
        const outText = globalizeBareImports(module);
        expect(parsesAsModule(outText), key).toBe(true);
        expect(/^[ \t]*import\b/m.test(outText), key).toBe(false);
        if (module.includes(THREE_IMPORT)) expect(outText, key).toContain('const THREE = globalThis.THREE;');
      }
    });
  }
});
