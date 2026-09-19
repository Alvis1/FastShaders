/**
 * Custom preview mesh (dropped 3D model) — pure helpers shared by the preview
 * drop surface, the shader zip export, and the zip import.
 *
 * A dropped/imported model file is ADVERSARIAL input (like every other import:
 * `.fastshader` files are shared between users). The bytes are never parsed on
 * the trusted side — they only ever cross into the sandboxed preview iframe
 * via postMessage, where a blob URL is minted for THREE's loaders (same
 * security model as podest.html). These helpers just bound and classify the
 * file so a hostile drop can't balloon memory or smuggle a weird name into
 * the zip export / UI labels. Two narrow, bounded readers here are the first
 * exception — `countMeshVertices` and the compressed-glTF pre-check
 * `inspectGltfCompression` (which lives in the `gltfCompression.ts` leaf with
 * the size caps, and is re-exported here) — and each reads only a
 * length-capped glTF JSON header (see their comments). The second, documented
 * exception is the glTF MODEL reader behind "build from materials" and the
 * preview's model facts (`utils/gltfReader.ts`, with `gltfNaming.ts`, and
 * `gltfStrip.ts`, which writes the texture-stripped copy that then comes back
 * through `createPreviewMesh` like any drop; `engine/gltfImport.ts` is the
 * composer that calls both, and hands image bytes to `encodeImageFile` only
 * through `gltfTextureEncode.ts`): it reads
 * materials, textures, image bytes by bufferView or strict `data:` URI, the
 * model signature and the loader's mesh naming — but builds no geometry, reads
 * no accessor data, decodes no picture, never resolves or requests a URI, and
 * hands image bytes only to the dropped-image pipeline. Its report is
 * transient (it holds views into the file); only `gltfPreviewFacts`, strings
 * and numbers, may be kept — and `createPreviewMesh` below is where they are
 * kept: every glb/gltf load (drop, zip import, IndexedDB restore) carries
 * them as `PreviewMesh.gltf`, which the Output node's index sections read for
 * their dormancy and double-claim marks. They are never cached or posted:
 * `meshToRecord` writes only the name and the bytes, so a restore recomputes
 * them from the bytes it re-validates.
 *
 * Every refusal is a structured `MeshRefusal`, not a finished sentence, so each
 * surface can translate it (`previewMeshMessage.ts` renders it). This module
 * takes no i18n VALUE import: the store, the engine and FeedbackModal import it.
 */

import { safeJsonReviver } from './safeJson';
import { formatMiB } from './formatSize';
import { fillTemplate } from './fillTemplate';
import {
  GLTF_JSON_PARSE_LIMIT,
  MESH_MAX_BYTES,
  inspectGltfCompression,
  modelTooLargeRefusal,
  notInspectedCompression,
  type GltfCompressionReport,
  type MeshRefusal,
} from './gltfCompression';
import type { DecoderNeeds } from './meshDecoders';
// gltfReader imports the gltfCompression leaf, never this module, so this is
// not a cycle (integration §3.2).
import {
  gltfPreviewFactsOrRefusal,
  readGltfModel,
  type GltfPreviewFacts,
  type GltfReadRefusalReason,
} from './gltfReader';
// The payload drop (GLB Phase 7, L1). Neither module imports this one at run
// time (glbShaderExtras takes only a TYPE from here), so no cycle.
import { planTextureStrip, stripGltfTextures } from './gltfStrip';
import { dropFastShadersPayload, fsJsonMayCarry } from './glbShaderExtras';
import { hasFsExtras } from '@/engine/glbShaderContract';
import type { Language } from '@/i18n';

// The caps and the compressed-glTF pre-check moved to the `gltfCompression.ts`
// leaf (so the glTF reader can use them without an import cycle through this
// module); every existing importer keeps reaching them here.
// The pre-read size gate and the too-large refusal it returns moved there too.
export {
  BUNDLED_DECODERS,
  GLB_READ_MAX_BYTES,
  MESH_MAX_BYTES,
  MESH_TOO_LARGE_KEY,
  inspectGltfCompression,
  inspectParsedGltf,
  modelTooLargeRefusal,
  preReadModelGate,
  type CompressionName,
  type GltfCompressionReport,
  type MeshRefusal,
  type MeshRejectReason,
} from './gltfCompression';

export type PreviewMeshKind = 'obj' | 'glb' | 'gltf';

