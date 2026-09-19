/**
 * Import-built INDEX sections, the pure half (GLB Phase 5 Step 5): the section
 * data model in utils/outputMaterials.ts — `isIndexSection`, the index planner
 * emission and the node share, the counts that keep the two caps apart, the
 * label, the loader-0.6 mirror plan, and the sanitizer's index / signature /
 * `modelMeshes` rules every restore path runs.
 *
 * Every value below is adversarial: node data arrives from a `.fastshader`,
 * localStorage, a saved group, or a parse of text someone else wrote.
 */
import { describe, it, expect } from 'vitest';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, OutputMaterial } from '@/types';
import {
  isIndexSection,
  gltfIndexOf,
  materialTargetNames,
  sanitizeOutputMaterialsReport,
  sanitizeOutputMaterials,
  planIndexParts,
  planNamedParts,
  countSections,
  sectionLabel,
  displayMaterialName,
  readModelSignature,
  sanitizeModelMeshes,
  materialPartsMirrorPlan,
  mirrorPlanKey,
  carryModelMeshes,
  assignMeshTargets,
  foldExtraOutputs,
  outputMaterials,
  dormantMaterialIndices,
  dormantIndicesForPreview,
  loadedModelOf,
  shownPreviewMesh,
  outputDormancyFromState,
  anyOutputDormant,
  indexSectionsAwake,
  indexSectionCoverage,
  defaultSectionUnused,
  pickFreeMesh,
  type IndexCoverage,
  MAX_INDEX_MATERIALS,
  MAX_PARTS,
  MAX_MIRROR_ENTRIES,
  MAX_MODEL_MESHES,
  GLTF_MATERIAL_INDEX_MAX,
} from './outputMaterials';
import {
  LOADER_MATERIAL_PARTS_MAX,
  MATERIAL_PART_KEY_RE,
  SIGNATURE_MATERIALS_MAX,
} from '@/engine/materialPartsContract';
import { formatSectionLabel, indexChipTitle, joinCapped } from '@/components/NodeEditor/nodes/sectionLabelText';
import { computeReachableCost } from './nodeCost';

const SIG = ['Body', 'Glass', 'Trim'];

/** An Output carrying `materials` (the ADDED ones) plus any node-level fields. */
function output(id: string, materials: unknown, extra: Record<string, unknown> = {}): AppNode {
  const node = makeNode(id, 'output');
  const d = node.data as Record<string, unknown>;
  if (materials !== undefined) d.materials = materials;
  Object.assign(d, extra);
  return node;
}

const dataOf = (n: AppNode) => n.data as Record<string, unknown>;
const matsOf = (n: AppNode) => dataOf(n).materials as OutputMaterial[] | undefined;

describe('isIndexSection / gltfIndexOf', () => {
  it('a number, an integer, 0..9999 — never coerced', () => {
    for (const v of [0, 3, GLTF_MATERIAL_INDEX_MAX]) expect(isIndexSection({ gltfMaterialIndex: v })).toBe(true);
    for (const v of ['1', 1.5, -1, Number.NaN, Infinity, GLTF_MATERIAL_INDEX_MAX + 1, null, true, [], {}]) {
      expect(isIndexSection({ gltfMaterialIndex: v } as unknown as OutputMaterial), String(v)).toBe(false);
    }
    expect(isIndexSection(undefined)).toBe(false);
    expect(isIndexSection({})).toBe(false);
    expect(gltfIndexOf({ gltfMaterialIndex: 7 })).toBe(7);
    expect(gltfIndexOf({ gltfMaterialIndex: '7' } as unknown as OutputMaterial)).toBeNull();
  });

  it('its range is exactly the module key range (MATERIAL_PART_KEY_RE)', () => {
    expect(MATERIAL_PART_KEY_RE.test(String(GLTF_MATERIAL_INDEX_MAX))).toBe(true);
    expect(MATERIAL_PART_KEY_RE.test(String(GLTF_MATERIAL_INDEX_MAX + 1))).toBe(false);
  });

  it('an index section is nameless: materialTargetNames returns [] even when it carries names', () => {
    expect(materialTargetNames({ gltfMaterialIndex: 1, meshTargets: ['Body'] })).toEqual([]);
    expect(planNamedParts([{}, { gltfMaterialIndex: 1, meshTargets: ['Body'] }]).entries).toEqual([]);
  });

  it('the caps stay apart, and the index cap sits within the loader bound', () => {
    expect(MAX_INDEX_MATERIALS).toBe(16);
    expect(MAX_INDEX_MATERIALS).toBeLessThanOrEqual(LOADER_MATERIAL_PARTS_MAX);
    expect(MAX_MIRROR_ENTRIES).toBeLessThanOrEqual(LOADER_MATERIAL_PARTS_MAX);
    expect(MAX_PARTS).toBe(9);
    expect(MAX_MODEL_MESHES).toBe(256);
  });
});

