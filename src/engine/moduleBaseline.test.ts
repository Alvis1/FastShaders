import { describe, it, expect, beforeAll } from 'vitest';
import { parse } from '@babel/parser';
import { graphToCode } from './graphToCode';
import { tslToShaderModule } from './tslToShaderModule';
import { collectShaderProperties, marchMaterialSettings } from './exportShader';
import { inlineImageAssetsFromNodes } from './imageAssets';
import { loadUnknownExpressionValidator } from './unknownExpression';
import { findDefaultOutput } from '@/utils/outputMaterials';
import { makeDataNodeData } from '@/utils/dataNode';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge, OutputNodeData } from '@/types';

/**
 * The shaderloader MODULE a download carries, pinned byte for byte.
 *
 * builtinByteStability, unwiredDefaults and the image-graph snapshot pin what
 * graphToCode emits — the code panel's text. None of them sees the step after
 * it: `tslToShaderModule` (→ `buildShaderModule`), which wraps that text into
 * the module a recipient's page actually loads, with its header, its schema,
 * its import line and its return object. That is the layer the loader-0.8
 * switch changes, so this snapshot was taken BEFORE it, on the unchanged code,
 * and re-taken ONCE by it (Phase 3 Step 5). That `-u` was reviewed against the
 * list below: it moved exactly the four kinds of line named there, and C3
 * appended no name to this corpus (raymarch already imported its `Fn`).
 *
 * Each case runs the export path minus the store (`buildShaderBundle`):
 * graphToCode → the image payloads inlined → tslToShaderModule with the
 * Raymarch-aware material settings and the property list, exactly as the
 * EXPORT button assembles them. The project block is NOT part of it — it
 * carries preview prefs read from localStorage, not module bytes.
 *
 * WHAT MAY CHANGE, AND WHEN (review every `-u` against this list):
 *   - Phase 3 Step 5 (the loader switch), and ONLY in these ways:
 *       · the header lines that name the loader file, and the plain-three
 *         block, rewritten once (integration §3.5);
 *       · `export const threeRevision = '184';` + a blank line, after the
 *         imports and before the schema (§2g);
 *       · `import * as THREE from 'three/webgpu';` in the modules that read
 *         `globalThis.THREE` (Image, Data, Colormap — C2, §2g), with those
 *         reads rewritten to `THREE`;
 *       · called three/tsl names missing from the import line, appended sorted
 *         (C3, §2g). Review any growth by name: raymarch already carries `Fn`
 *         (buildShaderModule appends it), and `unknown` must NEVER gain
 *         `mysteryFn` — it is not a three/tsl export.
 *   - Nothing else, ever. The shader body, the schema, the return object and
 *     the `parts` map are the loader contract; they do not move with the loader.
 */

const IMG = 'data:image/webp;base64,' + btoa('abc');

/** col0 = 0…4, a clean linear ramp; col1 crosses zero. */
function dataValues() {
  return makeDataNodeData(
    {
      columnNames: ['ramp', 'signed'],
      columns: [
        [0, 1, 2, 3, 4],
        [-2, -1, 0, 1, 4],
      ],
      rowCount: 5,
    },
    2,
  ).values;
}

/** The ONE Output node, with one added material shading `Glass`. */
function outputWithGlass(): AppNode {
  const node = makeNode('out', 'output');
  (node.data as Record<string, unknown>).materials = [{ meshTargets: ['Glass'] }];
  return node;
}

interface Graph { nodes: AppNode[]; edges: AppEdge[] }