export interface PreviewMesh {
  /** Sanitized file name — safe as a zip entry name and a UI label. */
  name: string;
  kind: PreviewMeshKind;
  bytes: Uint8Array<ArrayBuffer>;
  /**
   * Decoded text for the text formats (obj/gltf), decoded ONCE at load time —
   * the model feed re-posts on every iframe rebuild, and re-decoding megabytes
   * per rebuild would be pure waste. Absent for glb (binary).
   */
  text?: string;
  /**
   * Monotonic identity for this loaded mesh. Baked into the preview rebuild
   * key and the model-feed handshake so re-dropping a file (same name, new
   * bytes) still forces a fresh iframe, and a slow feed for a previous mesh
   * can never apply to a newer document.
   */
  id: number;
  /**
   * The decoders this model needs (Draco, meshopt, the KTX2 transcoder),
   * present only when it needs one. DERIVED by `createPreviewMesh` from the
   * glTF's extension lists
   * and never persisted: the IndexedDB restore re-runs `createPreviewMesh`,
   * which derives it again. The preview's model feed reads it to decide which
   * decoder files to push into the sandbox with the model.
   */
  decoders?: DecoderNeeds;
  /**
   * The trusted-side facts about a glTF model (`gltfPreviewFacts`): its
   * material signature and, per predicted GLTFLoader mesh name, the glTF
   * material indices of that mesh's primitives. DERIVED by `createPreviewMesh`
   * for every glb/gltf and never persisted (`meshToRecord` keeps only the name
   * and bytes; the restore recomputes them). `null` when the reader refused
   * the file (strict: an unreadable model hides nothing); absent for OBJ.
   * Session state: the Output node's index-section DORMANCY and double-claim
   * marks read it (`loadedModelOf`), EMISSION never does — a module may not
   * depend on what happens to be loaded. Strings and numbers only.
   */
  gltf?: GltfPreviewFacts | null;
  /**
   * Why the trusted-side reader refused this glTF, from the SAME read that
   * feeds `gltf` (never a second parse); absent when it read OK and for OBJ.
   * Session-only like `gltf`. Read by `glbExportAvailability`, which needs to
   * tell an external-data `.gltf` — which can never be packed into one `.glb`
   * — from a file that simply could not be read.
   */
  gltfReadRefusal?: GltfReadRefusalReason;
}

/** Extensions accepted by every custom-mesh surface (drop, picker, zip import). */
export const MESH_EXTENSIONS: readonly PreviewMeshKind[] = ['obj', 'glb', 'gltf'];

/** Classify a file name by extension; null when it isn't a model file. */
export function detectMeshKind(name: string): PreviewMeshKind | null {
  const m = /\.([^./\\]+)$/.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  return (MESH_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as PreviewMeshKind)
    : null;
}

/*
 * The refusal KEYS. Each is the English template AND its lv.json `ui` key, so a
 * reword here must move the lv.json entry with it (src/i18n/index.ts). The three
 * short ones kept their historical text, so their translations stayed live.
 */
export const MESH_EMPTY_KEY = 'The model file is empty.';
export const MESH_BAD_GLB_KEY = 'Not a valid .glb file (missing glTF header).';
export const MESH_UNSUPPORTED_KEY = 'Not a supported model file (.obj / .glb / .gltf).';
// MESH_TOO_LARGE_KEY lives in gltfCompression.ts with the pre-read gate.
/** `{ext}` occurs TWICE — `fillMeshRefusal`'s single pass fills both. */
export const MESH_COMPRESSED_KEY =
  '“{name}” uses {ext} compression, which FastShaders cannot read yet. Re-export it from Blender (or gltf-transform) without {ext}.';

// `MeshRejectReason`, `MeshRefusal` and `modelTooLargeRefusal` live in
// gltfCompression.ts, beside the pre-read size gate that builds one; they are
// re-exported above.

/**
 * Fill a refusal's placeholders into `template` (its English key, or the
 * translation of it) in ONE pass (`fillTemplate`): `{name}` is a file name the
 * dropper chose, so it is inserted verbatim (no `$&` expansion) and is never
 * scanned for placeholders. `{ext}` occurs twice in the compressed sentence;
 * the pass fills both.
 * The size is MiB rounded UP, so one byte over the cap never reads
 * "64 MB — max 64 MB".
 */