describe('readModelSignature', () => {
  it('reads through the ONE sanitizer', () => {
    expect(readModelSignature({ modelSignature: { materials: SIG } })).toEqual(SIG);
    expect(readModelSignature({ modelSignature: { materials: ['Body ', ''] } })).toEqual(['Body ', '']);
    for (const bad of [undefined, 5, 'x', [], { materials: 'x' }, { materials: [1] }, { materials: [] }]) {
      expect(readModelSignature({ modelSignature: bad }), JSON.stringify(bad)).toBeNull();
    }
    expect(readModelSignature(null)).toBeNull();
    expect(readModelSignature(5)).toBeNull();
    expect(readModelSignature({ modelSignature: { materials: new Array(SIGNATURE_MATERIALS_MAX + 1).fill('') } })).toBeNull();
  });
});

describe('sanitizeOutputMaterialsReport — index sections', () => {
  const clean = () => output('o', [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 2, values: { color: '#ff0000' } }], {
    modelSignature: { materials: SIG },
    modelMeshes: [{ name: 'Hull', material: 0 }, { name: 'Plain', material: 2 }],
  });

  it('a clean graph is returned as the SAME array, trimmed 0', () => {
    const nodes = [clean()];
    const r = sanitizeOutputMaterialsReport(nodes);
    expect(r.nodes).toBe(nodes);
    expect(r.trimmed).toBe(0);
  });

  it('an index section carrying names loses them (a section is ONE kind), trimmed 1', () => {
    const node = output('o', [{ gltfMaterialIndex: 1, meshTargets: ['Body'], meshTarget: { name: 'X' } }], {
      modelSignature: { materials: SIG },
    });
    const r = sanitizeOutputMaterialsReport([node]);
    expect(r.trimmed).toBe(1);
    expect(matsOf(r.nodes[0])).toEqual([{ gltfMaterialIndex: 1 }]);
  });

  it('an index past the signature DETACHES the section (wiring kept), trimmed 1', () => {
    const node = output('o', [{ gltfMaterialIndex: 3, values: { color: '#00ff00' }, exposedPorts: ['color'] }], {
      modelSignature: { materials: SIG },
    });
    const r = sanitizeOutputMaterialsReport([node]);
    expect(r.trimmed).toBe(1);
    expect(matsOf(r.nodes[0])).toEqual([{ meshTargets: [], values: { color: '#00ff00' }, exposedPorts: ['color'] }]);
    // No index section survives, so the signature goes too.
    expect(dataOf(r.nodes[0]).modelSignature).toBeUndefined();
  });

  it('an invalid signature detaches EVERY index section and is removed, with its mirror source', () => {
    for (const bad of [5, 'x', [1], { materials: 'x' }, { materials: [] }, { materials: ['a', 2] }, { materials: ['x'.repeat(70_000)] }]) {
      const node = output('o', [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }], {
        modelSignature: bad,
        modelMeshes: [{ name: 'Hull', material: 0 }],
      });
      const r = sanitizeOutputMaterialsReport([node]);
      expect(r.trimmed, JSON.stringify(bad).slice(0, 40)).toBe(2);
      expect(matsOf(r.nodes[0])).toEqual([{ meshTargets: [] }, { meshTargets: [] }]);
      expect(dataOf(r.nodes[0]).modelSignature).toBeUndefined();
      expect(dataOf(r.nodes[0]).modelMeshes).toBeUndefined();
    }
  });

  it('a signature with no index section is stripped, and that is not counted', () => {
    const node = output('o', [{ meshTargets: ['Glass'] }], {
      modelSignature: { materials: SIG },
      modelMeshes: [{ name: 'Hull', material: 0 }],
    });
    const r = sanitizeOutputMaterialsReport([node]);
    expect(r.trimmed).toBe(0);
    expect(dataOf(r.nodes[0]).modelSignature).toBeUndefined();
    expect(dataOf(r.nodes[0]).modelMeshes).toBeUndefined();
    // …and the same when the node carries no `materials` at all.
    const bare = output('o2', undefined, { modelSignature: { materials: SIG }, gltfMaterialIndex: 0 });
    const r2 = sanitizeOutputMaterialsReport([bare]);
    expect(r2.trimmed).toBe(0);
    expect(Object.keys(dataOf(r2.nodes[0]))).not.toContain('modelSignature');
    expect(Object.keys(dataOf(r2.nodes[0]))).not.toContain('gltfMaterialIndex');
  });

  it('the two caps are counted separately: 40 index + 12 named → 16 index + 9 named kept', () => {
    const named = Array.from({ length: 12 }, (_, i) => ({ meshTargets: [`n${i}`] }));
    const indexed = Array.from({ length: 40 }, (_, i) => ({ gltfMaterialIndex: i }));
    const node = output('o', [...indexed, ...named], {
      modelSignature: { materials: Array.from({ length: 40 }, (_, i) => `m${i}`) },
    });
    const r = sanitizeOutputMaterialsReport([node]);
    expect(r.trimmed).toBe(24 + 3);
    const kept = matsOf(r.nodes[0])!;
    expect(countSections([{}, ...kept])).toEqual({ named: MAX_PARTS, index: MAX_INDEX_MATERIALS });
    // Order preserved: the first 16 indices, then the first 9 names.
    expect(kept.slice(0, 16).map(gltfIndexOf)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(kept.slice(16).map((m) => m.meshTargets?.[0])).toEqual(Array.from({ length: 9 }, (_, i) => `n${i}`));
  });

  it('a duplicate glTF index is KEPT (first claim wins at emission), order is never changed', () => {
    const node = output('o', [{ meshTargets: ['A'] }, { gltfMaterialIndex: 1 }, { gltfMaterialIndex: 1 }], {
      modelSignature: { materials: SIG },
    });
    const nodes = [node];
    const r = sanitizeOutputMaterialsReport(nodes);
    expect(r.nodes).toBe(nodes);
    expect(r.trimmed).toBe(0);
  });

  it('unknown keys on an index entry are stripped; a node-level gltfMaterialIndex is deleted', () => {
    const node = output('o', [{ gltfMaterialIndex: 0, payload: 'x'.repeat(10), constructor: 1 }], {
      modelSignature: { materials: SIG },
      gltfMaterialIndex: 0,
    });
    const r = sanitizeOutputMaterialsReport([node]);
    expect(matsOf(r.nodes[0])).toEqual([{ gltfMaterialIndex: 0 }]);
    expect(Object.keys(dataOf(r.nodes[0]))).not.toContain('gltfMaterialIndex');
  });

  it('a signature carrying another key is rewritten to exactly { materials }', () => {
    const node = output('o', [{ gltfMaterialIndex: 0 }], { modelSignature: { materials: SIG, evil: 'x' } });
    const r = sanitizeOutputMaterialsReport([node]);
    expect(dataOf(r.nodes[0]).modelSignature).toEqual({ materials: SIG });
  });

  it('modelMeshes: junk entries, unusable names, out-of-range materials and duplicates go', () => {
    const node = output('o', [{ gltfMaterialIndex: 0 }], {
      modelSignature: { materials: SIG },
      modelMeshes: [
        null, 5, [], { name: '__proto__', material: 0 }, { name: 'ok', material: 99 },
        { name: 'ok', material: 1.5 }, { name: 'ok', material: '1' }, { name: '', material: 0 },
        { name: 'Hull', material: 0 }, { name: 'Hull', material: 1 }, { name: 'Glass', material: 1, extra: 1 },
      ],
    });
    const r = sanitizeOutputMaterialsReport([node]);
    expect(dataOf(r.nodes[0]).modelMeshes).toEqual([{ name: 'Hull', material: 0 }, { name: 'Glass', material: 1 }]);
  });

  it('modelMeshes that are not an array, or empty after cleaning, are removed', () => {
    for (const bad of [5, 'x', {}, [null], [{ name: 'a', material: 9 }]]) {
      const node = output('o', [{ gltfMaterialIndex: 0 }], { modelSignature: { materials: SIG }, modelMeshes: bad });
      const r = sanitizeOutputMaterialsReport([node]);
      expect(Object.keys(dataOf(r.nodes[0])), JSON.stringify(bad)).not.toContain('modelMeshes');
    }
  });

  it('nothing throws on primitive or hostile node data', () => {
    for (const raw of [5, 'x', null, [], [5, null, 'x', { gltfMaterialIndex: {} }]]) {
      const node = output('o', raw, { modelSignature: { materials: SIG } });
      expect(() => sanitizeOutputMaterials([node])).not.toThrow();
    }
  });
});

