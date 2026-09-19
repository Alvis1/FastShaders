/**
 * The Output node's MATERIALS — one node, several materials, one per sub-mesh.
 *
 * The first design gave each targeted mesh its own Output NODE. This one keeps
 * a single Output and stacks materials inside it, which is what the canvas
 * wanted to say all along: a shader has one output, and a multi-mesh model just
 * means that output resolves differently per mesh. It also removes a whole
 * class of failure by construction — with one node there is no "which Output is
 * THE output" question to get wrong at ten call sites, no way to paste a rival
 * Output, and no document that has targets but no default.
 *
 * STORAGE. Material 0 is the node's OWN `values` / `exposedPorts` /
 * `materialSettings`, exactly where they have always lived; only the ADDED
 * materials ride `data.materials`. That is not tidiness — it is what keeps
 * every saved graph, every built-in preset and every exported `.js` byte-
 * identical: a document with no added materials has no `materials` key and
 * emits precisely what it emitted before this file existed.
 *
 * Material 0 is the default UNLESS it names a mesh of its own. Left alone it
 * shades every mesh no other material claims — the whole-model behaviour that
 * predates per-mesh shading, and what every single-material document does. Its
 * target lives in `data.meshTarget`, the field the earlier one-Output-per-mesh
 * shape already used for exactly this meaning, so a graph from that shape reads
 * correctly rather than losing it.
 *
 * A targeted material 0 means the module has NO default, which emits and runs
 * correctly (loader 0.6 leaves unclaimed meshes on their authored materials) but
 * cannot be told apart in CODE from an empty default beside the same parts —
 * there is nowhere in a `parts` map to record which material was the default.
 * `codeToGraph` therefore resolves that shape the historical way, so a
 * code-panel Apply NORMALIZES a targeted material 0 back into "empty default +
 * that material". Nothing is lost — every wire is re-created from the code and
 * the module re-emits byte-identically — but the node grows the empty default
 * section back, and the document is stable from then on.
 *
 * INDEX SECTIONS (GLB Phase 5). An ADDED material may be bound to a glTF
 * MATERIAL INDEX instead of mesh names — `gltfMaterialIndex` on the entry,
 * plus the node-level `modelSignature: { materials }` (the model's glTF
 * material names in order, read by the trusted-side reader at import) and
 * `modelMeshes` (the source of the loader-0.6 mirror entries, module-only).
 * Such a section emits into `materialParts`, keyed by the index, not into
 * `parts`. Index and names are EXCLUSIVE: `materialTargetNames` returns [] for
 * an index section, so every name consumer (parts emission, the name dormancy
 * rule, the fold, the pickers) sees it as nameless. Material 0 is never one.
 * The signature exists only while an index section does, so a graph without
 * one gains no key and emits byte-identically. Canonical order is index
 * sections (ascending glTF index), then named ones: the builder writes it, the
 * parse restores it, and the sanitizer never REORDERS (handles are positional).
 *
 * Index-section DORMANCY is trusted-side and all-or-nothing per node: the
 * sections are awake iff the LOADED model's facts (`previewMesh.gltf`, read by
 * the trusted glTF reader in `createPreviewMesh`) carry exactly the node's
 * signature (`indexSectionsAwake`). It never reads the sandbox's inventory or
 * the loader's `shader-material-parts` event — both are forgeable — and, like
 * name dormancy, it changes visibility only, never emission.
 *
 * HANDLES. Material 0 keeps the BARE channel ids (`color`, `emissive`, …) —
 * every saved edge, every `generateEdgeId` string and every consumer that reads
 * `targetHandle === 'color'` was authored against them. Added materials
 * namespace theirs as `m<n>:<channel>`. Both directions go through
 * `channelHandle`/`parseChannelHandle` so no caller ever builds one by hand.
 *
 * Pure and import-light, so the vitest node env covers it.
 */

import type { AppNode, AppEdge, MaterialSettings, OutputMaterial } from '@/types';
import { isUsableMeshName, MATERIAL_NAME_MAX, MAX_INVENTORY_MESHES } from './meshInventory';
// Type-only: the facts' shape. The reader itself is never imported here.
import type { GltfPreviewFacts } from './gltfReader';
import {
  GLTF_MATERIAL_INDEX_MAX,
  MAX_INDEX_MATERIALS,
  MAX_MIRROR_ENTRIES,
  emitRank,
  isGltfMaterialIndex,
  modelSignatureMatches,
  sanitizeModelSignature,
  type MaterialPartsMirrorEntry,
} from '@/engine/materialPartsContract';
import { generateEdgeId } from './idGenerator';
import { growGroupFrames } from './groupFrame';
// The Output def's real channel ids, for the unfold's handle validation. Read
// LAZILY (see `isOutputChannel`) — this module sits inside the store's import
// cycle, and `exposedPorts` below already reaches the registry, so this adds
// no edge to the graph.
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { OUTPUT_DEFAULT_EXPOSED } from './exposedPorts';
import { hasActiveFlag, isUntargetedOutput } from './sdfPartition';

export type { OutputMaterial, MaterialPartsMirrorEntry };
// The index-section caps live in the contract leaf (buildShaderModule reads
// them too, and the engine may not import this store-coupled module); they are
// re-exported so every editor surface keeps one import site for "the caps".
// `emitRank` is there for the same reason — utils/sdfPartition.ts is a leaf and
// must read the SAME accessor, never a second copy of it.
export { MAX_INDEX_MATERIALS, MAX_MIRROR_ENTRIES, emitRank };

/**
 * Most ADDED materials. Eight targeted meshes is already past what anyone
 * authors by hand, and each one is a whole generated material: N materials
 * compile to N pipelines and the preview recompiles ALL of them on every
 * 200 ms-debounced edit (measured ~55-62 ms each on desktop; Quest-class
 * hardware is slower).
 */
export const MAX_ADDED_MATERIALS = 8;

/**
 * Most `parts` entries one module may carry. Material 0 can name a mesh too, so
 * a fully-loaded node is `MAX_ADDED_MATERIALS` added materials plus that one —
 * bounding emission at `MAX_ADDED_MATERIALS` would silently drop the last
 * material the UI still draws and still lets the user wire.
 *
 * It is a PER-NODE cap and NEVER a module budget: the names one material may
 * carry (`materialTargetNames` caps on read), the named sections one node may
 * keep (the sanitizer), the picker's refused tenth row. `MAX_PART_ENTRIES`
 * below is the module's. A reader that counts a WHOLE MODULE with this constant
 * is off by a factor of ten — `codeToGraph`'s `parts` parse did exactly that
 * until 2026-09, destroying every material past the ninth on the first Apply.
 */
export const MAX_PARTS = MAX_ADDED_MATERIALS + 1;

/**
 * Most name-keyed `parts` ENTRIES one module may carry: every name the
 * sanitizer can admit (`MAX_PARTS` sections × `MAX_PARTS` names each), so the
 * emission cap can never bite sanitized data and never drop a mesh the node
 * still shows. Until 2026-09 emission capped at `MAX_PARTS` entries IN TOTAL,
 * so two sections naming five meshes each silently lost the tenth.
 */
export const MAX_PART_ENTRIES = (MAX_PARTS + 1) * MAX_PARTS;

/** Most `modelMeshes` entries (the loader-0.6 mirror source) one Output keeps. */
export const MAX_MODEL_MESHES = 256;

/** The highest glTF material index a section may name — the range of the
 *  module's `materialParts` key (MATERIAL_PART_KEY_RE, canonical decimal).
 *  Defined in the contract LEAF and re-exported here, so utils/sdfPartition.ts
 *  can ask the same question without importing this store-coupled module. */
export { GLTF_MATERIAL_INDEX_MAX };

/** The glTF material index an import-built INDEX section shades, else null.
 *  A number only — never coerced (`'1'` from a tampered file is not an index). */
export function gltfIndexOf(material: OutputMaterial | undefined): number | null {
  const v: unknown = material ? (material as { gltfMaterialIndex?: unknown }).gltfMaterialIndex : undefined;
  return isGltfMaterialIndex(v) ? v : null;
}

/** Is this an import-built INDEX section (bound to a glTF material, not to
 *  mesh names)? The value-level test; `planIndexParts` additionally requires
 *  the index to fall inside the node's signature. */
export function isIndexSection(material: OutputMaterial | undefined): boolean {
  return gltfIndexOf(material) !== null;
}

/**
 * The node's model signature as a name list, or null when absent or invalid —
 * through THE sanitizer (engine/materialPartsContract), so emission, the
 * mirror plan and the node read exactly what a restore path would keep.
 * `data` is node data; plain property access.
 */
/**
 * ONE answer per `data` OBJECT.
 *
 * Node data is REUSED across drag frames (`applyNodeChanges` hands back the
 * same `data` for a node that only moved) and is treated as IMMUTABLE
 * everywhere — every write is a fresh `{ ...data }` — so caching on it is
 * exact, and the entry dies with the node. A WeakMap and not a module-scope
 * Map, because this is keyed on adversarial, unbounded input.
 *
 * It pays on eight paths, most of them per NODE per store notify: the Output
 * card's bindings key, its index-claim labels, `moduleSignatureOf`, the node's
 * own signature read, ShaderSettingsMenu, CodeEditor's mirror key, the GLB
 * export plan, and `previewWireTargets` TWICE per contributing node.
 *
 * `sanitizeModelSignature` already returns the SAME array for a clean
 * `{ materials }`, so the cache preserves the identity callers memoize on.
 */
const signatureCache = new WeakMap<object, string[] | null>();

export function readModelSignature(data: unknown): string[] | null {
  if (!data || typeof data !== 'object') return null;
  // `!== undefined`, not a truthiness test: a cached `null` is a HIT.
  const hit = signatureCache.get(data);
  if (hit !== undefined) return hit;
  const sig = sanitizeModelSignature((data as { modelSignature?: unknown }).modelSignature)?.materials ?? null;
  signatureCache.set(data, sig);
  return sig;
}

/** Separator between the material prefix and the channel in a handle id. */
const SEP = ':';
const HANDLE_RE = /^m([1-9]\d*):(.+)$/;

/**
 * The handle id for `channel` on the material at `index`.
 *
 * Index 0 returns the BARE channel — the id every existing graph already uses.
 */
export function channelHandle(index: number, channel: string): string {
  return index === 0 ? channel : `m${index}${SEP}${channel}`;
}

/** Split a handle id back into its material index and channel. */
export function parseChannelHandle(handle: string): { index: number; channel: string } {
  const m = HANDLE_RE.exec(handle);
  return m ? { index: Number(m[1]), channel: m[2] } : { index: 0, channel: handle };
}

/** Read the node's added materials, or an empty list. */
function addedMaterials(node: AppNode): OutputMaterial[] {
  if (node.data.registryType !== 'output') return [];
  const raw = (node.data as { materials?: unknown }).materials;
  return Array.isArray(raw) ? (raw as OutputMaterial[]) : [];
}

/**
 * Every material on this node, material 0 first.
 *
 * Material 0 is synthesized from the node's own fields, so callers never do the
 * off-by-one between `materials[k]` and material index `k + 1`.
 *
 * Its BINDING comes from whichever of the two node-level forms is present: a
 * `gltfMaterialIndex` makes it an INDEX section, otherwise the mesh-name list.
 * A section is ONE kind, so the index wins outright and any names beside it are
 * ignored — exactly what `sanitizeOutputMaterials` does to an index ENTRY that
 * also carried names.
 *
 * The index form is what `unfoldOutputMaterials` writes: once a node IS one
 * material, an import-built section's glTF binding has nowhere else to live.
 * No document that has not been through the unfold carries one (the builder
 * writes indices inside `materials`, and the sanitizer used to delete a
 * node-level copy outright), so every existing graph resolves through the name
 * branch exactly as before and emits byte-identically.
 */
export function outputMaterials(node: AppNode): OutputMaterial[] {
  if (node.data.registryType !== 'output') return [];
  const d = node.data as {
    values?: Record<string, string | number>;
    exposedPorts?: string[];
    materialSettings?: MaterialSettings;
    meshTargets?: string[];
    meshTarget?: { name: string };
    gltfMaterialIndex?: unknown;
  };
  const shared = {
    values: d.values,
    exposedPorts: d.exposedPorts,
    materialSettings: d.materialSettings,
  };
  return [
    isGltfMaterialIndex(d.gltfMaterialIndex)
      ? { gltfMaterialIndex: d.gltfMaterialIndex, ...shared }
      : { meshTargets: d.meshTargets, meshTarget: d.meshTarget, ...shared },
    ...addedMaterials(node),
  ];
}

/** How many materials this node carries (always >= 1). */
export function materialCount(node: AppNode): number {
  return 1 + addedMaterials(node).length;
}

/**
 * Every mesh a material shades: de-duped, all usable, capped.
 *
 * ONE material may name SEVERAL meshes — the picker is a checkbox list — and
 * each named mesh becomes its own `parts` entry carrying that material's
 * channels. So this is the accessor; `meshTargets` is the field, and the older
 * single `meshTarget: { name }` is still READ (never written) so a graph or a
 * saved group from before the list existed keeps its target.
 *
 * Empty means THE DEFAULT: the material shades every mesh no other material
 * claims. Only material 0 may be in that state — an added material with no
 * usable name means nothing and is dropped by the sanitizer. So "is this the
 * default" is `materialTargetNames(m).length === 0`, always over the whole
 * list: a `[0]`-plus-null-check helper existed here until 2026-09-05, called by
 * nothing, and a first-name test is exactly the assumption-about-the-rest this
 * rule exists to forbid. A surface that shows ONE label for a section goes
 * through `sectionLabel` below (ShaderSettingsMenu's scope line);
 * MeshTargetPicker's closed label is the one remaining reader of `[0]`.
 */
export function materialTargetNames(material: OutputMaterial | undefined): string[] {
  // Index sections are nameless by construction: `parts` emission, the name
  // dormancy rule, the fold and the pickers must never see names on one.
  if (isIndexSection(material)) return [];
  const out: string[] = [];
  const push = (name: unknown) => {
    if (!isUsableMeshName(name) || out.includes(name) || out.length >= MAX_PARTS) return;
    out.push(name);
  };
  const list = material?.meshTargets;
  if (Array.isArray(list)) for (const n of list) push(n);
  else push(material?.meshTarget?.name);
  return out;
}