export function fillMeshRefusal(r: MeshRefusal, template: string, lang: Language): string {
  return fillTemplate(template, {
    name: r.name ?? '',
    ext: r.ext ?? '',
    size: formatMiB(r.sizeBytes ?? 0, lang, 'up'),
  });
}

/**
 * Bound + sanity-check model bytes before they enter the store. Returns the
 * refusal, or null when acceptable. Deliberately shallow — real parsing
 * happens inside the sandboxed iframe, where a malformed file surfaces as the
 * loader's error overlay.
 */
export function checkMeshBytes(kind: PreviewMeshKind, bytes: Uint8Array): MeshRefusal | null {
  if (bytes.length === 0) return { reason: 'empty', key: MESH_EMPTY_KEY };
  if (bytes.length > MESH_MAX_BYTES) return modelTooLargeRefusal(bytes.length);
  if (kind === 'glb') {
    // GLB container magic: ASCII "glTF" as the first uint32.
    if (bytes.length < 12 ||
        bytes[0] !== 0x67 || bytes[1] !== 0x6c || bytes[2] !== 0x54 || bytes[3] !== 0x46) {
      return { reason: 'bad-glb', key: MESH_BAD_GLB_KEY };
    }
  }
  return null;
}

/** `checkMeshBytes` as an English sentence (or null) — kept for callers that
 *  only need a message and never translate it. */
export function validateMeshBytes(kind: PreviewMeshKind, bytes: Uint8Array): string | null {
  const r = checkMeshBytes(kind, bytes);
  return r ? fillMeshRefusal(r, r.key, 'en') : null;
}

/**
 * What `createPreviewMesh` returns. `error` is the English sentence (a caller
 * that only logs can print it); `refusal` is what a notice translates through
 * `meshRefusalMessage`. `ktx2Fallback` marks a model whose KTX2 textures will
 * be shown through their fallback images (see `inspectGltfCompression`) — only
 * for a caller passing a support set WITHOUT `ktx2`, since the bundled
 * transcoder decodes them. In the app that line arrives instead from the
 * sandbox's `fs:model-ktx2` count, when a transcode really fell back.
 */
export type CreatePreviewMeshResult =
  | { mesh: PreviewMesh; ktx2Fallback: boolean }
  | { error: string; refusal: MeshRefusal };

function refuse(r: MeshRefusal): { error: string; refusal: MeshRefusal } {
  return { error: fillMeshRefusal(r, r.key, 'en'), refusal: r };
}

/**
 * A glTF copy with no FastShaders PAYLOAD (GLB Phase 7, layer L1 of the
 * never-runs rule): no root or scene `extras.fastshaders`, and no module or
 * project bytes. A file whose JSON neither spells `"fastshaders"` nor could
 * hide it behind an escape comes back as the SAME reference, unread.
 * Otherwise the COMPACTING drop is preferred —
 * the Phase 5 strip with no built materials, which reclaims the payload views
 * and the images only the module used (`'kept'` mode zeroes the payload in
 * place instead) — because zeroing alone would leave the payload's size in
 * every later copy, and a later single-GLB export's `truncateDeadTail` pops
 * only the strip's own one-byte views, so a cycle would grow (integration §3
 * C10). When the reader refuses the model, or the strip cannot run, the
 * in-place drop (`dropFastShadersPayload`, podest's twin) zeroes it; a payload
 * sniffed in a container that will not parse is `{ ok: false }` — fail
 * closed, a bad GLB.
 */
function dropPreviewPayload(
  kind: 'glb' | 'gltf',
  bytes: Uint8Array<ArrayBuffer>,
): { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false } {
  // The cheap sniff first — `fsJsonMayCarry`, which answers the `\u00` an
  // escaped spelling of the key must carry as well as the literal one, or a
  // crafted `{"fastshaders":…}` walks its module straight through here
  // into every preview copy. A GLB whose JSON chunk will not extract (broken,
  // or over the header-read cap) falls through to the full path, which sniffs
  // the raw bytes itself.
  const json = kind === 'glb' ? extractGlbJsonChunk(bytes) : new TextDecoder().decode(bytes);
  if (json !== null && !fsJsonMayCarry(json)) return { ok: true, bytes };
  const r = readGltfModel(bytes, kind);
  if (r.ok) {
    if (!hasFsExtras(r.model.source.doc)) return { ok: true, bytes };
    try {
      const plan = planTextureStrip(r.model, []);
      if (plan) return { ok: true, bytes: stripGltfTextures(r.model, plan).bytes };
    } catch {
      // An invariant failure in the strip: the in-place drop below still removes the payload.
    }
  }
  const d = dropFastShadersPayload(kind, bytes);
  return d.ok ? { ok: true, bytes: d.bytes } : { ok: false };
}

