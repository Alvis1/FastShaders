/**
 * THE BYTE-IDENTITY HARNESS for the Output-node split (plan step 5).
 *
 * Rule 5 of the split is that **the emitted module text does not change**: the
 * same logical content in the FOLDED shape (one Output carrying
 * `data.materials`) and in the UNFOLDED one (one Output NODE per material, all
 * on bare channel handles) must produce byte-identical output, so loader
 * 0.6/0.8, the single-GLB export, `materialPartsMirror`, the GLB contract and
 * every committed snapshot are untouched and ONLY the graph shape moves.
 *
 * Nothing else can prove that mechanically. The byte-stability suites pin the
 * folded shape against its own history; the unfold's own suite pins the shape
 * it produces. Only this file puts the two side by side.
 *
 * Three rules keep it from being fooled:
 *
 *  - the unfolded document is DERIVED by running the real
 *    `unfoldOutputMaterials` over the folded one, never hand-built to a shape
 *    that happens to agree;
 *  - both sides go through the SAME `emit`, which is the real emission stack —
 *    `graphToCode` for the editor TSL and `buildShaderModule` for the module,
 *    the latter carrying the cross-node mirror plan, since the loader-0.6
 *    mirrors are MODULE-only (materialPartsContract R7) and are exactly what
 *    B5's `modelMeshes` order decides;
 *  - a VACUITY guard asserts the corpus really emits multi-entry `parts` and
 *    `materialParts` tables, so the comparison can never degenerate into two
 *    empty maps agreeing with each other.
 */
import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { buildShaderModule } from './tslCodeProcessor';
import { buildGltfSectionGraph } from './gltfSectionBuilder';
import { encodeRequests } from '@/utils/gltfImportPlan';
import { encodeGltfImages, type GltfEncodedImage } from '@/utils/gltfTextureEncode';
import {
  aiGlb,
  allSlotsGlb,
  blenderGlb,
  fakeEncoder,
  fakeStash,
  interleavedGlb,
  readOk,
  scanGlb,
} from './gltfImportFixtures';
import { codeToGraph } from './codeToGraph';
import {
  channelHandle,
  contributingOutputs,
  gltfIndexOf,
  isIndexSection,
  materialPartsMirrorPlanAcross,
  materialTargetNames,
  moduleSettingsOutput,
  outputMaterials,
  outputsInEmitOrder,
  unfoldOutputMaterials,
} from '@/utils/outputMaterials';
import { generateEdgeId } from '@/utils/idGenerator';
import { makeEdge, makeNode } from '@/test-utils';
import type { AppEdge, AppNode, OutputMaterial, OutputNodeData } from '@/types';
import type { GltfModelReport } from '@/utils/gltfReader';

interface Doc { nodes: AppNode[]; edges: AppEdge[] }

/**
 * The emission surface a document has, in the two forms the split could move.
 *
 * `code` is the editor TSL (the `parts` / `materialParts` / `modelSignature`
 * keys and the `__partPixel<n>` wrappers); `module` is what the loader runs,
 * which adds the mirror `parts` entries and the `materialPartsMirror` list.
 * The calls are the ones the real surfaces make — `moduleSettingsOutput` for
 * the module's four top-level material keys (owner decision D1) and
 * `materialPartsMirrorPlanAcross(contributingOutputs(...))` for the mirrors,
 * the same pair `buildExportModule` and ShaderPreview pass.
 */
function emit(doc: Doc): { code: string; module: string } {
  const { code } = graphToCode(doc.nodes, doc.edges);
  const settings = (moduleSettingsOutput(doc.nodes)?.data as OutputNodeData | undefined)?.materialSettings;
  const module = buildShaderModule(code, {
    materialSettings: settings,
    materialPartsMirror: materialPartsMirrorPlanAcross(contributingOutputs(doc.nodes)),
  });
  return { code, module };
}

/**
 * Every Output NODE's BINDING, in emit order — `matchKey`'s own vocabulary
 * (utils/resyncPairing.ts), which is what the resync pairs on.
 */
function bindings(nodes: readonly AppNode[]): string[] {
  return outputsInEmitOrder(nodes.filter((n) => n.data.registryType === 'output')).map((n) => {
    const m = outputMaterials(n)[0];
    if (isIndexSection(m)) return `i${gltfIndexOf(m)}`;
    const names = materialTargetNames(m);
    return names.length === 0 ? 'default' : `n${[...names].sort().join(',')}`;
  });
}

