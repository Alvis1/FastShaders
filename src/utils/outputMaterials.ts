/**
 * The Output nodes' MATERIALS — ONE Output node is ONE material.
 *
 * Every node wears the BARE channel handles (`color`, `emissive`, …). Its
 * binding is node-level: `meshTargets` (mesh names), or `gltfMaterialIndex`
 * beside `modelSignature` for an import-built INDEX node; an UNTARGETED node
 * is the DEFAULT material. Nodes are ordered by `emitRank`, never array order.
 *
 * `data.materials` and `m<n>:<channel>` handles are the FOLDED shape a saved
 * `.fastshader` may still carry: every restore path retires it (sanitize →
 * unfold → normalize), so `outputMaterials(node)` is a one-element list on
 * live data.
 *
 * An INDEX binding emits into `materialParts`, never `parts`, and is nameless
 * (`materialTargetNames` returns []). Its DORMANCY is decided trusted-side
 * (`indexSectionsAwake`) and changes visibility only, never emission.
 *
 * See docs/dev/outputs-and-materials.md. Pure, so the vitest node env covers it.
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
// Read LAZILY (see `isOutputChannel`): this module sits inside the store's
// import cycle, so nothing here is evaluated at module scope.
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { OUTPUT_DEFAULT_EXPOSED } from './exposedPorts';
import { hasActiveFlag, isUntargetedOutput } from './sdfPartition';

export type { OutputMaterial, MaterialPartsMirrorEntry };
// Defined in the contract LEAF (the engine and utils/sdfPartition.ts may not
// import this store-coupled module) and re-exported, so every editor surface
// keeps one import site — and one `emitRank`, never a second copy.
export { MAX_INDEX_MATERIALS, MAX_MIRROR_ENTRIES, emitRank };
/** The highest glTF material index a binding may name (the `materialParts` key range). */
export { GLTF_MATERIAL_INDEX_MAX };

/**
 * `MAX_PARTS` minus one — the named sections a FOLDED node carried beside its
 * own material. Each material is a whole generated pipeline, and the preview
 * recompiles ALL of them per debounced edit (measured ~55-62 ms each on desktop).
 */
export const MAX_ADDED_MATERIALS = 8;

/**
 * A PER-NODE cap, NEVER a module budget: the names one material may carry
 * (`materialTargetNames` caps on read) and the named sections one folded node
 * may keep (the sanitizer). `MAX_PART_ENTRIES` is the module's — counting a
 * whole module with this one destroyed every material past the ninth on Apply.
 */
export const MAX_PARTS = MAX_ADDED_MATERIALS + 1;

/**
 * Most name-keyed `parts` ENTRIES one module may carry: every name the
 * sanitizer can admit (`MAX_PARTS` sections × `MAX_PARTS` names each), so the
 * emission cap never bites sanitized data.
 */
export const MAX_PART_ENTRIES = (MAX_PARTS + 1) * MAX_PARTS;

/** Most `modelMeshes` entries (the loader-0.6 mirror source) one Output keeps. */
export const MAX_MODEL_MESHES = 256;

/** The glTF material index an import-built INDEX section shades, else null.
 *  A number only — never coerced (`'1'` from a tampered file is not an index). */
export function gltfIndexOf(material: OutputMaterial | undefined): number | null {
  const v: unknown = material ? (material as { gltfMaterialIndex?: unknown }).gltfMaterialIndex : undefined;
  return isGltfMaterialIndex(v) ? v : null;
}

/** Is this an import-built INDEX section (bound to a glTF material, not to
 *  mesh names)? The value-level test; `planIndexPartsAcross` additionally
 *  requires the index to fall inside the signature. */
export function isIndexSection(material: OutputMaterial | undefined): boolean {
  return gltfIndexOf(material) !== null;
}

/** ONE answer per `data` OBJECT: node data is immutable and reused across drag
 *  frames, and this is read per node per store notify. A WeakMap, because the
 *  key is adversarial, unbounded input. */
