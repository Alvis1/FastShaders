/**
 * The CROSS-NODE Output plans (step 2 of the Output split).
 *
 * The plans used to take ONE node's material list. They now take the node SET,
 * which is the capability the split needs and which nothing in the app can
 * exercise yet — `contributingOutputs` still answers with a single node, so the
 * existing byte-stability suites are the proof that the one-node path did not
 * move, and THIS file is the proof that the cross-node path does what it claims.
 *
 * Three properties, each a defect that would otherwise land silently at step 6b:
 *
 *  - ONE claim set and ONE cap counter for the whole call. `parts` and
 *    `materialParts` are single maps in a single module, so a mesh (or a glTF
 *    index) claimed by an earlier-ranked node must not be re-claimed by a later
 *    one, and `MAX_PART_ENTRIES` / `MAX_INDEX_MATERIALS` bound that map rather
 *    than each node's share of it. Planned per node, two Outputs would each
 *    emit a `Glass` key — the later one silently overwriting the earlier in the
 *    emitted object literal — and 90 entries per node would blow the loader's
 *    own bound with nothing reporting it.
 *
 *  - ORDER is `(emitRank, id)` and never the nodes array. `liftChildrenAfterParents`
 *    splices a node into a new array slot on an ordinary drag-into-a-group and
 *    `useSyncEngine` reorders on every Apply, so an array-derived order would
 *    rewrite the module on a layout gesture: `previewCode` advances, the 3D
 *    preview recompiles, the autosave dirties, `__partPixel<n>` renumbers, and
 *    first-claim-wins flips on a duplicate mesh name — all with `errors: []`.
 *
 *  - The ID TIE-BREAK is not decoration. `unfoldOutputMaterials` seeds every
 *    node it makes from its material index, so two folded Outputs unfolded in
 *    one document each produce a node carrying `emitOrder: 0`. `Array.prototype.sort`
 *    is stable, so without the tie-break those two fall back to array order —
 *    exactly the thing the rank replaces, and invisible until the day a document
 *    has two of them.
 *
 * Plus the equivalence that makes the two forms safe to keep side by side: for
 * ONE node, the cross-node plan must agree with the material-list plan the
 * golden in `outputSectionCaps.test.ts` pins against graphToCode's own
 * pre-Step-4 loop.
 */
import { describe, it, expect } from 'vitest';
import {
  planNamedParts,
  planNamedPartsAcross,
  planIndexParts,
  planIndexPartsAcross,
  countSections,
  countSectionsAcross,
  indexSectionCoverage,
  indexSectionCoverageAcross,
  pickFreeMesh,
  pickFreeMeshAcross,
  defaultSectionUnused,
  defaultSectionUnusedAcross,
  materialPartsMirrorPlan,
  materialPartsMirrorPlanAcross,
  mirrorPlanKey,
  outputsInEmitOrder,
  contributingOutputs,
  findDefaultOutput,
  outputMaterials,
  emitRank,
  loadedModelOf,
  MAX_PART_ENTRIES,
  MAX_INDEX_MATERIALS,
  MAX_PARTS,
  type OutputMaterial,
} from './outputMaterials';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';

/** An Output node with an explicit emit rank and whatever data the case needs. */
const out = (id: string, emitOrder: number | undefined, data: Record<string, unknown> = {}): AppNode => {
  const n = makeNode(id, 'output');
  Object.assign(n.data as Record<string, unknown>, data);
  if (emitOrder !== undefined) (n.data as Record<string, unknown>).emitOrder = emitOrder;
  return n;
};
/** `meshTargets` on material 0, `materials` for the rest. */
const named = (id: string, emitOrder: number | undefined, first: string[], added: OutputMaterial[] = []): AppNode =>
  out(id, emitOrder, { meshTargets: first, ...(added.length ? { materials: added } : {}) });
const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const keys = (plan: { entries: { name: string }[] }) => plan.entries.map((e) => e.name);
const at = (plan: { entries: { name: string; nodeId: string }[] }, name: string) =>
  plan.entries.find((e) => e.name === name)?.nodeId ?? null;

