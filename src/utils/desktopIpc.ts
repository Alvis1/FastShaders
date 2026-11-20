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
 * but two leaves. The one exception is the local-LLM block below, which
 * `llm/transport/fetchTransport.ts` (the probe under node, the dev server)
 * reads as well, so every transport enforces ONE set of routes and caps.
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

// --- The local-LLM bridge (src-tauri/src/llm.rs) ---------------------------
// The desktop app reaches a model server on this computer through Rust, never
// through the webview's fetch. Every value here is pinned against llm.rs's
// text by desktopIpcContract.test.ts.

/** GET an allow-listed path: `{ base, path, requestId }` → the raw body. */
export const LLM_LOCAL_MODELS = 'llm_local_models';
/** POST a chat request: `{ base, path, body, requestId, onEvent: Channel }`;
 *  the answer streams over the channel (frames below). */
export const LLM_LOCAL_CHAT = 'llm_local_chat';
/** `{ requestId }`: cancel that request (also one that has not started yet). */
export const LLM_LOCAL_CANCEL = 'llm_local_cancel';

/** = Rust `GET_ROUTES`, the exact paths a GET may request. */
export const LLM_LOCAL_GET_ROUTES = ['/v1/models', '/api/v1/models', '/api/tags', '/api/version'] as const;
/** = Rust `POST_ROUTES`. */
export const LLM_LOCAL_POST_ROUTES = ['/v1/chat/completions', '/api/chat'] as const;
/** = Rust `LOOPBACK_HOSTS`: the only host spellings a base may use. */
export const LLM_LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const;

/** = Rust `MAX_REQUEST_BYTES`: a larger chat body is refused before invoking. */
export const LLM_MAX_REQUEST_BYTES = 1024 * 1024;
/** = Rust `MAX_STREAM_BYTES`: the most body bytes one chat answer may stream. */
export const LLM_MAX_STREAM_BYTES = 8 * 1024 * 1024;
/** = Rust `MAX_MODEL_LIST_BYTES`: the largest GET body. */
export const LLM_MAX_MODEL_LIST_BYTES = 1024 * 1024;

/**
 * Channel frames of `llm_local_chat` (Rust `FRAME_DATA` / `FRAME_END`): every
 * message is raw bytes whose first byte is one of these tags. DATA carries
 * response-body bytes in order; END — exactly one, always last — carries the
 * final status as UTF-8: empty for success, else an `E_…` string. Completion
 * is END, never the invoke promise: frames of 1 KiB or more are fetched by the
 * webview asynchronously and can arrive after that promise resolves.
 */
export const LLM_FRAME_DATA = 1;
export const LLM_FRAME_END = 2;

// --- The bundled engine (src-tauri/src/engine.rs) ----------------------------
// llama.cpp's llama-server, shipped in the desktop app and pinned file by file
// in src-tauri/engine.json. Pinned against engine.rs by desktopIpcContract.test.ts.

/** Survey this computer for the bundled engine: no arguments → the survey as
 *  RAW JSON bytes (`parseEngineSurvey`, src/llm/engineSurvey.ts). */
export const LLM_ENGINE_SURVEY = 'llm_engine_survey';
/** The model's and the engine process's state; starts nothing. */
export const LLM_ENGINE_STATUS = 'llm_engine_status';
/** `{ action: 'start' | 'pause' | 'cancel' }` — never a repository. */
export const LLM_ENGINE_DOWNLOAD = 'llm_engine_download';
export const LLM_ENGINE_DELETE = 'llm_engine_delete';
export const LLM_ENGINE_STOP = 'llm_engine_stop';
/** A chat with the bundled engine: a body and a channel, no address (llm.rs). */
export const LLM_ENGINE_CHAT = 'llm_engine_chat';
/** = Rust `MODEL_STATES`: every `model.state` a status reports. */
export const ENGINE_MODEL_STATES = [
  'none',
  'partial',
  'downloading',
  'offline',
  'checking',
  'bad-hash',
  'low-disk',
  'ready',
] as const;
/** = Rust `SERVER_STATES`. */
export const ENGINE_SERVER_STATES = ['stopped', 'starting', 'ready', 'failed'] as const;
/** = Rust `SURVEY_STATES`: every `state` a survey reports. */
export const ENGINE_SURVEY_STATES = [
  'ok',
  'unsupported',
  'intel-mac',
  'old-mac',
  'missing',
  'tampered',
  'blocked',
  'runtime-missing',
  'failed',
] as const;

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