describe('planIndexParts', () => {
  it('first claim wins, ascending, inside the signature only', () => {
    const mats: OutputMaterial[] = [
      {}, { gltfMaterialIndex: 2 }, { meshTargets: ['A'] }, { gltfMaterialIndex: 0 },
      { gltfMaterialIndex: 2 }, { gltfMaterialIndex: 5 },
    ];
    const plan = planIndexParts(mats, SIG);
    expect(plan.entries).toEqual([{ gltfIndex: 0, section: 3 }, { gltfIndex: 2, section: 1 }]);
    expect([...plan.duplicates]).toEqual([4]);
    expect(plan.overCap).toEqual([]);
  });

  it('no signature emits nothing, and material 0 is never an index section', () => {
    expect(planIndexParts([{}, { gltfMaterialIndex: 0 }], null).entries).toEqual([]);
    expect(planIndexParts([{ gltfMaterialIndex: 0 } as OutputMaterial], SIG).entries).toEqual([]);
  });

  it('is capped at MAX_INDEX_MATERIALS', () => {
    const mats: OutputMaterial[] = [{}, ...Array.from({ length: 20 }, (_, i) => ({ gltfMaterialIndex: i }))];
    const plan = planIndexParts(mats, Array.from({ length: 20 }, () => ''));
    expect(plan.entries).toHaveLength(MAX_INDEX_MATERIALS);
    expect(plan.overCap).toEqual([17, 18, 19, 20]);
  });
});

