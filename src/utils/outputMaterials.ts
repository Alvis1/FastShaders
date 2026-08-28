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
 * HANDLES. Material 0 keeps the BARE channel ids (`color`, `emissive`, …) —
 * every saved edge, every `generateEdgeId` string and every consumer that reads
 * `targetHandle === 'color'` was authored against them. Added materials
 * namespace theirs as `m<n>:<channel>`. Both directions go through
 * `channelHandle`/`parseChannelHandle` so no caller ever builds one by hand.
 *
 * Pure and import-light, so the vitest node env covers it.
 */

import type { AppNode, AppEdge, MaterialSettings, OutputMaterial } from '@/types';
import { isUsableMeshName } from './meshInventory';
import { generateEdgeId } from './idGenerator';
import { OUTPUT_DEFAULT_EXPOSED } from './exposedPorts';

export type { OutputMaterial };

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
 * usable name means nothing and is dropped by the sanitizer.
 */
export function materialTargetNames(material: OutputMaterial | undefined): string[] {
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
  opts: { meshNames: readonly string[]; inventoryKnown: boolean; defaultContributes: boolean },
): Set<number> {
  if (!opts.inventoryKnown) return new Set();
  const dormant = dormantMaterialIndices(materials, opts.meshNames);
  if (!opts.defaultContributes && opts.meshNames.length <= 1) {
    for (let i = 1; i < materials.length; i++) {
      if (materialTargetNames(materials[i]).length > 0) {
        dormant.delete(i);
        break;
      }
    }
  }
  return dormant;
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
  previewMeshInventory: { meshes?: readonly { name: string }[] } | null;
}): { outputId: string | null; dormant: Set<number>; visibleCount: number } {
  const out = findDefaultOutput(state.nodes as AppNode[]);
  if (!out) return { outputId: null, dormant: new Set(), visibleCount: 0 };
  const materials = outputMaterials(out);
  const dormant = dormantIndicesForPreview(materials, {
    meshNames: (state.previewMeshInventory?.meshes ?? []).map((m) => m.name),
    inventoryKnown: !state.previewMesh || !!state.previewMeshInventory,
    defaultContributes: outputDefaultContributes(out, state.edges),
  });
  return { outputId: out.id, dormant, visibleCount: materials.length - dormant.size };
}

/**
 * The FIRST mesh a material shades, or null when it is the default.
 *
 * Kept alongside `materialTargetNames` because several surfaces want ONE name
 * to show (the picker's closed label, the settings menu's material list) and
 * every one of them abbreviates the rest as an ellipsis. "Is this the default"
 * is `materialTargetNames(m).length === 0` — never `materialTargetName(m) ===
 * null` plus an assumption about the rest.
 */
export function materialTargetName(material: OutputMaterial | undefined): string | null {
  return materialTargetNames(material)[0] ?? null;
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
  const taken = new Set(names);
  return materials.map((m, i) => {
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

/** Every mesh name claimed by an added material, in order (a material may
 *  claim several). */
export function claimedMeshNames(node: AppNode): string[] {
  return addedMaterials(node).flatMap((m) => materialTargetNames(m));
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
 * THE Output node — the one every surface means by "this shader's output".
 *
 * With materials living inside one node there is only ever one, so this is now
 * a genuine singleton lookup rather than a rule about which of several wins.
 * Kept as a shared function anyway, because the alternative is ten call sites
 * each writing their own `find` and disagreeing the moment the shape changes
 * again — which is exactly what happened last time.
 */
export function findDefaultOutput(nodes: readonly AppNode[]): AppNode | null {
  return outputNodes(nodes)[0] ?? null;
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
 *    payload past the caps by hanging it off a material.
 */
export function sanitizeOutputMaterials(nodes: AppNode[]): AppNode[] {
  let changed = false;

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

    const raw = (node.data as { materials?: unknown }).materials;
    if (raw === undefined && target0Clean) return node;

    if (raw === undefined || !Array.isArray(raw)) {
      changed = true;
      const data = { ...node.data } as Record<string, unknown>;
      if (raw !== undefined) delete data.materials;
      applyTarget0(data);
      return { ...node, data } as unknown as AppNode;
    }

    const kept: OutputMaterial[] = [];
    let dirty = false;

    for (const entry of raw) {
      if (kept.length >= MAX_PARTS) { dirty = true; break; }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { dirty = true; continue; }
      const e = entry as Record<string, unknown>;
      const names = materialTargetNames({
        meshTargets: Array.isArray(e.meshTargets) ? (e.meshTargets as string[]) : undefined,
        meshTarget: e.meshTarget as { name: string } | undefined,
      });

      const clean: OutputMaterial = { meshTargets: names };
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
        || !Array.isArray(e.meshTargets)
        || (e.meshTargets as unknown[]).length !== names.length
        || (e.meshTargets as unknown[]).some((n, i) => n !== names[i])
      ) {
        dirty = true;
      }
      kept.push(clean);
    }

    if (!dirty && target0Clean && kept.length === raw.length) return node;
    changed = true;
    const data = { ...node.data } as Record<string, unknown>;
    if (kept.length > 0) data.materials = kept;
    else delete data.materials;
    applyTarget0(data);
    return { ...node, data } as unknown as AppNode;
  });

  return changed ? out : nodes;
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
 * Collapse a graph that carries SEVERAL Output nodes into the single-node
 * shape, rewriting the edges that fed the extras.
 *
 * The multi-Output design shipped to `main` but never to a release, so this
 * exists for two readers: anyone whose working session still holds such a
 * graph, and a hand-edited or hostile `.fastshader`, which can always claim any
 * shape at all. Without it those extra Outputs would sit on the canvas emitting
 * nothing — silently dropping whatever the user had wired into them.
 *
 * The FIRST Output survives (array order is creation order); each additional
 * one becomes a material, keeping its `meshTarget`, values, ports and settings,
 * and its incoming edges are re-pointed at the surviving node's namespaced
 * handles. An extra UNTARGETED Output has no material to become — material 0 is
 * already the default — so its edges are dropped with the node, which is what
 * emission did with it anyway.
 */
export function foldExtraOutputs(
  nodes: AppNode[],
  edges: AppEdge[],
): { nodes: AppNode[]; edges: AppEdge[] } {
  const outputs = outputNodes(nodes);
  if (outputs.length <= 1) return { nodes, edges };

  const keep = outputs[0];
  const extras = outputs.slice(1);
  const materials = [...outputMaterials(keep).slice(1)];
  /** old node id → its new material index on the surviving node. */
  const remap = new Map<string, number>();

  for (const extra of extras) {
    const ed = extra.data as { meshTargets?: string[]; meshTarget?: { name: string } };
    const names = materialTargetNames({ meshTargets: ed.meshTargets, meshTarget: ed.meshTarget });
    // A name another material already claims is KEPT, not skipped: the section
    // and its wiring survive (shadowed at emission), which is the same call
    // `sanitizeOutputMaterials` makes.
    if (names.length === 0 || materials.length >= MAX_PARTS) continue;
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
    remap.set(extra.id, materials.length); // material index = position + 1
  }

  const extraIds = new Set(extras.map((n) => n.id));
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