describe('planNamedPartsAcross — ONE claim set across every Output', () => {
  it('a mesh an earlier-ranked node claims is not re-claimed by a later one', () => {
    const a = named('a', 0, ['Body', 'Glass']);
    const b = named('b', 1, ['Glass', 'Roof']);
    const plan = planNamedPartsAcross([a, b]);
    // `parts` has ONE slot per mesh: Glass belongs to `a` and `b` emits Roof only.
    expect(plan.entries).toEqual([
      { name: 'Body', nodeId: 'a', section: 0 },
      { name: 'Glass', nodeId: 'a', section: 0 },
      { name: 'Roof', nodeId: 'b', section: 0 },
    ]);
    // Planned PER NODE the two would each emit a Glass key, and the later one
    // would silently overwrite the earlier in the emitted object literal.
    expect(keys(planNamedParts(outputMaterials(b)))).toEqual(['Glass', 'Roof']);
  });

  it('a node whose every name is already claimed is SHADOWED, not dropped silently', () => {
    const a = named('a', 0, ['Glass']);
    const b = named('b', 1, ['Glass']);
    const plan = planNamedPartsAcross([a, b]);
    expect(plan.entries).toEqual([{ name: 'Glass', nodeId: 'a', section: 0 }]);
    expect(plan.shadowed.get('b')).toEqual(new Set([0]));
    // A node with nothing to report is ABSENT rather than carrying an empty set,
    // so `shadowed.get(id) ?? EMPTY` is the reader's contract.
    expect(plan.shadowed.has('a')).toBe(false);
  });

  it('an EMPTY section is never shadowed, on any node — "No mesh" is a different state', () => {
    const a = named('a', 0, ['Glass']);
    const b = out('b', 1, { meshTargets: [] });
    expect(planNamedPartsAcross([a, b]).shadowed.size).toBe(0);
  });
});

describe('planNamedPartsAcross — ONE cap counter across every Output', () => {
  /** A node holding `sections` sections of `MAX_PARTS` distinct names each. */
  const full = (id: string, rank: number, sections: number): AppNode =>
    named(
      id,
      rank,
      names(`${id}_s0_`, MAX_PARTS),
      Array.from({ length: sections - 1 }, (_, s) => ({ meshTargets: names(`${id}_s${s + 1}_`, MAX_PARTS) })),
    );

  it('is a RUNNING TOTAL, so a third node past the cap reports overCap', () => {
    // 45 + 45 fills MAX_PART_ENTRIES exactly; `c` then has nowhere to go.
    const a = full('a', 0, 5);
    const b = full('b', 1, 5);
    const c = named('c', 2, ['late']);
    const plan = planNamedPartsAcross([a, b, c]);
    expect(plan.entries).toHaveLength(MAX_PART_ENTRIES);
    expect(plan.overCap).toEqual(['late']);
    expect(plan.shadowed.get('c')).toEqual(new Set([0]));
    // Per node NOTHING would be over the cap — 45 each, then 1 — which is the
    // whole point: a per-node budget silently admits 91 entries.
    expect(planNamedParts(outputMaterials(a)).overCap).toEqual([]);
    expect(planNamedParts(outputMaterials(c)).overCap).toEqual([]);
  });
});