describe('countSections', () => {
  it('counts ADDED sections by kind (material 0 excluded)', () => {
    expect(countSections([{ meshTargets: ['A'] }, { gltfMaterialIndex: 0 }, {}, { meshTargets: [] }])).toEqual({
      named: 2,
      index: 1,
    });
  });
});

describe('the section label', () => {
  it('names an index section by its glTF material, 0-based "Material #n" when unnamed', () => {
    const mats: OutputMaterial[] = [{}, { gltfMaterialIndex: 1 }, { gltfMaterialIndex: 2 }];
    const sig = ['A', 'Glass', ''];
    expect(sectionLabel(mats, 1, sig)).toEqual({ kind: 'index', gltfIndex: 1, name: 'Glass' });
    expect(sectionLabel(mats, 2, sig)).toEqual({ kind: 'index', gltfIndex: 2, name: '' });
    expect(formatSectionLabel(sectionLabel(mats, 1, sig), 'en')).toBe('Glass');
    expect(formatSectionLabel(sectionLabel(mats, 2, sig), 'en')).toBe('Material #2');
    expect(formatSectionLabel(sectionLabel(mats, 2, null), 'lv')).toBe('Materiāls #2');
    // Material 0 is never an index section, whatever it carries.
    expect(sectionLabel([{ gltfMaterialIndex: 0 } as OutputMaterial], 0, SIG)).toEqual({ kind: 'default' });
  });

  it('display text replaces control and bidi characters and caps at 64 code points', () => {
    expect(displayMaterialName('a\u202eb\u0000c\u2028d\u2066e')).toBe('a\ufffdb\ufffdc\ufffdd\ufffde');
    const long = displayMaterialName('ā'.repeat(100));
    expect(Array.from(long)).toHaveLength(65);
    expect(long.endsWith('…')).toBe(true);
    // Surrogate pairs are never split.
    const emoji = String.fromCodePoint(0x1f600);
    expect(Array.from(displayMaterialName(emoji.repeat(70))).slice(0, 64).every((c) => c === emoji)).toBe(true);
  });

  it('the chip title fills the name in ONE pass (a name spelling {name} cannot hijack it)', () => {
    expect(indexChipTitle('{name}', undefined, 'en')).toBe('glTF material “{name}”');
    const dup = { meshes: [], overridden: [], state: 'duplicate' as const };
    expect(indexChipTitle('Glass', dup, 'en')).toContain('already shaded by a section above');
    expect(indexChipTitle('Glass', dup, 'lv')).toContain('Glass');
  });
});

describe('assignMeshTargets leaves index sections alone', () => {
  it('an index section keeps its object reference and gains no meshTargets key', () => {
    const idx: OutputMaterial = { gltfMaterialIndex: 0, values: { color: '#ff0000' } };
    const next = assignMeshTargets([{}, idx, { meshTargets: ['A'] }], 2, ['A', 'B']);
    expect(next[1]).toBe(idx);
    expect(next[2].meshTargets).toEqual(['A', 'B']);
  });

  it('targeting an index section is refused: a fresh list of the same materials', () => {
    const mats: OutputMaterial[] = [{}, { gltfMaterialIndex: 0 }];
    const next = assignMeshTargets(mats, 1, ['Body']);
    expect(next).not.toBe(mats);
    expect(next[1]).toBe(mats[1]);
    expect(next[1].meshTargets).toBeUndefined();
  });
});

