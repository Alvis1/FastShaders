/**
 * The frontend half of the desktop IPC contract: command names, header names,
 * the size the Rust reader refuses above, and the structured error format the
 * Rust side answers with. `desktopIpcContract.test.ts` pins every value here
 * against the text of `src-tauri/src/*.rs`, because the two halves can only be
 * run together on a real `tauri build`, and a drifted literal fails there with
 * nothing to say which side moved.
 *
 * Zero-cost on the web: every importer is desktop-only — the Work-folder
 * control, `utils/desktopAutosave.ts` and the store's `desktopAutosaveBoot.ts`,
 * all reached only behind `__FS_DESKTOP__` — and this module imports nothing
 * but two leaves.
 */
import { DESKTOP_MAX_TOTAL_UNCOMPRESSED } from './zipReader';
import { errorText } from './tauriBridge';

/** Save a file into the work folder. The body is the RAW file bytes (no base64,
 *  so a 256 MiB zip crosses IPC as 256 MiB), and the name rides a header. */
export const WORK_FOLDER_WRITE_BYTES = 'work_folder_write_bytes';

/** Carries the target file name for `work_folder_write_bytes`, percent-encoded
 *  (`encodeHeaderName`). Rust: `FILE_NAME_HEADER` in work_folder.rs. */
export const FILE_NAME_HEADER = 'x-fs-file-name';

/** The header room a zip archive carries over its unpacked total (zipReader's
 *  `MAX_ARCHIVE_BYTES = MAX_TOTAL_UNCOMPRESSED + 8 MiB` relationship). */
export const ARCHIVE_SLACK_BYTES = 8 * 1024 * 1024;

/** = Rust `MAX_READ_BYTES`: the desktop reader's zip cap plus the archive slack
 *  (`READ_MAX_ARCHIVE_BYTES` in a desktop build). `work_folder_read` refuses a
 *  larger file with `E_TOO_LARGE <size> <limit>` before reading it. */
export const DESKTOP_MAX_READ_BYTES = DESKTOP_MAX_TOTAL_UNCOMPRESSED + ARCHIVE_SLACK_BYTES;

export interface DesktopError {
  /** The code without its `E_` prefix: `TOO_LARGE`, `BAD_NAME`, … */
  code: string;
  value?: number;
  limit?: number;
  detail?: string;
}

/**
 * Rust errors are `E_<CODE>`, `E_<CODE> <value> <limit>` or `E_<CODE> <detail>`.
 * Null for anything else — the English errors older builds and the untouched
 * commands still return, which callers show verbatim as before.
 */
const DESKTOP_ERROR_RE = /^E_([A-Z_]+)(?: (\d+) (\d+)$| (.+)$|$)/s;

export function parseDesktopError(e: unknown): DesktopError | null {
  const m = DESKTOP_ERROR_RE.exec(errorText(e));
  if (!m) return null;
  const [, code, value, limit, detail] = m;
  if (value !== undefined && limit !== undefined) {
    return { code, value: Number(value), limit: Number(limit) };
  }
  if (detail !== undefined) return { code, detail };
  return { code };
}

/** A human line for an IPC failure: a structured error's detail (the OS text),
 *  else its code, else the raw message. */
export function describeDesktopError(e: unknown): string {
  const parsed = parseDesktopError(e);
  return parsed?.detail ?? parsed?.code ?? errorText(e);
}

/**
 * Header values must be visible ISO-8859-1, and file names are Unicode ("Zīle",
 * any CJK name). `encodeURIComponent` produces pure ASCII; Rust decodes it with
 * `decode_header_name` and then vets the result with `safe_name`, so an encoded
 * `/` or `..` gains nothing.
 */
export const encodeHeaderName = (name: string): string => encodeURIComponent(name);

/**
 * `tauri::ipc::Response` arrives as an ArrayBuffer, but normalise defensively,
 * since this path can only be verified on a real desktop run. A view is COPIED,
 * so the result is plain-ArrayBuffer-backed (BlobPart rejects ArrayBufferLike
 * views under TS's typed-array generics).
 */
export function desktopBytes(data: unknown): Uint8Array<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return copy;
  }
  if (Array.isArray(data)) return new Uint8Array(data);
  throw new Error('Unexpected binary payload from the desktop bridge');
}
