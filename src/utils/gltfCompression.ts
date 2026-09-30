/**
 * The glTF size caps and the compressed-glTF PRE-CHECK — a LEAF, split out of
 * `previewMesh.ts`, which re-exports every name here so no importer moved.
 *
 * It exists as its own module to keep the model-reading graph ACYCLIC: the
 * trusted-side glTF reader (`gltfReader.ts`, Phase 5) needs the caps and the
 * post-parse half of the pre-check, while `previewMesh.ts` will need the reader
 * to derive a model's facts inside `createPreviewMesh`. With the caps living in
 * `previewMesh.ts` that would be a cycle, and a cycle evaluated during module
 * initialisation is exactly the costTable TDZ failure CLAUDE.md records. The
 * pre-read size gate (`preReadModelGate`) lives here for the same reason, with
 * the too-large refusal it returns. So
 * this file imports only the shared JSON reviver, two TYPES and the zero-import
 * splat caps leaf (the pre-read gate refuses a `.splat` from its size alone),
 * and must never import `previewMesh.ts`, the reader or anything that reaches
 * them (`gltfCompression.test.ts` pins it).
 */

import { safeJsonReviver } from './safeJson';
import type { DecoderNeeds, DecoderSupport } from './meshDecoders';
import { SPLAT_MAX_COUNT, SPLAT_ROW_BYTES } from './splatLimits';

/** Hard cap on a model file. The zip reader's SUM cap (zipReader
 *  `MAX_TOTAL_UNCOMPRESSED`, 96 MiB) is this plus 32 MiB of headroom, so an
 *  export carrying a model at this cap still re-opens. */
export const MESH_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The largest `.glb` the build-from-materials path reads BEFORE the model gate
 * (its texture-stripped copy must then pass MESH_MAX_BYTES). Equals THIS
 * build's zip reader cap, pinned by gltfCompression.test.ts: 96 MiB on the web
 * (a read holds about twice the file, which is what a tablet or a headset can
 * afford), 256 MiB in the desktop room. LITERALS behind zipReader's `typeof`
 * guard, because this leaf imports nothing that could supply them.
 */
export const GLB_READ_MAX_BYTES =
  typeof __FS_DESKTOP__ !== 'undefined' && __FS_DESKTOP__ ? 256 * 1024 * 1024 : 96 * 1024 * 1024;

/**
 * Largest glTF JSON chunk we will hand to `JSON.parse` in the pre-check and in
 * `countMeshVertices`. The chunk is a structure table (accessors, nodes,
 * materials), not the vertex payload, so a legitimate one is orders of
 * magnitude under this; a file that isn't just declines to be inspected.
 */
export const GLTF_JSON_PARSE_LIMIT = 8 * 1024 * 1024;

/** The display name of a compression the pre-check refuses (never translated). */
export type CompressionName = 'Draco' | 'meshopt' | 'KTX2';

/*
 * The model REFUSAL shape and the too-large refusal live here, beside the caps,
 * because the pre-read gate below builds one and this leaf may import nothing
 * that could supply it. `previewMesh.ts` re-exports all of it, so every
 * importer still reaches them there; the other refusal keys stay in
 * previewMesh.ts, which is the only module that builds those.
 */

/** The literal "64" is pinned against MESH_MAX_BYTES by previewMesh.test.ts. */
export const MESH_TOO_LARGE_KEY =
  'Model too large ({size} MB — max 64 MB). Reduce its polygon count or texture sizes and export it again from your 3D software.';

/**
 * The same sentence for a cap that is NOT the 64 MiB model gate (the build
 * path's GLB_READ_MAX_BYTES). A second key so the "64" literal above stays
 * pinned by previewMesh.test.ts; `fillMeshRefusal` fills `{limit}`.
 */
export const MESH_TOO_LARGE_LIMIT_KEY =
  'Model too large ({size} MB — max {limit} MB). Reduce its polygon count or texture sizes and export it again from your 3D software.';

/**
 * Why a model was refused — what a caller that must BRANCH on it reads. The
 * splat reasons: `bad-splat` (a container its loader would throw on),
 * `splat-count` (over SPLAT_MAX_COUNT), `ply-not-splat` (a mesh or point-cloud
 * `.ply`), `ply-sh` (a training `.ply` with `f_rest_*` bands), `ply-compressed`
 * (SuperSplat's chunked `.ply`), `spz-version` (SPZ v4, zstd), `gltf-splat` (a
 * glTF naming KHR_gaussian_splatting) and `splat-eval` (a study session).
 */
