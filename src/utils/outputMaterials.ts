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
  MAX_INDEX_MATERIALS,
  MAX_MIRROR_ENTRIES,
  modelSignatureMatches,
  sanitizeModelSignature,
  type MaterialPartsMirrorEntry,
} from '@/engine/materialPartsContract';
import { generateEdgeId } from './idGenerator';
import { OUTPUT_DEFAULT_EXPOSED } from './exposedPorts';

export type { OutputMaterial, MaterialPartsMirrorEntry };
// The index-section caps live in the contract leaf (buildShaderModule reads
// them too, and the engine may not import this store-coupled module); they are
// re-exported so every editor surface keeps one import site for "the caps".
export { MAX_INDEX_MATERIALS, MAX_MIRROR_ENTRIES };

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
 *  module's `materialParts` key (MATERIAL_PART_KEY_RE, canonical decimal). */
export const GLTF_MATERIAL_INDEX_MAX = 9999;

function isGltfMaterialIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= GLTF_MATERIAL_INDEX_MAX;
}

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
export function readModelSignature(data: unknown): string[] | null {
  if (!data || typeof data !== 'object') return null;
  return sanitizeModelSignature((data as { modelSignature?: unknown }).modelSignature)?.materials ?? null;
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
 */
export function outputMaterials(node: AppNode): OutputMaterial[] {
  if (node.data.registryType !== 'output') return [];
  const d = node.data as {
    values?: Record<string, string | number>;
    exposedPorts?: string[];
    materialSettings?: MaterialSettings;
    meshTargets?: string[];
    meshTarget?: { name: string };
  };
  return [
    {
      meshTargets: d.meshTargets,
      meshTarget: d.meshTarget,
      values: d.values,
      exposedPorts: d.exposedPorts,
      materialSettings: d.materialSettings,
    },
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

/**
 * THE one first-claim-wins loop over the named sections. Emission (graphToCode's
 * `parts`) and the node's shadowed mark both read it, so the two can never
 * disagree about which section a mesh belongs to.
 *
 * FIRST CLAIM WINS for a duplicate name: a `parts` map has one slot per mesh, and
 * a duplicate arrives only from a hand-edited or foreign file (the picker MOVES
 * a mesh rather than duplicating it). The cap is `MAX_PART_ENTRIES`; a name past
 * it is reported in `overCap` and NOT claimed. For every graph with at most
 * `MAX_PARTS` entries this is exactly the order emission has always used.
 */
export function planNamedParts(materials: readonly OutputMaterial[]): NamedPartsPlan {
  const entries: { name: string; section: number }[] = [];
  const shadowed = new Set<number>();
  const overCap: string[] = [];
  const claimed = new Set<string>();
  for (let i = 0; i < materials.length; i++) {
    const names = materialTargetNames(materials[i]);
    if (names.length === 0) continue;
    let emitted = 0;
    for (const name of names) {
      if (claimed.has(name)) continue;
      if (entries.length >= MAX_PART_ENTRIES) { overCap.push(name); continue; }
      claimed.add(name);
      entries.push({ name, section: i });
      emitted++;
    }
    if (emitted === 0) shadowed.add(i);
  }
  return { entries, shadowed, overCap };
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

/**
 * THE one first-claim-wins loop over the INDEX sections (the `planNamedParts`
 * twin): emission's `materialParts`, the mirror plan and the node's shadowed
 * mark all read it. Nothing is emitted without a valid signature, and an index
 * at or past its length is skipped (defensive: the sanitizer detaches those).
 * A duplicate index cannot be encoded — `materialParts` has one slot per
 * material — so the later section is shadowed, as a duplicate NAME is.
 */
export function planIndexParts(
  materials: readonly OutputMaterial[],
  signature: readonly string[] | null,
): IndexPartsPlan {
  const entries: { gltfIndex: number; section: number }[] = [];
  const duplicates = new Set<number>();
  const overCap: number[] = [];
  if (!signature) return { entries, duplicates, overCap };
  const claimed = new Set<number>();
  for (let i = 1; i < materials.length; i++) {
    const g = gltfIndexOf(materials[i]);
    if (g === null || g >= signature.length) continue;
    if (claimed.has(g)) { duplicates.add(i); continue; }
    if (entries.length >= MAX_INDEX_MATERIALS) { overCap.push(i); continue; }
    claimed.add(g);
    entries.push({ gltfIndex: g, section: i });
  }
  entries.sort((a, b) => a.gltfIndex - b.gltfIndex);
  return { entries, duplicates, overCap };
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
  const g = index > 0 ? gltfIndexOf(materials[index]) : null;
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
 * makes the "restore" perfect by construction. Material 0 never hides (it is
 * the node's own channel state; this loop starts at 1), an EMPTY added
 * material never hides (it names nothing to be missing — it is a state to
 * resolve, shown as "No mesh"), and a PARTIALLY missing material stays
 * visible with its absent names marked by the picker.
 *
 * Consumers must agree: OutputNode skips these sections (and folds this set
 * into its updateNodeInternals key — a hidden section UNMOUNTS real channel
 * handles, and the remount must be re-measured or restored wires never draw),
 * and PreviewLink counts only visible materials for its wire paths.
 */
export function dormantMaterialIndices(
  materials: readonly OutputMaterial[],
  meshNames: readonly string[],
): Set<number> {
  const present = new Set(meshNames);
  const dormant = new Set<number>();
  for (let i = 1; i < materials.length; i++) {
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
 *    (material 0 contributes nothing) on a ONE-mesh model paints the FIRST
 *    part — that material is actively shading the screen, and hiding it
 *    behind a chip that says "for another model" would be a lie. It stays
 *    visible with its missing names marked, the pre-dormancy honest state.
 *    `meshNames.length <= 1` covers both the one-mesh custom model (one
 *    reported name) and every primitive/built-in (no inventory, one unnamed
 *    mesh).
 */
export function dormantIndicesForPreview(
  materials: readonly OutputMaterial[],
  opts: {
    meshNames: readonly string[];
    inventoryKnown: boolean;
    defaultContributes: boolean;
    /** REQUIRED, so a caller that forgot index sections fails tsc:
     *  `indexSectionsAwake(readModelSignature(data), loadedModelOf(previewMesh))`. */
    indexSectionsAwake: boolean;
  },
): Set<number> {
  const dormant = new Set<number>();
  if (opts.inventoryKnown) {
    for (const i of dormantMaterialIndices(materials, opts.meshNames)) dormant.add(i);
    if (!opts.defaultContributes && opts.meshNames.length <= 1) {
      // Rule 2 lands on the first NAMED material; an index section is
      // nameless, so it can never be the one the exemption picks.
      for (let i = 1; i < materials.length; i++) {
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
  // dropped).
  if (!opts.indexSectionsAwake) {
    for (let i = 1; i < materials.length; i++) {
      if (isIndexSection(materials[i])) dormant.add(i);
    }
  }
  return dormant;
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
  const out = new Map<number, IndexCoverage>();
  if (!signature) return out;
  const { duplicates } = planIndexParts(materials, signature);
  const known = loaded.kind === 'gltf' && indexSectionsAwake(signature, loaded);
  const claimedByName = new Set(namedPlan.entries.map((e) => e.name));
  for (let i = 1; i < materials.length; i++) {
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
 * One derivation for the consumers that see the WHOLE store (PreviewLink's
 * selector, NodeEditor's scoped onError), keeping their opts in lockstep.
 * OutputNode derives the same opts from its granular subscriptions instead
 * (a whole-store selector there would re-render every Output per notify);
 * `outputTargetChip.test.ts` pins that both routes end in
 * `dormantIndicesForPreview`.
 */
export function outputDormancyFromState(state: {
  nodes: readonly AppNode[];
  edges: readonly AppEdge[];
  previewMesh: unknown;
  previewShowsModel?: boolean;
  previewMeshInventory: { meshes?: readonly { name: string }[] } | null;
}): { outputId: string | null; dormant: Set<number>; visibleCount: number } {
  const out = findDefaultOutput(state.nodes as AppNode[]);
  if (!out) return { outputId: null, dormant: new Set(), visibleCount: 0 };
  const materials = outputMaterials(out);
  const dormant = dormantIndicesForPreview(materials, {
    meshNames: (state.previewMeshInventory?.meshes ?? []).map((m) => m.name),
    inventoryKnown: !state.previewMesh || !!state.previewMeshInventory,
    defaultContributes: outputDefaultContributes(out, state.edges),
    indexSectionsAwake: indexAwakeFor(out, materials, shownPreviewMesh(state)),
  });
  return { outputId: out.id, dormant, visibleCount: materials.length - dormant.size };
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
 * Is material `index` dormant on ANY Output node? React Flow's 008 message
 * carries only the handle id (`m<n>:`), not the node, and several Outputs may
 * coexist (one active), so the dormancy swallow in NodeEditor's onFlowError
 * has to ask across all of them — an inactive Output's sleeping section would
 * otherwise flood the console at frame rate exactly as the active one used to.
 */
export function anyOutputDormant(
  state: {
    nodes: readonly AppNode[];
    edges: readonly AppEdge[];
    previewMesh: unknown;
    previewShowsModel?: boolean;
    previewMeshInventory: { meshes?: readonly { name: string }[] } | null;
  },
  index: number,
): boolean {
  const meshNames = (state.previewMeshInventory?.meshes ?? []).map((m) => m.name);
  const inventoryKnown = !state.previewMesh || !!state.previewMeshInventory;
  for (const out of outputNodes(state.nodes)) {
    const materials = outputMaterials(out);
    const dormant = dormantIndicesForPreview(materials, {
      meshNames,
      inventoryKnown,
      defaultContributes: outputDefaultContributes(out, state.edges),
      indexSectionsAwake: indexAwakeFor(out, materials, shownPreviewMesh(state)),
    });
    if (dormant.has(index)) return true;
  }
  return false;
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
 * THE plain Output node — the one every surface means by "this shader's
 * Output": the Output carrying the ACTIVE flag when one does (several Outputs
 * may coexist since 2026-09-03, exactly one of them active — see
 * `activeSink` in utils/sdfPartition.ts), else the first in array order,
 * which is what every document without a flag has always meant.
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
    const names0 = materialTargetNames({
      meshTargets: Array.isArray(d0.meshTargets) ? (d0.meshTargets as string[]) : undefined,
      meshTarget: d0.meshTarget as { name: string } | undefined,
    });
    trimmed += droppedTargetCount(rawTargetList(d0.meshTargets, d0.meshTarget), names0);
    // "Already clean" means: the list form, byte-for-byte what we would write.
    const target0Clean =
      !hadTargetKeys
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

    // The node-level index-section fields. Plain property access (a tampered
    // value may be any shape). A signature is only ever KEPT beside a
    // surviving index section, which is decided after the loop.
    const dn = node.data as { modelSignature?: unknown; modelMeshes?: unknown; gltfMaterialIndex?: unknown };
    const rawSig = dn.modelSignature;
    const rawMeshes = dn.modelMeshes;
    const sig = rawSig === undefined ? null : sanitizeModelSignature(rawSig);
    const noNodeExtras = rawSig === undefined && rawMeshes === undefined && dn.gltfMaterialIndex === undefined;
    /** Drop the node-level index fields from a data copy (no index section survives). */
    const dropNodeExtras = (data: Record<string, unknown>) => {
      delete data.modelSignature;
      delete data.modelMeshes;
      delete data.gltfMaterialIndex;
    };

    const raw = (node.data as { materials?: unknown }).materials;
    if (raw === undefined && target0Clean && noNodeExtras) return node;

    if (raw === undefined || !Array.isArray(raw)) {
      changed = true;
      const data = { ...node.data } as Record<string, unknown>;
      if (raw !== undefined) {
        // Not a list at all: whatever it held is gone, so it is announced.
        delete data.materials;
        trimmed++;
      }
      applyTarget0(data);
      dropNodeExtras(data);
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

    // The signature lives exactly as long as an index section does, and the
    // mirror source only beside it.
    const anyIndex = kept.some(isIndexSection);
    const outSig = anyIndex ? sig : null;
    const outMeshes = outSig ? sanitizeModelMeshes(rawMeshes, outSig.materials.length) : undefined;
    const extrasClean =
      (anyIndex ? outSig === rawSig : rawSig === undefined)
      && outMeshes === rawMeshes
      && dn.gltfMaterialIndex === undefined;

    if (!dirty && target0Clean && kept.length === raw.length && extrasClean) return node;
    changed = true;
    const data = { ...node.data } as Record<string, unknown>;
    if (kept.length > 0) data.materials = kept;
    else delete data.materials;
    applyTarget0(data);
    dropNodeExtras(data);
    if (outSig) data.modelSignature = outSig;
    if (outMeshes) data.modelMeshes = outMeshes;
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

/**
 * Collapse a graph that carries SEVERAL Output nodes into the single-node
 * shape, rewriting the edges that fed the extras.
 *
 * The multi-Output design shipped to `main` but never to a release, so this
 * exists for two readers: anyone whose working session still holds such a
 * graph, and a hand-edited or hostile `.fastshader`, which can always claim any
 * shape at all. Without it those extra Outputs would sit on the canvas emitting
 * nothing — silently dropping whatever the user had wired into them.
 *
 * The ACTIVE Output survives (`findDefaultOutput`: the flagged one, else the
 * first in array order); each additional one that carries the LEGACY per-node
 * mesh target becomes a material, keeping its `meshTarget`, values, ports and
 * settings, with its incoming edges re-pointed at the surviving node's
 * namespaced handles. An UNTARGETED extra is NOT touched: since 2026-09-03
 * several Outputs may coexist with exactly one active (utils/sdfPartition.ts
 * `activeSink`), so an untargeted second Output is an ordinary inactive one,
 * kept together with everything wired into it.
 */
export function foldExtraOutputs(
  nodes: AppNode[],
  edges: AppEdge[],
): { nodes: AppNode[]; edges: AppEdge[] } {
  const outputs = outputNodes(nodes);
  if (outputs.length <= 1) return { nodes, edges };

  const keep = findDefaultOutput(nodes) ?? outputs[0];
  // Only an extra carrying the LEGACY per-node mesh target is folded — that
  // is the one-Output-per-mesh shape this migration exists for. An untargeted
  // extra is an ordinary INACTIVE Output now (several may coexist, one
  // active — see `activeSink`) and is left exactly as it is, wiring included.
  // An extra carrying INDEX sections (or a signature) is a modern inactive
  // Output, never the legacy shape: folding it would keep only its node-level
  // target and silently drop the sections it was built with.
  const extras = outputs.filter((n) => n.id !== keep.id
    && readModelSignature(n.data) === null
    && !outputMaterials(n).some(isIndexSection)
    && materialTargetNames({
      meshTargets: (n.data as { meshTargets?: string[] }).meshTargets,
      meshTarget: (n.data as { meshTarget?: { name: string } }).meshTarget,
    }).length > 0);
  if (extras.length === 0) return { nodes, edges };
  const materials = [...outputMaterials(keep).slice(1)];
  /** old node id → its new material index on the surviving node. */
  const remap = new Map<string, number>();
  // The NAMED cap counts named sections only — the keep's index sections
  // (an import-built Output) have their own cap and must not block the fold.
  let named = countSections([{}, ...materials]).named;

  for (const extra of extras) {
    const ed = extra.data as { meshTargets?: string[]; meshTarget?: { name: string } };
    const names = materialTargetNames({ meshTargets: ed.meshTargets, meshTarget: ed.meshTarget });
    // A name another material already claims is KEPT, not skipped: the section
    // and its wiring survive (shadowed at emission), which is the same call
    // `sanitizeOutputMaterials` makes.
    //
    // Folds only what FITS: an extra past the cap is NOT folded and NOT
    // deleted — it stays on the canvas as an ordinary inactive Output with its
    // wiring (it is left out of `remap`, so `extraIds` below never names it).
    // Until 2026-09 it was deleted and its incoming edges silently dropped.
    if (names.length === 0 || named >= MAX_PARTS) continue;
    const d = extra.data as {
      values?: Record<string, string | number>;
      exposedPorts?: string[];
      materialSettings?: MaterialSettings;
    };
    const material: OutputMaterial = { meshTargets: names };
    if (d.values) material.values = d.values;
    if (d.exposedPorts) material.exposedPorts = d.exposedPorts;
    if (d.materialSettings) material.materialSettings = d.materialSettings;
    materials.push(material);
    named++;
    remap.set(extra.id, materials.length); // material index = position + 1
  }

  // Nothing fit: the graph is left exactly as it arrived (same arrays).
  if (remap.size === 0) return { nodes, edges };
  // Only the FOLDED extras leave the canvas; the rest keep node and wiring.
  const extraIds = new Set(remap.keys());
  const nextNodes = nodes
    .filter((n) => !extraIds.has(n.id))
    .map((n) => {
      if (n.id !== keep.id) return n;
      const data = { ...n.data };
      if (materials.length > 0) (data as { materials?: OutputMaterial[] }).materials = materials;
      return { ...n, data } as AppNode;
    });

  const nextEdges: AppEdge[] = [];
  for (const e of edges) {
    if (!extraIds.has(e.target)) { nextEdges.push(e); continue; }
    const index = remap.get(e.target);
    if (index === undefined || typeof e.targetHandle !== 'string') continue;
    const { channel } = parseChannelHandle(e.targetHandle);
    const targetHandle = channelHandle(index, channel);
    // The id is derived from the endpoints, so a re-pointed edge must be
    // re-derived too — a stale id would collide with the next edge that really
    // does connect these two, and dedupe logic keyed on it would drop one.
    nextEdges.push({
      ...e,
      id: generateEdgeId(e.source, e.sourceHandle ?? 'out', keep.id, targetHandle),
      target: keep.id,
      targetHandle,
    });
  }

  return { nodes: nextNodes, edges: nextEdges };
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
  if (!Array.isArray(rawMeshes) || rawMeshes.length === 0) return [];
  const sig = readModelSignature(node.data);
  if (!sig) return [];
  const materials = outputMaterials(node);
  const emitting = new Set(planIndexParts(materials, sig).entries.map((e) => e.gltfIndex));
  if (emitting.size === 0) return [];
  const nameClaimed = new Set(materials.flatMap((m) => materialTargetNames(m)));
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