const signatureCache = new WeakMap<object, string[] | null>();

/**
 * The node's model signature as a name list, or null when absent or invalid —
 * through THE sanitizer (engine/materialPartsContract), so emission, the
 * mirror plan and the node read exactly what a restore path would keep. The
 * SAME array comes back for the same `data`, so callers may memoize on it.
 */
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
 * Every material on this node, material 0 first — ONE element on live data;
 * more only on a folded node a restore path has not unfolded yet.
 *
 * Material 0 is the node's own fields. Its BINDING is ONE kind: a node-level
 * `gltfMaterialIndex` makes it an INDEX section and any names beside it are
 * ignored (the sanitizer's rule), otherwise the mesh-name list.
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
 * Every mesh a material shades: de-duped, all usable, capped at `MAX_PARTS`.
 * THE accessor — `meshTargets` is the field, and the older single
 * `meshTarget: { name }` is still READ (never written) so an old graph or
 * saved group keeps its target.
 *
 * Empty on a node's own material means THE DEFAULT (it shades every mesh no
 * other material claims), so "is this the default" is always `.length === 0`
 * over the whole list, never a first-name test. One LABEL for a material goes
 * through `sectionLabel`.
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
 * THE home of the array-order rule. The nodes ARRAY is not a usable order:
 * `liftChildrenAfterParents` splices a node into a new slot on an ordinary
 * drag-into-a-group and `useSyncEngine` reorders on every Apply, so deriving
 * emitted order from it would rewrite the module on a layout gesture, with
 * `errors: []` and nothing on screen to explain it.
 *
 * The ID tie-break exists because a rank is NOT unique (two folded Outputs
 * unfolded in one document each produce a node carrying `emitOrder: 0`), and a
 * stable sort would otherwise fall back to array order.
 */
