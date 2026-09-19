/**
 * The module return-object contract for glTF MATERIAL-INDEX parts, shared by
 * shaderloader 0.8 (which obeys it) and the Phase 5 emitter (which must write
 * it). Since GLB Phase 5 Step 5 they are emitted (graphToCode, buildShaderModule)
 * and parsed back (codeToGraph) for graphs carrying index sections; this file
 * fixes their names and bounds so the loader and the app cannot drift apart,
 * and shaderloaderMaterialParts.test.ts pins the loader's restatement to it.
 *
 * The keys, every one additive (a module without them behaves exactly as on
 * 0.6):
 *   materialParts:       { "<i>": spec }  — `i` the canonical decimal glTF
 *                        material index (MATERIAL_PART_KEY_RE); `spec` shaped
 *                        like a `parts` entry. A spec with no channel is skipped.
 *   modelSignature:      { materials: string[] } — the model's glTF
 *                        `materials[].name` values in order, '' for an absent
 *                        name, length = its material count.
 *   materialPartsMirror: string[] — the `parts` keys that exist only as 0.6
 *                        mirrors of materialParts entries.
 *
 * The export-side rules (0.6 is FROZEN, so its half of the guard lives here):
 *   R1  A module carrying materialParts MUST carry a `parts` object, `{}` when
 *       there is nothing to mirror. A materialParts-ONLY module takes 0.6's
 *       Simple-API branch — the whole return object becomes every mesh's
 *       colorNode, a zero vec4, near-black with no error. A truthy `parts`
 *       keeps 0.6 on the object path, where unclaimed meshes stay authored.
 *   R2  `parts` carries one MIRROR entry per mesh name the trusted-side GLB
 *       reader maps to an emitted materialParts index (reproducing
 *       GLTFLoader's naming), its body byte-identical to that entry's. A name
 *       an authored name-targeted section already claims is NOT mirrored: a
 *       name claim wins, the same precedence as 0.8.
 *   R3  `modelSignature` MUST accompany materialParts. 0.8 applies the table
 *       only when it equals the parse exactly (count + raw names in order).
 *   R4  Every mirror name is listed in `materialPartsMirror`. 0.8 drops those
 *       keys from its name table in every status, so on a mismatched model a
 *       mirror cannot paint unrelated meshes that share a name.
 *   R5  Every string key and signature name goes through `moduleStringLiteral`
 *       (engine/partKeyLiteral.ts, which graphToCode aliases as
 *       `partKeyLiteral`: JSON.stringify + the star-slash and `<` escapes).
 *   R6  codeToGraph and scriptToTSL DROP mirror keys before the byte-identical
 *       body merge and never turn them into name sections; emission and parse
 *       land in ONE commit.
 *   R7  The mirror is emitted inside buildShaderModule (the module layer), so
 *       the preview module and the exported module stay identical; the TSL in
 *       the code panel never shows it.
 *
 * The signature helpers (`sanitizeModelSignature`, `modelSignatureMatches`,
 * SIGNATURE_TOTAL_CHARS_MAX) live here and nowhere else: the reader, the
 * builder, the Output node's sanitizer, emission and the parse all import them.
 *
 * A leaf: no imports.
 */

export const MATERIAL_PARTS_KEY = 'materialParts';
export const MATERIAL_PARTS_MIRROR_KEY = 'materialPartsMirror';
export const MODEL_SIGNATURE_KEY = 'modelSignature';

/** The loader's resource bound on applied index entries. The editor's section cap must stay at or below it. */
export const LOADER_MATERIAL_PARTS_MAX = 256;
export const SIGNATURE_MATERIALS_MAX = 1024;
export const SIGNATURE_NAME_MAX = 1024;
/**
 * The editor's bound on a signature's SUMMED name length. The loader has no such
 * bound (1024 names of 1024 characters pass its `validSignature`); the editor
 * adds one because a signature rides node data, so it is copied into ~50 undo
 * snapshots, every autosave and every export, and it is emitted on the module's
 * one-line return. The reader refuses a model over it (`too-complex`), so a model
 * it accepts can never fail `sanitizeModelSignature` afterwards.
 */
export const SIGNATURE_TOTAL_CHARS_MAX = 65536;
export const MATERIAL_PART_KEY_RE = /^(0|[1-9][0-9]{0,3})$/;