describe('planIndexPartsAcross — ONE claim set and ONE cap counter', () => {
  const SIG = names('mat', 20);
  const idx = (id: string, rank: number, indices: number[]): AppNode =>
    out(id, rank, {
      modelSignature: { materials: SIG },
      materials: indices.map((gltfMaterialIndex) => ({ gltfMaterialIndex })),
    });

  it('a glTF index an earlier-ranked node claims shadows the later node s section', () => {
    const a = idx('a', 0, [2, 0]);
    const b = idx('b', 1, [0, 1]);
    const plan = planIndexPartsAcross([a, b], SIG);
    // Ascending by index, each index once — the canonical `materialParts` order.
    expect(plan.entries).toEqual([
      { gltfIndex: 0, nodeId: 'a', section: 2 },
      { gltfIndex: 1, nodeId: 'b', section: 2 },
      { gltfIndex: 2, nodeId: 'a', section: 1 },
    ]);
    expect(plan.duplicates.get('b')).toEqual(new Set([1]));
    expect(plan.duplicates.has('a')).toBe(false);
  });

  it('MAX_INDEX_MATERIALS is a running total, not a per-node budget', () => {
    const a = idx('a', 0, names('', MAX_INDEX_MATERIALS).map((_, i) => i));
    const b = idx('b', 1, [MAX_INDEX_MATERIALS]);
    const plan = planIndexPartsAcross([a, b], SIG);
    expect(plan.entries).toHaveLength(MAX_INDEX_MATERIALS);
    expect(plan.overCap).toEqual([{ nodeId: 'b', section: 1 }]);
    expect(planIndexParts(outputMaterials(b), SIG).overCap).toEqual([]);
  });

  it('no signature means no table at all, whatever the nodes carry', () => {
    expect(planIndexPartsAcross([idx('a', 0, [0])], null).entries).toEqual([]);
  });
});

describe('the emitted order is (emitRank, id) and NEVER the nodes array', () => {
  it('a PERMUTED nodes array plans identically; `emitOrder` is what moves it', () => {
    const a = named('a', 1, ['X', 'A']);
    const b = named('b', 0, ['X', 'B']);
    // `b` ranks first, so it claims the shared X — in BOTH array orders.
    const forward = planNamedPartsAcross([a, b]);
    const reversed = planNamedPartsAcross([b, a]);
    expect(forward.entries).toEqual(reversed.entries);
    expect(keys(forward)).toEqual(['X', 'B', 'A']);
    expect(at(forward, 'X')).toBe('b');

    // Move the rank and the order follows — the ONE thing that may move it.
    const a2 = named('a', 0, ['X', 'A']);
    const b2 = named('b', 1, ['X', 'B']);
    const moved = planNamedPartsAcross([a2, b2]);
    expect(keys(moved)).toEqual(['X', 'A', 'B']);
    expect(at(moved, 'X')).toBe('a');
    expect(planNamedPartsAcross([b2, a2]).entries).toEqual(moved.entries);
  });

  it('the index table follows the rank too: the lower rank wins a duplicate index', () => {
    const SIG = ['m0', 'm1'];
    const hi = out('hi', 1, { modelSignature: { materials: SIG }, materials: [{ gltfMaterialIndex: 0 }] });
    const lo = out('lo', 0, { modelSignature: { materials: SIG }, materials: [{ gltfMaterialIndex: 0 }] });
    for (const arr of [[hi, lo], [lo, hi]]) {
      const plan = planIndexPartsAcross(arr, SIG);
      expect(plan.entries).toEqual([{ gltfIndex: 0, nodeId: 'lo', section: 1 }]);
      expect(plan.duplicates.get('hi')).toEqual(new Set([1]));
    }
  });
});

describe('(emitRank, id) ties break deterministically', () => {
  it('two nodes at the same rank sort by id, in both array orders', () => {
    // `unfoldOutputMaterials` seeds material 0 with `emitOrder: 0`, so TWO
    // folded Outputs in one document really do produce this.
    const b = named('b', 0, ['Shared']);
    const a = named('a', 0, ['Shared']);
    expect(emitRank(a)).toBe(0);
    expect(emitRank(b)).toBe(0);
    for (const arr of [[b, a], [a, b]]) {
      expect(outputsInEmitOrder(arr).map((n) => n.id)).toEqual(['a', 'b']);
      const plan = planNamedPartsAcross(arr);
      expect(at(plan, 'Shared')).toBe('a');
      expect(plan.shadowed.get('b')).toEqual(new Set([0]));
    }
  });

  it('an ABSENT or junk emitOrder is rank 0, so it ties with a real 0 and sorts by id', () => {
    const absent = named('a', undefined, ['Shared']);
    const junk = named('b', undefined, ['Shared']);
    (junk.data as Record<string, unknown>).emitOrder = '0';
    const real = named('c', 0, ['Shared']);
    for (const arr of [[junk, real, absent], [real, absent, junk], [absent, junk, real]]) {
      expect(outputsInEmitOrder(arr).map((n) => n.id)).toEqual(['a', 'b', 'c']);
    }
  });

  it('a duplicate id is planned ONCE — first wins, and a plan keyed by id stays unambiguous', () => {
    const first = named('same', 0, ['A']);
    const second = named('same', 0, ['B']);
    expect(outputsInEmitOrder([first, second])).toEqual([first]);
    expect(keys(planNamedPartsAcross([first, second]))).toEqual(['A']);
  });
});