/**
 * THE total order the Output nodes emit in: `emitRank` first, node id as the
 * tie-break, duplicate ids dropped (first wins, the `byId` idiom).
 *
 * BOTH halves are load-bearing. The RANK exists because the nodes ARRAY is not
 * a usable order and never can be — `liftChildrenAfterParents` splices a node
 * into a new slot on an ordinary drag-into-a-group and `useSyncEngine` reorders
 * on every Apply, so deriving emitted order from it would rewrite the module on
 * a layout gesture (`previewCode` advances, the preview recompiles, the autosave
 * dirties, `__partPixel<n>` renumbers, first-claim-wins flips on a duplicate
 * mesh name) with `errors: []` and nothing on screen to explain it. The ID
 * tie-break exists because a rank is NOT unique: `unfoldOutputMaterials` seeds
 * every node it makes from its material index, so two folded Outputs unfolded
 * in one document each produce a node 0 carrying `emitOrder: 0` — and
 * `Array.prototype.sort` is stable, so without the tie-break those two would
 * fall back to array order, which is the very thing the rank replaces.
 *
 * Duplicate ids are dropped rather than planned twice: a plan keyed by node id
 * cannot say anything sensible about two nodes claiming one id, and React Flow
 * cannot render them either.
 */
export function outputsInEmitOrder(outputs: readonly AppNode[]): AppNode[] {
  const byId = new Map<string, AppNode>();
  for (const n of outputs) if (!byId.has(n.id)) byId.set(n.id, n);
  return [...byId.values()].sort(
    (a, b) => emitRank(a) - emitRank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The name `parts` plan: which mesh name each section emits, first claim wins. */
export interface NamedPartsPlan {
  /** Emitted entries, in section order, each name once. */
  entries: { name: string; section: number }[];
  /** Sections that NAME a mesh but emit no entry: every name was claimed by
   *  a section above (or, on data no sanitizer admitted, fell past the cap).
   *  An EMPTY section is never shadowed — it is "No mesh", a different state. */
  shadowed: Set<number>;
  /** Names past `MAX_PART_ENTRIES`, dropped at emission. Empty for every
   *  graph a restore path has sanitized (9 × 9 = 81 < 90). */
  overCap: string[];
}

/** The same plan ACROSS several Output nodes: one claim set, one cap counter,
 *  one emitted order. Entries and shadowed sections carry the node they belong
 *  to, because a section INDEX stops being unique the moment materials live on
 *  more than one node. */
export interface NamedPartsPlanAcross {
  /** Emitted entries, in (emitRank, id) node order then section order. */
  entries: { name: string; nodeId: string; section: number }[];
  /** node id → that node's shadowed sections. A node with none is ABSENT, so a
   *  reader wanting "is section i of node n shadowed" asks
   *  `shadowed.get(n)?.has(i)`. */
  shadowed: Map<string, Set<number>>;
  /** Names past `MAX_PART_ENTRIES` — a running total across every node, never
   *  a per-node budget: the cap bounds ONE MODULE's `parts` map. */
  overCap: string[];
}

/** The first-claim state a whole plan shares: the claimed names and the ONE
 *  entry list whose length is the cap. Passing it from node to node is what
 *  makes the cap a running total and the claim set global. */
interface NamedClaimState {
  entries: { name: string; nodeId: string; section: number }[];
  overCap: string[];
  claimed: Set<string>;
}

/**
 * THE one first-claim-wins loop over one node's named sections, into a shared
 * state. Returns THIS node's shadowed sections.
 *
 * Both entry points below run this same body, so the per-node form (the fold's
 * in-progress list, and `outputSectionCaps.test.ts`'s golden against
 * graphToCode's pre-Step-4 loop) and the cross-node form cannot drift.
 */
function claimNamedParts(
  st: NamedClaimState,
  materials: readonly OutputMaterial[],
  nodeId: string,
): Set<number> {
  const shadowed = new Set<number>();
  for (let i = 0; i < materials.length; i++) {
    const names = materialTargetNames(materials[i]);
    if (names.length === 0) continue;
    let emitted = 0;
    for (const name of names) {
      if (st.claimed.has(name)) continue;
      if (st.entries.length >= MAX_PART_ENTRIES) { st.overCap.push(name); continue; }
      st.claimed.add(name);
      st.entries.push({ name, nodeId, section: i });
      emitted++;
    }
    if (emitted === 0) shadowed.add(i);
  }
  return shadowed;
}

/**
 * THE one first-claim-wins loop over the named sections of ONE material list.
 * Emission (graphToCode's `parts`) and the node's shadowed mark both read it —
 * through `planNamedPartsAcross` since the plans went cross-node — so the two
 * can never disagree about which section a mesh belongs to.
 *
 * FIRST CLAIM WINS for a duplicate name: a `parts` map has one slot per mesh, and
 * a duplicate arrives only from a hand-edited or foreign file (the picker MOVES
 * a mesh rather than duplicating it). The cap is `MAX_PART_ENTRIES`; a name past
 * it is reported in `overCap` and NOT claimed. For every graph with at most
 * `MAX_PARTS` entries this is exactly the order emission has always used.
 *
 * THE MATERIALS-FORM PAIR, and why it survives with no production caller.
 * Since the plans went cross-node, emission reads `planNamedPartsAcross` and
 * this form is reached only from `outputSectionCaps.test.ts` — where it carries
 * the GOLDEN that pins this loop against graphToCode's own pre-Step-4 one, i.e.
 * against the loop every committed byte-stability snapshot came out of. That
 * golden is written over a material LIST and cannot be restated over a node set
 * without becoming a restatement of the new code instead of the old. Both forms
 * run the SAME `claimNamedParts` body, so the golden still covers what emission
 * executes, and `outputPlansAcross.test.ts` pins the one-node equivalence that
 * makes that transitive. The same reasoning keeps `planIndexParts`,
 * `indexSectionCoverage`, `pickFreeMesh`, `defaultSectionUnused` and
 * `materialPartsMirrorPlan` beside their `…Across` twins. None of them has a
 * production caller any more (`countSections`' last one went with
 * `foldExtraOutputs`).
 *
 * THEY ARE KEPT, deliberately, and step 6b decided so rather than deferring it
 * again. Retiring them means rewriting that golden over a node set, which turns
 * a proof against the OLD emission loop into a restatement of the new one — the
 * single thing tying today's plans to the code every committed snapshot came
 * out of. An untested-in-production primitive costs a few dozen lines; losing
 * that proof cannot be undone, because the loop it pins no longer exists to
 * re-derive it from.
 */
export function planNamedParts(materials: readonly OutputMaterial[]): NamedPartsPlan {
  const st: NamedClaimState = { entries: [], overCap: [], claimed: new Set() };
  const shadowed = claimNamedParts(st, materials, '');
  return {
    entries: st.entries.map(({ name, section }) => ({ name, section })),
    shadowed,
    overCap: st.overCap,
  };
}

/**
 * The name `parts` plan across a SET of Output nodes — what emission reads.
 *
 * ONE claim set and ONE cap counter for the whole call: `parts` is a single map
 * in a single module, so a mesh claimed by an earlier-ranked node must not be
 * re-claimed by a later one, and `MAX_PART_ENTRIES` bounds that map rather than
 * each node's share of it. Nodes are visited in `outputsInEmitOrder`, never in
 * the order the caller happened to hold them.
 */
export function planNamedPartsAcross(outputs: readonly AppNode[]): NamedPartsPlanAcross {
  const st: NamedClaimState = { entries: [], overCap: [], claimed: new Set() };
  const shadowed = new Map<string, Set<number>>();
  for (const n of outputsInEmitOrder(outputs)) {
    const s = claimNamedParts(st, outputMaterials(n), n.id);
    if (s.size > 0) shadowed.set(n.id, s);
  }
  return { entries: st.entries, shadowed, overCap: st.overCap };
}

/** The index-section plan: which section emits each glTF index, first claim wins. */
export interface IndexPartsPlan {
  /** Emitted entries, ascending by glTF index, each index once. */
  entries: { gltfIndex: number; section: number }[];
  /** Sections whose glTF index an EARLIER section already claims: inert. */
  duplicates: Set<number>;
  /** Sections past `MAX_INDEX_MATERIALS`: dropped at emission. Empty for
   *  every graph a restore path has sanitized. */
  overCap: number[];
}

/** The same plan ACROSS several Output nodes: one claim set, one cap counter.
 *  No node tie-break is needed in `entries` — an index is claimed once, so
 *  ascending glTF index is already a total order (which is why B1 says
 *  `materialParts` needs no `emitOrder` of its own); the node order decides
 *  only WHICH section wins a duplicate index. */
export interface IndexPartsPlanAcross {
  entries: { gltfIndex: number; nodeId: string; section: number }[];
  /** node id → that node's sections whose index an earlier one claims. Absent
   *  for a node with none. */
  duplicates: Map<string, Set<number>>;
  overCap: { nodeId: string; section: number }[];
}

/** The first-claim state an index plan shares — the index twin of
 *  `NamedClaimState`, and shared for the same reason. */
interface IndexClaimState {
  entries: { gltfIndex: number; nodeId: string; section: number }[];
  overCap: { nodeId: string; section: number }[];
  claimed: Set<number>;
}

/**
 * One node's index sections into a shared state; returns ITS duplicates.
 *
 * From `i = 0`, because material 0 CAN be an index section: once
 * `unfoldOutputMaterials` gives each material its own node, an import-built
 * section's glTF binding is the node's own (`outputMaterials` reads it from
 * `data.gltfMaterialIndex`). While every material lived on one node it never
 * could be — the builder writes indices into `materials` and the sanitizer
 * deleted a node-level copy — so this loop started at 1, and starting there
 * after the split dropped the WHOLE `materialParts` table of every GLB-built
 * shader: `return vec3(1, 0, 0);`, with `errors: []`. For a document that has
 * not been split, `gltfIndexOf(materials[0])` is null and the extra iteration
 * changes nothing (`unfoldEmissionParity.test.ts` pins that both ways).
 */
function claimIndexParts(
  st: IndexClaimState,
  materials: readonly OutputMaterial[],
  signature: readonly string[],
  nodeId: string,
): Set<number> {
  const duplicates = new Set<number>();
  for (let i = 0; i < materials.length; i++) {
    const g = gltfIndexOf(materials[i]);
    if (g === null || g >= signature.length) continue;
    if (st.claimed.has(g)) { duplicates.add(i); continue; }
    if (st.entries.length >= MAX_INDEX_MATERIALS) { st.overCap.push({ nodeId, section: i }); continue; }
    st.claimed.add(g);
    st.entries.push({ gltfIndex: g, nodeId, section: i });
  }
  return duplicates;
}

/**
 * THE one first-claim-wins loop over ONE material list's INDEX sections (the
 * `planNamedParts` twin): emission's `materialParts`, the mirror plan and the
 * node's shadowed mark all read it, through `planIndexPartsAcross`. Nothing is
 * emitted without a valid signature, and an index at or past its length is
 * skipped (defensive: the sanitizer detaches those). A duplicate index cannot
 * be encoded — `materialParts` has one slot per material — so the later section
 * is shadowed, as a duplicate NAME is.
 */
export function planIndexParts(
  materials: readonly OutputMaterial[],
  signature: readonly string[] | null,
): IndexPartsPlan {
  if (!signature) return { entries: [], duplicates: new Set(), overCap: [] };
  const st: IndexClaimState = { entries: [], overCap: [], claimed: new Set() };
  const duplicates = claimIndexParts(st, materials, signature, '');
  const entries = st.entries.map(({ gltfIndex, section }) => ({ gltfIndex, section }));
  entries.sort((a, b) => a.gltfIndex - b.gltfIndex);
  return { entries, duplicates, overCap: st.overCap.map((e) => e.section) };
}

/**
 * The `materialParts` plan across a SET of Output nodes — what emission reads.
 *
 * ONE claim set and ONE `MAX_INDEX_MATERIALS` counter, for the same reason the
 * name plan shares its own: `materialParts` is a single map in a single module.
 *
 * ONE signature governs the whole call, which is the invariant the split keeps:
 * `modelSignature` is REPLICATED onto every index node and the sanitizer
 * DETACHES any index node whose copy differs, so a document can never have two
 * live signatures to choose between (see `materialPartsMirrorPlanAcross`, which
 * reads the lowest-ranked index node's copy).
 */
export function planIndexPartsAcross(
  outputs: readonly AppNode[],
  signature: readonly string[] | null,
): IndexPartsPlanAcross {
  if (!signature) return { entries: [], duplicates: new Map(), overCap: [] };
  const st: IndexClaimState = { entries: [], overCap: [], claimed: new Set() };
  const duplicates = new Map<string, Set<number>>();
  for (const n of outputsInEmitOrder(outputs)) {
    const d = claimIndexParts(st, outputMaterials(n), signature, n.id);
    if (d.size > 0) duplicates.set(n.id, d);
  }
  st.entries.sort((a, b) => a.gltfIndex - b.gltfIndex);
  return { entries: st.entries, duplicates, overCap: st.overCap };
}

/**
 * The ADDED sections by kind. The two caps are counted SEPARATELY everywhere
 * (`MAX_PARTS`/`MAX_ADDED_MATERIALS` for named ones, `MAX_INDEX_MATERIALS` for
 * index ones), so an import-built Output never blocks "+ Add output".
 */
export function countSections(materials: readonly OutputMaterial[]): { named: number; index: number } {
  let named = 0;
  let index = 0;
  for (let i = 1; i < materials.length; i++) {
    if (isIndexSection(materials[i])) index++;
    else named++;
  }
  return { named, index };
}

/**
 * The ADDED sections by kind across a SET of Output nodes — a RUNNING TOTAL,
 * not a per-node budget, because both caps bound what ONE MODULE may carry.
 */
export function countSectionsAcross(outputs: readonly AppNode[]): { named: number; index: number } {
  let named = 0;
  let index = 0;
  for (const n of outputsInEmitOrder(outputs)) {
    const c = countSections(outputMaterials(n));
    named += c.named;
    index += c.index;
  }
  return { named, index };
}

/**
 * A glTF material name as DISPLAY text: control, line-terminator and
 * bidi-override characters become U+FFFD (the name is attacker-supplied and
 * may be up to 1024 characters of anything) and it is capped at
 * MATERIAL_NAME_MAX code points plus an ellipsis. Display only — the
 * signature comparison always uses the raw name.
 */
export function displayMaterialName(raw: string): string {
  const cleaned = String(raw).replace(
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    '\ufffd',
  );
  const points = Array.from(cleaned);
  return points.length > MATERIAL_NAME_MAX ? points.slice(0, MATERIAL_NAME_MAX).join('') + '\u2026' : cleaned;
}

/**
 * What ONE label for a section says, as data (`formatSectionLabel` in
 * nodes/sectionLabelText.ts turns it into words). The default is material 0
 * with no target; a named section shows its FIRST mesh plus whether there are
 * more; an added section with no mesh is `empty` ("No mesh", as on the node);
 * an INDEX section names its glTF material (`name` is display text, '' for an
 * unnamed material — the formatter then says "Material #<gltfIndex>").
 */
export type SectionLabel =
  | { kind: 'default' }
  | { kind: 'named'; first: string; more: boolean }
  | { kind: 'empty' }
  | { kind: 'index'; gltfIndex: number; name: string };

export function sectionLabel(
  materials: readonly OutputMaterial[],
  index: number,
  signature: readonly string[] | null = null,
): SectionLabel {
  // Asked at EVERY index, material 0 included: once `unfoldOutputMaterials`
  // gives each material its own node, an import-built section's glTF binding is
  // the node's own (`outputMaterials` reads `data.gltfMaterialIndex` into
  // material 0), so an `index > 0` guard labelled every split index node "All
  // meshes (default)" — the node's chip and the settings menu's scope line both
  // claiming it shades the whole model while emission gave it one glTF
  // material. For an unsplit document `gltfIndexOf(materials[0])` is null and
  // the extra read changes nothing (`claimIndexParts` documents the same fix).
  const g = gltfIndexOf(materials[index]);
  if (g !== null) return { kind: 'index', gltfIndex: g, name: displayMaterialName(signature?.[g] ?? '') };
  const names = materialTargetNames(materials[index]);
  if (names.length > 0) return { kind: 'named', first: names[0], more: names.length > 1 };
  return index === 0 ? { kind: 'default' } : { kind: 'empty' };
}

/**
 * Added materials whose EVERY named mesh is absent from the live inventory —
 * DORMANT: the model on screen has no surface they could shade, so the Output
 * node hides their sections behind a one-line chip and shows them again,
 * wiring intact, the moment a model carrying their names is loaded.
 *
 * A pure VISIBILITY rule, deliberately not a data rule: the materials, their
 * edges, the undo history and EMISSION are all untouched — emission may never
 * depend on the inventory, which is session-only (absent after every reload)
 * and forgeable by the sandboxed preview — and that untouched data is what
 * makes the "restore" perfect by construction. An EMPTY material never hides
 * (it names nothing to be missing — it is a state to resolve, shown as
 * "No mesh"), and a PARTIALLY missing material stays visible with its absent
 * names marked by the picker.
 *
 * FROM `i = 0`, because material 0 CAN carry a binding of its own: once
 * `unfoldOutputMaterials` gives each material its own node, THE node's binding
 * is material 0's (`outputMaterials` reads `meshTargets` straight off the node
 * data), so a loop starting at 1 meant a split targeted node could never sleep
 * — dormancy was dead in the split shape, silently, with every consumer still
 * calling this. It is safe both ways: the DEFAULT material names nothing, so
 * the `targets.length > 0` gate already excludes it, which is what "material 0
 * never hides" really rested on. A legacy folded node whose material 0 names a
 * mesh now sleeps with it, which is the same answer the split gives that
 * document after one restore.
 *
 * Consumers must agree: OutputNode skips a dormant section — and, split, a
 * dormant NODE renders header-plus-chip — and folds this set into its
 * updateNodeInternals key (a hidden section UNMOUNTS real channel handles, and
 * the remount must be re-measured or restored wires never draw); PreviewLink
 * counts only visible materials for its wire paths.
 */
export function dormantMaterialIndices(
  materials: readonly OutputMaterial[],
  meshNames: readonly string[],
): Set<number> {
  const present = new Set(meshNames);
  const dormant = new Set<number>();
  for (let i = 0; i < materials.length; i++) {
    const targets = materialTargetNames(materials[i]);
    if (targets.length > 0 && targets.every((n) => !present.has(n))) dormant.add(i);
  }
  return dormant;
}

/** Stored channel values graphToCode deliberately treats as no-ops and emits
 *  NOTHING for (zero discard/displacement, the identity normal texel — see
 *  the Output stored-value contract in CLAUDE.md). Lives here, not in
 *  OutputNode, so the node's red-fallback swatch and
 *  `outputDefaultContributes` share ONE notion of "this value emits". */
export function storedValueEmits(channel: string, v: unknown): boolean {
  if (v === undefined || v === null || v === '') return false;
  if (channel === 'discard' || channel === 'position') return Number(v) !== 0;
  if (channel === 'normal') return String(v).toLowerCase() !== '#8080ff';
  return true;
}

/**
 * Does MATERIAL 0 contribute anything to the emitted module? Mirrors
 * graphToCode's channelEntries test: a wire on a bare channel handle, or an
 * emitting stored value on an EXPOSED channel (emission is exposure-gated, so
 * a tampered value on a hidden channel must not count — the same guard the
 * node's red-fallback swatch applies). False means the module is PARTS-ONLY,
 * which is what arms the 0.6 loader's single-mesh fallback — see
 * `dormantIndicesForPreview`.
 */
export function outputDefaultContributes(
  node: AppNode,
  edges: readonly Pick<AppEdge, 'target' | 'targetHandle'>[],
): boolean {
  if (
    edges.some(
      (e) =>
        e.target === node.id &&
        typeof e.targetHandle === 'string' &&
        parseChannelHandle(e.targetHandle).index === 0,
    )
  ) {
    return true;
  }
  const data = node.data as { values?: Record<string, unknown>; exposedPorts?: unknown };
  const values = data.values;
  if (!values) return false;
  const exposed = new Set(
    Array.isArray(data.exposedPorts)
      ? data.exposedPorts.filter((p): p is string => typeof p === 'string')
      : OUTPUT_DEFAULT_EXPOSED,
  );
  return Object.entries(values).some(([ch, v]) => exposed.has(ch) && storedValueEmits(ch, v));
}

/**
 * Does an ADDED material contribute a channel — i.e. does emission produce a
 * `parts` entry for it that `buildShaderModule` will KEEP?
 *
 * The same test `outputDefaultContributes` makes for material 0, over the
 * material's own values and its own exposed list: a wire on one of its
 * handles, or an emitting stored value on an EXPOSED channel (emission is
 * exposure-gated, so a tampered value on a hidden channel must not count).
 *
 * False is the state the owner reported as "when I add a section and choose
 * the mesh to apply to, it does not assign the color, only after I change it"
 * (2026-09-18): `buildShaderModule` drops a part with no channels
 * (`props.length > 0`), so the meshes the section names keep exactly what they
 * had, while the node drew the section's unwired Color row at the CHANNEL
 * DEFAULT — a white the preview never paints. It is a normal, momentary state
 * (every "+ Add output" starts here), so it is MARKED rather than prevented:
 * seeding a value would repaint the claimed mesh the instant the section
 * appears, throwing away the authored/index material to announce an empty
 * block.
 *
 * `wired` is "any edge lands on this material's channel handles", which the
 * node already knows from its `wiredLabels` map — passing it keeps this
 * function free of the edge list and usable from a component that does not
 * subscribe to edges.
 */
export function addedMaterialContributes(
  material: OutputMaterial | undefined,
  wired: boolean,
): boolean {
  if (wired) return true;
  const values = material?.values;
  if (!values || typeof values !== 'object') return false;
  const exposed = new Set(materialExposedPorts(material, OUTPUT_DEFAULT_EXPOSED));
  return Object.entries(values).some(([ch, v]) => exposed.has(ch) && storedValueEmits(ch, v));
}

/**
 * The dormant set every SURFACE actually uses — `dormantMaterialIndices` plus
 * the two context rules all consumers must share (OutputNode's render,
 * PreviewLink's wire count, NodeEditor's scoped onError):
 *
 * 1. UNKNOWN inventory hides NOTHING. A custom model that is loaded but has
 *    not reported yet (`previewMesh` set, inventory null — every model swap
 *    passes through this window) must not flash the chip claiming "for
 *    another model" about the very model that is loading.
 * 2. The 0.6 loader's single-mesh fallback is MIRRORED: a parts-only module
 *    (the DEFAULT material contributes nothing) on a ONE-mesh model paints the
 *    FIRST part — that material is actively shading the screen, and hiding it
 *    behind a chip that says "for another model" would be a lie. It stays
 *    visible with its missing names marked, the pre-dormancy honest state.
 *    `meshNames.length <= 1` covers both the one-mesh custom model (one
 *    reported name) and every primitive/built-in (no inventory, one unnamed
 *    mesh).
 *
 *    `firstNamedHere` is what keeps that rule about the MODULE rather than
 *    about one node. The exemption belongs to the module's first emitted named
 *    part; with every material on one node that is this list's own first named
 *    material, which is why it defaults to true and every existing caller is
 *    unchanged. Split per material, each node holds exactly one — so without
 *    the flag EVERY targeted node would exempt itself and none would ever
 *    sleep. The caller passes `firstNamedOutputId(outputs) === node.id`.
 */
export function dormantIndicesForPreview(
  materials: readonly OutputMaterial[],
  opts: {
    meshNames: readonly string[];
    inventoryKnown: boolean;
    /** Does the MODULE's default material contribute a channel? Split, that is
     *  `defaultOutput(nodes)`, not this node. */
    defaultContributes: boolean;
    /** REQUIRED, so a caller that forgot index sections fails tsc:
     *  `indexSectionsAwake(readModelSignature(data), loadedModelOf(previewMesh))`. */
    indexSectionsAwake: boolean;
    /** May this material list claim rule 2's single-mesh exemption? Default
     *  true (the one-node shape); see the rule above. */
    firstNamedHere?: boolean;
  },
): Set<number> {
  const dormant = new Set<number>();
  if (opts.inventoryKnown) {
    for (const i of dormantMaterialIndices(materials, opts.meshNames)) dormant.add(i);
    if (!opts.defaultContributes && opts.meshNames.length <= 1 && opts.firstNamedHere !== false) {
      // Rule 2 lands on the first NAMED material; an index section is
      // nameless, so it can never be the one the exemption picks.
      for (let i = 0; i < materials.length; i++) {
        if (materialTargetNames(materials[i]).length > 0) {
          dormant.delete(i);
          break;
        }
      }
    }
  }
  // Rule 3: INDEX sections sleep all-or-nothing when the loaded model's
  // trusted signature differs — never from the inventory, so rule 1's
  // hold-off does not apply to them (the facts exist the moment the model is
  // dropped). From `i = 0` for `dormantMaterialIndices`' reason: split, the
  // node's own binding IS material 0's, so starting at 1 left every
  // import-built Output permanently awake on the wrong model.
  if (!opts.indexSectionsAwake) {
    for (let i = 0; i < materials.length; i++) {
      if (isIndexSection(materials[i])) dormant.add(i);
    }
  }
  return dormant;
}

/**
 * The lowest-ranked Output node holding a NAMED binding — the node whose
 * material the 0.6 loader's single-mesh fallback would paint, i.e. the one
 * allowed to claim rule 2's exemption above (`firstNamedHere`). Null when no
 * Output names a mesh.
 *
 * `outputsInEmitOrder`, never array order: the module's first `parts` entry is
 * decided by `emitRank`, and the nodes array is reordered by an ordinary
 * drag-into-a-group.
 */
export function firstNamedOutputId(outputs: readonly AppNode[]): string | null {
  for (const n of outputsInEmitOrder(outputs)) {
    if (outputMaterials(n).some((m) => materialTargetNames(m).length > 0)) return n.id;
  }
  return null;
}

/**
 * What the loaded preview model says about glTF materials, as the index
 * sections need it:
 *  - `none`: no custom model (a primitive or a built-in is showing);
 *  - `not-gltf`: an OBJ, which has no glTF materials;
 *  - `unknown`: a glb/gltf whose facts are absent or were refused — the
 *    reader is strict, so this hides NOTHING (rule 1's analogue);
 *  - `gltf`: the trusted facts, signature plus mesh → material indices.
 */
export type LoadedModel =
  | { readonly kind: 'none' }
  | { readonly kind: 'not-gltf' }
  | { readonly kind: 'unknown' }
  | {
    readonly kind: 'gltf';
    readonly signature: readonly string[];
    readonly meshMaterials: GltfPreviewFacts['meshMaterials'];
  };

const LOADED_NONE: LoadedModel = Object.freeze({ kind: 'none' });
const LOADED_NOT_GLTF: LoadedModel = Object.freeze({ kind: 'not-gltf' });
const LOADED_UNKNOWN: LoadedModel = Object.freeze({ kind: 'unknown' });
/** One result per facts object, so a memo keyed on the result stays put. */
const loadedGltfCache = new WeakMap<object, LoadedModel>();

/**
 * `store.previewMesh` as a `LoadedModel`. Takes `unknown` (the whole-store
 * selectors type it so) and reads with plain property access. The three
 * fact-less answers are frozen module constants and a `gltf` answer is cached
 * per facts object, so selector results and memos stay identity-stable.
 */
export function loadedModelOf(pm: unknown): LoadedModel {
  if (!pm || typeof pm !== 'object') return LOADED_NONE;
  const kind: unknown = (pm as { kind?: unknown }).kind;
  if (kind !== 'glb' && kind !== 'gltf') return LOADED_NOT_GLTF;
  const facts: unknown = (pm as { gltf?: unknown }).gltf;
  if (!facts || typeof facts !== 'object') return LOADED_UNKNOWN;
  const cached = loadedGltfCache.get(facts);
  if (cached) return cached;
  const signature: unknown = (facts as { signature?: unknown }).signature;
  const meshMaterials: unknown = (facts as { meshMaterials?: unknown }).meshMaterials;
  if (!Array.isArray(signature) || !(meshMaterials instanceof Map)) return LOADED_UNKNOWN;
  const out: LoadedModel = Object.freeze({
    kind: 'gltf' as const,
    signature: signature as readonly string[],
    meshMaterials: meshMaterials as GltfPreviewFacts['meshMaterials'],
  });
  loadedGltfCache.set(facts, out);
  return out;
}

/**
 * The preview mesh index sections are judged against: `previewMesh` only while
 * the 3D pane SHOWS it (`previewShowsModel`, written by ShaderPreview from the
 * geometry it renders). Picking Sphere in the Model menu while a glTF stays
 * loaded therefore reads as no model, so the sections sleep instead of claiming
 * meshes the pane is not drawing. An absent flag means shown.
 */
export function shownPreviewMesh(state: { previewMesh: unknown; previewShowsModel?: boolean }): unknown {
  return state.previewShowsModel === false ? null : state.previewMesh;
}

/**
 * Are a node's index sections AWAKE on the loaded model? False without a
 * signature and with no glTF loaded (`none`, `not-gltf`); TRUE for `unknown`
 * (an unreadable glTF hides nothing); for `gltf`, loader 0.8's exact rule
 * (`modelSignatureMatches`: same count, every raw name `===` in order — never
 * the display-sanitized name).
 */
export function indexSectionsAwake(nodeSig: readonly string[] | null, loaded: LoadedModel): boolean {
  if (!nodeSig) return false;
  if (loaded.kind === 'unknown') return true;
  if (loaded.kind !== 'gltf') return false;
  return modelSignatureMatches(
    { materials: nodeSig as string[] },
    { materials: loaded.signature as string[] },
  );
}

/**
 * What ONE index section does on the loaded model:
 *  - `duplicate`: an earlier section claims the same glTF index (first claim
 *    wins, `planIndexParts`), so this one emits nothing;
 *  - `unknown`: the model's meshes are not known (no trusted facts, or the
 *    section is asleep);
 *  - `unused`: no mesh of the loaded model wears this material;
 *  - `overridden`: every mesh that wears it is claimed by a NAME section,
 *    which wins (0.8's precedence), so this section does nothing;
 *  - `covered`: it shades `meshes` minus `overridden`.
 * `meshes` are the reader's PREDICTED GLTFLoader names — possibly uncertain,
 * which only ever affects these marks, never emission.
 */
export interface IndexCoverage {
  meshes: string[];
  overridden: string[];
  state: 'duplicate' | 'unknown' | 'unused' | 'overridden' | 'covered';
}

/**
 * The coverage of every index section on this node, keyed by section index
 * (a section outside its signature — which the sanitizer detaches — has no
 * entry). `namedPlan` is THE name plan (`planNamedParts`), so "overridden"
 * means exactly the names emission gives to a name section. Bounded:
 * sections × at most MAX_INVENTORY_MESHES names × each name's few indices.
 */
export function indexSectionCoverage(
  materials: readonly OutputMaterial[],
  signature: readonly string[] | null,
  loaded: LoadedModel,
  namedPlan: NamedPartsPlan,
): Map<number, IndexCoverage> {
  if (!signature) return new Map();
  return coverageOfMaterials(
    materials,
    signature,
    loaded,
    new Set(namedPlan.entries.map((e) => e.name)),
    planIndexParts(materials, signature).duplicates,
  );
}

/**
 * The coverage of every index section of ONE node, given the CROSS-NODE answers
 * to the two questions that are not this node's to decide: which names a name
 * section claims anywhere (`claimedByName`) and which of this node's sections a
 * higher-ranked one shadows (`duplicates`). Both entry points run this body.
 */
function coverageOfMaterials(
  materials: readonly OutputMaterial[],
  signature: readonly string[],
  loaded: LoadedModel,
  claimedByName: ReadonlySet<string>,
  duplicates: ReadonlySet<number>,
): Map<number, IndexCoverage> {
  const out = new Map<number, IndexCoverage>();
  const known = loaded.kind === 'gltf' && indexSectionsAwake(signature, loaded);
  // From `i = 0` — `claimIndexParts`' reason, and it has to match it exactly:
  // split, material 0 IS the index section, so a loop from 1 left every
  // import-built Output with an EMPTY coverage map while emission happily
  // claimed its glTF index. The chip then showed `unknown` (just the material
  // name, no meshes, no override mark), the picker rows lost their "also in
  // material section X" hint and `defaultSectionUnusedAcross` counted no
  // index-covered mesh, so the default never read as unused.
  for (let i = 0; i < materials.length; i++) {
    const g = gltfIndexOf(materials[i]);
    if (g === null || g >= signature.length) continue;
    const meshes: string[] = [];
    if (known && loaded.kind === 'gltf') {
      for (const [name, e] of loaded.meshMaterials) {
        if (meshes.length >= MAX_INVENTORY_MESHES) break;
        if (e.materials.includes(g)) meshes.push(name);
      }
    }
    const overridden = meshes.filter((n) => claimedByName.has(n));
    const state: IndexCoverage['state'] = duplicates.has(i)
      ? 'duplicate'
      : !known
        ? 'unknown'
        : meshes.length === 0
          ? 'unused'
          : overridden.length === meshes.length
            ? 'overridden'
            : 'covered';
    out.set(i, { meshes, overridden, state });
  }
  return out;
}

/** Every index section's coverage across a SET of Output nodes: node id →
 *  section → coverage. A node with no index section is ABSENT, so a reader
 *  asks `byNode.get(id) ?? EMPTY`. The two cross-node questions — which names
 *  a name section claims, and which sections a higher-ranked node shadows —
 *  are answered once for the whole call. */
export function indexSectionCoverageAcross(
  outputs: readonly AppNode[],
  signature: readonly string[] | null,
  loaded: LoadedModel,
  namedPlan: NamedPartsPlanAcross,
): Map<string, Map<number, IndexCoverage>> {
  const out = new Map<string, Map<number, IndexCoverage>>();
  if (!signature) return out;
  const claimedByName = new Set(namedPlan.entries.map((e) => e.name));
  const indexPlan = planIndexPartsAcross(outputs, signature);
  for (const n of outputsInEmitOrder(outputs)) {
    const c = coverageOfMaterials(
      outputMaterials(n),
      signature,
      loaded,
      claimedByName,
      indexPlan.duplicates.get(n.id) ?? EMPTY_SECTIONS,
    );
    if (c.size > 0) out.set(n.id, c);
  }
  return out;
}

/** Shared empty set — a plan omits a node with nothing to report, and handing
 *  every such lookup a fresh `new Set()` would allocate per node per render. */
const EMPTY_SECTIONS: ReadonlySet<number> = new Set<number>();

/**
 * The mesh "+ Add output" seeds a new NAME section with: first one no name
 * section claims and no index section covers, else one no name section
 * claims — which then OVERRIDES its material's index section (the name claim
 * wins), the intended way to restyle one mesh of an imported material. Null
 * when every mesh is name-claimed. Never mints a duplicate NAME claim, which
 * would arrive inert.
 */
export function pickFreeMesh(
  meshNames: readonly string[],
  materials: readonly OutputMaterial[],
  coverage: ReadonlyMap<number, IndexCoverage>,
): string | null {
  const claimed = new Set(materials.flatMap((m) => materialTargetNames(m)));
  const covered = new Set<string>();
  for (const c of coverage.values()) for (const n of c.meshes) covered.add(n);
  return pickFrom(meshNames, claimed, covered);
}

/** The same choice across a SET of Output nodes: a mesh is taken if ANY of them
 *  names it, and covered if any of their index sections covers it. Per node the
 *  answer would be wrong in the dangerous direction — it would hand back a mesh
 *  another Output already claims, and the new section would arrive inert. */
export function pickFreeMeshAcross(
  meshNames: readonly string[],
  outputs: readonly AppNode[],
  coverage: ReadonlyMap<string, ReadonlyMap<number, IndexCoverage>>,
): string | null {
  const claimed = new Set<string>();
  for (const n of outputsInEmitOrder(outputs)) {
    for (const m of outputMaterials(n)) for (const name of materialTargetNames(m)) claimed.add(name);
  }
  const covered = new Set<string>();
  for (const byNode of coverage.values()) for (const c of byNode.values()) for (const n of c.meshes) covered.add(n);
  return pickFrom(meshNames, claimed, covered);
}

/** The two-pass preference both forms share: an entirely free mesh first, then
 *  one only an index section covers (which the new NAME section overrides). */
function pickFrom(
  meshNames: readonly string[],
  claimed: ReadonlySet<string>,
  covered: ReadonlySet<string>,
): string | null {
  return meshNames.find((n) => !claimed.has(n) && !covered.has(n))
    ?? meshNames.find((n) => !claimed.has(n))
    ?? null;
}

/**
 * Does the DEFAULT section (material 0, untargeted) shade NOTHING of the model
 * on screen?
 *
 * Material 0 means "every mesh the sections below do not claim". After a GLB
 * import that is usually NONE — one index section per glTF material covers the
 * whole model — so the node opens with a block whose channels look exactly like
 * a fresh Output's and change nothing when wired. Reported from the canvas as
 * the Output "doubling with the PBR … like a dead part" (owner, 2026-09-18).
 *
 * It is NOT dead, which is why the section is MARKED rather than removed or
 * hidden: it shades any mesh whose material has no section of its own (a model
 * past `MAX_INDEX_MATERIALS`), and it shades EVERYTHING again the moment a
 * model with other materials is loaded, when the index sections sleep. Marking
 * leaves every control where it was, changes no data and changes no emission.
 *
 * True only when the answer is KNOWN and negative: material 0 names nothing
 * (a TARGETED material 0 shades exactly its own meshes), there is at least one
 * section below it, the preview has reported meshes, and every one of them is
 * claimed by a name section or covered by an AWAKE index section — a sleeping
 * one covers nothing (`indexSectionCoverage`), so a different model puts the
 * default back to work and the mark disappears with it.
 */
export function defaultSectionUnused(
  meshNames: readonly string[],
  materials: readonly OutputMaterial[],
  namedPlan: NamedPartsPlan,
  coverage: ReadonlyMap<number, IndexCoverage>,
): boolean {
  if (materials.length < 2 || meshNames.length === 0) return false;
  if (materialTargetNames(materials[0]).length > 0) return false;
  // The names emission really gives to a name section (first claim wins), plus
  // every mesh an index section covers — `pickFreeMesh`'s two sets.
  const taken = new Set(namedPlan.entries.map((e) => e.name));
  for (const c of coverage.values()) for (const n of c.meshes) taken.add(n);
  return meshNames.every((n) => taken.has(n));
}

/**
 * The same mark across a SET of Output nodes. The section judged is material 0
 * of `defaultOutput` — THE node that owns the module's top-level channels, and
 * the only one whose block the mark belongs on — while "is there a section
 * below it" and "is every mesh taken" are answered across every node handed in.
 *
 * `defaultOutput` and NOT the lowest-ranked node, which is what this asked
 * while every material still lived on one node: split per material, an
 * untargeted Output is not necessarily first (a PARKED whole-model variant is
 * untargeted too, and an import-built document's lowest-ranked node is a
 * TARGETED index node). Judging the lowest-ranked one would put the mark on a
 * node that is not the default at all — and would read its targeted binding as
 * "material 0 names a mesh" and bail, so the real default never got the mark.
 *
 * No default → false: there is no whole-model block to mark.
 *
 * "A section below" becomes "any OTHER section anywhere", which for a single
 * node is exactly today's `materials.length >= 2` and for several nodes also
 * counts the other nodes' materials.
 */
export function defaultSectionUnusedAcross(
  meshNames: readonly string[],
  outputs: readonly AppNode[],
  namedPlan: NamedPartsPlanAcross,
  coverage: ReadonlyMap<string, ReadonlyMap<number, IndexCoverage>>,
): boolean {
  const ordered = outputsInEmitOrder(outputs);
  if (ordered.length === 0 || meshNames.length === 0) return false;
  const def = defaultOutput(ordered);
  if (!def) return false;
  let total = 0;
  for (const n of ordered) total += outputMaterials(n).length;
  // "A section below" = any material at all besides the default's own one.
  if (total < 2) return false;
  const taken = new Set(namedPlan.entries.map((e) => e.name));
  for (const byNode of coverage.values()) for (const c of byNode.values()) for (const n of c.meshes) taken.add(n);
  return meshNames.every((n) => taken.has(n));
}

/** The whole-store shape both derivations below read. */
interface DormancyState {
  nodes: readonly AppNode[];
  edges: readonly AppEdge[];
  previewMesh: unknown;
  previewShowsModel?: boolean;
  previewMeshInventory: { meshes?: readonly { name: string }[] } | null;
}

/**
 * The `dormantIndicesForPreview` opts for ONE Output node, derived from the
 * whole store — so both whole-store consumers ask identical questions.
 *
 * Two of the five are CROSS-NODE and cannot be read off `out`:
 *  - `defaultContributes` is about the MODULE's default material, which after
 *    the per-material split is usually a SIBLING of the node being judged.
 *    Reading it off `out` asked "does this targeted node contribute", which is
 *    a different question with a different answer.
 *  - `firstNamedHere` decides which node may claim the 0.6 single-mesh
 *    fallback exemption; split, every targeted node would otherwise claim it
 *    and none would ever sleep.
 */
function dormancyOptsFor(state: DormancyState, out: AppNode) {
  const outs = outputNodes(state.nodes as AppNode[]);
  const def = defaultOutput(outs);
  return {
    meshNames: (state.previewMeshInventory?.meshes ?? []).map((m) => m.name),
    inventoryKnown: !state.previewMesh || !!state.previewMeshInventory,
    defaultContributes: def ? outputDefaultContributes(def, state.edges) : false,
    indexSectionsAwake: indexAwakeFor(out, outputMaterials(out), shownPreviewMesh(state)),
    firstNamedHere: firstNamedOutputId(outs) === out.id,
  };
}

/**
 * The whole-store dormancy derivation — and, since the per-material Output
 * split, one with NO PRODUCTION CALLER. Both consumers it was written for have
 * moved: PreviewLink's selector went to `previewWireTargets`, and NodeEditor's
 * scoped React Flow 008 suppression to `outputEdgeIsDormant`, which asks the
 * node a wire actually lands on rather than "is material n asleep anywhere".
 *
 * Kept, like the materials-form plan primitives above, because it is the
 * tested statement of the rule those two now restate in their own shapes, and
 * because its suites are the ones that pin what dormancy MEANS over a whole
 * store. Delete it only together with a replacement for that coverage — a
 * silently retired derivation is how the two live copies start to disagree.
 *
 * OutputNode derives the same opts from its granular subscriptions instead (a
 * whole-store selector there would re-render every Output per notify);
 * `outputTargetChip.test.ts` pins that both routes end in
 * `dormantIndicesForPreview`.
 */
export function outputDormancyFromState(state: DormancyState): {
  outputId: string | null;
  dormant: Set<number>;
  visibleCount: number;
} {
  const out = findDefaultOutput(state.nodes as AppNode[]);
  if (!out) return { outputId: null, dormant: new Set(), visibleCount: 0 };
  const materials = outputMaterials(out);
  const dormant = dormantIndicesForPreview(materials, dormancyOptsFor(state, out));
  return { outputId: out.id, dormant, visibleCount: materials.length - dormant.size };
}

/** One decorative Output→preview wire: the node it leaves, and what that node
 *  shades — as DATA, so the selector key that carries it is language-free and
 *  `linkLabelText` (nodes/sectionLabelText.ts) does the wording. */
export interface PreviewWireTarget {
  id: string;
  label: SectionLabel;
}

/**
 * The Output nodes the decorative preview wires leave from, in EMIT ORDER —
 * ONE WIRE PER CONTRIBUTING OUTPUT NODE.
 *
 * It was one wire per MATERIAL SECTION of the single Output; per-material
 * splitting turns that into one per node by construction, and `contributing
 * Outputs` is the same set emission reads, so the canvas cannot show a wire
 * from a node the module ignores (a PARKED untargeted Output) or miss one from
 * a node it emits.
 *
 * DORMANT nodes are left out, which is the same rule the retired per-section
 * count followed: a dormant Output renders header-plus-chip and mounts NO
 * preview socket, so its wire would have no anchor and PreviewLink's element
 * cache would re-query every frame for as long as the node sleeps. Its wiring
 * is untouched and the wire returns with the node.
 *
 * The three CROSS-NODE dormancy opts are derived ONCE for the whole set rather
 * than through `dormancyOptsFor` per node: that helper re-walks the edge list
 * for `defaultContributes` on every call, which on an import-built document is
 * one whole-graph walk per glTF material, per store notify, during a drag.
 *
 * A DRIVING Raymarch Output is deliberately NOT consulted here — it silences
 * every plain Output, but `activeSink`'s fallbacks are array-order dependent
 * and its callers do not all hold the same array (`contributingOutputs`
 * documents the same rule). PreviewLink answers that question once, in its own
 * selector, and skips this entirely when a march drives.
 */
export function previewWireTargets(state: DormancyState): PreviewWireTarget[] {
  const nodes = state.nodes as AppNode[];
  const outs = outputNodes(nodes);
  if (outs.length === 0) return [];
  const def = defaultOutput(outs);
  const meshNames = (state.previewMeshInventory?.meshes ?? []).map((m) => m.name);
  const inventoryKnown = !state.previewMesh || !!state.previewMeshInventory;
  const defaultContributes = def ? outputDefaultContributes(def, state.edges) : false;
  const firstNamed = firstNamedOutputId(outs);
  const shown = shownPreviewMesh(state);
  const wires: PreviewWireTarget[] = [];
  for (const n of contributingOutputs(nodes)) {
    const materials = outputMaterials(n);
    const dormant = dormantIndicesForPreview(materials, {
      meshNames,
      inventoryKnown,
      defaultContributes,
      indexSectionsAwake: indexAwakeFor(n, materials, shown),
      firstNamedHere: firstNamed === n.id,
    });
    // Material 0 is the NODE — `OutputNode`'s own `nodeDormant = dormant.has(
    // SELF)`, SELF being 0 — so this is the same question the card answers when
    // it decides to render its socket at all.
    if (dormant.has(0)) continue;
    wires.push({ id: n.id, label: sectionLabel(materials, 0, readModelSignature(n.data)) });
  }
  return wires;
}

/**
 * The `indexSectionsAwake` opt for one Output, as the whole-store selectors
 * derive it. Per notify, so the signature is sanitized and compared only
 * when the node really carries an index section (true otherwise is
 * equivalent: there is nothing for the flag to put to sleep).
 */
function indexAwakeFor(out: AppNode, materials: readonly OutputMaterial[], previewMesh: unknown): boolean {
  if (!materials.some(isIndexSection)) return true;
  return indexSectionsAwake(readModelSignature(out.data), loadedModelOf(previewMesh));
}

/**
 * Does this EDGE land on a legitimately-absent Output handle — i.e. is its
 * target a dormant material, whose unmounted handles are the visibility rule's
 * steady state rather than a bug?
 *
 * THE question NodeEditor's scoped 008 swallow asks. It takes an edge ID and
 * not a handle because React Flow's message carries both, and only the edge id
 * identifies a NODE: several Outputs may coexist (one active) and they all
 * spell their handles the same way, so a handle-keyed test had to ask "is
 * material `n` dormant ANYWHERE" and would excuse a real 008 about an awake
 * section on a different node. Resolving the edge answers for the node the
 * wire actually ends on.
 *
 * The edge is LOOKED UP rather than parsed out of its id: `generateEdgeId`
 * joins four fields with `-` and two of them come out of a `.fastshader` file,
 * so the composite has no unambiguous reverse. `state.edges` is the very array
 * React Flow renders (NodeEditor passes `s.edges` by reference), so the lookup
 * always finds an edge React Flow is complaining about.
 *
 * False for everything else — an unknown id, a non-Output target, a collapsed
 * group's boundary handle — so the warning is printed.
 *
 * A BARE channel handle is now excusable too, and must be: since the split a
 * dormant Output is a whole NODE, which renders header-plus-chip and unmounts
 * every one of its bare channel handles. It is still narrow — the node has to
 * be asleep, which the DEFAULT never is (it names nothing, so no dormancy rule
 * can reach it) — so an 008 about the node that owns the module's top-level
 * channels still reports as the missing-`useUpdateNodeInternals` bug it is.
 */
export function outputEdgeIsDormant(state: DormancyState, edgeId: string): boolean {
  const edge = state.edges.find((e) => e.id === edgeId);
  if (!edge || typeof edge.targetHandle !== 'string') return false;
  const out = state.nodes.find((n) => n.id === edge.target);
  if (!out || !isOutputNode(out)) return false;
  const dormant = dormantIndicesForPreview(outputMaterials(out), dormancyOptsFor(state, out));
  return dormant.has(parseChannelHandle(edge.targetHandle).index);
}

/**
 * Give material `index` exactly `names`, taking each of them away from every
 * OTHER material.
 *
 * A mesh belongs to ONE material. Ticking it somewhere else MOVES it rather
 * than duplicating it, which is what makes the checkbox list behave the way a
 * list of assignments should: no inert second claim, no first-wins tie for
 * emission to break, and no disabled rows — the earlier objection to locking
 * them was that swapping two materials' meshes became impossible, and moving
 * makes the swap the ordinary two clicks.
 *
 * A material stripped of its LAST mesh is KEPT, empty. That is the state a swap
 * passes through (two single-mesh materials cannot exchange meshes without one
 * of them being briefly empty), so the alternatives are both worse: deleting it
 * destroys a section and its wiring on a checkbox tick, and refusing the tick
 * makes the checkbox silently do nothing. Empty means "shades nothing yet" —
 * NOT a second default; only material 0's empty list means "everything else" —
 * and the node marks it, because a material contributing nothing must not look
 * like one that works.
 *
 * Pure: returns a fresh list, material 0 first, and never mutates its input.
 *
 * NO PRODUCTION CALLER since the per-material Output split — `assignMeshTargets
 * Across` below is what the node writes through, because "every OTHER material"
 * became "every other NODE". Kept on the materials-form plans' terms (see
 * `planNamedParts`): it is the tested statement of the move-not-duplicate rule
 * the cross-node form has to obey.
 */
export function assignMeshTargets(
  materials: readonly OutputMaterial[],
  index: number,
  names: readonly string[],
): OutputMaterial[] {
  // An index section is bound to a MATERIAL, not to names: targeting one is
  // refused (a fresh list, per the purity contract), and every index section
  // below keeps its object reference and gains no `meshTargets` key. A mesh
  // ticked in a NAME section that an index section's material also covers is
  // an OVERRIDE (the name claim wins, loader 0.8's precedence), not a move.
  if (isIndexSection(materials[index])) return materials.map((m) => m);
  const taken = new Set(names);
  return materials.map((m, i) => {
    if (isIndexSection(m)) return m;
    // The legacy single-target key is dropped on any edit, so the two shapes
    // can never disagree about what a material shades.
    const { meshTarget: _legacy, ...rest } = m;
    return {
      ...rest,
      meshTargets: i === index
        ? [...names]
        : materialTargetNames(m).filter((n) => !taken.has(n)),
    };
  });
}

/**
 * Give the Output NODE `nodeId` exactly `names`, taking each of them away from
 * every OTHER Output node.
 *
 * `assignMeshTargets`' rule, one level up: a mesh belongs to exactly ONE
 * material, and after the per-material split "another material" is another
 * NODE. So this is necessarily a MULTI-NODE write — `updateNodeData` cannot
 * express it, and doing it as two writes would make Cmd+Z step through a
 * half-assigned state where two Outputs briefly claim the same mesh. The caller
 * wraps ONE `setNodes` in `asOneHistoryEntry`.
 *
 * An INDEX-bound node is never re-targeted and never stripped: it is bound to a
 * glTF MATERIAL, has no names to take, and a mesh ticked here that its material
 * also covers is an OVERRIDE (the name claim wins, loader 0.8's precedence),
 * not a move.
 *
 * Pure, and returns the SAME array when nothing changed — the reference
 * contract every other graph-shaped helper here holds, because the autosave
 * subscriber and `selectionOnlyGraphChange` compare nodes by identity. Node
 * objects that do not change are returned by reference for the same reason.
 */
export function assignMeshTargetsAcross(
  nodes: readonly AppNode[],
  nodeId: string,
  names: readonly string[],
): AppNode[] {
  const target = nodes.find((n) => n.id === nodeId);
  if (!target || !isOutputNode(target) || isIndexSection(outputMaterials(target)[0])) {
    return nodes as AppNode[];
  }
  const wanted = [...new Set(names.filter(isUsableMeshName))];
  const taken = new Set(wanted);
  let changed = false;
  const next = nodes.map((n) => {
    if (!isOutputNode(n)) return n;
    if (isIndexSection(outputMaterials(n)[0])) return n;
    const current = materialTargetNames(outputMaterials(n)[0]);
    const keep = n.id === nodeId ? wanted : current.filter((x) => !taken.has(x));
    const d = n.data as { meshTargets?: unknown; meshTarget?: unknown };
    // Nothing to write: same names, and neither shape key needs cleaning up.
    const sameNames = keep.length === current.length && keep.every((x, i) => x === current[i]);
    if (sameNames && Array.isArray(d.meshTargets) === (keep.length > 0) && d.meshTarget === undefined) return n;
    changed = true;
    // The legacy single-target key is dropped on any edit, so the two shapes
    // can never disagree about what a node shades. An empty list drops the key
    // outright rather than storing `[]`, so an untargeted node is JSON-identical
    // to one that was never targeted.
    const data = { ...n.data } as Record<string, unknown>;
    delete data.meshTarget;
    if (keep.length > 0) data.meshTargets = keep;
    else delete data.meshTargets;
    return { ...n, data } as AppNode;
  });
  return changed ? (next as AppNode[]) : (nodes as AppNode[]);
}

/**
 * THE model signature that governs a module's `materialParts` table: the one
 * carried by the lowest-ranked contributing Output that holds an index section.
 *
 * `graphToCode` and the Output node both ask it, so it lives here rather than
 * being spelled twice — the node's red-sentinel test has to agree with what
 * emission really writes, and two copies of "which signature governs" is
 * exactly the drift the cross-node plans were extracted to stop. Null when no
 * Output carries an index section, which is byte-neutral: `planIndexPartsAcross`
 * then yields no entries either way.
 *
 * `outputs` must already be in emit order (`contributingOutputs` returns them
 * that way) — the sanitizer REPLICATES one signature onto every index node and
 * detaches any whose copy differs, so there is never a choice to make, but the
 * order is what makes "lowest-ranked" true rather than accidental.
 */
export function moduleSignatureOf(outputs: readonly AppNode[]): string[] | null {
  return readModelSignature(outputs.find((n) => outputMaterials(n).some(isIndexSection))?.data);
}

/**
 * A material's effective exposed channels.
 *
 * The `effectiveExposedPorts` rule, applied per material: an explicit list is
 * honoured (an empty one means "every channel hidden"), and only an ABSENT list
 * falls back to the default set — so an added material starts life showing the
 * same channels a fresh Output does.
 */
export function materialExposedPorts(
  material: OutputMaterial | undefined,
  defaults: readonly string[],
): string[] {
  const raw = material?.exposedPorts;
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
  return [...defaults];
}

/** Is this node an Output? (Shared so callers stop re-deriving the test.) */
export function isOutputNode(node: AppNode): boolean {
  return node.data.registryType === 'output';
}

/** Every Output node, in array (creation) order. */
export function outputNodes(nodes: readonly AppNode[]): AppNode[] {
  return nodes.filter(isOutputNode);
}

/**
 * "THE Output" is THREE questions, and they answer differently the moment a
 * TARGETED Output exists. Every call site picks one of these deliberately.
 *
 *   `defaultOutput`        — who owns the module's TOP-LEVEL channels.
 *   `moduleSettingsOutput` — whose `materialSettings` the module writes.
 *   `findDefaultOutput`    — where do I point the USER (the settings menu's
 *                            fallback node, and Preview mode's anchor).
 *
 * They were one function (`flagged ?? outputs[0]`), blind to whether the node
 * names a mesh of its own. That is safe only while ONE Output holds every
 * material: split per material, handing a TARGETED node the top-level channels
 * paints its material twice — once as its own `parts`/`materialParts` entry
 * and once at module level over every unclaimed mesh.
 *
 * `outputs[0]` is ARRAY order, which is what makes that reachable. MEASURED:
 * `gltfSectionBuilder` pushes the untargeted default first, so an import-built
 * document's first Output is in fact the DEFAULT — but the array does not STAY
 * that way (`liftChildrenAfterParents` splices a node into a new slot on a
 * drag-into-a-group, `useSyncEngine` reorders on every Apply), so what the
 * predicates test is the BINDING, never the position.
 */

/**
 * The DEFAULT material's Output — the node that owns the module's top-level
 * channels: the flagged-and-untargeted one when there is one, else the
 * LOWEST-RANKED untargeted one, else NULL.
 *
 * Lowest-RANKED, not first-in-array, and that is not tidiness. After
 * `unfoldOutputMaterials` an EMPTY section — a material with no mesh names,
 * which "shades nothing" and is the state a mesh swap passes through — is its
 * own node, and its own node is untargeted. Position was what told it apart
 * from the default while every material lived on one node ("only material 0's
 * empty list means everything else"); once each is a node, `emitRank` is.
 * Picking by array order instead handed the module's top-level channels to
 * whichever of them came first, so an ordinary drag-into-a-group
 * (`liftChildrenAfterParents` splices a node into a new slot) could silently
 * drop `color:` from the module — MEASURED by reversing the Output nodes of a
 * split document, which is why the parity harness reverses them.
 *
 * Ties keep ARRAY order (strict `<`), so a document that has never been split
 * — where every rank is the absent-key 0 — elects exactly the node it always
 * did, and emits byte-identically.
 *
 * Null is a real answer, not a gap: a document whose only Output names a mesh
 * of its own has no default TODAY either — graphToCode's `material0Target`
 * suppresses the top-level channels and emits `parts` alone, which is exactly
 * what loader 0.6/0.8 needs to leave every unclaimed mesh on its authored
 * material.
 *
 * "Untargeted" is `isUntargetedOutput` (utils/sdfPartition.ts), the same
 * predicate `activeSink` elects on, so the node that drives and the node that
 * owns the default can never be two different nodes.
 */
export function defaultOutput(nodes: readonly AppNode[]): AppNode | null {
  let best: AppNode | null = null;
  for (const n of nodes) {
    if (!isUntargetedOutput(n)) continue;
    if (hasActiveFlag(n)) return n;
    if (!best || emitRank(n) < emitRank(best)) best = n;
  }
  return best;
}

/**
 * The Output whose `materialSettings` become the MODULE's top-level
 * transparent / side / alphaTest / depthWrite (owner decision D1).
 *
 * `buildShaderModule` always writes those four keys at module level, so unlike
 * the channels this question must always have an answer while any Output
 * exists — hence the fallback past `defaultOutput`'s null: the LOWEST-RANKED
 * Output of any kind, targeted or not.
 *
 * That fallback is `emitRank`, never array order, and the difference is not
 * academic: these four keys are module TEXT, so an array-ordered answer would
 * rewrite the module when the array moved — and `liftChildrenAfterParents`
 * (NodeEditor.tsx) moves it on an ordinary drag-into-a-group, while
 * `useSyncEngine` reorders on every Apply. That is exactly the class the
 * `emitOrder` bullet in CLAUDE.md exists to close, and `defaultOutput` above
 * already ranks for the same reason; leaving one of the pair on array order
 * would have made the module's settings follow a layout gesture on any
 * document where EVERY Output names a mesh. Rare — the parse mints an
 * untargeted default for any module carrying top-level channels — but
 * reachable by hand and by an all-targeted import.
 *
 * A Raymarch Output is deliberately not a candidate: its settings come from
 * `marchMaterialSettings`, which layers over this.
 */
export function moduleSettingsOutput(nodes: readonly AppNode[]): AppNode | null {
  return defaultOutput(nodes) ?? outputsInEmitOrder(outputNodes(nodes))[0] ?? null;
}

/**
 * The Output carrying the ACTIVE flag when one does (several Outputs may
 * coexist since 2026-09-03, exactly one of them active — see `activeSink` in
 * utils/sdfPartition.ts), else the first in array order, which is what every
 * document without a flag has always meant. TARGETING is deliberately not
 * consulted here; that is what the two predicates above are for.
 *
 * What is left wanting exactly this is "WHERE DO I POINT THE USER" — a node
 * that must exist whether or not it owns the default, and must be the SAME one
 * for every surface that names it in the same breath. Its callers:
 * `ShaderSettingsMenu`'s fallback for the paths that open the menu with no node
 * id (a right-click on the canvas background), and Preview mode's three —
 * `previewGraph`'s anchor plus `PreviewRoute` and NodeEditor's `previewDstId`,
 * which draw the route line and mark its far end. Those three MUST agree, or
 * the line on screen points at one node while the 3D view renders another.
 *
 * Emission, the parse, the mirror plan, the export plan, dormancy and the
 * preview wires do NOT use it: since the split each reads the node SET
 * (`contributingOutputs`, the `…Across` plans), because no single node holds
 * every material any more.
 *
 * Consumers that must also honour an active RAYMARCH Output layer
 * `drivingMarchOutput` over this, as they always did. Kept as a shared
 * function because the alternative is ten call sites each writing their own
 * `find` and disagreeing the moment the rule changes again — which is exactly
 * what happened last time.
 */
export function findDefaultOutput(nodes: readonly AppNode[]): AppNode | null {
  const outputs = outputNodes(nodes);
  return outputs.find((n) => (n.data as Record<string, unknown>).activeOutput === true) ?? outputs[0] ?? null;
}

/**
 * THE Output nodes whose materials reach the module — the ONE answer every
 * emission-side consumer reads (graphToCode, the single-GLB export plan, the
 * `.js` export, the code panel's tabs, the preview and its XR popup), so none of
 * them can disagree about which nodes contribute.
 *
 * It is `defaultOutput` — the node supplying the module's top-level channels —
 * plus EVERY TARGETED plain Output, which supplies its own `parts` /
 * `materialParts` entry. A dozen call sites each re-deriving "who contributes"
 * is how they drift, which is what B2 found; this is the `costSeeds` shape and
 * the same reasoning.
 *
 * **The active flag governs only the UNTARGETED half.** A targeted Output
 * shades the meshes it names and nothing else, so parking it behind another
 * node's flag would silently drop a material the canvas still shows — and
 * would make "which meshes does this shader paint" depend on a choice the user
 * made about a different node. Among UNTARGETED Outputs exactly one
 * contributes (the flagged one, else the first), which is what still lets a
 * whole-model variant be parked beside the one in use.
 *
 * Returned in `outputsInEmitOrder`, so a caller that walks the list is already
 * walking the module's own order and never has to sort again.
 *
 * A DRIVING Raymarch Output silences every plain Output, and that check is
 * deliberately NOT made here: `activeSink`'s fallbacks are ARRAY-ORDER
 * dependent, and its callers do not all hold the same array — graphToCode
 * resolves the march over the TOPOLOGICALLY SORTED nodes while reading the
 * Output off the raw list. Answering it here, over whichever array this
 * happened to be handed, could elect a different sink than the caller already
 * did. So each caller keeps its own march check, exactly where it has always
 * been.
 */
export function contributingOutputs(nodes: readonly AppNode[]): AppNode[] {
  const def = defaultOutput(nodes);
  const out: AppNode[] = [];
  for (const n of nodes) {
    if (n.data.registryType !== 'output') continue;
    // The default, and every node with a binding of its own. An UNTARGETED
    // Output that is not the default is PARKED and contributes nothing.
    if (n === def || !isUntargetedOutput(n)) out.push(n);
  }
  return outputsInEmitOrder(out);
}

/** A `MaterialSettings`-shaped value, or undefined. */
function cleanSettings(v: unknown): MaterialSettings | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as MaterialSettings) : undefined;
}

