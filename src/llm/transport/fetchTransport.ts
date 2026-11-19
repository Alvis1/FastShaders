/**
 * `LocalTransport` over `fetch`: the probe under node (scripts/llm-probe/) and
 * the dev server. It answers with the SAME codes, details and limits as the
 * Rust bridge (src-tauri/src/llm.rs), so one classifier and one provider serve
 * both and what the probe measured is what the app runs:
 *
 * - the base must pass `isLoopbackBase` (Rust's `parse_base` rule) and the path
 *   an allow-list, checked before anything is sent (`requestRefusal`);
 * - one request at a time per transport (`BUSY` otherwise);
 * - only 200 succeeds; a 3xx is refused, never followed; any other status is
 *   `HTTP` with detail `<status>: <excerpt>`, the excerpt cleaned exactly as
 *   Rust cleans it (`excerptText`), and an error status in hand outranks a
 *   timer;
 * - the same caps (request, stream, model list) and the same timers: a
 *   first-byte window that lasts until the first BODY byte, a gap allowed
 *   between chunks after that, and a total — with Rust's detail texts.
 *
 * Unlike Rust it cannot drop the browser's own headers: in a page `fetch`
 * still sends an `Origin` (and the server must allow CORS), and the browser
 * decides `Accept-Encoding` and `Connection` itself. Under node neither
 * applies.
 *
 * Never throws or rejects (transport/types.ts). Aborting the signal resolves
 * `CANCELLED` at once and aborts the fetch, so the server sees the disconnect.
 */
import {
  LLM_LOCAL_GET_ROUTES,
  LLM_LOCAL_POST_ROUTES,
  LLM_MAX_MODEL_LIST_BYTES,
  LLM_MAX_STREAM_BYTES,
} from '@/utils/desktopIpc';
import { requestRefusal } from '../endpoint';
import type { LocalTransport, TransportCode, TransportFailure, TransportResult } from './types';

/** Milliseconds. The first-byte window runs until the first BODY byte. */
export interface TransportTimeouts {
  firstByteMs: number;
  betweenChunksMs: number;
  totalMs: number;
}

/** = llm.rs `CHAT_TIMEOUTS` (desktopIpcContract.test.ts pins the pair). Rust
 *  also caps the connect at 3 s per address; fetch folds that into the first
 *  byte. */
export const CHAT_TIMEOUTS: TransportTimeouts = { firstByteMs: 300_000, betweenChunksMs: 120_000, totalMs: 900_000 };
/** = llm.rs `LIST_TIMEOUTS`. */
export const LIST_TIMEOUTS: TransportTimeouts = { firstByteMs: 30_000, betweenChunksMs: 30_000, totalMs: 60_000 };

/** = llm.rs `EXCERPT_CHARS`, `EXCERPT_SOURCE_BYTES`, `ERROR_BODY_WAIT`. */
const EXCERPT_CHARS = 300;
const EXCERPT_SOURCE_BYTES = 4 * 1024;
const ERROR_BODY_WAIT_MS = 2_000;

