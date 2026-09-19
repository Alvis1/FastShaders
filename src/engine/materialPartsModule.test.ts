/**
 * The MODULE layer of glTF material-index parts (GLB Phase 5 Step 5):
 * buildShaderModule translates `materialParts` through the same per-part
 * translator as `parts`, and adds what the frozen loader 0.6 needs to stay safe
 * (materialPartsContract R1–R4): a `parts` object always (`{}` at minimum), the
 * MIRRORS — one name-keyed `parts` entry per GLTFLoader mesh of an emitted
 * index, its body byte-identical — and the `materialPartsMirror` list. Mirrors
 * exist only here, never in the editor TSL (R7); scriptToTSL strips them (R6).
 *
 * Then the real loaders run the emitted module: 0.8 (served copy) over a real
 * GLTFLoader parse with its glTF plugin, and the FROZEN 0.6 (submodule, skipped
 * on a non-recursive checkout) through its object-API test and name dispatch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three/webgpu';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { tslToShaderModule } from './tslToShaderModule';
import { buildShaderModule } from './tslCodeProcessor';
import { buildPreviewShaderModule, tslToPreviewHTML } from './tslToPreviewHTML';
import { scriptToTSL } from './scriptToTSL';
import { moduleStringLiteral, partEntryColon, partEntryKey, stripMirrorParts } from './partKeyLiteral';
import { checkLegacyGuard, MAX_MIRROR_ENTRIES, MAX_INDEX_MATERIALS } from './materialPartsContract';
import { makeNode, makeEdge } from '@/test-utils';
import { safeJsonReviver } from '@/utils/safeJson';
import type { AppNode, AppEdge } from '@/types';
import { materialPartsMirrorPlan, outputMaterials, type MaterialPartsMirrorEntry } from '@/utils/outputMaterials';
import { evalLoader, loaderAvailable, loaderText, type FastShadersApi } from '@/shaderloaderHarness';
import { GLTF_NODE_GLOBALS, gltfText, materials, parseWith, type GltfSpec } from '@/gltfTestFixtures';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SIG = ['Body', 'Glass', 'Trim'];
const MESH_NAMES = ['Hull', 'Hull2', 'Window', 'Named', 'Plain', 'Bare'];

/**
 * Materials Body/Glass/Trim: Hull and Hull2 wear 0, Window and Named 1, Plain
 * 2, Bare none — the shaderloaderMaterialParts fixture, GLTFLoader-named after
 * the NODES (mesh names differ, so the loader never renames a node).
 */
const SPEC: GltfSpec = {
  materials: materials(SIG),
  meshes: [
    { name: 'm-hull', primitives: [{ material: 0 }] },
    { name: 'm-window', primitives: [{ material: 1 }] },
    { name: 'm-trim', primitives: [{ material: 2 }] },
    { name: 'm-bare', primitives: [{}] },
  ],
  nodes: [
    { name: 'Hull', mesh: 0 },
    { name: 'Hull2', mesh: 0 },
    { name: 'Window', mesh: 1 },
    { name: 'Named', mesh: 1 },
    { name: 'Plain', mesh: 2 },
    { name: 'Bare', mesh: 3 },
  ],
};

/** An import-built Output: glTF materials 0 and 1 as index sections, plus a
 *  hand-added mesh section overriding `Named` (a name claim wins). */
function sectionGraph(): { nodes: AppNode[]; edges: AppEdge[]; out: AppNode } {
  const out = makeNode('out1', 'output');
  Object.assign(out.data as Record<string, unknown>, {
    materials: [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }, { meshTargets: ['Named'] }],
    modelSignature: { materials: SIG },
    modelMeshes: [
      { name: 'Hull', material: 0 },
      { name: 'Hull2', material: 0 },
      { name: 'Window', material: 1 },
      { name: 'Named', material: 1 },
      { name: 'Plain', material: 2 },
    ],
  });
  const nodes = [
    makeNode('c1', 'color', { hex: '#ff0000' }),
    makeNode('c2', 'color', { hex: '#00ff00' }),
    makeNode('c3', 'color', { hex: '#0000ff' }),
    out,
  ];
  const edges = [
    makeEdge('c1', 'out', 'out1', 'm1:color'),
    makeEdge('c2', 'out', 'out1', 'm2:color'),
    makeEdge('c3', 'out', 'out1', 'm3:color'),
  ];
  return { nodes, edges, out };
}

function sectionModule(): string {
  const { nodes, edges, out } = sectionGraph();
  return tslToShaderModule(graphToCode(nodes, edges).code, undefined, [], materialPartsMirrorPlan(out));
}

