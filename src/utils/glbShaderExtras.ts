/**
 * THE trusted-side READER of a FastShaders single-GLB (Phase 7), and the
 * payload DROP every preview copy goes through.
 *
 * THE TRUST RULE. A FastShaders GLB is a `.js` in a model's clothing, and the
 * bytes arrive from a drop, a zip, the IndexedDB mirror or another user's
 * export. This module classifies and SLICES bytes: it never decodes a
 * picture, never executes text, never fetches, and never touches the store.
 * Every cap, index, magic number, the UTF-8 validity (a FATAL decoder) and
 * the JSON reviver are applied before anything is used, and a structural
 * failure refuses the WHOLE restore — the caller then loads the file as a
 * plain model. A bad ASSET, by contrast, only leaves its placeholder verbatim
 * (that image renders black, and the project side raises `images-missing`),
 * which is what loader 0.8's stash does on a page.
 *
 * THE LAYOUT it reads is engine/glbShaderContract.ts (root
 * `extras.fastshaders`: `v: 1`, `assets`, `module`, `project`), and every
 * constant comes from there — none of its own. Scene extras are IGNORED
 * (integration §3 C2): the root is authoritative, and a scene copy could
 * only disagree.
 *
 * PARITY. It refuses everything loader 0.8 refuses for a module view (a wrong
 * mimeType, a `byteStride`/`target`/`extensions` on the view, a buffer that
 * is not the BIN, an empty or over-long view, one cut short by the BIN, text
 * that is not UTF-8), so a file that restores here also runs on an A-Frame
 * page — with ONE loader-only refusal it deliberately does not mirror: the
 * module's CONTENT is never inspected, so a module with no default export
 * reads `ok` here and is refused (M_NO_DEFAULT) there. The loader's is a
 * runtime `typeof` check after the import; see glbShaderContract.ts.
 * The DISAGREEMENT rule: the editor takes the PROJECT (the module text
 * is never parsed; `moduleEdited` only flags a digest mismatch as a warning);
 * podest, A-Frame pages and plain three run the MODULE.
 *
 * podest.html carries a hand-written vanilla TWIN (`fsReadGlb`,
 * `fsDropPayload`) that must agree with this module on the same fixtures; a
 * drift test runs both. Nothing here is called at runtime yet (Phase 7 Step
 * 2): the restore commit and the preview-mesh drop arrive in Step 6.
 */
import { GLB_MAGIC, buildGlbContainer, decodeDataUri, encodeDataUri, parseGlbContainer } from './glbContainer';
import { GLB_READ_MAX_BYTES } from './gltfCompression';
import { GLTF_READ_CAPS } from './gltfReader';
import { safeJsonReviver } from './safeJson';
import { fnv1a32Hex } from './payloadDigest';
import type { PreviewMeshKind } from './previewMesh';
import {
  FS_ASSET_KEY_RE,
  FS_ASSET_MIMES,
  FS_EMBED_ASSET_BYTES_MAX,
  FS_EMBED_ASSETS_MAX,
  FS_EMBED_TOTAL_BYTES_MAX,
  FS_EXTRAS_KEY,
  FS_EXTRAS_VERSION,
  FS_FNV1A_RE,
  FS_MODULE_MAX_BYTES,
  FS_MODULE_MIME,
  FS_PLACEHOLDER_RE,
  FS_PROJECT_BEGIN,
  FS_PROJECT_END,
  FS_PROJECT_MAX_BYTES,
  fsPayloadViews,
  hasFsExtras,
  isPlainObject,
} from '@/engine/glbShaderContract';

/** The byte sniff over a JSON chunk (or the raw file) before any parse. */
export const FS_JSON_SNIFF = '"fastshaders"';
/**
 * The ESCAPE sniff beside it, and it is what makes the cheap text gate SOUND
 * rather than merely fast. A JSON key is delimited by LITERAL quotes (an
 * escaped quote is content, not a delimiter), and the only escape that can
 * spell a letter is `\uXXXX`; every character of `fastshaders` is
 * U+0061..U+0074, so ANY escaped spelling of the key contains `\u00`.
 * A JSON carrying that is therefore un-sniffable and must fall through to the
 * parse — without it `{"extras":{"fastshaders":…}}` parses to the very
 * same document while the literal sniff misses it, so the reader answers
 * `none`, the drop hands the bytes back untouched, and a crafted GLB's module
 * survives into the IndexedDB mirror, the XR blob at the app's REAL origin
 * and a zip `models/` entry (integration §5 layer L1). The `00` is what keeps
 * it tight: `\u` alone matches ~always in a multi-megabyte BIN.
 */