export interface FetchTransportOptions {
  /** Defaults to the global `fetch`. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  chatTimeouts?: TransportTimeouts;
  listTimeouts?: TransportTimeouts;
}

const fail = (code: TransportCode, detail = ''): TransportFailure => ({ ok: false, code, detail });

/** llm.rs `seconds()`: whole seconds from 1 s up, else milliseconds. */
const seconds = (ms: number): string => (ms >= 1000 ? `${Math.floor(ms / 1000)} s` : `${ms} ms`);

const INVISIBLE_RE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
/** Rust's `char::is_control` (C0, DEL, C1) or `char::is_whitespace`. */
const CONTROL_OR_SPACE_RE = /^(?:[\u0000-\u001F\u007F-\u009F]|\s)$/u;

/**
 * llm.rs `excerpt_text`: every run of control or whitespace characters becomes
 * one space, bidi controls, zero-width and other invisible characters are
 * dropped, and at most `limit` characters (code points) are kept.
 */
export function excerptText(text: string, limit = EXCERPT_CHARS): string {
  let out = '';
  let gap = false;
  for (const ch of text.replace(INVISIBLE_RE, '')) {
    if (CONTROL_OR_SPACE_RE.test(ch)) {
      gap = true;
      continue;
    }
    if (gap && out) out += ' ';
    gap = false;
    out += ch;
  }
  return Array.from(out).slice(0, limit).join('').trimEnd();
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Connect-time failures are UNREACHABLE (Rust's connect errors); anything
 *  after the connection was made is BAD_RESPONSE. A browser's bare
 *  "Failed to fetch" carries no cause and counts as unreachable. */
const UNREACHABLE_CAUSES = new Set([
  'ECONNREFUSED',
  'EADDRNOTAVAIL',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function fromFetchError(e: unknown): TransportFailure {
  const cause = (e as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const message = typeof cause?.message === 'string' && cause.message ? cause.message : errorMessage(e);
  if (!code || UNREACHABLE_CAUSES.has(code)) return fail('UNREACHABLE', message);
  return fail('BAD_RESPONSE', message);
}

/** A `Content-Encoding` other than identity, or ''. */
function compression(res: Response): string {
  const encoding = res.headers.get('content-encoding')?.trim() ?? '';
  return encoding.toLowerCase() === 'identity' ? '' : encoding;
}

function concat(parts: Uint8Array[], limit: number): Uint8Array {
  const out = new Uint8Array(Math.min(limit, parts.reduce((n, p) => n + p.byteLength, 0)));
  let at = 0;
  for (const part of parts) {
    if (at >= out.length) break;
    const take = part.subarray(0, out.length - at);
    out.set(take, at);
    at += take.byteLength;
  }
  return out;
}

export function fetchTransport(options: FetchTransportOptions = {}): LocalTransport {
  const doFetch = options.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));
  const chatTimeouts = options.chatTimeouts ?? CHAT_TIMEOUTS;
  const listTimeouts = options.listTimeouts ?? LIST_TIMEOUTS;
  let busy = false;

  async function exchange(
    method: 'GET' | 'POST',
    base: string,
    path: string,
    body: string | undefined,
    t: TransportTimeouts,
    cap: number,
    onChunk: (bytes: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<TransportResult<void>> {
    const refused = requestRefusal(base, path, method === 'GET' ? LLM_LOCAL_GET_ROUTES : LLM_LOCAL_POST_ROUTES, body);
    if (refused) return refused;
    if (signal.aborted) return fail('CANCELLED');
    if (busy) return fail('BUSY');
    busy = true;

    const controller = new AbortController();
    // Why WE stopped the request (a cancel or a timer). Whatever the fetch
    // throws after that is only the echo of the abort, and `stopped` settles
    // the request at once even if the fetch is slow to notice.
    let stopped: TransportFailure | null = null;
    let settleStopped: (why: TransportFailure) => void = () => {};
    const whenStopped = new Promise<TransportFailure>((resolve) => {
      settleStopped = resolve;
    });
    const stop = (why: TransportFailure) => {
      if (stopped) return;
      stopped = why;
      controller.abort();
      settleStopped(why);
    };

    const totalTimer = setTimeout(() => stop(fail('TIMEOUT', `the request ran past ${seconds(t.totalMs)}`)), t.totalMs);
    let gapTimer = setTimeout(() => stop(fail('TIMEOUT', `nothing arrived within ${seconds(t.firstByteMs)}`)), t.firstByteMs);
    const bodyArrived = () => {
      clearTimeout(gapTimer);
      gapTimer = setTimeout(
        () => stop(fail('TIMEOUT', `the stream stalled for ${seconds(t.betweenChunksMs)}`)),
        t.betweenChunksMs,
      );
    };
    const stopTimers = () => {
      clearTimeout(totalTimer);
      clearTimeout(gapTimer);
    };
    const onAbort = () => stop(fail('CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });

    const headers: Record<string, string> =
      method === 'POST'
        ? {
            'content-type': 'application/json',
            accept: 'text/event-stream, application/x-ndjson, application/json',
            'accept-encoding': 'identity',
            connection: 'close',
          }
        : { accept: 'application/json', 'accept-encoding': 'identity', connection: 'close' };

    const run = async (): Promise<TransportResult<void>> => {
      let res: Response;
      try {
        res = await doFetch(base.replace(/\/$/, '') + path, {
          method,
          headers,
          body,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (e) {
        return stopped ?? fromFetchError(e);
      }
      const reader = res.body?.getReader();
      const drop = () => {
        reader?.cancel().catch(() => {});
      };
      if (stopped) {
        drop();
        return stopped;
      }

      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        drop();
        return fail('HTTP', `${res.status}: redirect refused`);
      }

      if (res.status !== 200) {
        // The status is the news: only a cancel or the excerpt's own short
        // wait may stop it now.
        stopTimers();
        if (compression(res)) {
          drop();
          return fail('HTTP', `${res.status}: compressed error body`);
        }
        const parts: Uint8Array[] = [];
        let n = 0;
        const deadline = setTimeout(drop, ERROR_BODY_WAIT_MS);
        try {
          while (reader && n < EXCERPT_SOURCE_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            n += value.byteLength;
          }
        } catch {
          // Keep what arrived.
        } finally {
          clearTimeout(deadline);
          drop();
        }
        if (stopped) return stopped;
        const excerpt = excerptText(new TextDecoder().decode(concat(parts, EXCERPT_SOURCE_BYTES)));
        return fail('HTTP', `${res.status}: ${excerpt}`.trimEnd());
      }

      const encoding = compression(res);
      if (encoding) {
        drop();
        return fail('BAD_RESPONSE', `compressed response (content-encoding ${excerptText(encoding, 40)})`);
      }
      const declared = res.headers.get('content-length')?.trim() ?? '';
      if (/^\d{1,19}$/.test(declared) && Number(declared) > cap) {
        drop();
        return fail('TOO_LARGE', `${declared} ${cap}`);
      }
      if (!reader) return { ok: true, value: undefined };
      let total = 0;
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          return stopped ?? fail('BAD_RESPONSE', `the connection failed: ${errorMessage(e)}`);
        }
        if (stopped) {
          drop();
          return stopped;
        }
        if (chunk.done) return { ok: true, value: undefined };
        const bytes = chunk.value;
        if (bytes.byteLength === 0) continue;
        bodyArrived();
        total += bytes.byteLength;
        if (total > cap) {
          drop();
          return fail('TOO_LARGE', `${total} ${cap}`);
        }
        try {
          onChunk(bytes);
        } catch (e) {
          drop();
          return fail('BAD_RESPONSE', `the stream reader failed: ${errorMessage(e)}`);
        }
      }
    };

    try {
      const ran = run().catch((e: unknown) => fail('BAD_RESPONSE', errorMessage(e)));
      return await Promise.race([ran, whenStopped]);
    } finally {
      stopTimers();
      signal.removeEventListener('abort', onAbort);
      // Release the connection on every path (a no-op once the body ended).
      controller.abort();
      busy = false;
    }
  }

  return {
    async get(base, path, signal) {
      const parts: Uint8Array[] = [];
      const result = await exchange(
        'GET',
        base,
        path,
        undefined,
        listTimeouts,
        LLM_MAX_MODEL_LIST_BYTES,
        (bytes) => {
          parts.push(bytes);
        },
        signal,
      );
      if (!result.ok) return result;
      return { ok: true, value: new TextDecoder().decode(concat(parts, LLM_MAX_MODEL_LIST_BYTES)) };
    },

    post(base, path, body, onBytes, signal) {
      return exchange('POST', base, path, body, chatTimeouts, LLM_MAX_STREAM_BYTES, onBytes, signal);
    },
  };
}
