/**
 * THE FastShaders single-GLB format (Phase 7), stated ONCE.
 *
 * A single-GLB export is one `.glb` holding the model, the optimised textures
 * the shader uses, the shader MODULE and the FASTSHADERS_PROJECT_V1 block.
 * Three kinds of code read or write that file, and this leaf is what they
 * agree on: the trusted WRITER (utils/glbRepack.ts), the trusted READERS
 * (utils/glbShaderExtras.ts and podest's hand-written twin), and loader 0.8's
 * glTF plugin on third-party pages, whose `EMBED_*`/`MODEL_SRC` literals are
 * text-pinned to these values by glbShaderContract.test.ts. Zero imports, so
 * anything may import it — test-utils and the reader included.
 *
 * ROOT `json.extras.fastshaders` is the ONLY authoritative location:
 *
 *   { v: 1,
 *     assets:  { "<placeholder key>": <images[] index>, … },  // ALWAYS written, possibly {}; keys sorted
 *     module:  { bufferView: <int>, mimeType: 'text/javascript', fnv1a: '<8 lowercase hex>' },
 *     project: { bufferView: <int> } }                         // block text; the loader never reads it
 *
 * The default scene carries `extras.fastshaders = FS_SCENE_MARKER` — a
 * POINTER-FREE marker, because GLTFExporter writes `scene.userData` back out
 * as scene extras, and indices there would point into an unrelated file.
 * Every reader ignores scene extras; the strip and the payload drop delete
 * them.
 *
 * THE MODULE VIEW: UTF-8 of the shader module with its image placeholders
 * KEPT (`"fs-asset:<key>"` literals, never inlined) and the GLB usage header
 * lines; a plain view — no `byteStride`, no `target`, no `extensions` — on
 * buffer 0 (the BIN); 1..FS_MODULE_MAX_BYTES long and read back at exactly
 * that length. The loader refuses each of those the same way the editor
 * reader does (parity: a file that restores in the editor also runs on an
 * A-Frame page). The WRITER always emits a module with a DEFAULT EXPORT, and
 * the loader refuses one without (M_NO_DEFAULT) — the ONE loader-only
 * refusal, deliberately not mirrored here: the loader's is a runtime
 * `typeof d` check AFTER the import, which no text scan can stand in for
 * (`export { x as default }` would be false-refused). So a hand-made GLB
 * whose module has no default export reads `ok`, is offered as a Restore and
 * takes the bare-script path, while an A-Frame page keeps the authored PBR.
 * Every `fs-asset:` key the module
 * references must be an `assets` key naming the image whose bytes EQUAL the
 * project payload (the optimised WebP when converted) — never the PNG/JPEG
 * fallback a texture's core `source` holds under EXT_texture_webp, and never
 * a KTX2 (the loader's stash admits only FS_ASSET_MIMES). Each distinct
 * payload is written ONCE: the same `images[]` entry serves the glTF texture
 * and the module.
 *
 * THE PROJECT VIEW: UTF-8 of exactly `embedProjectState('', project).trim()`,
 * i.e. the marker block, so the editor reads it back through
 * `extractProjectState` (reviver, version, shape gate) with no second parse
 * path; at most FS_PROJECT_MAX_BYTES. Refs (`imageRefs`) are ALWAYS written
 * for the images that ride in the file: no build older than the single-GLB
 * import can open one, so the `.js` readers' EXPORT_IMAGE_REFS gate does not
 * apply.
 *
 * WHO RUNS THE MODULE: only a page that opts in with `shader="src: model"`
 * (or `FastShaders.applyFromGltf`), or the editor / podest after an explicit
 * confirm. It is a `.js` in a model's clothing. The sandboxed preview and the
 * XR popups never execute a GLB-borne module: every preview copy is
 * payload-free, no document the app itself runs spells the opt-in, and the
 * loader's `disableModelModules` latch is called in each.
 *
 * The three helpers below are PLAIN PROPERTY reads over a parsed document,
 * never `in` (a hostile key may sit on the prototype chain), return a `Map`
 * where keys come from the file, and never throw — a document is someone's
 * model file.
 */