function cases(): Record<string, Graph> {
  const out = () => makeNode('out', 'output');
  return {
    plain: {
      nodes: [makeNode('c1', 'color', { hex: '#2d6cdf' }), out()],
      edges: [makeEdge('c1', 'out', 'out', 'color')],
    },
    'float-property': {
      nodes: [makeNode('p1', 'property_float', { name: 'speed', value: 0.5 }), out()],
      edges: [makeEdge('p1', 'out', 'out', 'color')],
    },
    'color-property': {
      nodes: [makeNode('p1', 'property_color', { name: 'tint', hex: '#3366ff' }), out()],
      edges: [makeEdge('p1', 'out', 'out', 'color')],
    },
    image: {
      nodes: [
        makeNode('i1', 'imageNode', { imageB64: IMG, width: 2, height: 2, fileName: 'x.webp', colorSpace: 'color' }),
        out(),
      ],
      edges: [makeEdge('i1', 'out', 'out', 'color')],
    },
    data: {
      nodes: [makeNode('d1', 'dataNode', dataValues()), makeNode('n1', 'dataRange', { mode: 'minmax' }), out()],
      edges: [makeEdge('d1', 'col0', 'n1', 'value'), makeEdge('n1', 'out', 'out', 'color')],
    },
    colormap: {
      nodes: [makeNode('f1', 'float', { value: 0.3 }), makeNode('c1', 'colormap', { map: 'viridis' }), out()],
      edges: [makeEdge('f1', 'out', 'c1', 'value'), makeEdge('c1', 'out', 'out', 'color')],
    },
    unknown: {
      nodes: [makeNode('u', 'unknown', { functionName: 'mysteryFn', rawExpression: 'mysteryFn(1, 2, 3)' }), out()],
      edges: [makeEdge('u', 'out', 'out', 'color')],
    },
    raymarch: {
      nodes: [
        makeNode('pos', 'positionLocal'),
        makeNode('sd', 'sdCircle'),
        makeNode('col', 'color', { hex: '#2d6cdf' }),
        makeNode('rm', 'raymarchOutput'),
      ],
      edges: [
        makeEdge('pos', 'out', 'sd', 'p'),
        makeEdge('sd', 'out', 'rm', 'field'),
        makeEdge('col', 'out', 'rm', 'color'),
      ],
    },
    parts: {
      nodes: [
        makeNode('c1', 'color', { hex: '#22cc22' }),
        makeNode('c2', 'color', { hex: '#cc2222' }),
        outputWithGlass(),
      ],
      edges: [makeEdge('c1', 'out', 'out', 'color'), makeEdge('c2', 'out', 'out', 'm1:color')],
    },
    discard: {
      nodes: [makeNode('c1', 'color', { hex: '#2d6cdf' }), makeNode('f1', 'float', { value: 0.5 }), out()],
      edges: [makeEdge('c1', 'out', 'out', 'color'), makeEdge('f1', 'out', 'out', 'discard')],
    },
  };
}

/** `buildShaderBundle`'s module step, fed a graph instead of the store. */
function exportModule({ nodes, edges }: Graph): string {
  const output = findDefaultOutput(nodes);
  return tslToShaderModule(
    inlineImageAssetsFromNodes(graphToCode(nodes, edges).code, nodes),
    marchMaterialSettings(nodes, edges, (output?.data as OutputNodeData | undefined)?.materialSettings),
    collectShaderProperties(nodes),
  );
}

function emitAll(): Record<string, string> {
  const outMap: Record<string, string> = {};
  for (const [key, g] of Object.entries(cases())) outMap[key] = exportModule(g);
  return outMap;
}

describe('the exported shaderloader module is byte-stable', () => {
  // The unknown node's validator is loaded lazily and FAILS CLOSED while cold
  // (`float(0)` in place of the raw expression). Whether it is warm would
  // otherwise depend on which suite this worker ran first (isolate: false), so
  // the snapshot would pin one of two outputs at random. Warm it — that is the
  // state every real export runs in, since the app re-runs codegen the moment
  // the validator lands.
  beforeAll(() => loadUnknownExpressionValidator());

  it('module corpus', () => {
    expect(emitAll()).toMatchSnapshot();
  });

  it('covers every case, so one cannot be dropped with a `-u`', () => {
    expect(Object.keys(cases())).toEqual([
      'plain',
      'float-property',
      'color-property',
      'image',
      'data',
      'colormap',
      'unknown',
      'raymarch',
      'parts',
      'discard',
    ]);
  });

  it('every case really exercises what its key names', () => {
    // A snapshot pins whatever came out, including a fixture that silently
    // stopped wiring what it claims to. These are the facts each key exists for,
    // chosen to hold on BOTH sides of the loader switch.
    const m = emitAll();
    for (const [key, text] of Object.entries(m)) {
      expect(() => parse(text, { sourceType: 'module' }), key).not.toThrow();
      expect(text, key).toContain('export default');
    }
    expect(m['float-property']).toMatch(/speed:\s*\{\s*type:\s*'number'/);
    expect(m['color-property']).toMatch(/tint:\s*\{\s*type:\s*'color'/);
    expect(m.image).toContain(IMG);
    expect(m.image).not.toContain('fs-asset:');
    expect(m.data).toContain('data1_col0');
    expect(m.colormap).toContain('colormap1');
    // Warm validator: the raw expression, not the fail-closed `float(0)`.
    expect(m.unknown).toContain('const mysteryFn1 = mysteryFn(1, 2, 3);');
    expect(m.raymarch).toContain('rm1Field');
    expect(m.raymarch).toMatch(/\bside: 2\b/); // THREE.DoubleSide, forced by marchMaterialSettings
    expect(m.parts).toMatch(/parts:\s*\{/);
    expect(m.parts).toContain('"Glass"');
    expect(m.discard).toContain('Discard(');
    // The loader file every module names — the one thing Step 5 moves in all ten.
    for (const [key, text] of Object.entries(m)) expect(text, key).toContain('a-frame-shaderloader-0.');
  });
});