describe('the rest of the plans go cross-node too', () => {
  const SIG = ['mA', 'mB'];
  const LOADED = loadedModelOf({
    kind: 'glb',
    gltf: { signature: SIG, meshMaterials: new Map([['Hull', { materials: [0] }], ['Glass', { materials: [1] }]]) },
  });

  it('countSectionsAcross sums the ADDED sections of every node', () => {
    const a = named('a', 0, [], [{ meshTargets: ['A'] }, { meshTargets: ['B'] }]);
    const b = out('b', 1, { modelSignature: { materials: SIG }, materials: [{ gltfMaterialIndex: 0 }] });
    expect(countSectionsAcross([a, b])).toEqual({ named: 2, index: 1 });
    expect(countSections(outputMaterials(a))).toEqual({ named: 2, index: 0 });
  });

  it('pickFreeMeshAcross never offers a mesh ANOTHER Output already names', () => {
    const a = named('a', 0, ['Hull']);
    const b = named('b', 1, ['Glass']);
    expect(pickFreeMeshAcross(['Hull', 'Glass', 'Spare'], [a, b], new Map())).toBe('Spare');
    expect(pickFreeMeshAcross(['Hull', 'Glass'], [a, b], new Map())).toBeNull();
    // Per node it would happily hand back a mesh the sibling holds, and the new
    // section would arrive inert (emission shadows it).
    expect(pickFreeMesh(['Hull', 'Glass'], outputMaterials(a), new Map())).toBe('Glass');
  });

  it('indexSectionCoverageAcross keys by node and honours a SIBLING node s name claim', () => {
    const idxNode = out('i', 0, { modelSignature: { materials: SIG }, materials: [{ gltfMaterialIndex: 0 }] });
    const nameNode = named('n', 1, ['Hull']);
    const plan = planNamedPartsAcross([idxNode, nameNode]);
    const cov = indexSectionCoverageAcross([idxNode, nameNode], SIG, LOADED, plan);
    // Hull wears glTF material 0 AND is claimed by name on the other node, so
    // the index section is fully overridden (0.8's precedence: the name wins).
    expect(cov.get('i')?.get(1)).toEqual({ meshes: ['Hull'], overridden: ['Hull'], state: 'overridden' });
    // A node with no index section is absent from the map.
    expect(cov.has('n')).toBe(false);
    // Per node the same section reads as plainly `covered` — the sibling's
    // claim is invisible to it.
    expect(
      indexSectionCoverage(outputMaterials(idxNode), SIG, LOADED, planNamedParts(outputMaterials(idxNode))).get(1)?.state,
    ).toBe('covered');
  });

  it('defaultSectionUnusedAcross counts the other NODES sections, not just its own', () => {
    const def = named('a', 0, []);
    const other = named('b', 1, ['Hull', 'Glass']);
    expect(defaultSectionUnusedAcross(['Hull', 'Glass'], [def, other], planNamedPartsAcross([def, other]), new Map()))
      .toBe(true);
    // A mesh nobody claims puts the default back to work.
    expect(defaultSectionUnusedAcross(['Hull', 'Glass', 'Spare'], [def, other], planNamedPartsAcross([def, other]), new Map()))
      .toBe(false);
    // Alone it has no section below it at all, so it is never marked.
    expect(defaultSectionUnusedAcross(['Hull'], [def], planNamedPartsAcross([def]), new Map())).toBe(false);
    // And that is exactly what the per-node form answers for the SAME document:
    // `def` carries one material, so it can never see that a sibling NODE has
    // taken every mesh out from under it.
    expect(defaultSectionUnused(['Hull', 'Glass'], outputMaterials(def), planNamedParts(outputMaterials(def)), new Map()))
      .toBe(false);
    // A TARGETED default shades exactly its own meshes and is never marked.
    const targeted = named('a', 0, ['Hull']);
    expect(
      defaultSectionUnusedAcross(['Hull', 'Glass'], [targeted, other], planNamedPartsAcross([targeted, other]), new Map()),
    ).toBe(false);
  });

  it('materialPartsMirrorPlanAcross reads modelMeshes from the LOWEST-ranked index node, in stored order', () => {
    // `gltfSectionBuilder` fills modelMeshes in FIRST-SCENE-APPEARANCE order,
    // which INTERLEAVES materials; the stored order goes straight into module
    // TEXT, so regrouping it per material would reorder the mirror keys of
    // every already-distributed single-GLB export (B5).
    const interleaved = [
      { name: 'Hull', material: 0 },
      { name: 'Glass', material: 1 },
      { name: 'Hull2', material: 0 },
    ];
    const lo = out('lo', 0, {
      modelSignature: { materials: SIG },
      modelMeshes: interleaved,
      materials: [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }],
    });
    const hi = out('hi', 1, { modelSignature: { materials: SIG }, materials: [{ gltfMaterialIndex: 0 }] });
    for (const arr of [[lo, hi], [hi, lo]]) {
      expect(materialPartsMirrorPlanAcross(arr)).toEqual([
        { name: 'Hull', index: 0 },
        { name: 'Glass', index: 1 },
        { name: 'Hull2', index: 0 },
      ]);
    }
  });

  it('a SIBLING node s name claim wins over a mirror, as it does over an index section', () => {
    const idxNode = out('i', 0, {
      modelSignature: { materials: SIG },
      modelMeshes: [{ name: 'Hull', material: 0 }, { name: 'Glass', material: 1 }],
      materials: [{ gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }],
    });
    const nameNode = named('n', 1, ['Hull']);
    expect(materialPartsMirrorPlanAcross([idxNode, nameNode])).toEqual([{ name: 'Glass', index: 1 }]);
    // Per node the mirror would still name Hull and paint a mesh the other
    // Output claims by name.
    expect(materialPartsMirrorPlan(idxNode)).toEqual([
      { name: 'Hull', index: 0 },
      { name: 'Glass', index: 1 },
    ]);
  });

  it('no index node anywhere means no mirrors, whatever modelMeshes says', () => {
    const meshesOnly = out('m', 0, { modelSignature: { materials: SIG }, modelMeshes: [{ name: 'Hull', material: 0 }] });
    expect(materialPartsMirrorPlanAcross([meshesOnly])).toEqual([]);
    expect(materialPartsMirrorPlanAcross([])).toEqual([]);
    // The subscription key of an empty plan is the empty string either way, so
    // a graph without index sections re-renders nothing.
    expect(mirrorPlanKey(materialPartsMirrorPlanAcross([meshesOnly]))).toBe('');
  });
});