export type MeshRejectReason =
  | 'unsupported'
  | 'empty'
  | 'too-large'
  | 'bad-glb'
  | 'compressed'
  | 'bad-splat'
  | 'splat-count'
  | 'ply-not-splat'
  | 'ply-sh'
  | 'ply-compressed'
  | 'spz-version'
  | 'gltf-splat'
  | 'splat-eval';

/**
 * A model refusal, structured so every surface can translate it rather than
 * printing the English the constructor happened to build.
 *   - `key` is the English template and the lv.json key;
 *   - `name` is the SANITIZED file name (never the raw one — it is shown);
 *   - `ext` is a display name for `{ext}`;
 *   - `sizeBytes` is formatted at display time, in the reader's language;
 *   - `limitBytes` is the cap that was APPLIED, present only when it is not
 *     MESH_MAX_BYTES — it fills `{limit}`, which only MESH_TOO_LARGE_LIMIT_KEY
 *     carries and only `meshRefusalMessage` fills;
 *   - `count` is a splat count the file DECLARES (`{count}`), formatted at
 *     display time like the size;
 *   - `limitCount` is the splat cap that was applied, present only when it is
 *     not SPLAT_MAX_COUNT (`{maxCount}` falls back to that cap);
 *   - `version` is a container version the file declares (`{version}`).
 */
export interface MeshRefusal {
  reason: MeshRejectReason;
  key: string;
  name?: string;
  ext?: CompressionName;
  sizeBytes?: number;
  limitBytes?: number;
  count?: number;
  limitCount?: number;
  version?: number;
}

/*
 * The two splat refusals the pre-read gate can build from a `.splat`'s SIZE
 * alone. They live here for the reason the too-large key does: the gate is in
 * this leaf and may import nothing that could supply them. `splatSniff.ts`
 * builds the same two after the read, through these same builders, so a drop
 * refused before the read and a zip entry refused after it say the same thing.
 */

/** The literal "32" is pinned against SPLAT_ROW_BYTES by splatSniff.test.ts. */
export const MESH_BAD_SPLAT_KEY = 'Not a valid .splat file (its size is not a whole number of 32-byte splats).';

export const MESH_SPLAT_COUNT_KEY =
  'Too many splats ({count} — max {maxCount}). Reduce the scene in SuperSplat (or splat-transform) and export it again.';

/** Over the splat cap. `limitCount` is omitted for SPLAT_MAX_COUNT, as `limitBytes` is for the model gate. */
export function splatCountRefusal(count: number, limitCount: number = SPLAT_MAX_COUNT): MeshRefusal {
  return limitCount === SPLAT_MAX_COUNT
    ? { reason: 'splat-count', key: MESH_SPLAT_COUNT_KEY, count }
    : { reason: 'splat-count', key: MESH_SPLAT_COUNT_KEY, count, limitCount };
}

/**
 * The `.splat` rules that need nothing but the length: the format is headerless
 * fixed-width rows, so a length that is not a whole number of rows is a file
 * SPLATLoader throws on, and the length divided by the row size IS the count.
 * Null when the length passes (0 included: the empty-file refusal comes after
 * the read). Only called with a safe, non-negative integer.
 */
export function splatSizeRefusal(sizeBytes: number): MeshRefusal | null {
  if (sizeBytes % SPLAT_ROW_BYTES !== 0) return { reason: 'bad-splat', key: MESH_BAD_SPLAT_KEY };
  const count = sizeBytes / SPLAT_ROW_BYTES;
  return count > SPLAT_MAX_COUNT ? splatCountRefusal(count) : null;
}

/**
 * The over-cap refusal — also what the pre-read size gate returns. `limitBytes`
 * is the cap the CALLER applied: naming it is the difference between a truthful
 * refusal and one that tells the user to get under 64 MB when 96 (or 256) was
 * allowed. Omitted, it is the 64 MiB model gate and the sentence is unchanged,
 * so every existing caller and its Latvian entry stay exactly as they were.
 */
export function modelTooLargeRefusal(sizeBytes: number, limitBytes: number = MESH_MAX_BYTES): MeshRefusal {
  return limitBytes === MESH_MAX_BYTES
    ? { reason: 'too-large', key: MESH_TOO_LARGE_KEY, sizeBytes }
    : { reason: 'too-large', key: MESH_TOO_LARGE_LIMIT_KEY, sizeBytes, limitBytes };
}