const returnOf = (mod: string) => mod.split('\n').find((l) => l.trimStart().startsWith('return {'))!;

/**
 * The module's default export, evaluated against the real three/tsl: its one
 * `three/tsl` import becomes a destructure of the namespace, its exports plain
 * bindings. The modules here bake no texture, so they carry no THREE import.
 */
function moduleDefault(text: string): (params?: unknown) => Record<string, Any> {
  expect(text).not.toMatch(/from 'three\/webgpu'/);
  const body = text
    .replace(/^import \{([^}]*)\} from 'three\/tsl';$/m, 'const {$1} = TSL;')
    .replace(/^export const /gm, 'const ')
    .replace(/^export default function/m, 'return function');
  return new Function('TSL', body)(THREE.TSL) as (params?: unknown) => Record<string, Any>;
}

/** Editor TSL around one return line. */
const tsl = (ret: string, decls = '  const c = color(0xff0000);') =>
  ["import { Fn, color, float } from 'three/tsl';", '', 'const shader = Fn(() => {', decls, `  return { ${ret} };`, '});', '', 'export default shader;'].join('\n');

describe('the module-text helpers (partKeyLiteral.ts)', () => {
  it('moduleStringLiteral escapes the block-comment and <script> breakouts, value intact', () => {
    const s = 'a*/b</script>';
    const lit = moduleStringLiteral(s);
    expect(lit).toBe('"a*\\u002Fb\\u003C/script>"');
    expect(JSON.parse(lit, safeJsonReviver)).toBe(s);
  });

  it('partEntryColon finds the colon AFTER a quoted key that contains one', () => {
    const entry = '"Char:Body": { colorNode: c }';
    expect(entry.slice(0, partEntryColon(entry))).toBe('"Char:Body"');
    expect(partEntryColon('"unclosed: {')).toBe(-1);
  });

  it('partEntryKey decodes a JSON string key or a bare identifier, and nothing else', () => {
    expect(partEntryKey('"a\\u003Cb": {}')).toBe('a<b');
    expect(partEntryKey('Glass: {}')).toBe('Glass');
    expect(partEntryKey("'Glass': {}")).toBeNull();
    expect(partEntryKey('[x]: {}')).toBeNull();
    expect(partEntryKey('"bad\\x41": {}')).toBeNull();
  });

  it('stripMirrorParts drops mirror entries, keeps anything it cannot decode, never mutates', () => {
    const entries = ['"Named": { colorNode: c }', '"Hull": { colorNode: c }', "'Hull': { colorNode: c }", 'Hull2: {}'];
    const out = stripMirrorParts(entries, new Set(['Hull', 'Hull2']));
    expect(out).toEqual(['"Named": { colorNode: c }', "'Hull': { colorNode: c }"]);
    expect(entries).toHaveLength(4);
    expect(stripMirrorParts(entries, new Set())).not.toBe(entries);
  });
});