describe('contributingOutputs — the ONE resolver', () => {
  it('with only UNTARGETED Outputs it is exactly the default, as a list, in emit order', () => {
    const a = named('a', 0, []);
    const b = named('b', 1, []);
    const other = makeNode('c', 'color');
    expect(contributingOutputs([other, a, b])).toEqual([findDefaultOutput([other, a, b])]);
    expect(contributingOutputs([other, a, b]).map((n) => n.id)).toEqual(['a']);
    expect(contributingOutputs([other])).toEqual([]);
    expect(contributingOutputs([])).toEqual([]);
  });

  it('the ACTIVE flag decides which UNTARGETED Output is the default', () => {
    const a = named('a', 0, []);
    const b = named('b', 1, []);
    (b.data as Record<string, unknown>).activeOutput = true;
    expect(contributingOutputs([a, b]).map((n) => n.id)).toEqual(['b']);
  });

  /**
   * The rule the Output split turns on (plan rule 4). A TARGETED Output shades
   * the meshes it names and nothing else, so parking it behind another node's
   * flag would silently drop a material the canvas still shows — and would make
   * "which meshes does this shader paint" depend on a choice about a different
   * node. Only the UNTARGETED half is a one-of-several choice.
   */
  it('EVERY targeted Output contributes, flag or no flag; only the untargeted ones compete', () => {
    const def = named('def', 0, []);
    const parked = named('parked', 1, []);
    const body = named('body', 2, ['Body']);
    const glass = named('glass', 3, ['Glass']);
    (parked.data as Record<string, unknown>).activeOutput = true;
    // `parked` wins the untargeted contest; `def` drops out, both targeted
    // nodes stay, and the list comes back in (emitRank, id) order.
    expect(contributingOutputs([def, parked, body, glass]).map((n) => n.id))
      .toEqual(['parked', 'body', 'glass']);
    // With no untargeted Output at all there is no default — `parts` alone,
    // which is what loader 0.6/0.8 needs to leave unclaimed meshes authored.
    expect(contributingOutputs([body, glass]).map((n) => n.id)).toEqual(['body', 'glass']);
    expect(findDefaultOutput([body, glass])?.id).toBe('body');
  });

  it('an INDEX-bound Output is targeted too — the split writes that binding at node level', () => {
    const def = named('def', 0, []);
    const idx = named('idx', 1, []);
    (idx.data as Record<string, unknown>).gltfMaterialIndex = 2;
    expect(contributingOutputs([def, idx]).map((n) => n.id)).toEqual(['def', 'idx']);
  });
});