/**
 * THE PRE-READ SIZE GATE: the one place that decides how large a dropped model
 * may be BEFORE its bytes are read, so a hostile or oversized drop never forces
 * a multi-hundred-MB `arrayBuffer()` just to be refused.
 *
 * The larger cap (`GLB_READ_MAX_BYTES`) applies only to a `.glb` with
 * `buildEnabled`: that is the "build a shader from the model's materials" path,
 * which extracts the textures into project images and then hands the
 * texture-STRIPPED copy (`gltfStrip.ts`) to `createPreviewMesh`, where the
 * unchanged `MESH_MAX_BYTES` gate applies. A `.gltf` keeps `MESH_MAX_BYTES`
 * even then (its images are base64 inside the JSON text, which `JSON.parse`
 * must hold whole), and so does an OBJ or an unknown kind.
 *
 * `buildEnabled` is the caller's: ShaderPreview passes its OFFER predicate
 * (`!isEvalMode()`, not paired with a shader, a glTF), so it is never true in a
 * study session or for a model that came with a shader, and every non-offered
 * drop is exactly the old `file.size > MESH_MAX_BYTES` test
 * (`modelDropGate.test.ts` pins the call). A size that is not a finite,
 * non-negative number is refused: it cannot be shown to fit.
 *
 * A `.splat` is also refused from its size alone (`splatSizeRefusal`): a length
 * that is not a whole number of 32-byte rows, or more rows than SPLAT_MAX_COUNT,
 * is known before a byte is read — so a 32,000,032-byte drop never allocates.
 * That check runs BEFORE the byte cap, so an oversized `.splat` names its splat
 * count (what the user can act on) rather than megabytes, exactly as the
 * post-read sniff does for the same file arriving from a zip. The other splat
 * kinds carry their count in a header, which only the post-read sniff reads.
 */
export function preReadModelGate(
  kind: 'obj' | 'glb' | 'gltf' | 'splat' | 'spz' | 'ply' | 'ksplat' | null,
  sizeBytes: number,
  buildEnabled: boolean,
): MeshRefusal | null {
  const cap = buildEnabled === true && kind === 'glb' ? GLB_READ_MAX_BYTES : MESH_MAX_BYTES;
  // The refusal carries the cap it APPLIED: reporting a 120 MiB `.glb` on the
  // build path through the model-gate sentence told the user to get under 64 MB
  // when 96 — in the desktop room 256 — was allowed.
  if (typeof sizeBytes !== 'number' || !(sizeBytes >= 0)) return modelTooLargeRefusal(0, cap);
  if (kind === 'splat' && Number.isSafeInteger(sizeBytes)) {
    const splat = splatSizeRefusal(sizeBytes);
    if (splat) return splat;
  }
  return sizeBytes > cap ? modelTooLargeRefusal(sizeBytes, cap) : null;
}

/*
 * The compressed-glTF PRE-CHECK: which decoders a model NEEDS, and whether it
 * must be REFUSED because `support` cannot decode it. r184's GLTFLoader decides:
 *   - Draco: built whenever `extensionsUsed` lists it (GLTFLoader.js:520-522)
 *     and the uncompressed fallback is never read (:3738) — listed means needed.
 *   - meshopt (EXT_ and KHR_, :1611-1625) and KHR_texture_basisu (:1473-1484)
 *     fall back unless REQUIRED; a basisu-USED model then renders its fallback
 *     images (`ktx2Fallback`).
 * FAIL-OPEN — an early notice, not a security control: a document it cannot
 * read is let through. `gltfSplat` marks KHR_gaussian_splatting, which r184
 * would draw as raw POINTS, so `createPreviewMesh` refuses it. Split in two so
 * the glTF reader, which has parsed already, runs `inspectParsedGltf`.
 * See docs/dev/models-and-gltf.md, "Compressed glTF is decoded…".
 */
const GLTF_DRACO = 'KHR_draco_mesh_compression';
/** Both spellings of the meshopt extension — the ONE copy (reader, strip, repacker). */
export const MESHOPT_EXTENSIONS = ['EXT_meshopt_compression', 'KHR_meshopt_compression'] as const;
const GLTF_BASISU = 'KHR_texture_basisu';
const GLTF_GAUSSIAN_SPLATTING = 'KHR_gaussian_splatting';
/** How many entries of each extension list are looked at — a real file lists a handful. */
const EXTENSION_LIST_CAP = 256;