export const FS_JSON_ESCAPE_SNIFF = '\\u00';

/** Could this JSON text carry the key — literally, or hidden behind an escape? */
export const fsJsonMayCarry = (json: string): boolean =>
  json.includes(FS_JSON_SNIFF) || json.includes(FS_JSON_ESCAPE_SNIFF);

export type FsExtrasRefusal = 'damaged' | 'too-large' | 'unsupported-version' | 'inconsistent';

export interface FsEmbeddedShader {
  /** The module with its placeholders INLINED to canonical `data:` URLs; null = no module view. */
  readonly moduleText: string | null;
  /** The project block text, trimmed (FS_PROJECT_BEGIN … FS_PROJECT_END); null = no project view. */
  readonly projectText: string | null;
  /** placeholder key → canonical `data:` URL. */
  readonly assets: ReadonlyMap<string, string>;
  /** `assets` keys that were refused (their placeholders stay verbatim). */
  readonly assetsRefused: number;
  /** `module.fnv1a` present, well-formed and ≠ the stored module text's digest. */
  readonly moduleEdited: boolean;
}

export type FsExtrasRead =
  | { readonly state: 'none' }
  | { readonly state: 'refused'; readonly reason: FsExtrasRefusal }
  | { readonly state: 'ok'; readonly shader: FsEmbeddedShader };

const NONE: FsExtrasRead = { state: 'none' };
const refused = (reason: FsExtrasRefusal): FsExtrasRead => ({ state: 'refused', reason });

type Obj = Record<string, unknown>;

const isSafeNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isIndex = (v: unknown, length: number): v is number => isSafeNonNeg(v) && v < length;

/* ── the file's own structure ────────────────────────────────────────────── */

/**
 * Every bufferView index a MODEL site references: accessors (and their sparse
 * indices/values), images, and any primitive extension carrying a
 * `bufferView`. A payload view named here is also real data, so the reader
 * refuses the file and the drop leaves the bytes alone. 'damaged' when an
 * array is over the reader's caps (the file would be refused as a model too).
 */
function modelSiteViews(doc: Obj): Set<number> | 'damaged' {
  const out = new Set<number>();
  const add = (v: unknown) => {
    if (isSafeNonNeg(v)) out.add(v);
  };
  const accessors = Array.isArray(doc.accessors) ? doc.accessors : [];
  if (accessors.length > GLTF_READ_CAPS.accessors) return 'damaged';
  for (const a of accessors) {
    if (!isPlainObject(a)) continue;
    add(a.bufferView);
    const sparse = a.sparse;
    if (!isPlainObject(sparse)) continue;
    for (const part of ['indices', 'values']) {
      const p = sparse[part];
      if (isPlainObject(p)) add(p.bufferView);
    }
  }
  const images = Array.isArray(doc.images) ? doc.images : [];
  if (images.length > GLTF_READ_CAPS.images) return 'damaged';
  for (const img of images) if (isPlainObject(img)) add(img.bufferView);
  const meshes = Array.isArray(doc.meshes) ? doc.meshes : [];
  if (meshes.length > GLTF_READ_CAPS.meshes) return 'damaged';
  let primitives = 0;
  for (const mesh of meshes) {
    if (!isPlainObject(mesh) || !Array.isArray(mesh.primitives)) continue;
    primitives += mesh.primitives.length;
    if (primitives > GLTF_READ_CAPS.primitives) return 'damaged';
    for (const prim of mesh.primitives) {
      if (!isPlainObject(prim) || !isPlainObject(prim.extensions)) continue;
      for (const key of Object.keys(prim.extensions)) {
        const e = prim.extensions[key];
        if (isPlainObject(e)) add(e.bufferView);
      }
    }
  }
  return out;
}

type ViewSlice =
  | { ok: true; bytes: Uint8Array; start: number; end: number }
  | { ok: false; reason: 'damaged' | 'too-large' };

const DAMAGED: ViewSlice = { ok: false, reason: 'damaged' };

/**
 * The bytes of bufferView `index` under the module-view rules (the loader's
 * refusals, applied to every payload and asset view alike): on buffer 0, the
 * GLB BIN (`buffers[0]` has no `uri`); no `byteStride`, `target` or
 * `extensions`; safe non-negative offset and length; 1..`max` bytes; inside
 * the BIN.
 */