describe('dormancy by NAME never touches an index section', () => {
  it('an index section is never name-dormant', () => {
    expect([...dormantMaterialIndices([{}, { gltfMaterialIndex: 0 }], ['Other'])]).toEqual([]);
  });
});

describe('the loaded model (trusted facts only)', () => {
  const facts = (signature: string[], meshes: [string, number[]][] = []) => ({
    signature,
    meshMaterials: new Map(meshes.map(([n, m]) => [n, { materials: m, certain: true }])),
  });

  it('loadedModelOf: none, not-gltf, unknown, gltf — the fact-less answers are identity-stable', () => {
    expect(loadedModelOf(null).kind).toBe('none');
    expect(loadedModelOf(undefined)).toBe(loadedModelOf(null));
    expect(loadedModelOf({ kind: 'obj' }).kind).toBe('not-gltf');
    expect(loadedModelOf({ kind: 'nonsense' }).kind).toBe('not-gltf');
    expect(loadedModelOf({ kind: 'glb' }).kind).toBe('unknown');
    expect(loadedModelOf({ kind: 'gltf', gltf: null })).toBe(loadedModelOf({ kind: 'glb' }));
    // Junk facts (a tampered or future shape) read as unknown, never as a match.
    expect(loadedModelOf({ kind: 'glb', gltf: { signature: 'Body', meshMaterials: new Map() } }).kind).toBe('unknown');
    expect(loadedModelOf({ kind: 'glb', gltf: { signature: ['Body'], meshMaterials: {} } }).kind).toBe('unknown');
    const f = facts(['Body']);
    const a = loadedModelOf({ kind: 'glb', gltf: f });
    expect(a.kind).toBe('gltf');
    // One answer per facts object, so a memo keyed on it stays put.
    expect(loadedModelOf({ kind: 'glb', gltf: f })).toBe(a);
    expect(() => loadedModelOf(5)).not.toThrow();
  });

  it('a model the pane is NOT showing reads as none: a primitive in the Model menu sleeps the index sections', () => {
    const out = output('o1', [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }], { modelSignature: { materials: SIG } });
    const pm = { kind: 'glb', gltf: facts(SIG, [['Hull', [0]], ['Window', [1]]]) };
    const state = (shows?: boolean) => ({
      nodes: [out],
      edges: [],
      previewMesh: pm,
      previewMeshInventory: null,
      ...(shows === undefined ? {} : { previewShowsModel: shows }),
    });
    expect(shownPreviewMesh(state())).toBe(pm);
    expect(shownPreviewMesh(state(true))).toBe(pm);
    expect(shownPreviewMesh(state(false))).toBeNull();
    // The matching glTF is loaded AND shown: awake.
    expect(outputDormancyFromState(state(true)).dormant).toEqual(new Set());
    expect(anyOutputDormant(state(true), 1)).toBe(false);
    // Same model, same facts, a primitive showing: every index section sleeps.
    expect(outputDormancyFromState(state(false))).toEqual({ outputId: 'o1', dormant: new Set([1, 2]), visibleCount: 1 });
    expect(anyOutputDormant(state(false), 2)).toBe(true);
    // The node's own route agrees: nothing is covered while nothing is shown.
    const mats = outputMaterials(out);
    const hidden = loadedModelOf(shownPreviewMesh(state(false)));
    expect(indexSectionsAwake(SIG, hidden)).toBe(false);
    expect(indexSectionCoverage(mats, SIG, hidden, planNamedParts(mats)).get(1)?.state).toBe('unknown');
  });

  it('indexSectionsAwake: the four kinds × match / mismatch', () => {
    const sig = ['Body', 'Glass'];
    const cases: [unknown, boolean, boolean][] = [
      [null, false, false],
      [{ kind: 'obj' }, false, false],
      [{ kind: 'glb', gltf: null }, true, true],
      [{ kind: 'glb', gltf: facts(sig) }, true, false],
    ];
    for (const [pm, match, mismatch] of cases) {
      const loaded = loadedModelOf(pm);
      expect(indexSectionsAwake(sig, loaded), `${loaded.kind} match`).toBe(match);
      expect(indexSectionsAwake(['Body', 'Glas'], loaded), `${loaded.kind} mismatch`).toBe(mismatch);
      // No signature on the node: nothing to be awake.
      expect(indexSectionsAwake(null, loaded)).toBe(false);
    }
  });

  it('dormantIndicesForPreview: asleep index sections sleep even while the inventory is unknown', () => {
    const mats: OutputMaterial[] = [{}, { gltfMaterialIndex: 0 }, { meshTargets: ['Body'] }, { gltfMaterialIndex: 1 }];
    expect([...dormantIndicesForPreview(mats, {
      meshNames: [], inventoryKnown: false, defaultContributes: true, indexSectionsAwake: false,
    })]).toEqual([1, 3]);
    expect([...dormantIndicesForPreview(mats, {
      meshNames: [], inventoryKnown: false, defaultContributes: true, indexSectionsAwake: true,
    })]).toEqual([]);
    // Named sections keep today's rules: known inventory without Body sleeps it.
    expect([...dormantIndicesForPreview(mats, {
      meshNames: ['Other', 'Else'], inventoryKnown: true, defaultContributes: true, indexSectionsAwake: true,
    })]).toEqual([2]);
  });

  it('the single-mesh exemption (rule 2) never lands on an index section', () => {
    const mats: OutputMaterial[] = [{}, { gltfMaterialIndex: 0 }, { meshTargets: ['Body'] }];
    const dormant = dormantIndicesForPreview(mats, {
      meshNames: [], inventoryKnown: true, defaultContributes: false, indexSectionsAwake: false,
    });
    // The first NAMED section stays visible (it is what 0.6 paints); the index
    // section sleeps on its own rule.
    expect([...dormant]).toEqual([1]);
  });

  it('coverage is empty without a signature and skips a section outside it', () => {
    const mats: OutputMaterial[] = [{}, { gltfMaterialIndex: 0 }, { gltfMaterialIndex: 5 }];
    const loaded = loadedModelOf({ kind: 'glb', gltf: facts(['A', 'B'], [['M', [0]]]) });
    expect(indexSectionCoverage(mats, null, loaded, planNamedParts(mats)).size).toBe(0);
    const c = indexSectionCoverage(mats, ['A', 'B'], loaded, planNamedParts(mats));
    expect([...c.keys()]).toEqual([1]);
    expect(c.get(1)).toEqual({ meshes: ['M'], overridden: [], state: 'covered' });
  });

  it('a duplicate index is marked duplicate (the plan emission uses), awake or not', () => {
    const mats: OutputMaterial[] = [{}, { gltfMaterialIndex: 0 }, { gltfMaterialIndex: 0 }];
    for (const pm of [null, { kind: 'glb', gltf: facts(['A'], [['M', [0]]]) }]) {
      const c = indexSectionCoverage(mats, ['A'], loadedModelOf(pm), planNamedParts(mats));
      expect(c.get(1)?.state).not.toBe('duplicate');
      expect(c.get(2)?.state).toBe('duplicate');
    }
  });

  it('defaultSectionUnused: true only when every mesh on screen belongs to a section below', () => {
    const idx: OutputMaterial[] = [{}, { gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }];
    const plan = planNamedParts(idx);
    const awake = loadedModelOf({ kind: 'glb', gltf: facts(SIG, [['Hull', [0]], ['Window', [1]]]) });
    const cov = indexSectionCoverage(idx, SIG, awake, plan);
    // An import-built node on its own model: both meshes are covered.
    expect(defaultSectionUnused(['Hull', 'Window'], idx, plan, cov)).toBe(true);
    // One mesh left over (a material past MAX_INDEX_MATERIALS) — the default
    // is what shades it, so it is NOT marked.
    expect(defaultSectionUnused(['Hull', 'Window', 'Spare'], idx, plan, cov)).toBe(false);
    // A DIFFERENT model: the sections sleep, coverage is empty, the default
    // shades everything again.
    const asleep = loadedModelOf({ kind: 'glb', gltf: facts(['Other'], [['Hull', [0]]]) });
    expect(defaultSectionUnused(['Hull'], idx, plan, indexSectionCoverage(idx, SIG, asleep, plan))).toBe(false);
    // No model reported yet, and a node with no section below it.
    expect(defaultSectionUnused([], idx, plan, cov)).toBe(false);
    expect(defaultSectionUnused(['Hull'], [{}], planNamedParts([{}]), new Map())).toBe(false);
  });

  it('defaultSectionUnused: NAME sections cover too, and a TARGETED material 0 is never marked', () => {
    const named: OutputMaterial[] = [{}, { meshTargets: ['Hull'] }, { meshTargets: ['Window'] }];
    const plan = planNamedParts(named);
    expect(defaultSectionUnused(['Hull', 'Window'], named, plan, new Map())).toBe(true);
    expect(defaultSectionUnused(['Hull', 'Window', 'Roof'], named, plan, new Map())).toBe(false);
    // Material 0 naming a mesh shades exactly that mesh — a different state
    // from "everything else", so the mark never applies to it.
    const targeted: OutputMaterial[] = [{ meshTargets: ['Hull'] }, { meshTargets: ['Window'] }];
    expect(defaultSectionUnused(['Hull', 'Window'], targeted, planNamedParts(targeted), new Map())).toBe(false);
  });

  it('pickFreeMesh never returns a name-claimed mesh', () => {
    const mats: OutputMaterial[] = [{ meshTargets: ['A'] }, { gltfMaterialIndex: 0 }, { meshTargets: ['B'] }];
    const cov = new Map<number, IndexCoverage>([[1, { meshes: ['C'], overridden: [], state: 'covered' }]]);
    expect(pickFreeMesh(['A', 'B', 'C', 'D'], mats, cov)).toBe('D');
    expect(pickFreeMesh(['A', 'B', 'C'], mats, cov)).toBe('C');
    expect(pickFreeMesh(['A', 'B'], mats, cov)).toBeNull();
    expect(pickFreeMesh([], mats, cov)).toBeNull();
  });
});