/**
 * A channel-values map with only primitive entries, or undefined.
 *
 * Returns the SAME object when nothing was dropped, so the caller can tell "I
 * cleaned this" from "this was already clean" by reference. Comparing key
 * COUNTS instead is the trap: a value replaced by a nested object keeps the
 * count identical, so the entry reads as unchanged and the ORIGINAL — the one
 * still carrying the object — is what survives.
 */
function cleanValues(v: unknown): Record<string, string | number> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const src = v as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  let dropped = false;
  for (const [k, val] of Object.entries(src)) {
    if (typeof val === 'string' || typeof val === 'number') out[k] = val;
    else dropped = true;
  }
  return dropped ? out : (src as Record<string, string | number>);
}

/** A string array, or undefined — the same array when nothing was dropped. */
function cleanPorts(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((p): p is string => typeof p === 'string');
  return out.length === v.length ? (v as string[]) : out;
}

/**
 * Validate the `materials` array arriving from any restore path.
 *
 * Every field here rides `fs:graph`, the project embed, the saved-group library
 * and ~50 history clones, and the mesh name reaches GENERATED CODE that the XR
 * popup executes at the app's real origin — so this is the same trust level as
 * `sanitizeEdgeExtras`, and the same contract: return the SAME array when
 * nothing needed changing, so the autosave subscriber and
 * `selectionOnlyGraphChange` can keep comparing by reference.
 *
 * Rules, all silent-failure-proof by construction rather than by care:
 *  - targets are NORMALIZED to a `meshTargets` list — one material may shade
 *    several meshes — de-duped within the material, capped, every name
 *    re-validated. The older single `meshTarget: { name }` is read once here and
 *    rewritten, so the rest of the codebase has exactly one shape to handle;
 *  - a material whose every name is unusable is DROPPED, and material 0's own
 *    target keys go with them, so a hostile file cannot park an unbounded
 *    string there;
 *  - a DUPLICATE name is KEPT. Two materials may name one mesh, because the
 *    picker lets them: forbidding it made swapping two materials' meshes
 *    impossible without deleting one first, and dropping the loser here would
 *    silently delete a whole section — with its wiring — on the next reload.
 *    Emission resolves a duplicate first-wins, so a live graph and a reloaded
 *    one still render identically; the node marks the shadowed section;
 *  - a material with NO usable target is KEPT, empty. It is not a second
 *    default (only material 0's empty list means "everything else") — it shades
 *    nothing, emits nothing, and is the state a swap passes through when one
 *    material's last mesh moves to another. Dropping it here would delete a
 *    section, and its wiring, on the reload after an ordinary swap;
 *  - the list is capped at `MAX_PARTS`, one MORE than the "+ Add output" button
 *    offers: a code-panel Apply turns a targeted material 0 into an ADDED one,
 *    so a bound at `MAX_ADDED_MATERIALS` would delete a material the user can
 *    legitimately have authored;
 *  - unknown keys are stripped, so a tampered file cannot smuggle an unbounded
 *    payload past the caps by hanging it off a material;
 *  - an INDEX section (`gltfMaterialIndex`) is kept only when the node's
 *    `modelSignature` is valid and the index falls inside it; it carries no
 *    targets (any it held are dropped, and counted). Otherwise it is DETACHED
 *    into an empty named section — wiring kept, counted — the "keep, don't
 *    delete a section" rule. Duplicate indices are KEPT (first claim wins at
 *    emission, `planIndexParts`). Index sections are capped at
 *    `MAX_INDEX_MATERIALS`, named ones at `MAX_PARTS`, counted separately;
 *  - `modelSignature` survives only beside a surviving index section, and
 *    `modelMeshes` only beside a surviving signature (`sanitizeModelMeshes`);
 *    a node-level `gltfMaterialIndex` is deleted (material 0 never has one).
 *    The entries are never REORDERED: handles are positional (`m<k>:`).
 *
 * Every drop is COUNTED (`trimmed`) so a restore path can announce it (decision
 * 9: a cap that does not announce itself reads as data loss): sections past
 * `MAX_PARTS` / `MAX_INDEX_MATERIALS`, non-object entries, a non-array
 * `materials`, names that are unusable or past a section's `MAX_PARTS` cap —
 * material 0's own list included — index sections detached for an invalid
 * index or signature, and an index section that also carried names.
 * De-duplicating a name is NOT a loss and is not counted, and neither is a
 * dropped signature or mirror list with no index section to serve.
 * `sanitizeOutputMaterials` is the uncounted wrapper, for the paths that
 * re-sanitize data a restore already reported.
 */