function viewSlice(doc: Obj, bin: Uint8Array | null, index: number, max: number): ViewSlice {
  const views = doc.bufferViews;
  if (!Array.isArray(views) || !isIndex(index, views.length)) return DAMAGED;
  const view: unknown = views[index];
  if (!isPlainObject(view) || view.buffer !== 0) return DAMAGED;
  const buffers = doc.buffers;
  if (!Array.isArray(buffers) || !isPlainObject(buffers[0]) || typeof buffers[0].uri === 'string') return DAMAGED;
  if (view.byteStride !== undefined || view.target !== undefined || view.extensions !== undefined) return DAMAGED;
  const start = view.byteOffset === undefined ? 0 : view.byteOffset;
  const length = view.byteLength;
  if (!isSafeNonNeg(start) || !isSafeNonNeg(length) || length === 0) return DAMAGED;
  if (length > max) return { ok: false, reason: 'too-large' };
  if (bin === null || start + length > bin.length) return DAMAGED;
  return { ok: true, bytes: bin.subarray(start, start + length), start, end: start + length };
}

/* ── assets ──────────────────────────────────────────────────────────────── */

function hasBytes(b: Uint8Array, at: number, sig: readonly number[]): boolean {
  if (b.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
}

/** mimeType → the file signature its bytes must start with (the loader's EMBED_MIME table). */
function magicMatches(mime: string, b: Uint8Array): boolean {
  switch (mime) {
    case 'image/png':
      return hasBytes(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return hasBytes(b, 0, [0xff, 0xd8, 0xff]);
    case 'image/webp':
      return hasBytes(b, 0, [0x52, 0x49, 0x46, 0x46]) && hasBytes(b, 8, [0x57, 0x45, 0x42, 0x50]);
    default:
      return false;
  }
}

/** One `images[]` entry as an asset: its canonical `data:` URL and byte count, or null when refused. */
function readAssetImage(doc: Obj, bin: Uint8Array | null, img: unknown): { src: string; length: number } | null {
  if (!isPlainObject(img) || typeof img.uri === 'string' || !isSafeNonNeg(img.bufferView)) return null;
  const mime = img.mimeType;
  if (typeof mime !== 'string' || !(FS_ASSET_MIMES as readonly string[]).includes(mime)) return null;
  const s = viewSlice(doc, bin, img.bufferView, FS_EMBED_ASSET_BYTES_MAX);
  if (!s.ok || !magicMatches(mime, s.bytes)) return null;
  return { src: encodeDataUri(mime, s.bytes), length: s.bytes.length };
}

/**
 * The `assets` map resolved to canonical `data:` URLs: at most
 * FS_EMBED_ASSETS_MAX keys considered (the rest count as refused), each key
 * matching FS_ASSET_KEY_RE and naming a bufferView image of an allowed MIME
 * whose bytes carry that MIME's magic, under the per-image and per-file caps
 * (the total is summed PER KEY, as the loader's stash counts). The data URL
 * is built once per image index.
 */
function readAssets(doc: Obj, bin: Uint8Array | null, raw: unknown): { assets: Map<string, string>; refused: number } {
  const assets = new Map<string, string>();
  let refusedCount = 0;
  if (!isPlainObject(raw)) return { assets, refused: 0 };
  const images = Array.isArray(doc.images) ? doc.images : [];
  const keys = Object.keys(raw);
  const n = Math.min(keys.length, FS_EMBED_ASSETS_MAX);
  refusedCount += keys.length - n;
  const memo = new Map<number, { src: string; length: number } | null>();
  let total = 0;
  for (let i = 0; i < n; i++) {
    const key = keys[i];
    if (!FS_ASSET_KEY_RE.test(key)) {
      refusedCount++;
      continue;
    }
    const idx = raw[key];
    if (!isIndex(idx, images.length)) {
      refusedCount++;
      continue;
    }
    let entry = memo.get(idx);
    if (entry === undefined) {
      entry = readAssetImage(doc, bin, images[idx]);
      memo.set(idx, entry);
    }
    if (entry === null || total + entry.length > FS_EMBED_TOTAL_BYTES_MAX) {
      refusedCount++;
      continue;
    }
    total += entry.length;
    assets.set(key, entry.src);
  }
  return { assets, refused: refusedCount };
}

/* ── the reader ──────────────────────────────────────────────────────────── */

function readFsExtrasUnsafe(doc: unknown, bin: Uint8Array | null): FsExtrasRead {
  if (!isPlainObject(doc)) return NONE;
  const extras = doc.extras;
  if (!isPlainObject(extras)) return NONE;
  const fs = extras[FS_EXTRAS_KEY];
  if (!isPlainObject(fs)) return NONE;

  // 2. The version: the number 1, exactly.
  if (fs.v !== FS_EXTRAS_VERSION) {
    const v = fs.v;
    return refused(typeof v === 'number' && Number.isSafeInteger(v) && v > FS_EXTRAS_VERSION ? 'unsupported-version' : 'damaged');
  }

  // 3. The pointers: each absent, or a plain object with a safe-integer view.
  const m = fs.module;
  const p = fs.project;
  if (m !== undefined && !(isPlainObject(m) && isSafeNonNeg(m.bufferView))) return refused('damaged');
  if (p !== undefined && !(isPlainObject(p) && isSafeNonNeg(p.bufferView))) return refused('damaged');
  if (m === undefined && p === undefined) return NONE; // an assets-only stash is not a restorable shader
  if (m !== undefined && m.mimeType !== FS_MODULE_MIME) return refused('damaged');

  // 4–5. The views, and that they are the file's own payload and nothing else's.
  const sites = modelSiteViews(doc);
  if (sites === 'damaged') return refused('damaged');
  let moduleSlice: ViewSlice | null = null;
  let projectSlice: ViewSlice | null = null;
  if (m !== undefined) {
    const s = viewSlice(doc, bin, m.bufferView as number, FS_MODULE_MAX_BYTES);
    if (!s.ok) return refused(s.reason);
    if (sites.has(m.bufferView as number)) return refused('inconsistent');
    moduleSlice = s;
  }
  if (p !== undefined) {
    const s = viewSlice(doc, bin, p.bufferView as number, FS_PROJECT_MAX_BYTES);
    if (!s.ok) return refused(s.reason);
    if (sites.has(p.bufferView as number)) return refused('inconsistent');
    projectSlice = s;
  }
  if (moduleSlice?.ok && projectSlice?.ok) {
    if ((m as Obj).bufferView === (p as Obj).bufferView) return refused('inconsistent');
    if (moduleSlice.start < projectSlice.end && projectSlice.start < moduleSlice.end) return refused('inconsistent');
  }

  // 7. Decode — fatal: not UTF-8 is damaged, never mojibake.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let storedModule: string | null = null;
  let projectText: string | null = null;
  if (moduleSlice?.ok) {
    try {
      storedModule = decoder.decode(moduleSlice.bytes);
    } catch {
      return refused('damaged');
    }
    if (storedModule.length === 0) return refused('damaged');
  }
  if (projectSlice?.ok) {
    try {
      projectText = decoder.decode(projectSlice.bytes).trim();
    } catch {
      return refused('damaged');
    }
    if (!projectText.startsWith(FS_PROJECT_BEGIN) || !projectText.endsWith(FS_PROJECT_END)) return refused('damaged');
  }

  // 8. The digest: an accidental-edit detector, never a control.
  const fnv1a = m !== undefined ? (m as Obj).fnv1a : undefined;
  const moduleEdited =
    storedModule !== null && typeof fnv1a === 'string' && FS_FNV1A_RE.test(fnv1a) && fnv1a32Hex(storedModule) !== fnv1a;

  // 9–10. The assets, and the module with them inlined.
  const { assets, refused: assetsRefused } = readAssets(doc, bin, fs.assets);
  const moduleText = storedModule === null ? null : inlineFsAssets(storedModule, assets);
  return { state: 'ok', shader: { moduleText, projectText, assets, assetsRefused, moduleEdited } };
}

/**
 * Read a parsed glTF document's FastShaders payload against its BIN. Never
 * throws: a document that throws while being read is `damaged`.
 */
export function readFsExtras(doc: unknown, bin: Uint8Array | null): FsExtrasRead {
  try {
    return readFsExtrasUnsafe(doc, bin);
  } catch {
    return refused('damaged');
  }
}

const isGlbMagic = (b: Uint8Array) =>
  b.length >= 4 && new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true) === GLB_MAGIC;

const SNIFF_BYTES = new TextEncoder().encode(FS_JSON_SNIFF);
const ESCAPE_SNIFF_BYTES = new TextEncoder().encode(FS_JSON_ESCAPE_SNIFF);

const matchesAt = (b: Uint8Array, i: number, pat: Uint8Array): boolean => {
  if (i + pat.length > b.length) return false;
  for (let j = 1; j < pat.length; j++) if (b[i + j] !== pat[j]) return false;
  return true;
};

/**
 * Does the raw file contain either ASCII sniff anywhere — the literal key, or
 * the `\u00` an escaped spelling of it must carry (`fsJsonMayCarry`, in byte
 * form)? One pass, because the file may be tens of megabytes. Used only when
 * the JSON chunk itself cannot be extracted.
 */
function sniffBytes(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === SNIFF_BYTES[0] && matchesAt(b, i, SNIFF_BYTES)) return true;
    if (c === ESCAPE_SNIFF_BYTES[0] && matchesAt(b, i, ESCAPE_SNIFF_BYTES)) return true;
  }
  return false;
}