/**
 * Classify + bound + assemble a PreviewMesh from a raw file name and bytes —
 * the single constructor used by the preview drop surface (and the node
 * canvas, which hands its model drops to it), the zip import and the
 * IndexedDB restore, so sanitization and the compressed-glTF pre-check always
 * happen at the store boundary. Returns a structured refusal for the caller's
 * notice surface instead of throwing. A FastShaders payload (`extras.fastshaders`
 * and its module/project views) never survives into a preview copy
 * (`dropPreviewPayload`): the XR popup runs at the app's real origin, and
 * every export and the IndexedDB mirror ship these bytes.
 */
let nextPreviewMeshId = 1;
export function createPreviewMesh(
  rawName: string,
  bytes: Uint8Array<ArrayBufferLike>,
): CreatePreviewMeshResult {
  const kind = detectMeshKind(rawName);
  if (!kind) return refuse({ reason: 'unsupported', key: MESH_UNSUPPORTED_KEY });
  const bad = checkMeshBytes(kind, bytes);
  if (bad) return refuse(bad);
  // Normalize to a plain-ArrayBuffer view — Blob construction and postMessage
  // need it, and zip-reader output is only typed over ArrayBufferLike.
  let owned = (bytes.buffer instanceof ArrayBuffer ? bytes : bytes.slice()) as Uint8Array<ArrayBuffer>;
  // L1: before anything is derived from the bytes, so the facts, the stored
  // bytes, the IndexedDB record, the XR blob and a zip's models/ entry all see
  // the payload-free copy.
  if (kind !== 'obj') {
    const cleaned = dropPreviewPayload(kind, owned);
    if (!cleaned.ok) return refuse({ reason: 'bad-glb', key: MESH_BAD_GLB_KEY });
    owned = cleaned.bytes;
  }
  const name = sanitizeMeshFileName(rawName, kind);
  const text = kind === 'glb' ? undefined : new TextDecoder().decode(owned);
  // OBJ has no extension lists (and a token in its text means nothing), so it
  // is never inspected.
  const comp: GltfCompressionReport = kind === 'obj'
    ? notInspectedCompression()
    : inspectGltfCompression(kind === 'glb' ? extractGlbJsonChunk(owned) : text);
  if (comp.refused) {
    return refuse({ reason: 'compressed', key: MESH_COMPRESSED_KEY, name, ext: comp.refused });
  }
  // The id is minted only on success, so a refusal never burns one.
  const mesh: PreviewMesh = { name, kind, bytes: owned, text, id: nextPreviewMeshId++ };
  // Only when a decoder is needed, so an uncompressed model carries no key.
  if (comp.needs.draco || comp.needs.meshopt || comp.needs.ktx2) mesh.decoders = { ...comp.needs };
  // The model facts, here in the single constructor so the drop, the zip
  // import and the IndexedDB restore all get them. The reader never throws; a
  // refusal is `null` facts (the index sections then hide nothing) plus its
  // REASON, which the single-GLB export's availability line needs. It also
  // runs in eval mode — harmless, no index section can arise there.
  if (kind !== 'obj') {
    const read = gltfPreviewFactsOrRefusal(owned, kind);
    if (read && 'facts' in read) mesh.gltf = read.facts;
    else if (read) {
      mesh.gltf = null;
      mesh.gltfReadRefusal = read.refusal;
    }
  }
  return { mesh, ktx2Fallback: comp.ktx2Fallback };
}

/**
 * Vertex count of a loaded model, or null when it cannot be determined
 * cheaply. Used ONLY for the feedback report's mesh line — nothing renders or
 * decides anything from it, so "unknown" is always an acceptable answer.
 *
 * NOTE — this is a deliberate, narrow exception to the module's "bytes are
 * never parsed on the trusted side" rule at the top of this file (the
 * compressed-glTF pre-check `inspectGltfCompression`, in `gltfCompression.ts`,
 * is the other, equally narrow one: two top-level string arrays, no geometry,
 * no URI, no buffer; `utils/gltfReader.ts` is the separate, larger documented
 * exception).
 * That rule exists to keep THREE's loaders (and the external-URL fetches a
 * hostile `.gltf` can request) inside the sandboxed iframe. This does none of
 * that: it counts `v` lines, or reads integers out of a length-capped JSON
 * header. It builds no geometry, resolves no URI, and touches no buffer data.
 * Every path is bounded and every failure returns null rather than throwing.
 *
 * The number is the AUTHORED vertex count, which is what a modeller recognises.
 * It is not what THREE ends up with — the OBJ loader emits non-indexed
 * geometry and `fit-bounds` then welds duplicates — so don't use it to reason
 * about GPU cost.
 */