export function sanitizeOutputMaterials(nodes: AppNode[]): AppNode[] {
  return sanitizeOutputMaterialsReport(nodes).nodes;
}

/**
 * The raw target values a material carried, for COUNTING what the sanitizer
 * drops: the list when it is one, else whatever sat in the list slot plus the
 * legacy name. Plain property access only (a primitive `meshTarget` reads
 * `undefined`, it never throws).
 */
function rawTargetList(meshTargets: unknown, meshTarget: unknown): unknown[] {
  if (Array.isArray(meshTargets)) return meshTargets;
  const out: unknown[] = [];
  if (meshTargets !== undefined) out.push(meshTargets);
  if (meshTarget !== undefined) {
    out.push(meshTarget !== null && typeof meshTarget === 'object'
      ? (meshTarget as { name?: unknown }).name
      : undefined);
  }
  return out;
}

/** How many DISTINCT raw values the cleaned list lost (duplicates are free). */
function droppedTargetCount(raw: readonly unknown[], kept: readonly string[]): number {
  return Math.max(0, new Set(raw).size - kept.length);
}

export function sanitizeOutputMaterialsReport(nodes: AppNode[]): { nodes: AppNode[]; trimmed: number } {
  let changed = false;
  let trimmed = 0;

  const out = nodes.map((node) => {
    if (!isOutputNode(node)) return node;

    // Material 0's own target is a NODE field, so it is cleaned even when the
    // node carries no `materials` array at all — it reaches generated code by
    // exactly the same route.
    const d0 = node.data as { meshTargets?: unknown; meshTarget?: unknown };
    const hadTargetKeys = d0.meshTargets !== undefined || d0.meshTarget !== undefined;

    // The node-level index-section fields. Plain property access (a tampered
    // value may be any shape). A signature is only ever KEPT beside a
    // surviving index section, which is decided after the loop.
    const dn = node.data as { modelSignature?: unknown; modelMeshes?: unknown; gltfMaterialIndex?: unknown };
    const rawSig = dn.modelSignature;
    const rawMeshes = dn.modelMeshes;
    const sig = rawSig === undefined ? null : sanitizeModelSignature(rawSig);
    /**
     * Is MATERIAL 0 ITSELF an index section? `unfoldOutputMaterials` gives each
     * material its own node, and an import-built section's glTF binding then
     * has nowhere to live but `data.gltfMaterialIndex` — so this key is now a
     * real, kept shape rather than a stray to delete. Judged by the SAME rule
     * as an entry's: only a signature the node carries can vouch for an index.
     *
     * Before the split this key was deleted unconditionally, which would have
     * destroyed every unfolded index node on the load AFTER the one that split
     * it — the sections and their signature gone, silently, leaving a document
     * of blank untargeted Outputs.
     */
    const nodeIndex = dn.gltfMaterialIndex;
    const nodeIndexValid = isGltfMaterialIndex(nodeIndex) && sig !== null && nodeIndex < sig.materials.length;

    const names0 = nodeIndexValid ? [] : materialTargetNames({
      meshTargets: Array.isArray(d0.meshTargets) ? (d0.meshTargets as string[]) : undefined,
      meshTarget: d0.meshTarget as { name: string } | undefined,
    });
    // A section is ONE kind: names beside a surviving index are dropped and
    // announced, exactly as they are on an index ENTRY (one count, not one per
    // name — what the hand-edit meant is gone, however many names it spelled).
    if (nodeIndexValid) { if (hadTargetKeys) trimmed++; }
    else trimmed += droppedTargetCount(rawTargetList(d0.meshTargets, d0.meshTarget), names0);
    // "Already clean" means: the list form, byte-for-byte what we would write.
    const target0Clean = nodeIndexValid
      ? !hadTargetKeys
      : !hadTargetKeys
        || (d0.meshTarget === undefined
          && Array.isArray(d0.meshTargets)
          && d0.meshTargets.length === names0.length
          && (d0.meshTargets as string[]).every((n, i) => n === names0[i])
          && names0.length > 0);

    /** Write material 0's normalized target list onto a data copy. */
    const applyTarget0 = (data: Record<string, unknown>) => {
      if (target0Clean) return;
      delete data.meshTarget;
      if (names0.length > 0) data.meshTargets = names0;
      else delete data.meshTargets;
    };

    /**
     * Write the node-level index fields onto a data copy. `anyIndex` is whether
     * ANY section of this node survived as an index one — material 0 itself, or
     * an entry — since that is exactly how long the signature lives, and the
     * mirror list only beside the signature.
     */
    const applyNodeExtras = (data: Record<string, unknown>, anyIndex: boolean) => {
      delete data.modelSignature;
      delete data.modelMeshes;
      delete data.gltfMaterialIndex;
      if (nodeIndexValid) data.gltfMaterialIndex = nodeIndex;
      const outSig = anyIndex ? sig : null;
      if (outSig) {
        data.modelSignature = outSig;
        const meshes = sanitizeModelMeshes(rawMeshes, outSig.materials.length);
        if (meshes) data.modelMeshes = meshes;
      }
    };

    /** Would `applyNodeExtras(_, anyIndex)` leave the node's data unchanged? */
    const nodeExtrasClean = (anyIndex: boolean): boolean => {
      const outSig = anyIndex ? sig : null;
      const outMeshes = outSig ? sanitizeModelMeshes(rawMeshes, outSig.materials.length) : undefined;
      return (outSig ? outSig === rawSig : rawSig === undefined)
        && outMeshes === rawMeshes
        && (nodeIndexValid || nodeIndex === undefined);
    };

    const raw = (node.data as { materials?: unknown }).materials;
    // With no `materials` array the only index section a node can have is its
    // own material 0, so `nodeIndexValid` IS `anyIndex` here.
    if (raw === undefined && target0Clean && nodeExtrasClean(nodeIndexValid)) return node;

    if (raw === undefined || !Array.isArray(raw)) {
      changed = true;
      const data = { ...node.data } as Record<string, unknown>;
      if (raw !== undefined) {
        // Not a list at all: whatever it held is gone, so it is announced.
        delete data.materials;
        trimmed++;
      }
      applyTarget0(data);
      applyNodeExtras(data, nodeIndexValid);
      return { ...node, data } as unknown as AppNode;
    }

    const kept: OutputMaterial[] = [];
    let dirty = false;
    let named = 0;
    let indexed = 0;

    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { trimmed++; dirty = true; continue; }
      const e = entry as Record<string, unknown>;
      const gi = e.gltfMaterialIndex;
      const validIndex = isGltfMaterialIndex(gi) && sig !== null && gi < sig.materials.length;
      let clean: OutputMaterial;
      let names: string[] = [];
      if (validIndex) {
        // Past the index cap: dropped AND counted.
        if (indexed >= MAX_INDEX_MATERIALS) { trimmed++; dirty = true; continue; }
        indexed++;
        clean = { gltfMaterialIndex: gi };
        // A section is ONE kind: targets on an index section are dropped, and
        // announced (they are what a hand-edit meant, and they are gone).
        if (e.meshTargets !== undefined || e.meshTarget !== undefined) trimmed++;
      } else {
        // An index the signature cannot vouch for — out of range, junk, or no
        // valid signature at all — DETACHES the section into an empty named
        // one (wiring kept): the "keep, don't delete a section" rule, counted.
        if (gi !== undefined) trimmed++;
        // Past the named cap: dropped AND counted. This used to be a silent
        // `break`, so the rest were neither kept nor reported.
        if (named >= MAX_PARTS) { trimmed++; dirty = true; continue; }
        named++;
        names = materialTargetNames({
          meshTargets: Array.isArray(e.meshTargets) ? (e.meshTargets as string[]) : undefined,
          meshTarget: e.meshTarget as { name: string } | undefined,
        });
        trimmed += droppedTargetCount(rawTargetList(e.meshTargets, e.meshTarget), names);
        clean = { meshTargets: names };
      }
      const values = cleanValues(e.values);
      const ports = cleanPorts(e.exposedPorts);
      const settings = cleanSettings(e.materialSettings);
      if (values) clean.values = values;
      if (ports) clean.exposedPorts = ports;
      if (settings) clean.materialSettings = settings;

      // Did anything about this entry actually change? The cleaners return
      // their input by REFERENCE when they dropped nothing, so this catches a
      // repaired sub-object as well as a stripped key — a key-count comparison
      // would call `{ a: 1, b: {…} }` unchanged and hand back the original.
      if (
        Object.keys(e).length !== Object.keys(clean).length
        || values !== e.values
        || ports !== e.exposedPorts
        || settings !== e.materialSettings
        || clean.gltfMaterialIndex !== e.gltfMaterialIndex
        || (!validIndex && (
          !Array.isArray(e.meshTargets)
          || (e.meshTargets as unknown[]).length !== names.length
          || (e.meshTargets as unknown[]).some((n, i) => n !== names[i])
        ))
      ) {
        dirty = true;
      }
      kept.push(clean);
    }

    // The signature lives exactly as long as an index section does — material
    // 0's own binding counts, since a split node's section IS material 0 — and
    // the mirror source only beside it.
    const anyIndex = nodeIndexValid || kept.some(isIndexSection);

    if (!dirty && target0Clean && kept.length === raw.length && nodeExtrasClean(anyIndex)) return node;
    changed = true;
    const data = { ...node.data } as Record<string, unknown>;
    if (kept.length > 0) data.materials = kept;
    else delete data.materials;
    applyTarget0(data);
    applyNodeExtras(data, anyIndex);
    return { ...node, data } as unknown as AppNode;
  });

  return { nodes: changed ? out : nodes, trimmed };
}