export function outputsInEmitOrder(outputs: readonly AppNode[]): AppNode[] {
  const byId = new Map<string, AppNode>();
  for (const n of outputs) if (!byId.has(n.id)) byId.set(n.id, n);
  return [...byId.values()].sort(
    (a, b) => emitRank(a) - emitRank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** The name `parts` plan ACROSS the Output nodes — which mesh name each
 *  material emits, first claim wins: one claim set, one cap counter, one
 *  emitted order. Entries carry their node, since a section index is not
 *  unique across nodes. */
export interface NamedPartsPlanAcross {
  /** Emitted entries, in (emitRank, id) node order then section order. */
  entries: { name: string; nodeId: string; section: number }[];
  /** node id → that node's shadowed sections: those that NAME a mesh but emit
   *  no entry, every name being claimed earlier. An EMPTY section is never
   *  shadowed ("No mesh" is a different state). A node with none is ABSENT. */
  shadowed: Map<string, Set<number>>;
  /** Names past `MAX_PART_ENTRIES` — a running total across every node, never
   *  a per-node budget. Empty for every graph a restore path has sanitized. */
  overCap: string[];
}

/** The first-claim state a whole plan shares; passing it from node to node is
 *  what makes the cap a running total and the claim set global. */
interface NamedClaimState {
  entries: { name: string; nodeId: string; section: number }[];
  overCap: string[];
  claimed: Set<string>;
}

/**
 * THE one first-claim-wins loop over one node's named sections, into a shared
 * state; returns THIS node's shadowed sections. A `parts` map has one slot per
 * mesh, so a duplicate name (a hand-edited file — the picker MOVES a mesh) goes
 * to the first claim, and a name past the cap is reported, never claimed.
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
 * The name `parts` plan across a SET of Output nodes — what emission AND the
 * node's shadowed mark read, so the two cannot disagree. ONE claim set and ONE
 * cap counter for the whole call (`parts` is a single map in a single module);
 * nodes are visited in `outputsInEmitOrder`.
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

/** The `materialParts` plan ACROSS the Output nodes: which node emits each
 *  glTF index, first claim wins. An index is claimed once, so ascending glTF
 *  index is already a total order; the node order decides only WHICH section
 *  wins a duplicate index. */
export interface IndexPartsPlanAcross {
  /** Emitted entries, ascending by glTF index, each index once. */
  entries: { gltfIndex: number; nodeId: string; section: number }[];
  /** node id → that node's sections whose index an earlier one claims (inert).
   *  Absent for a node with none. */
  duplicates: Map<string, Set<number>>;
  /** Sections past `MAX_INDEX_MATERIALS`, dropped at emission. Empty for every
   *  graph a restore path has sanitized. */
  overCap: { nodeId: string; section: number }[];
}

/** The index twin of `NamedClaimState`. */
interface IndexClaimState {
  entries: { gltfIndex: number; nodeId: string; section: number }[];
  overCap: { nodeId: string; section: number }[];
  claimed: Set<number>;
}

/**
 * One node's index sections into a shared state; returns ITS duplicates. An
 * index at or past the signature's length is skipped (the sanitizer detaches
 * those), and a duplicate index is shadowed, as a duplicate NAME is.
 *
 * THE `i = 0` RULE, for every loop over a node's materials in this file: on a
 * split node the binding IS material 0's. Starting at 1 dropped the WHOLE
 * `materialParts` table of every GLB-built shader, with `errors: []`
 * (pinned both ways by unfoldEmissionParity.test.ts).
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
 * The `materialParts` plan across a SET of Output nodes — what emission reads.
 * ONE claim set and ONE `MAX_INDEX_MATERIALS` counter, and ONE signature:
 * `modelSignature` is REPLICATED onto every index node and the sanitizer
 * DETACHES any node whose copy differs, so there is never a choice to make.
 * Nothing is emitted without a valid signature.
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
 * Asked at EVERY index, material 0 included (the `i = 0` rule, `claimIndexParts`).
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
  const g = gltfIndexOf(materials[index]);
  if (g !== null) return { kind: 'index', gltfIndex: g, name: displayMaterialName(signature?.[g] ?? '') };
  const names = materialTargetNames(materials[index]);
  if (names.length > 0) return { kind: 'named', first: names[0], more: names.length > 1 };
  return index === 0 ? { kind: 'default' } : { kind: 'empty' };
}

/**
 * Materials whose EVERY named mesh is absent from the live inventory —
 * DORMANT: the model on screen has no surface they could shade, so the Output
 * node renders header-plus-chip and returns, wiring intact, the moment a model
 * carrying its names is loaded.
 *
 * A pure VISIBILITY rule: data, edges, history and EMISSION are untouched —
 * emission may never depend on the inventory, which is session-only and
 * forgeable by the sandboxed preview. An EMPTY material never hides, and a
 * PARTIALLY missing one stays visible with its absent names marked. From
 * `i = 0` (`claimIndexParts`); the DEFAULT names nothing, so it never sleeps.
 *
 * A dormant node UNMOUNTS its channel handles, so OutputNode folds this set
 * into its updateNodeInternals key, or restored wires never draw.
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

/** Does a stored channel value EMIT? graphToCode emits NOTHING for zero
 *  discard/displacement and the identity normal texel. Here, not in OutputNode,
 *  so the node's red-fallback swatch and `outputDefaultContributes` share ONE
 *  notion of "this value emits". */
export function storedValueEmits(channel: string, v: unknown): boolean {
  if (v === undefined || v === null || v === '') return false;
  if (channel === 'discard' || channel === 'position') return Number(v) !== 0;
  if (channel === 'normal') return String(v).toLowerCase() !== '#8080ff';
  return true;
}

/**
 * Does this node's own material contribute anything to the emitted module?
 * Mirrors graphToCode's channelEntries test: a wire on a bare channel handle,
 * or an emitting stored value on an EXPOSED channel (emission is
 * exposure-gated, so a tampered value on a hidden channel must not count).
 * False for the default means the module is PARTS-ONLY, which arms the 0.6
 * loader's single-mesh fallback — see `dormantIndicesForPreview`.
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
 * Does a TARGETED material contribute a channel — i.e. does emission produce a
 * `parts` entry for it that `buildShaderModule` will KEEP? The
 * `outputDefaultContributes` test over the material's own values and exposed
 * list; `wired` is "any edge lands on its channel handles", passed in so this
 * stays free of the edge list.
 *
 * False is a normal, momentary state (every new Output node pointed at a mesh
 * starts here), so it is MARKED rather than prevented: seeding a value would
 * repaint the claimed mesh the instant the node appears.
 * See docs/dev/outputs-and-materials.md; pinned by outputSilentSection.test.ts.
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
 * The dormant set every SURFACE uses — `dormantMaterialIndices` plus the
 * context rules all consumers must share (OutputNode's render, the preview
 * wires, NodeEditor's scoped onError):
 *
 * 1. UNKNOWN inventory hides NOTHING: a model that is loaded but has not
 *    reported yet must not flash "for another model" about itself.
 * 2. The 0.6 loader's single-mesh fallback is MIRRORED: a parts-only module on
 *    a ONE-mesh model paints the FIRST named part, so that material stays
 *    visible. `firstNamedHere` keeps the exemption with the MODULE's first
 *    named part (`firstNamedOutputId(outputs) === node.id`); without it every
 *    targeted node would exempt itself and none would ever sleep.
 * 3. INDEX sections sleep all-or-nothing on the trusted signature, never the
 *    inventory, so rule 1's hold-off does not apply to them.
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
  // Rule 3, from `i = 0` (`claimIndexParts`).
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
 * Output names a mesh. Emit order, never array order (see `outputsInEmitOrder`).
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
 *    wins, `planIndexPartsAcross`), so this one emits nothing;
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
 * The coverage of every index section of ONE node, keyed by section index,
 * given the CROSS-NODE answers to the two questions that are not this node's
 * to decide: which names a name section claims anywhere (`claimedByName`) and
 * which of this node's sections a higher-ranked one shadows (`duplicates`).
 * Bounded: at most MAX_INVENTORY_MESHES names per section.
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
  // From `i = 0`, matching `claimIndexParts` exactly.
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
 * Does the DEFAULT material shade NOTHING of the model on screen? After a GLB
 * import that is the usual case — one index node per glTF material covers the
 * whole model — so the default's channels change nothing when wired.
 *
 * It is MARKED, never removed or hidden: the default still shades any mesh
 * with no material of its own, and EVERYTHING again once another model loads
 * and the index nodes sleep (a sleeping one covers nothing).
 *
 * True only when the answer is KNOWN and negative: a default exists
 * (`defaultOutput`, NOT the lowest-ranked node), there is any OTHER material,
 * the preview has reported meshes, and every one is claimed by name or covered
 * by an awake index section.
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
  // Any material at all besides the default's own one.
  if (total < 2) return false;
  const taken = new Set(namedPlan.entries.map((e) => e.name));
  for (const byNode of coverage.values()) for (const c of byNode.values()) for (const n of c.meshes) taken.add(n);
  return meshNames.every((n) => taken.has(n));
}

/** The whole-store shape the dormancy derivations read. */
interface DormancyState {
  nodes: readonly AppNode[];
  edges: readonly AppEdge[];
  previewMesh: unknown;
  previewShowsModel?: boolean;
  previewMeshInventory: { meshes?: readonly { name: string }[] } | null;
}

/**
 * The `dormantIndicesForPreview` opts for ONE Output node, derived from the
 * whole store — so every whole-store consumer asks identical questions.
 *
 * Two of the five are CROSS-NODE and cannot be read off `out`:
 * `defaultContributes` is about the MODULE's default (usually a SIBLING of the
 * node being judged), and `firstNamedHere` decides which single node may claim
 * the 0.6 single-mesh exemption.
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

/** One decorative Output→preview wire: the node it leaves, and what that node
 *  shades — as DATA, so the selector key that carries it is language-free and
 *  `linkLabelText` (nodes/sectionLabelText.ts) does the wording. */
export interface PreviewWireTarget {
  id: string;
  label: SectionLabel;
}

/**
 * The Output nodes the decorative preview wires leave from, in EMIT ORDER —
 * ONE WIRE PER CONTRIBUTING OUTPUT NODE, the same set emission reads, so the
 * canvas cannot show a wire from a node the module ignores (a PARKED Output).
 *
 * DORMANT nodes are left out: a dormant Output mounts NO preview socket, so
 * its wire would have no anchor and the element cache would re-query every
 * frame. The wire returns with the node.
 *
 * The CROSS-NODE dormancy opts are derived ONCE for the whole set, not through
 * `dormancyOptsFor` per node: that helper re-walks the edge list on every call
 * — one whole-graph walk per glTF material, per store notify, during a drag.
 *
 * A DRIVING custom sink is deliberately NOT consulted here (see
 * `contributingOutputs`); the caller skips this when one drives.
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
    // Material 0 is the NODE: the question the card asks (`nodeDormant`).
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
 * target a dormant node, whose unmounted handles are the visibility rule's
 * steady state rather than a bug? THE question NodeEditor's scoped React Flow
 * 008 swallow asks.
 *
 * Keyed on the EDGE ID, because only that identifies a NODE: every Output
 * spells its handles the same way, so a handle-keyed test would excuse a real
 * 008 about an awake node. The edge is LOOKED UP, never parsed out of its id
 * (`generateEdgeId`'s composite has no unambiguous reverse).
 *
 * False for everything else, so the warning is printed. The DEFAULT never
 * sleeps, so an 008 about it still reports the missing-`useUpdateNodeInternals`
 * bug it is.
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
 * Give the Output NODE `nodeId` exactly `names`, taking each of them away from
 * every OTHER Output node: a mesh belongs to exactly ONE material, so ticking
 * MOVES it. A MULTI-NODE write — the caller wraps ONE `setNodes` in
 * `asOneHistoryEntry`, or Cmd+Z steps through a half-assigned state.
 *
 * A node stripped of its LAST mesh is KEPT (the state a swap passes through)
 * and loses the key outright, never `[]`. An INDEX-bound node is never
 * re-targeted and never stripped; a mesh ticked here that its material also
 * covers is an OVERRIDE (the name claim wins, loader 0.8's precedence).
 *
 * Pure, and returns the SAME array (and the same node objects) when nothing
 * changed: the autosave subscriber and `selectionOnlyGraphChange` compare by
 * identity.
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
 * carried by the lowest-ranked contributing Output that holds an index
 * section, else null. `graphToCode` and the Output node both ask it, so the
 * node's red-sentinel test agrees with what emission writes.
 *
 * `outputs` must already be in emit order (`contributingOutputs` returns them
 * that way).
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
 * "THE Output" is FOUR questions, and they answer differently the moment a
 * TARGETED Output exists. Every call site picks one of these deliberately.
 *
 *   `defaultOutput`        — who owns the module's TOP-LEVEL channels.
 *   `contributingOutputs`  — which nodes' materials reach the module.
 *   `moduleSettingsOutput` — whose `materialSettings` the module writes.
 *   `findDefaultOutput`    — where do I point the USER (the settings menu's
 *                            fallback node, and Preview mode's anchor).
 *
 * The first three test the BINDING and the rank, never the array position.
 * See docs/dev/outputs-and-materials.md (several output nodes).
 */

/**
 * The DEFAULT material's Output — the node that owns the module's top-level
 * channels: the flagged-and-untargeted one when there is one, else the
 * LOWEST-RANKED untargeted one, else NULL. Emit order, never array order (see
 * `outputsInEmitOrder`): picking by array order silently dropped `color:` from
 * the module on a drag-into-a-group (pinned by unfoldEmissionParity.test.ts's
 * reversed case). Ties keep ARRAY order (strict `<`), so a document that has
 * never been split elects the node it always did.
 *
 * Null is a real answer: a document whose every Output names a mesh emits
 * `parts` alone, and the loader leaves unclaimed meshes on their authored
 * materials.
 *
 * "Untargeted" is `isUntargetedOutput`, the predicate `activeSink` elects on,
 * so the node that drives and the node that owns the default never differ.
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
 * `buildShaderModule` always writes those four keys, so unlike the channels
 * this must have an answer while any Output exists — hence the fallback past
 * `defaultOutput`'s null: the LOWEST-RANKED Output of any kind. Emit order,
 * never array order (see `outputsInEmitOrder`): the keys are module TEXT.
 *
 * A Raymarch Output is deliberately not a candidate: its settings come from
 * `marchMaterialSettings`, which layers over this.
 */
export function moduleSettingsOutput(nodes: readonly AppNode[]): AppNode | null {
  return defaultOutput(nodes) ?? outputsInEmitOrder(outputNodes(nodes))[0] ?? null;
}

/**
 * "WHERE DO I POINT THE USER": the Output carrying the ACTIVE flag, else the
 * first in array order. TARGETING is deliberately not consulted — the node
 * must exist whether or not it owns the default, and be the SAME one for every
 * surface naming it: `ShaderSettingsMenu`'s fallback and Preview mode's three
 * (`previewGraph`'s anchor, `PreviewRoute`, NodeEditor's `previewDstId`), which
 * MUST agree or the route line points at one node while the view renders
 * another.
 *
 * Emission, the parse, the plans, dormancy and the preview wires do NOT use
 * it; they read the node SET. Consumers that must also honour a driving
 * Raymarch Output layer `drivingMarchOutput` over this.
 */
export function findDefaultOutput(nodes: readonly AppNode[]): AppNode | null {
  const outputs = outputNodes(nodes);
  return outputs.find((n) => (n.data as Record<string, unknown>).activeOutput === true) ?? outputs[0] ?? null;
}

/**
 * THE Output nodes whose materials reach the module — the ONE answer every
 * emission-side consumer reads (graphToCode, both export plans, the code
 * panel's tabs, the preview and its XR popup): `defaultOutput` plus EVERY
 * TARGETED plain Output, returned in `outputsInEmitOrder`.
 *
 * **The active flag governs only the UNTARGETED half.** A targeted Output
 * always contributes; among UNTARGETED ones exactly one does (the flagged one,
 * else the lowest-ranked), so a whole-model variant can be PARKED.
 *
 * A DRIVING custom sink silences every plain Output, and that check is
 * deliberately NOT made here: `activeSink`'s first-wired fallback reads array
 * order and its callers do not all hold the same array (graphToCode resolves
 * it over the TOPOLOGICALLY SORTED nodes). Each caller keeps its own check.
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
 * Validate every Output's binding — and a folded node's `materials` array —
 * on any restore path. The mesh name reaches GENERATED CODE the XR popup runs
 * at the app's real origin, so this is `sanitizeEdgeExtras`' trust level and
 * contract: the SAME array comes back when nothing needed changing.
 *
 *  - targets are NORMALIZED to a `meshTargets` list (de-duped, capped, every
 *    name re-validated); the older `meshTarget: { name }` is rewritten, and a
 *    node with no usable name loses both keys;
 *  - a DUPLICATE name or index is KEPT (emission resolves it first-wins and
 *    the node marks the shadowed one): dropping the loser would delete a
 *    material, with its wiring, on the next reload;
 *  - a folded entry with NO usable target is KEPT, empty — the state a swap
 *    passes through. It shades nothing and is not a second default;
 *  - an INDEX binding is kept only inside a valid `modelSignature`, and names
 *    beside it are dropped; an invalid one is DETACHED into an empty named
 *    material, wiring kept;
 *  - `modelSignature` survives only beside a surviving index binding, and
 *    `modelMeshes` only beside the signature;
 *  - folded entries are capped (`MAX_PARTS` named, `MAX_INDEX_MATERIALS`
 *    index, counted apart), stripped of unknown keys and never REORDERED
 *    (their handles are positional, `m<k>:`).
 *
 * Every drop is COUNTED (`trimmed`) so a restore path can announce it;
 * de-duplicating a name is not a loss. `sanitizeOutputMaterials` is the
 * uncounted wrapper, for paths re-sanitizing data a restore already reported.
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
    // The node's OWN index binding (what the unfold writes) is a real, kept
    // shape, judged by the rule an entry's is: only a signature the node
    // carries can vouch for an index. Deleting it blanks every index node.
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
 * Drop the edges whose `m<k>:` handle names a material an Output node does not
 * have: React Flow keeps such an edge, never draws it, and reports error 008
 * for it every frame. A DORMANT node's edges are untouched.
 *
 * Every restore path runs `unfoldOutputMaterials` first, so what reaches here
 * is an `m<k>:` handle on an Output with no `materials` key — only a
 * hand-edited or foreign file carries one.
 *
 * Returns the SAME array when nothing was pruned.
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
 * units (a one-material Output measures ~137px tall). Exported because the
 * resync places a newly-parsed Output on the same pitch (`placeParsedOutputs`,
 * utils/resyncPairing.ts), so a built and a restored column are one column.
 */
export const UNFOLD_DY = 180;

/** The Output def's real channel ids, from the REGISTRY so they cannot drift
 *  from the ports the node renders. Read LAZILY: a module-scope read would
 *  evaluate across the store's import cycle (the costTable TDZ class). */
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
 * THE UNFOLD: every Output carrying `data.materials` becomes one Output NODE
 * per material, all on the BARE channel handles. The permanent migration —
 * every file saved before the split still carries the folded shape.
 *
 * PURE, and run by every restore path AFTER `sanitizeOutputMaterials` and
 * `sanitizeEdgeExtras` (it re-points the edge list) and before
 * `normalizeActiveOutput`. See docs/dev/outputs-and-materials.md.
 *
 *  - Node 0 IS the original node (same id and position), minus `materials`.
 *  - `emitOrder` is seeded from the old material index and read only through
 *    `emitRank`: emit order, never array order (see `outputsInEmitOrder`).
 *  - Sibling ids are DETERMINISTIC (`unfoldedId`).
 *  - Every moved edge is re-derived with `generateEdgeId`, and its channel is
 *    validated against the port list (a tampered `m1:zzz` is dropped). Edges
 *    that parse to index 0 are not touched.
 *  - `modelSignature` is REPLICATED onto every index node; `modelMeshes` stays
 *    ONE WHOLE LIST on the lowest-ranked index node, never regrouped per
 *    material (its stored order is module TEXT).
 *
 * Returns the SAME arrays when no Output carries a `materials` key (the
 * autosave compares by reference). An EMPTY `materials: []` is not clean: the
 * key itself is what the split retires.
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

  // Grow any group frame the new siblings hang out of (they inherit
  // `parentId`, and nothing else resizes a frame after a programmatic add).
  // Scoped to the ids THIS call minted; the SAME array when nothing grew.
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
 * The loader-0.6 MIRROR plan across a SET of Output nodes (materialPartsContract
 * R2/R4): one entry per `modelMeshes` name whose glTF material has an EMITTED
 * index section, minus every name a NAME section claims anywhere (a name claim
 * wins, as in 0.8) — in stored order, each name once, capped at
 * `MAX_MIRROR_ENTRIES`. Module-only (R7).
 *
 * `modelMeshes` and `modelSignature` are read from the LOWEST-RANKED index
 * node. The list is never regrouped per material: it is in
 * FIRST-SCENE-APPEARANCE order, which interleaves materials, and that stored
 * order is module TEXT. Emission never reads the session's `previewMesh`
 * facts — that is why the names ride node data.
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

/* ── List-form primitives: NO PRODUCTION CALLER, kept for their suites ─────
 *
 * Since one Output node became one material, every surface reads the
 * `…Across` forms above. These are KEPT deliberately: the golden in
 * `outputSectionCaps.test.ts` pins `claimNamedParts` against the emission
 * loop every committed snapshot came out of, and it is written over a
 * material LIST. The plans run the SAME bodies as their cross-node twins, and
 * `outputPlansAcross.test.ts` pins the one-node equivalence.
 * See docs/dev/outputs-and-materials.md.
 */

/** `NamedPartsPlanAcross` for ONE material list: sections, not nodes. */
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

/** The name plan of ONE material list: `claimNamedParts` with no node. It
 *  carries `outputSectionCaps.test.ts`'s golden. */
export function planNamedParts(materials: readonly OutputMaterial[]): NamedPartsPlan {
  const st: NamedClaimState = { entries: [], overCap: [], claimed: new Set() };
  const shadowed = claimNamedParts(st, materials, '');
  return {
    entries: st.entries.map(({ name, section }) => ({ name, section })),
    shadowed,
    overCap: st.overCap,
  };
}

/** `IndexPartsPlanAcross` for ONE material list. */
export interface IndexPartsPlan {
  /** Emitted entries, ascending by glTF index, each index once. */
  entries: { gltfIndex: number; section: number }[];
  /** Sections whose glTF index an EARLIER section already claims: inert. */
  duplicates: Set<number>;
  /** Sections past `MAX_INDEX_MATERIALS`: dropped at emission. Empty for
   *  every graph a restore path has sanitized. */
  overCap: number[];
}

/** The index plan of ONE material list: `claimIndexParts` with no node. */
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

/** The ADDED sections of one folded node by kind; the two caps are counted
 *  apart (`MAX_PARTS` named, `MAX_INDEX_MATERIALS` index). */
export function countSections(materials: readonly OutputMaterial[]): { named: number; index: number } {
  let named = 0;
  let index = 0;
  for (let i = 1; i < materials.length; i++) {
    if (isIndexSection(materials[i])) index++;
    else named++;
  }
  return { named, index };
}

/** The same count across a SET of Output nodes — a RUNNING TOTAL. */
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

/** The coverage of ONE node's index sections; `namedPlan` is its name plan. */
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

/** The mesh a new NAME section is seeded with: first one no name section
 *  claims and no index section covers, else one no name section claims (it
 *  then OVERRIDES its material's index section). Null when every mesh is
 *  name-claimed; never mints a duplicate NAME claim. */
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

/** The same choice across a SET of Output nodes: a mesh is taken if ANY of
 *  them names it. */
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

/** The two-pass preference both forms share: an entirely free mesh first,
 *  then one only an index section covers. */
function pickFrom(
  meshNames: readonly string[],
  claimed: ReadonlySet<string>,
  covered: ReadonlySet<string>,
): string | null {
  return meshNames.find((n) => !claimed.has(n) && !covered.has(n))
    ?? meshNames.find((n) => !claimed.has(n))
    ?? null;
}

/** `defaultSectionUnusedAcross` for ONE material list, material 0 being the
 *  default. */
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

/** The dormant set of `findDefaultOutput`'s node, derived from the whole
 *  store through `dormancyOptsFor` — the builder `outputEdgeIsDormant` uses. */
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

/** `assignMeshTargetsAcross` over ONE material list: material `index` gets
 *  exactly `names` and every OTHER material loses them. A material stripped
 *  of its last mesh is KEPT, empty. Pure: a fresh list, never a mutation. */
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

/** Re-point the edges of every material AFTER `removedIndex` one slot down,
 *  re-deriving each edge id with its handle; the SAME array when no edge
 *  moved. A folded file can still carry `m<n>:` handles, and code that
 *  renumbers them must not re-derive this by hand. */
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

/** `materialPartsMirrorPlanAcross` for ONE node: [] unless it is an Output
 *  with a valid signature. */
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