export function countMeshVertices(mesh: PreviewMesh): number | null {
  try {
    if (mesh.kind === 'obj') return mesh.text ? countObjVertices(mesh.text) : null;
    const json = mesh.kind === 'gltf' ? mesh.text : extractGlbJsonChunk(mesh.bytes);
    if (!json || json.length > GLTF_JSON_PARSE_LIMIT) return null;
    return countGltfVertices(json);
  } catch {
    // Malformed input is the expected case here, not an exceptional one.
    return null;
  }
}

/**
 * Count OBJ `v` statements. A hand-rolled scan rather than a regex over what
 * may be tens of megabytes: this walks each line's first two characters and
 * skips the rest, so it stays linear with no backtracking to reason about.
 */
function countObjVertices(text: string): number {
  let count = 0;
  let atLineStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 /* \n */) {
      atLineStart = true;
      continue;
    }
    if (!atLineStart) continue;
    // Only 'v' followed by whitespace — 'vt' (UVs) and 'vn' (normals) must not
    // count, and neither must a leading space before the keyword.
    if (c === 118 /* v */) {
      const next = text.charCodeAt(i + 1);
      if (next === 32 || next === 9) count++;
    }
    if (c !== 32 && c !== 9 && c !== 13) atLineStart = false;
  }
  return count;
}

/** Read the JSON chunk out of a GLB container; null if the layout is off. */
function extractGlbJsonChunk(bytes: Uint8Array): string | null {
  if (bytes.length < 20) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Header: magic(4) version(4) length(4); then chunk: length(4) type(4) data.
  const chunkLength = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  if (chunkType !== 0x4e4f534a /* 'JSON' */) return null;
  if (chunkLength === 0 || chunkLength > GLTF_JSON_PARSE_LIMIT) return null;
  if (20 + chunkLength > bytes.length) return null;
  return new TextDecoder().decode(bytes.subarray(20, 20 + chunkLength));
}

/**
 * Sum the POSITION accessor counts across every mesh primitive. Each primitive
 * declares its own vertex array, so the total is the authored vertex count.
 */
function countGltfVertices(json: string): number | null {
  // The one place this module parses model bytes at all, and the bytes are
  // adversarial — so it takes the shared deny-list reviver like every other
  // untrusted boundary (utils/safeJson.ts holds the single copy of that rule).
  // The reads below are already narrow (Array.isArray + typeof number), which
  // is what makes this exception safe; the reviver is what keeps a future
  // deny-list key from reaching only the sites that remembered to opt in.
  const doc = JSON.parse(json, safeJsonReviver) as {
    meshes?: { primitives?: { attributes?: Record<string, number> }[] }[];
    accessors?: { count?: number }[];
  };
  const accessors = doc.accessors;
  if (!Array.isArray(doc.meshes) || !Array.isArray(accessors)) return null;
  let total = 0;
  for (const m of doc.meshes) {
    if (!Array.isArray(m?.primitives)) continue;
    for (const p of m.primitives) {
      const idx = p?.attributes?.POSITION;
      if (typeof idx !== 'number') continue;
      const n = accessors[idx]?.count;
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) total += n;
    }
  }
  return total > 0 ? total : null;
}

/**
 * Sanitize a dropped file's name into something safe as a zip entry and UI
 * label: strip any directory part, allow only word chars/dot/dash, cap the
 * length, and guarantee the kind's extension survives.
 */
export function sanitizeMeshFileName(rawName: string, kind: PreviewMeshKind): string {
  const base = rawName.split(/[/\\]/).pop() ?? '';
  let stem = base
    .replace(/\.[^./\\]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  // Windows-reserved device names (CON, NUL, COM1, …) break extraction of the
  // exported zip on Windows — prefix rather than reject.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
  return `${stem || 'model'}.${kind}`;
}