/**
 * Re-point the edges of every material AFTER `removedIndex` one slot down.
 *
 * Removing a material renumbers the ones below it, so their handles move with
 * them: without this, removing the first of three strands material 3's wiring
 * on an `m3:` handle that now belongs to nothing — React Flow keeps such an
 * edge in the store and still emits code for it while never DRAWING it.
 *
 * The id is re-derived with the handle, because an edge id is built from its
 * endpoints: a moved edge carrying its old id collides with the next edge that
 * really does connect that pair, and anything keyed on it then names a handle
 * that no longer exists.
 *
 * Returns the SAME array when no edge moved.
 *
 * NO PRODUCTION CALLER since the per-material Output split: its only one was
 * the node's ✕, which removed a material out of a stack — a material is a NODE
 * now, so removing one deletes the node and there is no later section to
 * renumber. Kept as a tested primitive on the terms the materials-form plans
 * are kept on (see `planNamedParts`), because a folded `.fastshader` can still
 * carry `m<n>:` handles and any future code that renumbers them must not
 * re-derive this by hand.
 */
export function shiftMaterialHandles(
  edges: readonly AppEdge[],
  nodeId: string,
  removedIndex: number,
): AppEdge[] {
  let changed = false;
  const out = edges.map((e) => {
    if (e.target !== nodeId || typeof e.targetHandle !== 'string') return e;
    const { index, channel } = parseChannelHandle(e.targetHandle);
    if (index <= removedIndex) return e;
    changed = true;
    const targetHandle = channelHandle(index - 1, channel);
    return {
      ...e,
      id: generateEdgeId(e.source, e.sourceHandle ?? 'out', nodeId, targetHandle),
      targetHandle,
    };
  });
  return changed ? out : (edges as AppEdge[]);
}