describe('buildShaderModule — materialParts', () => {
  it('translates an index body like a part: CHANNEL_TO_PROP, a __partPixel for its discard, settings last', () => {
    const mod = buildShaderModule(tsl(
      'materialParts: { "0": { color: c, discard: f, side: 2 } }, modelSignature: { materials: ["A"] }',
      '  const c = color(0xff0000);\n  const f = float(0.5);',
    ));
    const ret = returnOf(mod);
    expect(ret).toContain('materialParts: { "0": { colorNode: __partPixel0(f, c), side: 2 } }');
    expect(mod).toContain('const __partPixel0 = Fn(([__c, __col]) => { Discard(__c); return __col; });');
    expect(mod).toMatch(/import \{[^}]*\bDiscard\b[^}]*\} from 'three\/tsl';/);
    // R1: no name part at all still leaves an (empty) parts object for 0.6.
    expect(ret).toContain('parts: {}, materialParts:');
  });

  it('property order: channels, parts, materialParts, modelSignature, materialPartsMirror, then settings', () => {
    const mod = buildShaderModule(
      tsl('color: c, materialParts: { "0": { color: c } }, modelSignature: { materials: ["A"] }'),
      { materialSettings: { transparent: true, mergeVertices: false }, materialPartsMirror: [{ name: 'Hull', index: 0 }] },
    );
    const ret = returnOf(mod);
    const at = (k: string) => ret.indexOf(k);
    const order = ['colorNode:', 'parts: {', 'materialParts:', 'modelSignature:', 'materialPartsMirror:', 'transparent: true', 'mergeVertices: false'].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('R2: a mirror body is byte-identical to its index entry; R4: listed, each name once', () => {
    const mod = sectionModule();
    const ret = returnOf(mod);
    const bodyOf = (key: string) => {
      const start = ret.indexOf(`${key}: { `);
      return ret.slice(start + key.length + 4, ret.indexOf(' }', start));
    };
    expect(bodyOf('"0"')).toBe('colorNode: color1');
    expect(bodyOf('"Hull"')).toBe(bodyOf('"0"'));
    expect(bodyOf('"Hull2"')).toBe(bodyOf('"0"'));
    expect(bodyOf('"Window"')).toBe(bodyOf('"1"'));
    expect(ret).toContain('materialPartsMirror: ["Hull", "Hull2", "Window"]');
    // The explicit name section keeps its own body; it is never mirrored.
    expect(bodyOf('"Named"')).toBe('colorNode: color3');
    expect(ret.match(/"Named":/g)).toHaveLength(1);
  });

  it('the module layer re-checks the plan: no name an explicit part holds, no unusable name, no duplicate, no index without a body', () => {
    const plan: MaterialPartsMirrorEntry[] = [
      { name: 'Named', index: 0 }, { name: '__proto__', index: 0 }, { name: '', index: 0 },
      { name: 'Dup', index: 0 }, { name: 'Dup', index: 0 }, { name: 'NoBody', index: 2 },
    ];
    const mod = buildShaderModule(
      tsl('parts: { "Named": { color: c } }, materialParts: { "0": { color: c }, "2": { transparent: true } }, modelSignature: { materials: ["A", "B", "C"] }'),
      { materialPartsMirror: plan },
    );
    expect(returnOf(mod)).toContain('materialPartsMirror: ["Dup"]');
    expect(returnOf(mod)).not.toContain('"2":'); // settings only: no channel, no entry
  });

  it(`caps the mirrors at ${MAX_MIRROR_ENTRIES}`, () => {
    const plan = Array.from({ length: 300 }, (_, i) => ({ name: `m${i}`, index: 0 }));
    const mod = buildShaderModule(tsl('materialParts: { "0": { color: c } }, modelSignature: { materials: ["A"] }'), { materialPartsMirror: plan });
    const list = returnOf(mod).match(/materialPartsMirror: \[([^\]]*)\]/)![1];
    expect(list.split(', ')).toHaveLength(MAX_MIRROR_ENTRIES);
  });

  it('R3: a signature that is not JSON (single quotes) drops the whole table — and no parts: {} appears', () => {
    const mod = buildShaderModule(tsl("materialParts: { \"0\": { color: c } }, modelSignature: { materials: ['A'] }"), {
      materialPartsMirror: [{ name: 'Hull', index: 0 }],
    });
    const ret = returnOf(mod);
    expect(ret).not.toContain('materialParts');
    expect(ret).not.toContain('modelSignature');
    expect(ret).not.toContain('parts:');
  });

  it('keys: canonical decimal inside the signature (quoted or bare digits), ascending, capped', () => {
    const mod = buildShaderModule(tsl(
      'materialParts: { "01": { color: c }, "5": { color: c }, x: { color: c }, 1: { color: c }, "0": { color: c } }, modelSignature: { materials: ["A", "B"] }',
    ));
    expect(returnOf(mod)).toContain('materialParts: { "0": { colorNode: c }, "1": { colorNode: c } }');
    const n = MAX_INDEX_MATERIALS + 4;
    const many = buildShaderModule(tsl(
      `materialParts: { ${Array.from({ length: n }, (_, i) => `"${i}": { color: c }`).join(', ')} }, modelSignature: { materials: [${Array.from({ length: n }, () => '""').join(', ')}] }`,
    ));
    expect(returnOf(many).match(/"\d+": \{ colorNode/g)).toHaveLength(MAX_INDEX_MATERIALS);
  });

  it('a signature name holding U+2028/U+2029 keeps the return ONE line: parseBody translates it, value intact', () => {
    const names = ['ls\u2028x', 'ps\u2029x'];
    const out = makeNode('out1', 'output');
    Object.assign(out.data as Record<string, unknown>, {
      materials: [{ gltfMaterialIndex: 0 }],
      modelSignature: { materials: names },
    });
    const nodes = [makeNode('c1', 'color', { hex: '#ff0000' }), out];
    const edges = [makeEdge('c1', 'out', 'out1', 'm1:color')];
    const mod = buildShaderModule(graphToCode(nodes, edges).code);
    expect(mod.match(/^\s*return\b/gm)).toHaveLength(1);
    const ret = returnOf(mod);
    expect(ret).toContain('parts: {}, materialParts: { "0": { colorNode: ');
    expect(ret).toContain('modelSignature: { materials: ["ls\\u2028x", "ps\\u2029x"] }');
    expect(mod).not.toMatch(/[\u2028\u2029]/);
    // The module evaluates to the same names, and reads back to them too.
    expect(moduleDefault(mod)().modelSignature.materials).toEqual(names);
    const back = codeToGraph(scriptToTSL(mod));
    const restored = back.nodes.find((n) => n.data.registryType === 'output')!;
    expect((restored.data as Record<string, unknown>).modelSignature).toEqual({ materials: names });
  });

  it('the signature is re-emitted through the ONE encoder', () => {
    const mod = buildShaderModule(tsl('materialParts: { "0": { color: c } }, modelSignature: { materials: ["x\\u003C/script>", "a*\\u002Fb"] }'));
    expect(returnOf(mod)).toContain('modelSignature: { materials: ["x\\u003C/script>", "a*\\u002Fb"] }');
    expect(mod).not.toContain('</script');
  });

  it('a module without materialParts ignores the mirror plan: byte-identical', () => {
    const out = makeNode('out1', 'output');
    (out.data as Record<string, unknown>).materials = [{ meshTargets: ['Glass'] }];
    const nodes = [makeNode('c1', 'color', { hex: '#ff0000' }), out];
    const edges = [makeEdge('c1', 'out', 'out1', 'm1:color')];
    const code = graphToCode(nodes, edges).code;
    expect(tslToShaderModule(code, undefined, [], [{ name: 'Hull', index: 0 }])).toBe(tslToShaderModule(code));
    expect(buildPreviewShaderModule(code, undefined, [{ name: 'Hull', index: 0 }])).toBe(buildPreviewShaderModule(code));
  });

  it('every emitted index module passes the export guard (and the dev throw sits behind DEV)', () => {
    const result = moduleDefault(sectionModule())();
    expect(checkLegacyGuard({
      hasMaterialParts: !!result.materialParts,
      hasParts: !!result.parts,
      hasSignature: !!result.modelSignature,
      partKeys: Object.keys(result.parts),
      mirrorKeys: result.materialPartsMirror,
    })).toEqual([]);
    const src = readFileSync(resolve(__dirname, 'tslCodeProcessor.ts'), 'utf8');
    expect(src).toContain('if (import.meta.env?.DEV) {');
    expect(src).toContain('const problems = checkLegacyGuard({');
  });

  it('the preview and the XR popup build the same mirrors', () => {
    const { nodes, edges, out } = sectionGraph();
    const code = graphToCode(nodes, edges).code;
    const plan = materialPartsMirrorPlan(out);
    expect(buildPreviewShaderModule(code, undefined, plan)).toContain('materialPartsMirror: ["Hull", "Hull2", "Window"]');
    const html = tslToPreviewHTML(code, { materialPartsMirror: plan, xr: true });
    expect(html).toMatch(/materialPartsMirror: \[\\?"Hull\\?", \\?"Hull2\\?", \\?"Window\\?"\]/);
  });
});

