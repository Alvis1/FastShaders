/**
 * The export pre-flight (N1): the PURE decision behind "This export is too
 * large to open again".
 *
 * The invariant is that the reader must open what the writer emits, and
 * nothing checked it: an export whose entries summed past zipReader's
 * `MAX_TOTAL_UNCOMPRESSED`, or that held more than its `MAX_ENTRIES`, downloaded
 * fine and then failed on every import surface and in Podest. The limits are
 * the web reader's caps for EVERY surface in Phase 1 — the editor's import
 * paths, Podest's hand-written twin (drift-guarded by zipReader.test.ts) and the
 * desktop Work folder's zip path all go through readZip. The desktop room
 * (Phase 6) reads up to `DESKTOP_MAX_TOTAL_UNCOMPRESSED` (256 MiB), so there
 * the blocking dialog applies above THAT cap (`READ_MAX_TOTAL_UNCOMPRESSED`,
 * the default below), and an export between the web cap and the desktop cap
 * is delivered and then announced by the non-blocking `planDesktopOnlyExport`
 * line ("only the desktop editor can open it again" — Podest and the web
 * editor stay on 96 MiB).
 *
 * The ENTRY cap is reachable at any byte size: collectImageFiles writes one
 * `images/` entry per DISTINCT image (MIME + decoded bytes), so more than 510
 * small distinct images (509 with a model riding along) — well inside the
 * 3M-char image budget — make a zip readZip refuses. Ctrl+D and paste copies
 * carry the same bytes and add no entry. The reader's third cap,
 * the 512-byte entry name, is NOT checked here (see CLAUDE.md's N1 bullet).
 *
 * The size and the count compared are `ExportBundleSize.unpackedBytes` and
 * `.entryCount`, which buildExportBundle counts from the same entry list it
 * writes (see exportBundle.ts), so the prediction cannot drift from the file.
 * The dialog and its three surfaces live in
 * components/Modals/ExportPreflightModal.tsx and engine/exportShader.ts's
 * buildShaderBundleChecked.
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
 * pre-read check is a strict `>`. Non-finite or negative sizes count as 0,
 * the guard formatMiB applies.
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