/**
 * Drop the edges whose `m<k>:` handle names a material an Output node no
 * longer has.
 *
 * A restore that dropped a section (a cap, an invalid entry) must not leave its
 * wires in the store: React Flow keeps such an edge, never draws it, emits
 * nothing for it, and reports error 008 for it every frame — unscoped, since
 * the section is not dormant, it is gone. A DORMANT section is untouched: its
 * material still exists, only its visibility sleeps. Edges into non-Output
 * nodes, or with no string handle, are never touched.
 *
 * Its JOB NARROWED with the Output split and did not disappear: every restore
 * path runs `unfoldOutputMaterials` first, which moves an in-range `m<k>:` edge
 * onto the k-th sibling's BARE handle and drops one whose material or channel
 * does not exist. What reaches here is an `m<k>:` handle on an Output the split
 * did not touch — a node with no `materials` key at all, so `materialCount` is
 * 1 and every `m<k>:` is orphaned. Only a hand-edited or foreign file can carry
 * one, which is exactly the input this exists for.
 *
 * Returns the SAME array when nothing was pruned (the autosave subscriber and
 * `selectionOnlyGraphChange` compare by reference).
 */
export function pruneOrphanMaterialEdges(
  nodes: readonly AppNode[],
  edges: AppEdge[],
): { edges: AppEdge[]; removed: number } {
  const counts = new Map<string, number>();
  for (const n of nodes) if (isOutputNode(n)) counts.set(n.id, materialCount(n));
  if (counts.size === 0) return { edges, removed: 0 };
  let removed = 0;
  const out = edges.filter((e) => {
    const count = counts.get(e.target);
    if (count === undefined || typeof e.targetHandle !== 'string') return true;
    const ok = parseChannelHandle(e.targetHandle).index < count;
    if (!ok) removed++;
    return ok;
  });
  return { edges: removed > 0 ? out : edges, removed };
}

