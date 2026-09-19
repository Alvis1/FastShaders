/**
 * `materialParts` + `modelSignature` in the EDITOR TSL (GLB Phase 5 Step 5):
 * graphToCode emits them on the ONE return line, codeToGraph parses them back,
 * and the two land together — emission alone is byte-stable and `errors: []`
 * while an Apply silently deletes every index section (CLAUDE.md per-mesh
 * rule 3), so this suite asserts the sections SURVIVE Applies.
 *
 * A graph without index sections is byte-identical to before; the
 * byte-stability, unwired-defaults, outputParts* and moduleBaseline suites pin
 * that without `-u`. The mirrors never appear here (R7) — see
 * materialPartsModule.test.ts for the module layer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge, OutputMaterial } from '@/types';
import { MAX_INDEX_MATERIALS, outputMaterials } from '@/utils/outputMaterials';
import { previewGraph } from '@/utils/nodePreview';

const SIG = ['Body', 'Glass', 'Trim'];

function indexOutput(materials: unknown[], extra: Record<string, unknown> = {}): AppNode {
  const node = makeNode('out1', 'output');
  const d = node.data as Record<string, unknown>;
  d.materials = materials;
  d.modelSignature = { materials: SIG };
  Object.assign(d, extra);
  return node;
}

const returnLine = (code: string) => code.split('\n').find((l) => l.trimStart().startsWith('return '))!;
const outOf = (nodes: AppNode[]) => nodes.find((n) => n.data.registryType === 'output')!;
const dataOf = (n: AppNode) => n.data as Record<string, unknown>;

/** Apply the emitted code and emit again, twice — the graph must not grow. */
function applyTwice(nodes: AppNode[], edges: AppEdge[]) {
  const first = graphToCode(nodes, edges).code;
  const a = codeToGraph(first);
  const second = graphToCode(a.nodes, a.edges).code;
  const b = codeToGraph(second);
  const third = graphToCode(b.nodes, b.edges).code;
  return { first, second, third, a, b };
}