describe('the chip and picker wording', () => {
  const cov = (state: IndexCoverage['state'], meshes: string[] = [], overridden: string[] = []): IndexCoverage =>
    ({ meshes, overridden, state });

  it('one sentence per state, every slot filled in ONE pass', () => {
    expect(indexChipTitle('G', cov('unknown'), 'en')).toBe('glTF material “G”');
    expect(indexChipTitle('G', cov('unused'), 'en')).toBe('glTF material “G” — no mesh of the loaded model uses it');
    expect(indexChipTitle('G', cov('overridden', ['A'], ['A']), 'en')).toContain('this section does nothing');
    expect(indexChipTitle('G', cov('covered', ['A', 'B']), 'en')).toBe('glTF material “G” — shades: A, B');
    // A material name spelling the other slot cannot capture it.
    expect(indexChipTitle('{meshes}', cov('covered', ['A']), 'en')).toBe('glTF material “{meshes}” — shades: A');
    for (const s of ['unknown', 'unused', 'overridden', 'covered', 'duplicate'] as const) {
      const lv = indexChipTitle('G', cov(s, ['A'], s === 'overridden' ? ['A'] : []), 'lv');
      expect(lv, s).toContain('G');
      expect(lv, s).not.toMatch(/\{\w+\}/);
    }
  });

  it('joinCapped caps a long list with an ellipsis', () => {
    expect(joinCapped(['a', 'b'])).toBe('a, b');
    expect(joinCapped(Array.from({ length: 14 }, (_, i) => `m${i}`), 3)).toBe('m0, m1, m2, …');
    expect(joinCapped([])).toBe('');
  });
});