describe('scriptToTSL strips the mirrors (R6)', () => {
  it('a module read back carries no mirror; the table and signature stay; the parse re-creates the sections', () => {
    const back = scriptToTSL(sectionModule());
    expect(back).not.toContain('materialPartsMirror');
    expect(back).not.toMatch(/"Hull2?":|"Window":/);
    expect(back).toContain('materialParts: {');
    expect(back).toContain('modelSignature: { materials: ["Body", "Glass", "Trim"] }');
    const parsed = codeToGraph(back);
    const out = parsed.nodes.find((n) => n.data.registryType === 'output')!;
    const mats = outputMaterials(out).slice(1);
    expect(mats.map((m) => m.gltfMaterialIndex ?? m.meshTargets)).toEqual([0, 1, ['Named']]);
  });

  it('whitespace inside a signature name survives the return collapse (only CODE whitespace collapses)', () => {
    const names = ['a  b', 'a\u00a0b', 'a\ufeffb', 'c\t\td'];
    const out = makeNode('out1', 'output');
    Object.assign(out.data as Record<string, unknown>, {
      materials: [{ gltfMaterialIndex: 0 }],
      modelSignature: { materials: names },
    });
    const nodes = [makeNode('c1', 'color', { hex: '#ff0000' }), out];
    const edges = [makeEdge('c1', 'out', 'out1', 'm1:color')];
    // A multi-line return, so the collapse really runs over the object.
    const mod = tslToShaderModule(graphToCode(nodes, edges).code).replace(/, modelSignature:/, ',\n    modelSignature:');
    expect(mod).toMatch(/,\n {4}modelSignature:/);
    const back = scriptToTSL(mod);
    const restored = codeToGraph(back).nodes.find((n) => n.data.registryType === 'output')!;
    expect((restored.data as Record<string, unknown>).modelSignature).toEqual({ materials: names });
  });
});