/**
 * What the editor's surfaces decode: all three. A claim about the preview and
 * its XR popup, which install the decoders vendored in public/js/decoders (a
 * test pins that the files exist).
 */
export const BUNDLED_DECODERS: DecoderSupport = { draco: true, meshopt: true, ktx2: true };

export interface GltfCompressionReport {
  refused: CompressionName | null;
  /** A basisu-USED model on a surface with NO transcoder: its fallback images
   *  are what renders. Always false under `BUNDLED_DECODERS`, which transcodes. */
  ktx2Fallback: boolean;
  /** The decoders the model needs, on a surface that has them. */
  needs: DecoderNeeds;
  /** Present (and `true`) only when either extension list names
   *  `KHR_gaussian_splatting` — a glTF-wrapped splat, which is refused as
   *  'gltf-splat'. Absent otherwise, so every other report is unchanged. */
  gltfSplat?: true;
}

/** A fresh report for a document that was not inspected (or needs nothing). */
export function notInspectedCompression(): GltfCompressionReport {
  return { refused: null, ktx2Fallback: false, needs: { draco: false, meshopt: false, ktx2: false } };
}

/** The string entries of a glTF extension list; anything else is ignored.
 *  Matching is exact and case-sensitive, as glTF's extension names are. */
function extensionNames(v: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(v)) return out;
  const n = Math.min(v.length, EXTENSION_LIST_CAP);
  for (let i = 0; i < n; i++) {
    const e: unknown = v[i];
    if (typeof e === 'string') out.add(e);
  }
  return out;
}

/**
 * Which decoders a glTF JSON document needs, and which compression it asks for
 * that `support` cannot decode (see above). Refusal precedence: Draco, meshopt,
 * KTX2.
 */
export function inspectGltfCompression(
  json: string | null | undefined,
  support: DecoderSupport = BUNDLED_DECODERS,
): GltfCompressionReport {
  if (!json || json.length > GLTF_JSON_PARSE_LIMIT) return notInspectedCompression();
  let doc: unknown;
  try {
    doc = JSON.parse(json, safeJsonReviver);
  } catch {
    return notInspectedCompression();
  }
  return inspectParsedGltf(doc, support);
}

/**
 * The pre-check's rules over an ALREADY-PARSED document (the post-parse half of
 * `inspectGltfCompression`). `doc` is adversarial: anything but a plain object
 * is not inspected, and only the two extension lists are read, by plain
 * property access.
 */
export function inspectParsedGltf(
  doc: unknown,
  support: DecoderSupport = BUNDLED_DECODERS,
): GltfCompressionReport {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return notInspectedCompression();
  const d = doc as { extensionsUsed?: unknown; extensionsRequired?: unknown };
  const used = extensionNames(d.extensionsUsed);
  const required = extensionNames(d.extensionsRequired);
  const dracoListed = used.has(GLTF_DRACO) || required.has(GLTF_DRACO);
  const meshoptRequired = MESHOPT_EXTENSIONS.some((m) => required.has(m));
  const meshoptListed = meshoptRequired || MESHOPT_EXTENSIONS.some((m) => used.has(m));
  const basisuRequired = required.has(GLTF_BASISU);
  const basisuListed = basisuRequired || used.has(GLTF_BASISU);
  const needs: DecoderNeeds = {
    draco: dracoListed && support.draco,
    meshopt: meshoptListed && support.meshopt,
    ktx2: basisuListed && support.ktx2,
  };
  const refusal = (refused: CompressionName): GltfCompressionReport => ({ refused, ktx2Fallback: false, needs });
  let report: GltfCompressionReport;
  if (dracoListed && !support.draco) report = refusal('Draco');
  else if (meshoptRequired && !support.meshopt) report = refusal('meshopt');
  else if (basisuRequired && !support.ktx2) report = refusal('KTX2');
  else report = { refused: null, ktx2Fallback: basisuListed && !support.ktx2, needs };
  if (used.has(GLTF_GAUSSIAN_SPLATTING) || required.has(GLTF_GAUSSIAN_SPLATTING)) report.gltfSplat = true;
  return report;
}