describe('foldExtraOutputs and index sections', () => {
  it("the keep's index sections are preserved and do not count against the named cap", () => {
    const keep = output('keep', Array.from({ length: 12 }, (_, i) => ({ gltfMaterialIndex: i })), {
      modelSignature: { materials: Array.from({ length: 12 }, () => '') },
      activeOutput: true,
    });
    const extra = output('extra', undefined, { meshTargets: ['Glass'] });
    const r = foldExtraOutputs([keep, extra], [makeEdge('c', 'out', 'extra', 'color')]);
    expect(r.nodes.map((n) => n.id)).toEqual(['keep']);
    expect(countSections(outputMaterials(r.nodes[0]))).toEqual({ named: 1, index: 12 });
    expect(r.edges[0].targetHandle).toBe('m13:color');
  });

  it('an extra carrying index sections (or a signature) is a modern inactive Output: never folded', () => {
    const keep = output('keep', undefined, { activeOutput: true });
    const extraIdx = output('x1', [{ gltfMaterialIndex: 0 }], { meshTargets: ['A'], modelSignature: { materials: SIG } });
    const extraSig = output('x2', undefined, { meshTarget: { name: 'B' }, modelSignature: { materials: SIG } });
    const nodes = [keep, extraIdx, extraSig];
    const edges = [makeEdge('c', 'out', 'x1', 'color')];
    const r = foldExtraOutputs(nodes, edges);
    expect(r.nodes).toBe(nodes);
    expect(r.edges).toBe(edges);
  });
});