/**
 * Read a `.glb`'s FastShaders payload from its bytes. Not a GLB, or a GLB
 * whose JSON neither mentions `"fastshaders"` nor could hide it behind an
 * escape → `none` without a parse; a container or JSON that will not parse
 * AFTER the sniff hit → `damaged` (fail closed: the file claims a payload it
 * cannot deliver). A `.gltf` text is `none` here — the editor restores from
 * GLBs only.
 */
export function readGlbFsExtras(bytes: Uint8Array): FsExtrasRead {
  try {
    if (!isGlbMagic(bytes)) return NONE;
    const c = parseGlbContainer(bytes);
    if (!c.ok) return sniffBytes(bytes) ? refused('damaged') : NONE;
    if (!fsJsonMayCarry(c.chunks.json)) return NONE;
    let doc: unknown;
    try {
      doc = JSON.parse(c.chunks.json, safeJsonReviver);
    } catch {
      return refused('damaged');
    }
    return readFsExtras(doc, c.chunks.bin);
  } catch {
    return refused('damaged');
  }
}

/* ── placeholders ────────────────────────────────────────────────────────── */

/**
 * Expand every `"fs-asset:<key>"` literal whose key is in `assets` to its
 * `data:` URL — the same semantics as engine/imageAssets' inlineImageAssets
 * (pinned equal by test): an unknown key stays verbatim, and the replacement
 * is a function so a `$&` in a payload is never a substitution pattern.
 */