/* ── The unfold: one Output NODE per material ────────────────────────────── */

/**
 * Vertical pitch between an unfolded sibling and the one above it, in flow
 * units. A one-material Output measures ~137px tall (layoutEngine's own
 * estimate, measured in Chromium), so this leaves a visible gap without
 * inventing a layout: the siblings come out as a column in the order the
 * sections were stacked inside the node they replace. Where they REALLY
 * belong is a question only the canvas answers.
 *
 * Exported because the resync places a newly-parsed Output on the same pitch
 * (`placeParsedOutputs`, utils/resyncPairing.ts) — the column has to read as
 * one column whichever path produced its members, and a second literal is the
 * way the two drift.
 */
export const UNFOLD_DY = 180;


/** Lazily-read set of the Output def's real channel ids.
 *
 *  Read from the REGISTRY, so it cannot drift from the ports the node renders,
 *  and read LAZILY because this module sits inside the store's import cycle
 *  (`nodeCost → outputMaterials → exposedPorts → edgeUtils → useAppStore`) —
 *  a module-scope `new Set(NODE_REGISTRY…)` would be an evaluation across it
 *  during initialisation, which is the costTable TDZ class. */
let outputChannelIds: Set<string> | null = null;
function isOutputChannel(id: string): boolean {
  outputChannelIds ??= new Set((NODE_REGISTRY.get('output')?.inputs ?? []).map((p) => p.id));
  return outputChannelIds.has(id);
}

/**
 * The id of the sibling Output carrying material `index` of `outputId`.
 *
 * DETERMINISTIC and zero-padded: a `.fastshader` must open with the same ids
 * every time, or a saved group re-lays out on every `instantiateSavedGroup`
 * and every boot rewrites `fs:graph`. `taken` is every id already in the
 * document — a hostile file may name a node exactly this — and a collision
 * appends a counter rather than minting a duplicate id, which React Flow
 * cannot render.
 */
