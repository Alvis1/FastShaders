/**
 * The preview's sub-mesh INVENTORY: what named meshes the loaded model actually
 * put in the scene, reported by the sandboxed preview and held session-only.
 *
 * WHY THE SANDBOX REPORTS IT INSTEAD OF THE PARENT PARSING THE FILE.
 * `utils/previewMesh.ts` states the rule this module obeys: model bytes are
 * never parsed on the trusted side (`countMeshVertices` is its one narrow,
 * bounded exception). Sub-mesh names are also not knowable from the file alone
 * — three's GLTFLoader rewrites them through `PropertyBinding.sanitizeNodeName`
 * and then de-duplicates collisions with a `_N` suffix, so the raw glTF JSON
 * name and the name a material dispatch would have to match are different
 * strings. The only source of truth is the loaded scene graph, which lives in
 * the sandbox. So the sandbox traverses and posts, and everything that arrives
 * here is treated as ADVERSARIAL: the preview document runs a loaded
 * `.fastshader`'s shader code, so a hostile shader can forge this message.
 *
 * WHAT IS AND IS NOT REJECTED, and why it is not the obvious ASCII whitelist.
 * three's sanitizer (animation/PropertyBinding.js) strips only `[ ] . : /` and
 * maps whitespace to `_`; its own comment says it "attempts to allow node names
 * from any language". Measured against the installed r184: `Ķermenis_āda 2`
 * comes back as `Ķermenis_āda_2` — non-ASCII SURVIVES. An `[A-Za-z0-9_.-]`
 * whitelist would therefore make every Latvian, Cyrillic and CJK mesh
 * permanently untargetable in a Latvian-first app, while admitting `Body.001`
 * (Blender's duplicate suffix), a name the glTF loader can never produce. So
 * this rejects only what is genuinely unusable or unsafe:
 *
 *  - EMPTY: an unnamed mesh (routine in OBJ, whose `o`/`g` lines are optional)
 *    cannot be addressed by name at all, so it is not offered as a target.
 *  - CONTROL CHARACTERS and the U+2028/U+2029 line terminators: invisible in
 *    every UI that would display them, and they exist here only as a way to
 *    smuggle something past a reader's eye.
 *  - `__proto__`: every map keyed by a mesh name must be a `Map` or a
 *    null-prototype object anyway (a plain-object lookup resolves `toString`
 *    and `constructor` to functions — measured in a browser, that assigns a
 *    Function to `node.material`), but a name that is *only* dangerous is worth
 *    refusing outright rather than defending everywhere forever.
 *  - Over-long names, as a resource bound: this rides postMessage now and, once
 *    per-mesh material targeting lands, node data, the autosave and the project
 *    embed.
 *
 * Whitespace and `[ ] . : /` are deliberately ALLOWED even though no glTF name
 * can contain them: OBJ names do not pass through the sanitizer, so `o my mesh`
 * really does land in the scene as `my mesh` and really is matchable by exact
 * name. Rejecting it would drop a mesh that is right there on screen. Emission
 * safety for these characters belongs at the emission site (`JSON.stringify`
 * plus the comment-terminator escape codegen already applies), not here.
 *
 * Pure and import-free, so the vitest node env covers it.
 */

/** One named mesh in the loaded model, as the preview scene actually holds it. */
export interface MeshInventoryEntry {
  /** Traversal index over `isMesh` nodes — a session-local disambiguator for
   *  duplicate names, never an identity that outlives the document. */
  index: number;
  /** The mesh's name in the SCENE (post-sanitize, post-`_N`-dedupe). */
  name: string;
  /** The AUTHORED material's name, or '' — a second targeting vocabulary that
   *  is cheap to carry now and awkward to retrofit into persisted bindings. */
  materialName: string;
  /** Vertices in the rendered geometry, for the picker's secondary line. */
  vertexCount: number;
}

/** The whole report, tied to the model document that produced it. */
export interface MeshInventory {
  /** The `custom:<id>` / built-in geometry key this report describes. A report
   *  is only ever valid for one model; the key is what makes a late arrival
   *  from a torn-down document identifiable as stale rather than plausible. */
  key: string;
  meshes: MeshInventoryEntry[];
}

/** Longest mesh name kept, in UTF-16 units. */
export const MESH_NAME_MAX = 128;
/** Most meshes kept from one report. A model may legitimately hold hundreds;
 *  this bounds what the UI and (later) the binding layer must carry, and the
 *  overflow is reported rather than silently truncated — see `truncated`. */
export const MAX_INVENTORY_MESHES = 256;
/** Longest material name kept. Shorter than a mesh name: it is a display hint,
 *  not an addressing key. */
export const MATERIAL_NAME_MAX = 64;

/* eslint-disable no-control-regex */
/** C0, C1, and the two line terminators that are legal in a JS string literal
 *  but invisible everywhere else. */
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
/* eslint-enable no-control-regex */

/**
 * Is this a mesh name the editor is willing to display and (later) bind to?
 *
 * Note this is a question about a name that ALREADY EXISTS in a loaded scene —
 * it never rewrites, because a name the loader produced is the only string a
 * material dispatch can match. Anything it refuses is simply not offered.
 */
export function isUsableMeshName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MESH_NAME_MAX) return false;
  if (name === '__proto__') return false;
  return !UNSAFE_CHARS.test(name);
}

/** Trim a display-only string to its cap, or '' for anything unusable. */
function displayString(v: unknown, max: number): string {
  if (typeof v !== 'string' || v.length === 0) return '';
  if (UNSAFE_CHARS.test(v)) return '';
  return v.length > max ? v.slice(0, max) : v;
}

/** A non-negative integer, or 0 — never NaN, never Infinity, never negative. */
function count(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
}

/**
 * Validate a report posted by the sandboxed preview.
 *
 * Returns null when there is nothing usable to show — deliberately null and not
 * an empty inventory, because "this model has no addressable meshes" and "no
 * model is loaded" must look the same to every reader: both mean the picker has
 * nothing to offer.
 *
 * `truncated` records that the model had more meshes than the cap, so the UI can
 * say so instead of presenting a silently shortened list as complete.
 */
export function sanitizeMeshInventory(
  key: unknown,
  meshes: unknown,
): (MeshInventory & { truncated: boolean }) | null {
  if (typeof key !== 'string' || key.length === 0 || key.length > MESH_NAME_MAX) return null;
  if (UNSAFE_CHARS.test(key)) return null;
  if (!Array.isArray(meshes)) return null;

  const out: MeshInventoryEntry[] = [];
  let seen = 0;
  for (const raw of meshes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (!isUsableMeshName(entry.name)) continue;
    seen += 1;
    if (out.length >= MAX_INVENTORY_MESHES) continue;
    out.push({
      index: count(entry.index),
      name: entry.name,
      materialName: displayString(entry.materialName, MATERIAL_NAME_MAX),
      vertexCount: count(entry.vertexCount),
    });
  }
  if (out.length === 0) return null;
  return { key, meshes: out, truncated: seen > out.length };
}

/**
 * How many meshes share each name — the "(x2)" the picker shows.
 *
 * A `Map`, not a plain object, for the reason the module header gives: these
 * keys come from a dropped file. Duplicate names are ordinary rather than
 * exceptional — three's de-duplication is bypassed when several glTF nodes
 * instance one multi-primitive mesh (three.js #30090), and OBJ never de-dupes
 * at all — and a name that appears twice addresses BOTH meshes, so the count is
 * information the user needs before binding, not a warning.
 */
export function meshNameCounts(meshes: readonly MeshInventoryEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of meshes) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  return counts;
}