export function inlineFsAssets(code: string, assets: ReadonlyMap<string, string>): string {
  if (assets.size === 0 || !code.includes('fs-asset:')) return code;
  return code.replace(FS_PLACEHOLDER_RE, (whole, key: string) => {
    const src = assets.get(key);
    return src === undefined ? whole : `"${src}"`;
  });
}

/**
 * The assets as scan-only text — one double-quoted `data:` literal per line —
 * for engine/projectImageRefs' `moduleImageLiterals`, so the project branch
 * of a restore resolves its `imageRefs` from the GLB's images without the
 * module text.
 */
export function assetLiteralText(assets: ReadonlyMap<string, string>): string {
  return [...assets.values()].map((s) => `"${s}"`).join('\n');
}

/* ── the payload drop ────────────────────────────────────────────────────── */

export type DropPayloadResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; dropped: boolean }
  | { ok: false };

function deleteFsExtras(o: Obj): void {
  const extras = o.extras;
  if (isPlainObject(extras) && Object.prototype.hasOwnProperty.call(extras, FS_EXTRAS_KEY)) delete extras[FS_EXTRAS_KEY];
}

/** The payload views (module, project) no model site also reads, with their byte ranges. */
function droppableRanges(doc: Obj): Array<{ view: number; buffer: number; start: number; end: number }> | 'damaged' {
  const sites = modelSiteViews(doc);
  if (sites === 'damaged') return 'damaged';
  const views = Array.isArray(doc.bufferViews) ? doc.bufferViews : [];
  const out: Array<{ view: number; buffer: number; start: number; end: number }> = [];
  for (const v of fsPayloadViews(doc)) {
    if (sites.has(v)) continue;
    const view: unknown = views[v];
    if (!isPlainObject(view) || !isSafeNonNeg(view.buffer) || !isSafeNonNeg(view.byteLength)) continue;
    const start = view.byteOffset === undefined ? 0 : view.byteOffset;
    if (!isSafeNonNeg(start)) continue;
    out.push({ view: v, buffer: view.buffer, start, end: start + view.byteLength });
  }
  return out;
}

