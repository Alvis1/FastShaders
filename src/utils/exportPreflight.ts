/**
 * The export pre-flight (N1): the PURE decisions behind "This export is too
 * large to open again" — the reader must open what the writer emits.
 *
 * Three planners: the bundle against zipReader's size and entry caps, the
 * non-blocking desktop-only line, and a single `.glb` against the model
 * reader's pre-read cap. `<=` fits, mirroring the readers' strict `>`. The
 * numbers are counted from the same entry list the zip is written from
 * (exportBundle.ts), so the prediction cannot drift.
 * The reasoning, the 510-image entry case, the unchecked 512-byte name cap and
 * the desktop room: docs/dev/models-and-gltf.md (N1).
 */
import { MAX_ENTRIES, MAX_TOTAL_UNCOMPRESSED, READ_MAX_TOTAL_UNCOMPRESSED } from './zipReader';
import { GLB_READ_MAX_BYTES } from './gltfCompression';
import type { ExportBundleSize } from './exportBundle';
import type { GlbRepackSize } from './glbRepack';

/** The answer from the N1 dialog. */
export type ExportPreflightChoice = 'full' | 'without-model' | 'cancel';

/** Why an export would not reopen, with every number the dialog prints. */
export interface ExportTooLarge {
  sizeBytes: number;
  limitBytes: number;
  entryCount: number;
  entryLimit: number;
  /** Which of the reader's caps the bundle crosses — at least one is true. */
  overSize: boolean;
  overEntries: boolean;
  /**
   * Only when a model rides in the bundle AND dropping it brings BOTH the size
   * and the entry count within their caps; otherwise null (the dialog then
   * offers no model button).
   */
  withoutModel: { modelBytes: number; sizeBytes: number } | null;
}

/**
 * null = the bundle reopens. `<=` fits because that is the reader's own
 * boundary: every readZip cap check is a strict `>`.
 */
export function planExportPreflight(
  size: ExportBundleSize,
  limitBytes: number = READ_MAX_TOTAL_UNCOMPRESSED,
  entryLimit: number = MAX_ENTRIES,
): ExportTooLarge | null {
  const overSize = size.unpackedBytes > limitBytes;
  const overEntries = size.entryCount > entryLimit;
  if (!overSize && !overEntries) return null;
  const withoutModel =
    size.meshBytes > 0 &&
    size.unpackedBytesWithoutMesh <= limitBytes &&
    size.entryCountWithoutMesh <= entryLimit
      ? { modelBytes: size.meshBytes, sizeBytes: size.unpackedBytesWithoutMesh }
      : null;
  return {
    sizeBytes: size.unpackedBytes,
    limitBytes,
    entryCount: size.entryCount,
    entryLimit,
    overSize,
    overEntries,
    withoutModel,
  };
}

/** N1's DESKTOP variant, non-blocking: the export reopens in the desktop
 *  editor, but not in Podest or the web editor. */
export interface DesktopOnlyExport {
  sizeBytes: number;
  webLimitBytes: number;
}

/**
 * null on the web build (its read cap IS the web cap), when the export fits
 * the web cap, and when it is over this build's read cap — planExportPreflight's
 * blocking dialog handles that one. Takes the byte count the READER counts
 * (`unpackedBytes` for a bundle; a single-file export passes its file size), so
 * every export kind gets the same line. Same `<=` boundary as the dialog.
 */
export function planDesktopOnlyExport(
  sizeBytes: number,
  readLimit: number = READ_MAX_TOTAL_UNCOMPRESSED,
  webLimit: number = MAX_TOTAL_UNCOMPRESSED,
): DesktopOnlyExport | null {
  if (readLimit <= webLimit) return null;
  if (!Number.isFinite(sizeBytes)) return null;
  if (sizeBytes <= webLimit || sizeBytes > readLimit) return null;
  return { sizeBytes, webLimitBytes: webLimit };
}

/**
 * N1-GLB: a single-GLB export (engine/exportSingleGlb.ts) FastShaders could
 * not open again. The file is read back through the glTF model reader's
 * pre-read cap, `GLB_READ_MAX_BYTES` (96 MiB on the web, the desktop room's
 * zip cap there — the constant carries it), so that is the limit; nothing is
 * "unpacked", so the zip wording does not apply. The size counts BOTH copies
 * of every WebP texture (the WebP and its PNG/JPEG fallback).
 */
export interface SingleGlbTooLarge {
  /** The file with fallbacks (the default export). */
  sizeBytes: number;
  limitBytes: number;
  /** Texture images plus their fallbacks: both encoded copies. */
  textureBytes: number;
  hasFallbacks: boolean;
  /** Offered only when dropping the fallbacks brings the file within the limit. */
  webpOnly: { sizeBytes: number } | null;
  /** The KTX2 copies' bytes (0 without an encoder), for the size breakdown. */
  ktx2Bytes: number;
  /** Offered only when dropping the KTX2 copies ALONE brings it within the limit. */
  noKtx2: { sizeBytes: number } | null;
}

/**
 * null = the default (fallback-mode) file reopens. `<=` fits: the reader's
 * pre-read check is a strict `>`.
 *
 * Non-finite or negative sizes count as 0 — defensive only: the repacker
 * guards its own u32 total (glbContainer.ts `pad4`), so do not lean on it.
 */
export function planSingleGlbPreflight(
  sizes: { fallback: GlbRepackSize; required: GlbRepackSize; noKtx2?: GlbRepackSize },
  limitBytes: number = GLB_READ_MAX_BYTES,
): SingleGlbTooLarge | null {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  const s = sizes.fallback;
  // `totalBytes` already counts the KTX2 copies, since they are images inside
  // the same file; `ktx2Bytes` only says how much of it they are.
  if (n(s.totalBytes) <= limitBytes) return null;
  const hasFallbacks = n(s.fallbackCount) > 0;
  const requiredBytes = n(sizes.required.totalBytes);
  const ktx2Bytes = n(s.ktx2Bytes);
  const plainBytes = n(sizes.noKtx2?.totalBytes ?? 0);
  return {
    sizeBytes: n(s.totalBytes),
    limitBytes,
    textureBytes: n(s.textureImageBytes) + n(s.fallbackBytes),
    hasFallbacks,
    webpOnly: hasFallbacks && requiredBytes <= limitBytes ? { sizeBytes: requiredBytes } : null,
    ktx2Bytes,
    noKtx2: ktx2Bytes > 0 && plainBytes > 0 && plainBytes <= limitBytes ? { sizeBytes: plainBytes } : null,
  };
}