/**
 * The highest glTF material index a section may be bound to — the range of
 * `MATERIAL_PART_KEY_RE` above, stated as a number so the two can be pinned
 * against each other.
 *
 * Held HERE, beside the key regex it must agree with, rather than in
 * utils/outputMaterials.ts (which re-exports it): `isUntargetedOutput` in
 * utils/sdfPartition.ts asks the same question when it decides whether an
 * Output may be ELECTED, and sdfPartition is a LEAF that nothing in the store
 * cycle may drag `outputMaterials` into (the costTable TDZ rule) — so the one
 * definition has to sit in a leaf both can import.
 */
export const GLTF_MATERIAL_INDEX_MAX = 9999;

/** A real, in-range glTF material index — never coerced (`'1'` from a
 *  tampered file is not an index, and `Number(true)` is 1). */
export function isGltfMaterialIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= GLTF_MATERIAL_INDEX_MAX;
}

/**
 * The node shape `emitRank` reads, stated STRUCTURALLY so this file keeps the
 * zero imports its header claims — not even a type one. An `AppNode` satisfies
 * it, which is what every caller passes.
 *
 * `data: object` rather than `{ emitOrder?: unknown }`: a type whose every
 * property is OPTIONAL is a WEAK TYPE, and TypeScript refuses an argument with
 * no property in common with it — so the honest-looking shape rejected every
 * `AppNode` whose data is a `ShaderNodeData`. `object` is required, excludes
 * `null` and the primitives (so the read below cannot throw), and every node
 * data interface satisfies it.
 */
export interface EmitOrdered {
  readonly data: object;
}

/**
 * THE strict accessor for an Output node's emitted position — the order its
 * `parts` / `materialParts` entry takes in the module, and nothing else.
 *
 * It exists because the nodes ARRAY is not a usable order and never can be:
 * `liftChildrenAfterParents` splices a node into a new slot on an ordinary
 * drag-into-a-group, and `useSyncEngine` reorders on every Apply. Deriving
 * emitted order from it would rewrite the module on a layout gesture —
 * `previewCode` advances, the 3D preview recompiles, the autosave dirties,
 * `__partPixel<n>` renumbers, and first-claim-wins flips on a duplicate mesh
 * name — all with `errors: []` and nothing on screen to explain it.
 *
 * Non-integer is 0, so a `.fastshader` claiming `"3"`, `3.5`, `NaN` or an
 * object cannot reorder anything; ties are broken by node id AT THE SORT, so
 * two nodes seeded 0 (two folded Outputs unfolded in one document) still have
 * one stable total order.
 *
 * Held HERE rather than in utils/outputMaterials.ts (which re-exports it), for
 * exactly the reason `GLTF_MATERIAL_INDEX_MAX` above is: `activeSink` in
 * utils/sdfPartition.ts must elect the LOWEST-RANKED untargeted Output — the
 * same node `defaultOutput` picks, or the two name different nodes on a split
 * document whose empty section was reordered ahead of node 0 — and
 * sdfPartition is a LEAF that nothing in the store cycle may drag
 * `outputMaterials` into (the costTable TDZ rule). A SECOND copy of the
 * accessor is what the rule forbids, so the one definition sits in the leaf
 * both can import.
 */
export function emitRank(node: EmitOrdered): number {
  const v: unknown = (node.data as { emitOrder?: unknown }).emitOrder;
  return Number.isInteger(v) ? (v as number) : 0;
}

/**
 * The EDITOR's ceiling on import-built INDEX sections (owner default 16, until a
 * browser recompile measurement exists: each section is a whole generated
 * material, measured ~55-62 ms apiece per 200 ms-debounced edit). N11's `{max}`.
 * Held HERE, beside the loader's bound it must never exceed, rather than in
 * utils/outputMaterials.ts (which re-exports it): buildShaderModule caps a
 * module's table with it too, and the engine may not import the store-coupled
 * utils graph. Emission, the parse, the sanitizer and the module layer all
 * read this one number.
 */
export const MAX_INDEX_MATERIALS = 16;