function dropFromGlb(bytes: Uint8Array<ArrayBuffer>): DropPayloadResult {
  const c = parseGlbContainer(bytes);
  if (!c.ok) return { ok: false };
  if (!fsJsonMayCarry(c.chunks.json)) return { ok: true, bytes, dropped: false };
  let doc: unknown;
  try {
    doc = JSON.parse(c.chunks.json, safeJsonReviver);
  } catch {
    return { ok: false };
  }
  if (!isPlainObject(doc) || !hasFsExtras(doc)) return { ok: true, bytes, dropped: false };
  const ranges = droppableRanges(doc);
  if (ranges === 'damaged') return { ok: false };
  let bin = c.chunks.bin;
  if (bin && ranges.length > 0) {
    const copy = new Uint8Array(bin);
    for (const r of ranges) {
      if (r.buffer !== 0) continue;
      copy.fill(0, Math.min(r.start, copy.length), Math.min(r.end, copy.length));
    }
    bin = copy;
  }
  deleteFsExtras(doc);
  for (const s of Array.isArray(doc.scenes) ? doc.scenes : []) if (isPlainObject(s)) deleteFsExtras(s);
  // The JSON chunk keeps its length (padded with JSON whitespace), so offsets
  // and sizes are unchanged: an aligned input gives an output of equal length.
  const json = JSON.stringify(doc);
  const padded = json.length < c.chunks.json.length ? json + ' '.repeat(c.chunks.json.length - json.length) : json;
  return { ok: true, bytes: buildGlbContainer(padded, bin), dropped: true };
}

function dropFromGltfText(bytes: Uint8Array<ArrayBuffer>): DropPayloadResult {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes), safeJsonReviver);
  } catch {
    return { ok: false };
  }
  if (!isPlainObject(doc) || !hasFsExtras(doc)) return { ok: true, bytes, dropped: false };
  const ranges = droppableRanges(doc);
  if (ranges === 'damaged') return { ok: false };
  const buffers = Array.isArray(doc.buffers) ? doc.buffers : [];
  const byBuffer = new Map<number, typeof ranges>();
  for (const r of ranges) byBuffer.set(r.buffer, [...(byBuffer.get(r.buffer) ?? []), r]);
  for (const [b, rs] of byBuffer) {
    const def: unknown = buffers[b];
    // Only an embedded `data:` buffer holds bytes this file owns; an external
    // one is not ours to rewrite (and the reader refuses such a model anyway).
    if (!isPlainObject(def) || typeof def.uri !== 'string') continue;
    const d = decodeDataUri(def.uri, 'buffer', GLB_READ_MAX_BYTES);
    if (!d.ok) continue;
    const copy = new Uint8Array(d.bytes);
    for (const r of rs) copy.fill(0, Math.min(r.start, copy.length), Math.min(r.end, copy.length));
    def.uri = encodeDataUri('application/octet-stream', copy);
  }
  deleteFsExtras(doc);
  for (const s of Array.isArray(doc.scenes) ? doc.scenes : []) if (isPlainObject(s)) deleteFsExtras(s);
  return { ok: true, bytes: new TextEncoder().encode(JSON.stringify(doc)) as Uint8Array<ArrayBuffer>, dropped: true };
}

/**
 * Remove a model's FastShaders payload IN PLACE: `extras.fastshaders` goes
 * from the root and every scene, and the module/project view bytes that no
 * model site also reads are ZEROED (offsets and sizes unchanged, so every
 * other index in the file still resolves). Returns the SAME reference when
 * there is nothing to drop, and `{ ok: false }` — the caller's `bad-glb`
 * refusal — when a payload is sniffed but the container or JSON will not
 * parse (fail closed: a file that claims a module it cannot deliver is not a
 * preview mesh). The cheap bail is `sniffBytes`, which answers the ESCAPE
 * sniff too, so an escaped key cannot walk a payload past this gate. OBJ
 * passes through. The Phase 5 strip (utils/gltfStrip.ts)
 * is the COMPACTING drop the preview-mesh path prefers; this is the in-place
 * one podest's twin mirrors.
 */
export function dropFastShadersPayload(kind: PreviewMeshKind, bytes: Uint8Array<ArrayBuffer>): DropPayloadResult {
  try {
    if (kind === 'obj' || !sniffBytes(bytes)) return { ok: true, bytes, dropped: false };
    return kind === 'gltf' ? dropFromGltfText(bytes) : dropFromGlb(bytes);
  } catch {
    return { ok: false };
  }
}