/** The same document with every `data.materials` split into sibling nodes. */
function unfolded(doc: Doc): Doc {
  return unfoldOutputMaterials(doc.nodes, doc.edges);
}

/**
 * The INVERSE of the unfold, test-only: a split document collapsed back into
 * the one-node-carrying-`data.materials` shape.
 *
 * It exists because the producers moved. `gltfSectionBuilder` and `codeToGraph`
 * now build the split shape DIRECTLY, so nothing in production makes a folded
 * document any more — but every `.fastshader`, `fs:graph` autosave and saved
 * group written before the split still carries one, and the restore paths still
 * unfold it. Rule 5 is a claim about THOSE documents, so the comparison has to
 * keep a folded side; re-deriving it here (rather than rewriting this file over
 * the split shape) is what keeps the harness a proof against the old code
 * instead of a restatement of the new.
 *
 * It reproduces exactly what the pre-split builder wrote: material 0 is the
 * first Output's own fields, the rest ride `data.materials` in emit order,
 * `modelSignature` and `modelMeshes` sit on the one node, and every edge into a
 * sibling is re-pointed at `m<k>:<channel>` with a re-derived id (the id is a
 * function of the endpoints, so a stale one collides).
 */
function refold(doc: Doc): Doc {
  const outs = outputsInEmitOrder(doc.nodes.filter((n) => n.data.registryType === 'output'));
  if (outs.length < 2) return doc;
  const [head, ...rest] = outs;
  const data: Record<string, unknown> = { ...head.data };
  delete data.emitOrder;
  delete data.modelSignature;
  delete data.modelMeshes;
  const materials: OutputMaterial[] = rest.map((n) => {
    const m = outputMaterials(n)[0];
    const d = n.data as Record<string, unknown>;
    const entry: OutputMaterial = isIndexSection(m)
      ? { gltfMaterialIndex: gltfIndexOf(m)! }
      : { meshTargets: materialTargetNames(m) };
    if (d.values) entry.values = d.values as Record<string, string | number>;
    if (d.exposedPorts) entry.exposedPorts = d.exposedPorts as string[];
    if (d.materialSettings) entry.materialSettings = d.materialSettings as OutputMaterial['materialSettings'];
    // The pre-split builder kept both on the ONE node.
    if (d.modelSignature !== undefined) data.modelSignature = d.modelSignature;
    if (d.modelMeshes !== undefined) data.modelMeshes = d.modelMeshes;
    return entry;
  });
  data.materials = materials;
  const rank = new Map(rest.map((n, i) => [n.id, i + 1]));
  const foldedNode = { ...head, data } as AppNode;
  const keep = new Set(rest.map((n) => n.id));
  return {
    nodes: doc.nodes.filter((n) => !keep.has(n.id)).map((n) => (n.id === head.id ? foldedNode : n)),
    edges: doc.edges.map((e) => {
      const k = rank.get(e.target);
      if (k === undefined) return e;
      const handle = channelHandle(k, e.targetHandle ?? '');
      return {
        ...e,
        target: head.id,
        targetHandle: handle,
        id: generateEdgeId(e.source, e.sourceHandle ?? 'out', head.id, handle),
      };
    }),
  };
}

/**
 * The same document with its OUTPUT nodes REVERSED among themselves, every
 * other node left exactly where it was.
 *
 * Only the Outputs move, because the array is a real input to everything else:
 * `topologicalSort` seeds Kahn's queue from it, so permuting the feeders would
 * renumber `color1`/`color2` and the comparison would fail for a reason that
 * has nothing to do with the split. What this isolates is the invariant that
 * matters — NOTHING may derive emitted order, or the identity of the default
 * material, from where an Output happens to sit in the array.
 *
 * It is not hypothetical: `liftChildrenAfterParents` (NodeEditor.tsx) splices a
 * node into a new slot on an ordinary drag-into-a-group, and `useSyncEngine`
 * reorders on every Apply. A module that moved there would advance
 * `previewCode`, recompile the 3D preview, dirty the autosave and renumber
 * `__partPixel<n>` — on a layout gesture, with `errors: []`.
 */
function outputsReversed(doc: Doc): Doc {
  const outs = doc.nodes.filter((n) => n.data.registryType === 'output').reverse();
  let i = 0;
  return {
    nodes: doc.nodes.map((n) => (n.data.registryType === 'output' ? outs[i++] : n)),
    edges: doc.edges,
  };
}

/* ── the GLB corpus ──────────────────────────────────────────────────────── */