describe.skipIf(!loaderAvailable('0.8'))('loader 0.8 runs the emitted module on a real GLTFLoader parse', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(GLTF_NODE_GLOBALS)) vi.stubGlobal(k, v);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function run(spec: GltfSpec) {
    const warns: string[] = [];
    const ev = evalLoader('0.8', {
      THREE,
      warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')),
      globals: { document: { querySelectorAll: () => [] } },
    });
    const FS = ev.FastShaders as FastShadersApi;
    const gltf = await parseWith([FS.gltfPlugin], gltfText(spec));
    const scene = gltf.scene;
    const authored = new Map(MESH_NAMES.map((n) => [n, (scene.getObjectByName(n) as Any).material]));
    const binding = FS.apply(scene, moduleDefault(sectionModule()));
    const m = (n: string) => (scene.getObjectByName(n) as Any).material;
    return { binding, m, authored, warns };
  }

  it('the index table applies per glTF material; the name section wins; mirrors are never name claims', async () => {
    const { binding, m, authored, warns } = await run(SPEC);
    expect(binding.materialParts).toEqual({ status: 'applied', applied: 2, dropped: 0, expected: 3, found: 3 });
    expect(m('Hull')).toBe(m('Hull2')); // ONE material for glTF material 0
    expect(m('Hull')).not.toBe(authored.get('Hull'));
    expect(m('Window')).not.toBe(m('Hull'));
    expect(m('Named')).not.toBe(m('Window')); // the name claim beats index 1
    expect(m('Plain')).toBe(authored.get('Plain')); // index 2 has no section, no default
    expect(m('Bare')).toBe(authored.get('Bare'));
    expect([...binding.parts.keys()]).toEqual(['Named']);
    expect(warns).toEqual([]);
  });

  it('a model whose material names differ: the table and the mirrors stay out, the name section applies', async () => {
    const { binding, m, authored } = await run({ ...SPEC, materials: materials(['Body', 'Glass', 'Trim2']) });
    expect(binding.materialParts.status).toBe('mismatch');
    for (const n of ['Hull', 'Hull2', 'Window', 'Plain']) expect(m(n), n).toBe(authored.get(n));
    expect(m('Named')).not.toBe(authored.get('Named'));
  });
});

describe.skipIf(!loaderAvailable('0.6'))('the FROZEN 0.6 runs the emitted module', () => {
  const NODE_PROPS = [
    'colorNode', 'positionNode', 'normalNode', 'opacityNode',
    'roughnessNode', 'metalnessNode', 'emissiveNode', 'envNode',
  ];

  it('takes the object API (R1), not the Simple-API branch that paints a model black', () => {
    const text = loaderText('0.6');
    const start = text.indexOf('const hasChannels = function');
    const decl = text.indexOf('const isObjectAPI = ', start);
    const block = text.slice(start, text.indexOf(';', decl) + 1);
    const isObjectAPI = new Function('nodeProps', 'shaderResult', `${block}\nreturn isObjectAPI;`) as (
      p: string[],
      r: unknown,
    ) => unknown;
    expect(!!isObjectAPI(NODE_PROPS, moduleDefault(sectionModule())())).toBe(true);
  });

  it('assigns the mirrors by NAME, so 0.6 paints the certain meshes of each index', () => {
    const result = moduleDefault(sectionModule())();
    const { def } = evalLoader('0.6', { href: 'https://example.test/x.html' });
    const ctx = Object.create(def as object) as Any;
    const meshes = ['Hull', 'Hull2', 'Window', 'Named', 'Plain'].map((name) => ({
      isMesh: true, name, uuid: name, material: { tag: `authored:${name}` },
    }));
    const root = { isMesh: false, traverse: (fn: (o: unknown) => void) => { fn(root); meshes.forEach(fn); } };
    ctx.originalMaterials = Object.fromEntries(meshes.map((x) => [x.uuid, x.material]));
    ctx._appliedMaterials = null;
    const parts = new Map(Object.keys(result.parts).map((k) => [k, { tag: `part:${k}` }]));
    ctx.applyMaterialToMesh(root, null, parts);
    expect(meshes.map((x) => x.material.tag)).toEqual([
      'part:Hull', 'part:Hull2', 'part:Window', 'part:Named', 'authored:Plain',
    ]);
  });
});