/** The root/scene extras key. === loader 0.8 `json.extras.fastshaders`. */
export const FS_EXTRAS_KEY = 'fastshaders';
/** The format version this leaf describes. `v` must be the NUMBER 1. */
export const FS_EXTRAS_VERSION = 1;
/** The `shader` src value that runs the module inside the entity's own model. === loader MODEL_SRC. */
export const MODEL_SRC = 'model';
/** `module.mimeType`. === loader MODULE_MIME. */
export const FS_MODULE_MIME = 'text/javascript';
/** The MIME the export download carries. */
export const FS_SINGLE_GLB_MIME = 'model/gltf-binary';
/** The module view's byte cap (16 MiB). === loader EMBED_MODULE_BYTES_MAX. */
export const FS_MODULE_MAX_BYTES = 16 * 1024 * 1024;
/** The project view's byte cap (32 MiB); the writer AND the editor/podest readers. */
export const FS_PROJECT_MAX_BYTES = 32 * 1024 * 1024;
/** At most this many `assets` keys are considered. === loader EMBED_ASSETS_MAX. */
export const FS_EMBED_ASSETS_MAX = 64;
/** One embedded image's byte cap. === loader EMBED_ASSET_BYTES_MAX. */
export const FS_EMBED_ASSET_BYTES_MAX = 16 * 1024 * 1024;
/** Every embedded image together, summed PER KEY as the loader's stash counts. === loader EMBED_TOTAL_BYTES_MAX. */
export const FS_EMBED_TOTAL_BYTES_MAX = 64 * 1024 * 1024;
/** An `assets` key. === loader EMBED_KEY_RE. */
export const FS_ASSET_KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** What engine/imageAssets.ts mints (`<safeKeyPart ≤64>-<fnv1a 8 hex>`); a subset of FS_ASSET_KEY_RE. */
export const IMAGE_ASSET_KEY_RE = /^[A-Za-z0-9_-]{1,64}-[0-9a-f]{8}$/;
/** The image MIMEs an `assets` entry may carry. === the loader's EMBED_MIME keys. */
export const FS_ASSET_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type FsAssetMime = (typeof FS_ASSET_MIMES)[number];
/**
 * The module's image placeholder literal, `"fs-asset:<key>"` — THE one
 * literal (imageAssets.test.ts pins that no second one exists under src/).
 * engine/imageAssets.ts re-exports this same object as IMAGE_PLACEHOLDER_RE;
 * it lives here because the single-GLB reader (utils/glbShaderExtras.ts) may
 * not import imageAssets, which reaches the store, and the loader's
 * MODEL_PLACEHOLDER_RE is text-pinned to it. The key class is `[^"]+`, so a
 * match can never run past the closing quote. A /g regex — iterate it with
 * `matchAll` or `String.prototype.replace`, never `test`/`exec`, whose
 * `lastIndex` carries between callers.
 */
export const FS_PLACEHOLDER_RE = /"fs-asset:([^"]+)"/g;
/** `module.fnv1a`: `fnv1a32Hex` of the module TEXT — 8 lowercase hex digits. */
export const FS_FNV1A_RE = /^[0-9a-f]{8}$/;
/** The default scene's pointer-free marker. */
export const FS_SCENE_MARKER = { v: 1, shader: true } as const;
/** The project block's markers. === engine/fastShadersProject.ts BEGIN_MARKER / END_MARKER (pinned). */
export const FS_PROJECT_BEGIN = '/* FASTSHADERS_PROJECT_V1';
export const FS_PROJECT_END = 'END_FASTSHADERS_PROJECT */';
/** `hasFsExtras` looks at this many scenes at most (= GLTF_READ_CAPS.scenes). */
export const FS_SCENES_SCAN_MAX = 256;

/** `extras.fastshaders.module` as the writer serialises it. */
export interface FsGlbModuleEntry {
  bufferView: number;
  mimeType: typeof FS_MODULE_MIME;
  fnv1a: string;
}
/** `extras.fastshaders.project` as the writer serialises it. */
export interface FsGlbProjectEntry {
  bufferView: number;
}
/** The root extras object the writer serialises, in THIS key order. */
export interface FsGlbExtrasWritten {
  v: typeof FS_EXTRAS_VERSION;
  assets: Record<string, number>;
  module: FsGlbModuleEntry;
  project: FsGlbProjectEntry;
}

/**
 * The pointers a document carries, validated leniently: every well-formed
 * entry is kept and every malformed one dropped, so the writer, the strip
 * and a cycle test can ask "what does this file point at" without deciding
 * whether the file is restorable — that stricter judgement (refusal reasons,
 * byte checks) is the reader's (utils/glbShaderExtras.ts).
 */