/**
 * Most loader-0.6 MIRROR entries one module carries (R2). A mirror is a whole
 * per-entry material on a 0.6 page, so a model with hundreds of meshes must
 * not become hundreds of materials; the rest simply stay on 0.8's index table.
 */
export const MAX_MIRROR_ENTRIES = 256;

export interface ModelSignature {
  materials: string[];
}

/**
 * One loader-0.6 MIRROR the module layer writes (R2): the GLTFLoader-given
 * mesh `name` gets a `parts` entry whose body is byte-identical to the
 * `materialParts` entry for glTF material `index`. Built by
 * utils/outputMaterials `materialPartsMirrorPlan` from the Output node's
 * `modelMeshes`, passed to buildShaderModule by every module path.
 */
export interface MaterialPartsMirrorEntry {
  readonly name: string;
  readonly index: number;
}

/**
 * THE editor-side signature sanitizer — the one copy every restore path, the
 * reader, the builder, emission and the parse call. `raw` is adversarial (node
 * data from a `.fastshader`, localStorage, a saved group, parsed module text).
 *
 * Accepts only an object (not an array) whose `materials` is an array of 1 to
 * SIGNATURE_MATERIALS_MAX strings, each at most SIGNATURE_NAME_MAX characters,
 * summing to at most SIGNATURE_TOTAL_CHARS_MAX. A hole, a non-string entry or
 * any bound exceeded → null. Nothing is trimmed, truncated or normalised: the
 * comparison is exact (`modelSignatureMatches`), so a rewritten name could only
 * ever make a signature match a model it does not describe.
 *
 * Plain property access, never `in` (a primitive `raw` would make `in` throw).
 * The length is checked BEFORE the walk, so a huge sparse array costs nothing.
 * Returns the SAME object when it is exactly `{ materials }` and clean — the
 * restore paths compare by identity to know nothing changed — else a fresh
 * `{ materials }` holding a copy of the array.
 */
export function sanitizeModelSignature(raw: unknown): ModelSignature | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const list: unknown = (raw as { materials?: unknown }).materials;
  if (!Array.isArray(list)) return null;
  const n = list.length;
  if (n < 1 || n > SIGNATURE_MATERIALS_MAX) return null;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const name: unknown = list[i];
    if (typeof name !== 'string' || name.length > SIGNATURE_NAME_MAX) return null;
    total += name.length;
    if (total > SIGNATURE_TOTAL_CHARS_MAX) return null;
  }
  const keys = Object.keys(raw);
  if (keys.length === 1 && keys[0] === 'materials') return raw as ModelSignature;
  return { materials: (list as string[]).slice() };
}

/**
 * Loader 0.8's match rule (`sameSignature`), stated once for the editor: the
 * same count, and every name `===` in order. No trimming, no Unicode
 * normalisation — another glTF also has materials 0, 1, 2.
 */
export function modelSignatureMatches(a: ModelSignature, b: ModelSignature): boolean {
  if (a.materials.length !== b.materials.length) return false;
  for (let i = 0; i < a.materials.length; i++) {
    if (a.materials[i] !== b.materials[i]) return false;
  }
  return true;
}

export interface LegacyGuardShape {
  hasMaterialParts: boolean;
  hasParts: boolean;
  hasSignature: boolean;
  partKeys: string[];
  mirrorKeys: string[];
}

/**
 * The R1/R3/R4 violations of one module shape, empty when it is safe on the
 * frozen 0.6 and well-formed for 0.8. The Phase 5 emitter must call this and
 * throw in dev on any violation.
 */
export function checkLegacyGuard(shape: LegacyGuardShape): string[] {
  const out: string[] = [];
  if (shape.hasMaterialParts && !shape.hasParts) {
    out.push('materialParts without a parts object (R1): 0.6 would paint every mesh near-black');
  }
  if (shape.hasMaterialParts && !shape.hasSignature) {
    out.push('materialParts without a modelSignature (R3)');
  }
  const parts = new Set(shape.partKeys);
  const seen = new Set<string>();
  for (const key of shape.mirrorKeys) {
    if (seen.has(key)) out.push(`mirror key listed twice: ${JSON.stringify(key)}`);
    seen.add(key);
    if (!parts.has(key)) out.push(`mirror key is not a parts key (R4): ${JSON.stringify(key)}`);
  }
  return out;
}