describe('emission', () => {
  it('an unwired index section still emits its entry, beside the signature, on ONE line', () => {
    const { code } = graphToCode([indexOutput([{ gltfMaterialIndex: 0 }])], []);
    expect(returnLine(code)).toBe(
      '  return { materialParts: { "0": {  } }, modelSignature: { materials: ["Body", "Glass", "Trim"] } };',
    );
    // An object return: never the red "nothing wired" sentinel.
    expect(code).not.toContain('vec3(1, 0, 0)');
    expect(code).not.toContain('parts: {');
  });

  it('channels, then parts, then materialParts (ascending), then modelSignature', () => {
    const nodes = [
      makeNode('c1', 'color', { hex: '#ff0000' }),
      makeNode('c2', 'color', { hex: '#00ff00' }),
      makeNode('c3', 'color', { hex: '#0000ff' }),
      makeNode('c4', 'color', { hex: '#ffffff' }),
      indexOutput([{ gltfMaterialIndex: 2 }, { gltfMaterialIndex: 0 }, { meshTargets: ['Named'] }]),
    ];
    const edges = [
      makeEdge('c4', 'out', 'out1', 'color'),
      makeEdge('c1', 'out', 'out1', 'm1:color'),
      makeEdge('c2', 'out', 'out1', 'm2:color'),
      makeEdge('c3', 'out', 'out1', 'm3:color'),
    ];
    const line = returnLine(graphToCode(nodes, edges).code);
    expect(line).toBe(
      '  return { color: color4, parts: { "Named": { color: color3 } }, materialParts: { "0": { color: color2 }, "2": { color: color1 } }, modelSignature: { materials: ["Body", "Glass", "Trim"] } };',
    );
  });

  it('a section carries its discard key and its settings in the loader spelling', () => {
    const nodes = [
      makeNode('c1', 'color', { hex: '#ff0000' }),
      makeNode('f1', 'float', { value: 0.5 }),
      indexOutput([{ gltfMaterialIndex: 1, materialSettings: { transparent: true, side: 'double' } }]),
    ];
    const edges = [makeEdge('c1', 'out', 'out1', 'm1:color'), makeEdge('f1', 'out', 'out1', 'm1:discard')];
    const line = returnLine(graphToCode(nodes, edges).code);
    expect(line).toContain('"1": { color: color1, discard: float1, transparent: true, side: 2 }');
  });

  it('two sections on one glTF index: the first claim wins', () => {
    const nodes = [
      makeNode('c1', 'color', { hex: '#ff0000' }),
      makeNode('c2', 'color', { hex: '#00ff00' }),
      indexOutput([{ gltfMaterialIndex: 2 }, { gltfMaterialIndex: 2 }]),
    ];
    const edges = [makeEdge('c1', 'out', 'out1', 'm1:color'), makeEdge('c2', 'out', 'out1', 'm2:color')];
    const line = returnLine(graphToCode(nodes, edges).code);
    expect(line).toContain('materialParts: { "2": { color: color1 } }');
    expect(line).not.toContain('color2');
  });

  it('an index past the signature, or no signature at all, emits no materialParts', () => {
    const empty = graphToCode([indexOutput([{ meshTargets: [] }])], []).code;
    const past = graphToCode([indexOutput([{ gltfMaterialIndex: 3 }])], []).code;
    const noSig = graphToCode([indexOutput([{ gltfMaterialIndex: 0 }], { modelSignature: undefined })], []).code;
    const badSig = graphToCode([indexOutput([{ gltfMaterialIndex: 0 }], { modelSignature: { materials: [1] } })], []).code;
    for (const code of [past, noSig, badSig]) {
      expect(code).not.toContain('materialParts');
      expect(code).not.toContain('modelSignature');
      expect(code).toBe(empty);
    }
  });

  it('a signature beside no index section changes nothing (byte-identical)', () => {
    const plain = makeNode('out1', 'output');
    const withSig = makeNode('out1', 'output');
    (withSig.data as Record<string, unknown>).modelSignature = { materials: SIG };
    (withSig.data as Record<string, unknown>).modelMeshes = [{ name: 'Hull', material: 0 }];
    const c = makeNode('c1', 'color', { hex: '#123456' });
    const e = [makeEdge('c1', 'out', 'out1', 'color')];
    expect(graphToCode([c, withSig], e).code).toBe(graphToCode([c, plain], e).code);
  });

  it('signature names are escaped where they must be, and survive the one-line return intact', () => {
    const names = ['x</script><svg onload=alert(1)>', 'a*/b', 'Gl"a}s,s: {', 'Ķermenis', '', 'ls\u2028x', 'ps\u2029x'];
    const node = indexOutput([{ gltfMaterialIndex: 0 }], { modelSignature: { materials: names } });
    const { code } = graphToCode([node], []);
    expect(code).not.toContain('</script');
    expect(code).not.toContain('a*/b');
    expect(code).toContain('x\\u003C/script>');
    expect(code).toContain('a*\\u002Fb');
    // JS line terminators JSON.stringify leaves raw: escaped, so the return
    // stays ONE line for the line-based module parse.
    expect(code).not.toMatch(/[\u2028\u2029]/);
    expect(code).toContain('"ls\\u2028x", "ps\\u2029x"');
    const parsed = codeToGraph(code);
    expect(parsed.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    expect(dataOf(outOf(parsed.nodes)).modelSignature).toEqual({ materials: names });
    expect(graphToCode(parsed.nodes, parsed.edges).code).toBe(code);
  });

  it('modelMeshes never reach the editor TSL (R7)', () => {
    const node = indexOutput([{ gltfMaterialIndex: 0 }], { modelMeshes: [{ name: 'HullMirror', material: 0 }] });
    const { code } = graphToCode([node], []);
    expect(code).not.toContain('HullMirror');
    expect(code).not.toContain('materialPartsMirror');
  });
});

describe('the parse (codeToGraph)', () => {
  it('re-creates index sections FIRST, then named ones, and re-emits byte-identically, twice', () => {
    const nodes = [
      makeNode('c1', 'color', { hex: '#ff0000' }),
      makeNode('c2', 'color', { hex: '#00ff00' }),
      makeNode('c3', 'color', { hex: '#0000ff' }),
      indexOutput([
        { gltfMaterialIndex: 0, materialSettings: { transparent: true } },
        { gltfMaterialIndex: 2 },
        { meshTargets: ['Named'] },
      ]),
    ];
    const edges = [
      makeEdge('c1', 'out', 'out1', 'm1:color'),
      makeEdge('c2', 'out', 'out1', 'm2:color'),
      makeEdge('c3', 'out', 'out1', 'm3:color'),
    ];
    const r = applyTwice(nodes, edges);
    expect(r.a.errors).toEqual([]);
    expect(r.second).toBe(r.first);
    expect(r.third).toBe(r.first);
    expect(r.b.nodes).toHaveLength(r.a.nodes.length);
    const out = outOf(r.a.nodes);
    const mats = outputMaterials(out).slice(1);
    expect(mats).toEqual([
      { gltfMaterialIndex: 0, materialSettings: { transparent: true } },
      { gltfMaterialIndex: 2 },
      { meshTargets: ['Named'] },
    ]);
    expect(dataOf(out).modelSignature).toEqual({ materials: SIG });
    // Channels are wired through the section's POSITIONAL handles.
    const handles = r.a.edges.filter((e) => e.target === out.id).map((e) => e.targetHandle).sort();
    expect(handles).toEqual(['m1:color', 'm2:color', 'm3:color']);
  });

  it('a named section authored BEFORE an index one is normalized to the canonical order by an Apply', () => {
    const nodes = [
      makeNode('c1', 'color', { hex: '#ff0000' }),
      makeNode('c2', 'color', { hex: '#00ff00' }),
      indexOutput([{ meshTargets: ['Named'] }, { gltfMaterialIndex: 1 }]),
    ];
    const edges = [makeEdge('c1', 'out', 'out1', 'm1:color'), makeEdge('c2', 'out', 'out1', 'm2:color')];
    const r = applyTwice(nodes, edges);
    expect(r.second).toBe(r.first);
    const out = outOf(r.a.nodes);
    expect(outputMaterials(out).slice(1)).toEqual([{ gltfMaterialIndex: 1 }, { meshTargets: ['Named'] }]);
    // The wiring followed its section: the Named colour is now m2.
    const c1 = r.a.nodes.find((n) => (n.data as { values?: { hex?: string } }).values?.hex === '#ff0000')!;
    expect(r.a.edges.find((e) => e.source === c1.id)!.targetHandle).toBe('m2:color');
  });

  it('bare numeric keys parse; identical bodies are NOT merged', () => {
    const code = [
      "import { Fn, color } from 'three/tsl';",
      '',
      'const shader = Fn(() => {',
      '  const c = color(0xff0000);',
      '  return { materialParts: { 0: { color: c }, "1": { color: c } }, modelSignature: { materials: ["A", "B"] } };',
      '});',
      '',
      'export default shader;',
    ].join('\n');
    const r = codeToGraph(code);
    expect(r.errors).toEqual([]);
    expect(outputMaterials(outOf(r.nodes)).slice(1)).toEqual([{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }]);
  });

  it('refuses a key that is not a canonical in-range index, with a warning each', () => {
    const code = [
      "import { Fn, color } from 'three/tsl';",
      'const shader = Fn(() => {',
      '  const c = color(0xff0000);',
      '  return { materialParts: { "01": { color: c }, "-1": { color: c }, 1.0: { color: c }, "__proto__": { color: c }, "7": { color: c }, x: { color: c }, "0": { color: c } }, modelSignature: { materials: ["A", "B"] } };',
      '});',
      'export default shader;',
    ].join('\n');
    const r = codeToGraph(code);
    const warned = r.errors.filter((e) => /is not a material of this model/.test(e.message));
    expect(warned).toHaveLength(6);
    expect(r.errors.every((e) => e.severity === 'warning')).toBe(true);
    expect(outputMaterials(outOf(r.nodes)).slice(1)).toEqual([{ gltfMaterialIndex: 0 }]);
  });

  it('drops the whole table, with a warning, without a valid signature', () => {
    for (const sig of ['', ', modelSignature: { materials: ["A", 3] }', ", modelSignature: { materials: ['A'] }".replace("'A'", 'A'), ', modelSignature: 5']) {
      const code = [
        "import { Fn, color } from 'three/tsl';",
        'const shader = Fn(() => {',
        '  const c = color(0xff0000);',
        `  return { materialParts: { "0": { color: c } }${sig} };`,
        '});',
        'export default shader;',
      ].join('\n');
      const r = codeToGraph(code);
      expect(r.errors.some((e) => /no valid modelSignature/.test(e.message)), sig).toBe(true);
      const out = outOf(r.nodes);
      expect(dataOf(out).materials, sig).toBeUndefined();
      expect(dataOf(out).modelSignature, sig).toBeUndefined();
    }
  });

  it('warns on a table that is not an object, and on a body that is not one', () => {
    const r1 = codeToGraph([
      "import { Fn } from 'three/tsl';",
      'const shader = Fn(() => {',
      '  return { materialParts: 5, modelSignature: { materials: ["A"] } };',
      '});',
      'export default shader;',
    ].join('\n'));
    expect(r1.errors.some((e) => /materialParts is not an object/.test(e.message))).toBe(true);
    const r2 = codeToGraph([
      "import { Fn } from 'three/tsl';",
      'const shader = Fn(() => {',
      '  return { materialParts: { "0": 5 }, modelSignature: { materials: ["A"] } };',
      '});',
      'export default shader;',
    ].join('\n'));
    expect(r2.errors.some((e) => /is not a channel object/.test(e.message))).toBe(true);
  });

  it(`more than ${MAX_INDEX_MATERIALS} entries: the rest are dropped with a warning`, () => {
    const n = MAX_INDEX_MATERIALS + 3;
    const entries = Array.from({ length: n }, (_, i) => `"${i}": {  }`).join(', ');
    const names = Array.from({ length: n }, (_, i) => `"m${i}"`).join(', ');
    const r = codeToGraph([
      "import { Fn } from 'three/tsl';",
      'const shader = Fn(() => {',
      `  return { materialParts: { ${entries} }, modelSignature: { materials: [${names}] } };`,
      '});',
      'export default shader;',
    ].join('\n'));
    expect(r.errors.some((e) => new RegExp(`More than ${MAX_INDEX_MATERIALS} material parts`).test(e.message))).toBe(true);
    expect(outputMaterials(outOf(r.nodes)).slice(1)).toHaveLength(MAX_INDEX_MATERIALS);
  });

  it('the index cap does not eat the named one: 16 index + 9 named sections all survive', () => {
    const entries = Array.from({ length: 16 }, (_, i) => `"${i}": {  }`).join(', ');
    const names = Array.from({ length: 16 }, (_, i) => `"m${i}"`).join(', ');
    const parts = Array.from({ length: 9 }, (_, i) => `"n${i}": {  }`).join(', ');
    const r = codeToGraph([
      "import { Fn } from 'three/tsl';",
      'const shader = Fn(() => {',
      `  return { parts: { ${parts} }, materialParts: { ${entries} }, modelSignature: { materials: [${names}] } };`,
      '});',
      'export default shader;',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(outputMaterials(outOf(r.nodes)).slice(1)).toHaveLength(25);
  });

  it('never turns a materialPartsMirror name into a name section (R6), and wires none of the companions', () => {
    const code = [
      "import { Fn, color } from 'three/tsl';",
      'const shader = Fn(() => {',
      '  const c = color(0xff0000);',
      '  const d = color(0x00ff00);',
      '  return { parts: { "Named": { color: d }, "Hull": { color: c } }, materialParts: { "0": { color: c } }, modelSignature: { materials: ["A"] }, materialPartsMirror: ["Hull"] };',
      '});',
      'export default shader;',
    ].join('\n');
    const r = codeToGraph(code);
    expect(r.errors).toEqual([]);
    const out = outOf(r.nodes);
    expect(outputMaterials(out).slice(1)).toEqual([{ gltfMaterialIndex: 0 }, { meshTargets: ['Named'] }]);
    const handles = r.edges.filter((e) => e.target === out.id).map((e) => e.targetHandle);
    for (const h of handles) expect(h).toMatch(/^m[12]:color$/);
  });
});

describe('the other surfaces', () => {
  it('preview mode drops index sections and the signature (it shows one socket on the whole model)', () => {
    const src = makeNode('c1', 'color', { hex: '#ff0000' });
    const out = indexOutput([{ gltfMaterialIndex: 0 }], { modelMeshes: [{ name: 'Hull', material: 0 }] });
    const g = previewGraph([src, out], [], { nodeId: 'c1', handleId: 'out' });
    const clean = outOf(g.nodes);
    expect(dataOf(clean).materials).toBeUndefined();
    expect(dataOf(clean).modelSignature).toBeUndefined();
    expect(dataOf(clean).modelMeshes).toBeUndefined();
    expect(graphToCode(g.nodes, g.edges).code).not.toContain('materialParts');
  });

  it('the resync carries the mirror source (useSyncEngine → carryModelMeshes)', () => {
    const src = readFileSync(resolve(__dirname, '../hooks/useSyncEngine.ts'), 'utf8');
    expect(src).toContain("if (merged.data.registryType === 'output') carryModelMeshes(merged, match);");
  });

  it('graphToCode reads index sections only through planIndexParts', () => {
    const src = readFileSync(resolve(__dirname, 'graphToCode.ts'), 'utf8');
    expect(src).toContain('planIndexParts(materials, signature).entries');
    expect(src).toContain('const partKeyLiteral = moduleStringLiteral;');
  });

  it('an index-section materials list round-trips through the store shape unchanged', () => {
    const mats: OutputMaterial[] = [{ gltfMaterialIndex: 0 }];
    const out = indexOutput(mats);
    expect(outputMaterials(out)[1]).toBe(mats[0]);
  });
});