export interface FsGlbPointers {
  v: typeof FS_EXTRAS_VERSION;
  /** key → images[] index; only keys matching FS_ASSET_KEY_RE with an index in range. */
  assets: Map<string, number>;
  /** null unless `module` is a plain object with an in-range integer bufferView and the exact mimeType. */
  module: { bufferView: number; fnv1a: string | null } | null;
  /** null unless `project` is a plain object with an in-range integer bufferView. */
  project: { bufferView: number } | null;
}

type Obj = Record<string, unknown>;

/** A non-null, non-array object — what a JSON `{…}` parses to. */
export function isPlainObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isIndex = (v: unknown, length: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < length;

/** The root `extras.fastshaders` when it is a plain object, else null. Any version. */
function rootFsExtras(doc: unknown): Obj | null {
  if (!isPlainObject(doc)) return null;
  const extras = doc.extras;
  if (!isPlainObject(extras)) return null;
  const fs = extras[FS_EXTRAS_KEY];
  return isPlainObject(fs) ? fs : null;
}

/**
 * Does the document carry a `fastshaders` extras object at the root or on
 * any of its first FS_SCENES_SCAN_MAX scenes? Any version, any content — this
 * is the "is there a payload to drop" question, not "is it restorable".
 */
export function hasFsExtras(doc: unknown): boolean {
  try {
    if (rootFsExtras(doc) !== null) return true;
    if (!isPlainObject(doc)) return false;
    const scenes = doc.scenes;
    if (!Array.isArray(scenes)) return false;
    const n = Math.min(scenes.length, FS_SCENES_SCAN_MAX);
    for (let i = 0; i < n; i++) {
      const s: unknown = scenes[i];
      if (!isPlainObject(s)) continue;
      const extras = s.extras;
      if (isPlainObject(extras) && isPlainObject(extras[FS_EXTRAS_KEY])) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The bufferView indices of the root `module` and `project` pointers that lie
 * in `[0, bufferViews.length)`: deduped, ascending. Anything malformed is
 * ignored. The strip (utils/gltfStrip.ts) reclaims these views — any version,
 * because a preview copy must never carry a module's bytes whatever `v` says.
 */
export function fsPayloadViews(doc: unknown): number[] {
  try {
    const fs = rootFsExtras(doc);
    if (!fs || !isPlainObject(doc)) return [];
    const views = doc.bufferViews;
    const count = Array.isArray(views) ? views.length : 0;
    const out = new Set<number>();
    for (const key of ['module', 'project']) {
      const entry = fs[key];
      if (isPlainObject(entry) && isIndex(entry.bufferView, count)) out.add(entry.bufferView);
    }
    return [...out].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * The validated pointers of a format-1 document, or null when the root has no
 * `fastshaders` object whose `v` is the number 1. `counts` are the array
 * lengths the indices are checked against (the caller's, so a reader that
 * capped the arrays passes what it kept).
 */
export function readFsGlbPointers(
  doc: unknown,
  counts: { images: number; bufferViews: number },
): FsGlbPointers | null {
  try {
    const fs = rootFsExtras(doc);
    if (!fs || fs.v !== FS_EXTRAS_VERSION) return null;
    const assets = new Map<string, number>();
    const rawAssets = fs.assets;
    if (isPlainObject(rawAssets)) {
      const keys = Object.keys(rawAssets);
      const n = Math.min(keys.length, FS_EMBED_ASSETS_MAX);
      for (let i = 0; i < n; i++) {
        const key = keys[i];
        if (!FS_ASSET_KEY_RE.test(key)) continue;
        const idx = rawAssets[key];
        if (isIndex(idx, counts.images)) assets.set(key, idx);
      }
    }
    const m = fs.module;
    const module =
      isPlainObject(m) && isIndex(m.bufferView, counts.bufferViews) && m.mimeType === FS_MODULE_MIME
        ? {
            bufferView: m.bufferView,
            fnv1a: typeof m.fnv1a === 'string' && FS_FNV1A_RE.test(m.fnv1a) ? m.fnv1a : null,
          }
        : null;
    const p = fs.project;
    const project = isPlainObject(p) && isIndex(p.bufferView, counts.bufferViews) ? { bufferView: p.bufferView } : null;
    return { v: FS_EXTRAS_VERSION, assets, module, project };
  } catch {
    return null;
  }
}