describe('the loader-0.6 mirror plan', () => {
  const MESHES = [
    { name: 'Hull', material: 0 }, { name: 'Hull2', material: 0 }, { name: 'Window', material: 1 },
    { name: 'Named', material: 1 }, { name: 'Plain', material: 2 },
  ];
  const node = (extra: Record<string, unknown> = {}, materials: unknown = [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }]) =>
    output('o', materials, { modelSignature: { materials: SIG }, modelMeshes: MESHES, ...extra });

  it('mirrors the meshes of EMITTED indices, in stored order', () => {
    expect(materialPartsMirrorPlan(node())).toEqual([
      { name: 'Hull', index: 0 }, { name: 'Hull2', index: 0 }, { name: 'Window', index: 1 }, { name: 'Named', index: 1 },
    ]);
  });

  it('never mirrors a name a named section claims (material 0 included), nor an index that does not emit', () => {
    const plan = materialPartsMirrorPlan(node({ meshTargets: ['Hull2'] }, [{ gltfMaterialIndex: 0 }, { meshTargets: ['Named'] }]));
    expect(plan).toEqual([{ name: 'Hull', index: 0 }]);
  });

  it('is empty without a valid signature, without mirrors, or for a non-Output', () => {
    expect(materialPartsMirrorPlan(node({ modelSignature: { materials: 5 } }))).toEqual([]);
    expect(materialPartsMirrorPlan(node({ modelMeshes: undefined }))).toEqual([]);
    expect(materialPartsMirrorPlan(makeNode('c', 'color'))).toEqual([]);
    expect(materialPartsMirrorPlan(null)).toEqual([]);
  });

  it('is capped (MAX_MIRROR_ENTRIES), the stored list itself at MAX_MODEL_MESHES', () => {
    const meshes = Array.from({ length: 300 }, (_, i) => ({ name: `m${i}`, material: 0 }));
    const plan = materialPartsMirrorPlan(node({ modelMeshes: meshes }));
    expect(plan).toHaveLength(Math.min(MAX_MIRROR_ENTRIES, MAX_MODEL_MESHES));
  });

  it('the key changes with the plan and is stable for an equal one', () => {
    const a = mirrorPlanKey(materialPartsMirrorPlan(node()));
    expect(mirrorPlanKey(materialPartsMirrorPlan(node()))).toBe(a);
    expect(mirrorPlanKey(materialPartsMirrorPlan(node({ meshTargets: ['Hull'] })))).not.toBe(a);
    expect(mirrorPlanKey([])).toBe('');
  });
});

describe('sanitizeModelMeshes', () => {
  it('returns the SAME array when clean', () => {
    const list = [{ name: 'Hull', material: 0 }];
    expect(sanitizeModelMeshes(list, 1)).toBe(list);
  });
  it('checks the length before walking a huge sparse array', () => {
    expect(sanitizeModelMeshes(new Array(2 ** 31), 3)).toBeUndefined();
  });
});

describe('carryModelMeshes (the resync carry)', () => {
  const meshes = [{ name: 'Hull', material: 0 }];
  const old = () => output('o', [{ gltfMaterialIndex: 0 }], { modelSignature: { materials: SIG }, modelMeshes: meshes });

  it('carries the mirror source while the parsed signature equals the old one', () => {
    const merged = output('o', [{ gltfMaterialIndex: 0 }], { modelSignature: { materials: [...SIG] } });
    carryModelMeshes(merged, old());
    expect(dataOf(merged).modelMeshes).toBe(meshes);
  });

  it('drops it when the code panel edited the signature, or the parse lost it', () => {
    for (const sig of [{ materials: ['Body', 'Glass'] }, { materials: ['Body', 'Glass', 'Trim '] }, undefined]) {
      const merged = output('o', [{ gltfMaterialIndex: 0 }], sig ? { modelSignature: sig } : {});
      carryModelMeshes(merged, old());
      expect(dataOf(merged).modelMeshes).toBeUndefined();
    }
  });

  it('touches nothing that is not an Output', () => {
    const merged = makeNode('c', 'color');
    carryModelMeshes(merged, old());
    expect(dataOf(merged).modelMeshes).toBeUndefined();
  });
});

describe('cost', () => {
  it('one node wired into two index sections is priced once', () => {
    const out = output('o', [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }], { modelSignature: { materials: SIG } });
    const nodes = [makeNode('s1', 'sin'), out];
    const one = computeReachableCost(nodes, [makeEdge('s1', 'out', 'o', 'm1:color')], out);
    const two = computeReachableCost(
      nodes,
      [makeEdge('s1', 'out', 'o', 'm1:color'), makeEdge('s1', 'out', 'o', 'm2:color')],
      out,
    );
    expect(two).toBe(one);
    expect(one).toBeGreaterThan(0);
  });
});