describe('ONE node: the cross-node plans agree with the material-list ones', () => {
  // The equivalence that makes the pair safe to keep side by side — and the
  // reason the material-list form survives at all: `outputSectionCaps.test.ts`
  // pins it against graphToCode's own pre-Step-4 loop, so agreeing with it is
  // agreeing with the loop every committed byte-stability snapshot came out of.
  const FIXTURES: Record<string, OutputMaterial[]> = {
    'the default alone': [{}],
    'one mesh material': [{}, { meshTargets: ['Glass'] }],
    'a targeted material 0': [{ meshTargets: ['Body'] }, { meshTargets: ['Glass'] }],
    'a duplicate claim': [{}, { meshTargets: ['Glass'] }, { meshTargets: ['Glass'] }],
    'a partial overlap': [{}, { meshTargets: ['A', 'B'] }, { meshTargets: ['B', 'C'] }],
    'an empty added section': [{}, { meshTargets: [] }, { meshTargets: ['A'] }],
    'an unusable name': [{}, { meshTargets: ['__proto__', '', 'ok'] as string[] }],
  };

  for (const [label, materials] of Object.entries(FIXTURES)) {
    it(`agrees on ${label}`, () => {
      const node = out('n', 0, { meshTargets: materials[0].meshTargets, materials: materials.slice(1) });
      const one = planNamedParts(outputMaterials(node));
      const across = planNamedPartsAcross([node]);
      expect(across.entries.map(({ name, section }) => ({ name, section }))).toEqual(one.entries);
      expect(across.entries.every((e) => e.nodeId === 'n')).toBe(true);
      expect(across.shadowed.get('n') ?? new Set()).toEqual(one.shadowed);
      expect(across.overCap).toEqual(one.overCap);
      expect(countSectionsAcross([node])).toEqual(countSections(outputMaterials(node)));
    });
  }

  it('agrees on the INDEX plan and the mirror plan too', () => {
    const SIG = ['mA', 'mB', 'mC'];
    const node = out('n', 0, {
      modelSignature: { materials: SIG },
      modelMeshes: [{ name: 'Hull', material: 0 }, { name: 'Glass', material: 1 }],
      materials: [{ gltfMaterialIndex: 1 }, { gltfMaterialIndex: 0 }, { gltfMaterialIndex: 1 }],
    });
    const one = planIndexParts(outputMaterials(node), SIG);
    const across = planIndexPartsAcross([node], SIG);
    expect(across.entries.map(({ gltfIndex, section }) => ({ gltfIndex, section }))).toEqual(one.entries);
    expect(across.duplicates.get('n') ?? new Set()).toEqual(one.duplicates);
    expect(materialPartsMirrorPlanAcross([node])).toEqual(materialPartsMirrorPlan(node));
  });
});