async function encodeAll(m: GltfModelReport, materials: number[]): Promise<Map<number, GltfEncodedImage>> {
  const { requests } = encodeRequests(m, materials);
  const r = await encodeGltfImages(m, requests, {
    modelName: 'model.glb',
    maxDim: null,
    deviceMaxDim: 2048,
    ignoreLimits: false,
    budgetChars: Infinity,
    encode: fakeEncoder([]),
    stash: fakeStash(),
  });
  return r.encoded;
}

/** A model's materials built into the SPLIT document the importer commits. */
async function builtDoc(bytes: Uint8Array): Promise<Doc> {
  const m = readOk(bytes);
  const materials = m.materials.filter((x) => x.usage.primitives > 0).map((x) => x.index);
  const encoded = await encodeAll(m, materials);
  const built = buildGltfSectionGraph(m, { materials, encoded });
  return { nodes: built.nodes, edges: built.edges };
}

const GLB_SHAPES: Record<string, () => Uint8Array> = {
  blender: blenderGlb,
  scan: scanGlb,
  ai: aiGlb,
  allSlots: allSlotsGlb,
  interleaved: interleavedGlb,
};

describe('the unfold does not move the module — import-built documents', () => {
  for (const [name, glb] of Object.entries(GLB_SHAPES)) {
    it(`${name}: folded and unfolded emit the identical editor TSL and module`, async () => {
      // The builder makes the SPLIT shape now; `refold` re-derives the shape a
      // `.fastshader` written before the split still carries, which is what
      // rule 5 is a claim about.
      const split = await builtDoc(glb());
      const folded = refold(split);
      const outputs = (ns: AppNode[]) => ns.filter((n) => n.data.registryType === 'output');
      expect(outputs(folded.nodes)).toHaveLength(1);
      expect(outputs(split.nodes).length).toBeGreaterThan(1);
      // The real restore path — the unfold over that folded document — really
      // ran, and lands on the same node count the builder produces.
      const restored = unfolded(folded);
      expect(outputs(restored.nodes).length).toBe(outputs(split.nodes).length);

      const a = emit(folded);
      const b = emit(split);
      expect(b.code).toBe(a.code);
      expect(b.module).toBe(a.module);
      expect(emit(restored).code).toBe(a.code);
      expect(emit(restored).module).toBe(a.module);
      // …and the split document emits the same module whichever slot each
      // Output sits in, which is what `emitRank` and `defaultOutput` are for.
      expect(emit(outputsReversed(split)).module).toBe(a.module);
    });
  }

  it('the corpus is not vacuous: a multi-entry materialParts table really emits', async () => {
    const { code, module } = emit(await builtDoc(blenderGlb()));
    // Three built materials → three `materialParts` entries plus a signature.
    expect(code).toMatch(/materialParts: \{ "0": \{.*"1": \{.*"2": \{/s);
    expect(code).toContain('modelSignature: { materials: [');
    // And the module carries the loader-0.6 mirrors of all three.
    expect(module).toContain('materialPartsMirror');
    expect(module).toMatch(/"Cube_1": \{/);
    expect(module).toMatch(/"Cube_2": \{/);
    expect(module).toMatch(/"Plate": \{/);
  });

  /**
   * B5. `gltfSectionBuilder` fills `modelMeshes` in FIRST-SCENE-APPEARANCE
   * order, which interleaves materials, and the mirror plan walks that stored
   * order into module TEXT. A per-material regroup would emit Bravo, Alpha,
   * Charlie — the unfold keeps the list whole on the lowest-ranked index node,
   * so the order survives the split.
   */
  /**
   * The ROUND TRIP, closed in both directions. Everything above proves the
   * split shape EMITS what the folded one emitted; this proves the module
   * PARSES BACK to the split shape it came from — same bindings, same order —
   * so `codeToGraph` and `unfoldOutputMaterials` cannot describe the document
   * differently. Without it each half could drift within its own suite while
   * an Apply silently re-bound every material.
   *
   * Bindings are compared as `i<glTF index>` / `n<sorted mesh names>` /
   * `default` — the resync's own `matchKey`, so what this asserts is exactly
   * what pairs. Node IDENTITY is not compared: the parse mints fresh ids and
   * `useSyncEngine` is what maps them back (outputSplitResync.test.ts).
   */
  it.each(Object.entries(GLB_SHAPES))(
    '%s: the emitted module parses back to the same Output set, in the same order',
    async (_name, glb) => {
      const split = await builtDoc(glb());
      const before = bindings(split.nodes);
      expect(before.length).toBeGreaterThan(1);
      const parsed = codeToGraph(emit(split).code);
      expect(parsed.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
      expect(bindings(parsed.nodes)).toEqual(before);
      // …and a second Apply is a fixed point: same bindings, same count.
      const again = codeToGraph(emit({ nodes: parsed.nodes, edges: parsed.edges }).code);
      expect(bindings(again.nodes)).toEqual(before);
      expect(again.nodes.filter((n) => n.data.registryType === 'output'))
        .toHaveLength(parsed.nodes.filter((n) => n.data.registryType === 'output').length);
    },
  );

  it('interleaved: the mirror keys stay in scene order across the split', async () => {
    const split = await builtDoc(interleavedGlb());
    const folded = refold(split);
    const order = (src: string) => ['Alpha', 'Bravo', 'Charlie']
      .map((n) => ({ n, at: src.indexOf(`"${n}": {`) }))
      .filter((e) => e.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((e) => e.n);
    expect(order(emit(folded).module)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(order(emit(unfolded(folded)).module)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(order(emit(split).module)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });
});

/* ── hand-built name-section documents ───────────────────────────────────── */

/** An Output carrying `materials`, plus the feeders every section wires. */
function namedDoc(opts: {
  /** Material 0's own mesh names — empty is the default material. */
  material0?: string[];
  /** Material 0's node-level settings. */
  settings0?: Record<string, unknown>;
  extraOutputs?: AppNode[];
}): Doc {
  const out = makeNode('out1', 'output');
  const d = out.data as Record<string, unknown>;
  if (opts.material0?.length) d.meshTargets = opts.material0;
  if (opts.settings0) d.materialSettings = opts.settings0;
  d.materials = [
    { meshTargets: ['Body'], materialSettings: { transparent: true, side: 'double' } },
    { meshTargets: ['Glass', 'Trim'], values: { roughness: 0.25 } },
    // An EMPTY section: kept by every sanitizer, emits nothing, and must keep
    // emitting nothing once it is a node of its own.
    { meshTargets: [] },
  ];
  const nodes: AppNode[] = [
    makeNode('c0', 'color', { hex: '#112233' }),
    makeNode('c1', 'color', { hex: '#445566' }),
    makeNode('c2', 'color', { hex: '#778899' }),
    makeNode('f1', 'float', { value: 0.5 }),
    out,
    ...(opts.extraOutputs ?? []),
  ];
  const edges: AppEdge[] = [
    makeEdge('c0', 'out', 'out1', 'color'),
    makeEdge('c1', 'out', 'out1', 'm1:color'),
    makeEdge('c2', 'out', 'out1', 'm1:emissive'),
    makeEdge('f1', 'out', 'out1', 'm2:discard'),
  ];
  return { nodes, edges };
}

describe('the unfold does not move the module — name sections', () => {
  it('a default plus two named sections emits identically split', () => {
    const folded = namedDoc({ settings0: { transparent: false } });
    const a = emit(folded);
    const b = emit(unfolded(folded));
    expect(b.code).toBe(a.code);
    expect(b.module).toBe(a.module);
    // Array order decides nothing — not the `parts` key order, and not which
    // node supplies the module's top-level channels.
    expect(emit(outputsReversed(unfolded(folded))).module).toBe(a.module);
    // Not vacuous: three mesh names and a per-part discard really emit.
    expect(a.code).toContain('"Body": {');
    expect(a.code).toContain('"Glass": {');
    expect(a.code).toContain('"Trim": {');
    // A per-part discard becomes an INDEXED `__partPixel<n>` wrapper in the
    // module — the numbering is what a reordered part list would move.
    expect(a.module).toContain('__partPixel');
  });

  it('a TARGETED material 0 (no module default) emits identically split', () => {
    const folded = namedDoc({ material0: ['Hull'] });
    const a = emit(folded);
    const b = emit(unfolded(folded));
    expect(b.code).toBe(a.code);
    expect(b.module).toBe(a.module);
    expect(a.code).toContain('"Hull": {');
    // Material 0 names a mesh, so the module carries NO top-level channels.
    expect(a.code).not.toMatch(/return \{ color: color1, parts/);
  });

  it('an inactive UNTARGETED second Output contributes nothing, folded or split', () => {
    const parked = makeNode('out2', 'output');
    const folded = namedDoc({ extraOutputs: [parked] });
    const withParked = emit(folded);
    const withoutParked = emit(namedDoc({}));
    expect(withParked.code).toBe(withoutParked.code);
    expect(emit(unfolded(folded)).code).toBe(withoutParked.code);
  });
});