function unfoldedId(outputId: string, index: number, taken: ReadonlySet<string>): string {
  const base = `${outputId}#m${String(index).padStart(2, '0')}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}#${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * The INVERSE of `foldExtraOutputs`: every Output carrying `data.materials`
 * becomes one Output NODE per material, all of them on the BARE channel
 * handles material 0 already uses.
 *
 * PURE, and run by ALL FOUR restore paths — `loadGraph` and
 * `loadSavedGroupsReport` (store/useAppStore.ts), `instantiateSavedGroup` (on
 * the COMBINED live-graph + arriving list) and `applyProjectToStore`
 * (engine/projectImport.ts) — each of them AFTER `sanitizeOutputMaterials` and
 * `sanitizeEdgeExtras`, because it walks and re-points the edge list. It is the
 * permanent migration, not a transitional one: both producers
 * (`gltfSectionBuilder`, `codeToGraph`) build the split shape directly now, but
 * every `.fastshader`, `fs:graph` autosave and saved group written before the
 * split still carries a folded document, and always will.
 *
 * What survives, and why each rule exists:
 *
 *  - **Node 0 IS the original node** — same id, same position, same values,
 *    ports, settings and mesh targets, minus `materials`. Minting a fresh node
 *    for material 0 would strand every edge on the bare handles that already
 *    spell its channels, and lose the node's place in the user's layout.
 *  - **`emitOrder`** is seeded from the old material index (node 0 → 0,
 *    `materials[k]` → k+1) and read only through `emitRank`. Emitted `parts`
 *    key order may NEVER be derived from the nodes array:
 *    `liftChildrenAfterParents` splices a node into a new slot on an ordinary
 *    drag-into-a-group and `useSyncEngine` reorders on every Apply, so the
 *    module text would change on a layout gesture — the preview recompiles,
 *    the autosave dirties and `__partPixel<n>` renumbers.
 *  - **Every moved edge is re-derived** with `generateEdgeId`. The id is a
 *    function of the endpoints, so a stale one collides with the next edge
 *    that really does connect that pair, and dedupe logic keyed on it drops
 *    one of them.
 *  - **The channel is validated against the port list.** `parseChannelHandle`
 *    returns `{ index: 0, channel: <the whole string> }` for anything it does
 *    not match, so without this a tampered `m1:zzz` would land on a sibling
 *    wearing a bare handle no port has — invisible, un-hit-testable, and a
 *    permanent 008. Nothing validates this today. Edges that parse to index 0
 *    (a bare channel, `m0:color`, junk) are NOT touched at all: they already
 *    sit on node 0 exactly as they will after the unfold, and pruning them is
 *    `pruneOrphanMaterialEdges`' job, not this one.
 *  - **`modelSignature` is REPLICATED** onto every index node (dormancy is
 *    per node and needs it there) and dropped from a node holding no index
 *    section, which is what `sanitizeOutputMaterialsReport` does too.
 *  - **`modelMeshes` stays ONE WHOLE LIST** on the lowest-`emitRank` index
 *    node, never split per material: `gltfSectionBuilder` fills it in
 *    first-scene-appearance order, which INTERLEAVES materials, and
 *    `materialPartsMirrorPlan` walks that stored order straight into module
 *    TEXT — regrouping it by material would silently reorder the mirror keys
 *    of every already-distributed single-GLB export.
 *
 * Returns the SAME arrays when no Output carries a `materials` key: the
 * autosave subscriber and `selectionOnlyGraphChange` compare by reference, so
 * a new array on a clean document rewrites `fs:graph` on every boot. An EMPTY
 * `materials: []` is not clean — the key itself is what the split shape
 * retires — so it costs one new array and has the key removed.
 */
export function unfoldOutputMaterials(
  nodes: AppNode[],
  edges: AppEdge[],
): { nodes: AppNode[]; edges: AppEdge[] } {
  const folded = nodes.filter(
    (n) => isOutputNode(n) && Array.isArray((n.data as { materials?: unknown }).materials),
  );
  if (folded.length === 0) return { nodes, edges };

  const taken = new Set(nodes.map((n) => n.id));
  /** The sibling ids THIS call minted — what `growGroupFrames` below is scoped
   *  to, so a frame grows only around nodes that were just added to it. */
  const minted = new Set<string>();
  /** original Output id → material index → the sibling's node id. NESTED, not
   *  a joined composite key: a node id comes out of a `.fastshader` and may
   *  spell any separator at all. */
  const siblingId = new Map<string, Map<number, string>>();
  /** original id → how many materials it had (so an out-of-range handle drops). */
  const materialCounts = new Map<string, number>();
  const replacement = new Map<string, AppNode[]>();

  for (const out of folded) {
    const materials = outputMaterials(out);
    materialCounts.set(out.id, materials.length);
    const signature = (out.data as { modelSignature?: unknown }).modelSignature;
    const modelMeshes = (out.data as { modelMeshes?: unknown }).modelMeshes;
    // The mirror source belongs to the LOWEST-emitRank INDEX node, which after
    // the seeding below is simply the first index material in order.
    const mirrorAt = materials.findIndex(isIndexSection);
    const byIndex = new Map<number, string>();
    siblingId.set(out.id, byIndex);

    const made: AppNode[] = [];
    for (let i = 0; i < materials.length; i++) {
      const material = materials[i];
      const isIndex = isIndexSection(material);
      const data: Record<string, unknown> = i === 0 ? { ...out.data } : {
        registryType: 'output',
        label: (out.data as { label?: unknown }).label,
        cost: (out.data as { cost?: unknown }).cost,
      };
      // `materials` is what the split retires; node 0 is the only node that
      // can still be carrying it.
      delete data.materials;
      if (i > 0) {
        // A sibling is material `i` and nothing else: its own binding, its own
        // channel state. The ACTIVE flag is deliberately NOT copied — exactly
        // one node may carry it (`normalizeActiveOutput`), and a targeted one
        // never should.
        delete data.activeOutput;
        delete data.meshTarget;
        if (isIndex) {
          data.gltfMaterialIndex = gltfIndexOf(material);
          delete data.meshTargets;
        } else {
          data.meshTargets = materialTargetNames(material);
          delete data.gltfMaterialIndex;
        }
        if (material.values) data.values = material.values;
        if (material.exposedPorts) data.exposedPorts = material.exposedPorts;
        if (material.materialSettings) data.materialSettings = material.materialSettings;
      }
      // Replicated on every index node; a node holding no index section has
      // nothing for a signature to describe.
      if (isIndex && signature !== undefined) data.modelSignature = signature;
      else delete data.modelSignature;
      if (i === mirrorAt && modelMeshes !== undefined) data.modelMeshes = modelMeshes;
      else delete data.modelMeshes;
      data.emitOrder = i;

      if (i === 0) {
        made.push({ ...out, data } as AppNode);
        continue;
      }
      const id = unfoldedId(out.id, i, taken);
      taken.add(id);
      minted.add(id);
      byIndex.set(i, id);
      made.push({
        ...out,
        id,
        // Deterministic and non-stacked: a column under the node they came out
        // of, in section order. A shared position would hide every sibling but
        // the last behind one card.
        position: { x: out.position.x, y: out.position.y + i * UNFOLD_DY },
        selected: false,
        data,
      } as AppNode);
    }
    replacement.set(out.id, made);
  }

  const nextNodes: AppNode[] = [];
  for (const n of nodes) {
    const made = replacement.get(n.id);
    if (made) nextNodes.push(...made);
    else nextNodes.push(n);
  }

  const nextEdges: AppEdge[] = [];
  for (const e of edges) {
    const count = materialCounts.get(e.target);
    if (count === undefined || typeof e.targetHandle !== 'string') { nextEdges.push(e); continue; }
    const { index, channel } = parseChannelHandle(e.targetHandle);
    // Index 0 covers a bare channel, a tampered `m0:` and every unparsable
    // handle: all of them already sit on node 0, which keeps its id.
    if (index === 0) { nextEdges.push(e); continue; }
    const target = index < count ? siblingId.get(e.target)?.get(index) : undefined;
    // A material that does not exist, or a channel no port has: the edge can
    // never be drawn or emitted, and moving it would mint exactly the bogus
    // landing this validation exists to prevent.
    if (target === undefined || !isOutputChannel(channel)) continue;
    nextEdges.push({
      ...e,
      id: generateEdgeId(e.source, e.sourceHandle ?? 'out', target, channel),
      target,
      targetHandle: channel,
    });
  }

  // Grow any frame the new siblings hang out of. A sibling inherits `parentId`
  // through the `{ ...out }` spread above and is stacked `i * UNFOLD_DY` BELOW
  // its original in the parent's own space, while `extent: 'parent'` is stripped
  // on load and never re-attached — so React Flow DRAWS it outside the frame
  // rather than clamping it, and nothing in this app resizes a frame after
  // nodes are added to it programmatically. A folded Output saved inside a
  // group came back with its materials strewn below the frame, and the only
  // repair was a collapse/expand round trip nobody would think to try.
  //
  // Scoped to the ids THIS call minted, and unpadded — see `growGroupFrames`.
  // Returns the SAME array when nothing grew, which is every document whose
  // folded Outputs sit at root.
  return { nodes: growGroupFrames(nextNodes, minted, UNFOLD_DY), edges: nextEdges };
}

/**
 * A `modelMeshes` list (the loader-0.6 mirror source) as it may be stored:
 * at most `MAX_MODEL_MESHES` plain `{ name, material }` entries, each name
 * `isUsableMeshName` and unique (the first wins), each material an integer
 * inside the signature (`sigLen`). Returns the SAME array when it was already
 * clean, undefined when nothing valid remains. Plain property access; the
 * length is capped BEFORE the walk, so a huge sparse array costs nothing.
 */
export function sanitizeModelMeshes(
  v: unknown,
  sigLen: number,
): { name: string; material: number }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: { name: string; material: number }[] = [];
  const seen = new Set<string>();
  let clean = v.length <= MAX_MODEL_MESHES;
  const n = Math.min(v.length, MAX_MODEL_MESHES);
  for (let i = 0; i < n; i++) {
    const e: unknown = v[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) { clean = false; continue; }
    const name: unknown = (e as { name?: unknown }).name;
    const material: unknown = (e as { material?: unknown }).material;
    if (
      !isUsableMeshName(name)
      || typeof material !== 'number'
      || !Number.isInteger(material)
      || material < 0
      || material >= sigLen
      || seen.has(name)
    ) {
      clean = false;
      continue;
    }
    if (Object.keys(e).length !== 2) clean = false;
    seen.add(name);
    out.push({ name, material });
  }
  if (out.length === 0) return undefined;
  return clean ? (v as { name: string; material: number }[]) : out;
}

/**
 * The loader-0.6 MIRROR plan for an Output (materialPartsContract R2/R4): one
 * entry per `modelMeshes` name whose glTF material has an EMITTED index
 * section, minus every name a named section claims (a name claim wins, the
 * same precedence as 0.8) — in stored order, each name once, capped at
 * `MAX_MIRROR_ENTRIES`. [] unless the node is an Output with a valid signature.
 *
 * Emission must never read the session's `previewMesh` facts (they are absent
 * under a different model, and would make the module depend on what is
 * loaded) — that is why the names ride node data. Every module path passes
 * this plan to buildShaderModule, which writes the mirrors into the MODULE
 * only (R7).
 */
export function materialPartsMirrorPlan(node: AppNode | null | undefined): MaterialPartsMirrorEntry[] {
  if (!node || !isOutputNode(node)) return [];
  const rawMeshes = (node.data as { modelMeshes?: unknown }).modelMeshes;
  const sig = readModelSignature(node.data);
  if (!sig) return [];
  const materials = outputMaterials(node);
  return mirrorEntries(
    rawMeshes,
    sig,
    new Set(planIndexParts(materials, sig).entries.map((e) => e.gltfIndex)),
    new Set(materials.flatMap((m) => materialTargetNames(m))),
  );
}

/**
 * The same plan across a SET of Output nodes (B5).
 *
 * `modelMeshes` is read from the LOWEST-RANKED node carrying an index section
 * and is never regrouped per material: `gltfSectionBuilder` fills it in
 * FIRST-SCENE-APPEARANCE order, which interleaves materials, and this plan
 * walks that stored order straight into module TEXT (`materialPartsMirror` and
 * the mirror `parts` keys). Splitting it per node and concatenating would emit
 * an interleaved scene's A,B,C as B,A,C — silently reordering the mirror keys
 * of every already-distributed single-GLB export.
 *
 * `modelSignature` comes from that SAME node (the sanitizer detaches any index
 * node whose copy differs, so there is only ever one live signature), while the
 * two sets that decide what survives are CROSS-NODE: which glTF indices really
 * emit, and which names a NAME section claims anywhere. Per node the second
 * would be wrong in the direction that matters — a mirror would paint a mesh an
 * Output elsewhere has claimed by name, which loader 0.8's precedence says the
 * name wins.
 */
export function materialPartsMirrorPlanAcross(outputs: readonly AppNode[]): MaterialPartsMirrorEntry[] {
  const ordered = outputsInEmitOrder(outputs);
  const mirrorNode = ordered.find((n) => isOutputNode(n) && outputMaterials(n).some(isIndexSection));
  if (!mirrorNode) return [];
  const sig = readModelSignature(mirrorNode.data);
  if (!sig) return [];
  const nameClaimed = new Set<string>();
  for (const n of ordered) {
    for (const m of outputMaterials(n)) for (const name of materialTargetNames(m)) nameClaimed.add(name);
  }
  return mirrorEntries(
    (mirrorNode.data as { modelMeshes?: unknown }).modelMeshes,
    sig,
    new Set(planIndexPartsAcross(outputs, sig).entries.map((e) => e.gltfIndex)),
    nameClaimed,
  );
}

/** The walk both forms share: stored order, each name once, a name a NAME
 *  section claims dropped, an index that does not emit dropped, capped. */
function mirrorEntries(
  rawMeshes: unknown,
  sig: readonly string[],
  emitting: ReadonlySet<number>,
  nameClaimed: ReadonlySet<string>,
): MaterialPartsMirrorEntry[] {
  if (!Array.isArray(rawMeshes) || rawMeshes.length === 0 || emitting.size === 0) return [];
  const out: MaterialPartsMirrorEntry[] = [];
  const seen = new Set<string>();
  for (const { name, material } of sanitizeModelMeshes(rawMeshes, sig.length) ?? []) {
    if (out.length >= MAX_MIRROR_ENTRIES) break;
    if (!emitting.has(material) || nameClaimed.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, index: material });
  }
  return out;
}

/** A cheap, stable subscription key for a mirror plan (names cannot contain
 *  a control character, so NUL cannot occur inside one). */
export function mirrorPlanKey(plan: readonly MaterialPartsMirrorEntry[]): string {
  return plan.map((e) => `${e.index} ${e.name}`).join('\u0000');
}

/**
 * Carry `modelMeshes` from the OLD Output onto the one a code-panel Apply
 * re-created (useSyncEngine's mergeMatch). The mirror source is module-only
 * (R7), so the parse can never re-create it; it is carried while the PARSED
 * signature equals the old one — a signature edited in the code panel
 * describes a different model, and its mirrors would paint the wrong meshes.
 */
export function carryModelMeshes(merged: AppNode, old: AppNode): void {
  if (!isOutputNode(merged) || !isOutputNode(old)) return;
  const meshes = (old.data as { modelMeshes?: unknown }).modelMeshes;
  if (meshes === undefined) return;
  const a = readModelSignature(merged.data);
  const b = readModelSignature(old.data);
  if (!a || !b || !modelSignatureMatches({ materials: a }, { materials: b })) return;
  (merged.data as Record<string, unknown>).modelMeshes = meshes;
}
