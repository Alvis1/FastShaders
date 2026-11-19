/**
 * How the local provider reaches a model server on this computer (LM Studio,
 * llama.cpp, Ollama), independent of what carries the bytes.
 *
 * Two implementations: `tauriTransport.ts` (the desktop app — Rust makes the
 * request, src-tauri/src/llm.rs) and `fetchTransport.ts` (the probe under node,
 * and the dev server). Both report failures with the SAME codes, the Rust
 * `E_<CODE>` strings without their prefix, so ONE classifier
 * (`protocol/errors.ts`) serves the app and the probe.
 *
 * A transport NEVER throws and never rejects: every outcome is a value (the
 * `eval/evalUpload.ts` contract), so a dialog that awaits it cannot leave an
 * unhandled rejection behind when it closes mid-request.
 */

/** The only paths a transport may request — the same lists as Rust's
 *  `GET_ROUTES` / `POST_ROUTES` (desktopIpcContract.test.ts pins the pair). */
export type LocalGetRoute = '/v1/models' | '/api/v1/models' | '/api/tags' | '/api/version';
export type LocalPostRoute = '/v1/chat/completions' | '/api/chat';

/**
 * The failure codes. Rust's: BAD_URL (not a loopback base), BAD_ROUTE (path not
 * allow-listed), BUSY (another request is in flight), UNREACHABLE (nothing
 * listens), TIMEOUT, CANCELLED, TOO_LARGE, HTTP (a non-200 answer; `detail` is
 * `<status>: <excerpt>`), BAD_RESPONSE (not HTTP/1.x, a broken chunk). Plus
 * NOT_DESKTOP for the Tauri transport outside the desktop app.
 */
export type TransportCode =
  | 'BAD_URL' | 'BAD_ROUTE' | 'BUSY' | 'UNREACHABLE' | 'TIMEOUT' | 'CANCELLED'
  | 'TOO_LARGE' | 'HTTP' | 'BAD_RESPONSE' | 'NOT_DESKTOP';

export interface TransportFailure {
  ok: false;
  code: TransportCode;
  /** DATA for display, never markup: the server's excerpt or the OS text. */
  detail: string;
}

export type TransportResult<T> = { ok: true; value: T } | TransportFailure;

export interface LocalTransport {
  /** GET an allow-listed path and return the whole body as text. */
  get(base: string, path: LocalGetRoute, signal: AbortSignal): Promise<TransportResult<string>>;
  /**
   * POST a JSON body and hand every received body chunk to `onBytes`, in
   * order, as it arrives (an SSE or NDJSON stream; the caller decodes). Resolves
   * once the response has ENDED — every chunk is delivered before it resolves.
   * Aborting `signal` cancels the request (the server sees the disconnect) and
   * resolves `{ ok: false, code: 'CANCELLED' }`.
   */
  post(
    base: string,
    path: LocalPostRoute,
    body: string,
    onBytes: (chunk: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<TransportResult<void>>;
}
