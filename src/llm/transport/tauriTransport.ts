/**
 * `LocalTransport` over the desktop app's Rust bridge (src-tauri/src/llm.rs):
 * Rust makes the loopback request, so the webview needs no CORS switch on the
 * server and sends no origin a server could refuse.
 *
 * The chat stream arrives over a Tauri channel in the frames llm.rs's header
 * documents (`LLM_FRAME_DATA` / `LLM_FRAME_END` in utils/desktopIpc.ts):
 * - every message is raw bytes, byte 0 the tag;
 * - DATA frames carry body bytes, in order, handed to `onBytes` as they come;
 * - ONE END frame, always last, carries the final status — empty for success,
 *   else an `E_…` string — and is what completes the request. The invoke
 *   promise is NOT completion: frames of 1 KiB or more are fetched by the
 *   webview separately and can land after it resolves.
 * - The command rejects only when it sent no frame at all (Tauri refused the
 *   arguments, or the caller is not the main window), so a rejection is final
 *   too.
 *
 * Aborting the signal sends `llm_local_cancel` once and resolves `CANCELLED` at
 * once; frames still in flight are ignored. A page that goes away mid-request
 * cancels it the same way (`pagehide`), and Rust also cancels whatever a
 * reloaded main window left running.
 *
 * Every Tauri call goes through an `LlmDesktopBridge`, so tests drive the whole
 * protocol with a fake (the desktopAutosave.ts pattern); `tauriLlmBridge` is
 * the real one, one `invokeDesktop` per command constant.
 */
import {
  LLM_FRAME_DATA,
  LLM_FRAME_END,
  LLM_LOCAL_CANCEL,
  LLM_LOCAL_CHAT,
  LLM_LOCAL_GET_ROUTES,
  LLM_LOCAL_MODELS,
  LLM_LOCAL_POST_ROUTES,
  desktopBytes,
  parseDesktopError,
} from '@/utils/desktopIpc';
import {
  createDesktopChannel,
  errorText,
  hasDesktopBridge,
  invokeDesktop,
  type DesktopChannel,
} from '@/utils/tauriBridge';
import { requestRefusal } from '../endpoint';
import type { LocalTransport, TransportCode, TransportFailure, TransportResult } from './types';

/** What the transport needs from Tauri. One method per command, so each call
 *  site names its command constant (desktopIpcContract.test.ts resolves them). */
export interface LlmDesktopBridge {
  available(): boolean;
  channel(onMessage: (message: unknown) => void): DesktopChannel | null;
  models(args: { base: string; path: string; requestId: number }): Promise<unknown>;
  chat(args: {
    base: string;
    path: string;
    body: string;
    requestId: number;
    onEvent: DesktopChannel;
  }): Promise<unknown>;
  cancel(args: { requestId: number }): Promise<unknown>;
}

export const tauriLlmBridge: LlmDesktopBridge = {
  available: hasDesktopBridge,
  channel: createDesktopChannel,
  models: (args) => invokeDesktop(LLM_LOCAL_MODELS, args),
  chat: (args) => invokeDesktop(LLM_LOCAL_CHAT, args),
  cancel: (args) => invokeDesktop(LLM_LOCAL_CANCEL, args),
};

/** Every transport code. A `Record` so the compiler holds it to the union. */
const CODES: Record<TransportCode, true> = {
  BAD_URL: true,
  BAD_ROUTE: true,
  BUSY: true,
  UNREACHABLE: true,
  TIMEOUT: true,
  CANCELLED: true,
  TOO_LARGE: true,
  HTTP: true,
  BAD_RESPONSE: true,
  NOT_DESKTOP: true,
};

/** The codes Rust can answer with — all but NOT_DESKTOP, which only this side
 *  says (desktopIpcContract.test.ts pins each one to an `E_` literal in llm.rs). */
export const RUST_TRANSPORT_CODES: readonly TransportCode[] = (
  Object.keys(CODES) as TransportCode[]
).filter((code) => code !== 'NOT_DESKTOP');

const isRustCode = (code: string): code is TransportCode =>
  (RUST_TRANSPORT_CODES as readonly string[]).includes(code);

const fail = (code: TransportCode, detail = ''): TransportFailure => ({ ok: false, code, detail });

/**
 * An `E_…` status — an END frame's payload or a command's rejection — as a
 * failure. `detail` is what Rust wrote after the code: `<status>: <excerpt>`
 * for HTTP, `<n> <limit>` for TOO_LARGE, the reason for UNREACHABLE, TIMEOUT
 * and BAD_RESPONSE. Anything that is not a status Rust answers with
 * (E_FORBIDDEN, Tauri's own argument errors, plain text) is a BAD_RESPONSE
 * carrying the text.
 */
export function failureFromStatus(text: string): TransportFailure {
  const parsed = parseDesktopError(text);
  if (!parsed || !isRustCode(parsed.code)) return fail('BAD_RESPONSE', text.slice(0, 300));
  if (parsed.value !== undefined && parsed.limit !== undefined) {
    return fail(parsed.code, `${parsed.value} ${parsed.limit}`);
  }
  return fail(parsed.code, parsed.detail ?? '');
}

let lastRequestId = 0;

/**
 * A request id: time-based, so it is unique across page loads too — Rust
 * remembers a cancel that arrived before its request, and an id reused by a
 * reloaded page must never meet it. Safe integers (a u64 in Rust) for the next
 * two centuries.
 */
export function nextRequestId(): number {
  lastRequestId = Math.max(lastRequestId + 1, Date.now() * 1000);
  return lastRequestId;
}

/** Window-level `pagehide`, where there is a window (none under node). */
function onPageHide(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('pagehide', listener);
  return () => window.removeEventListener('pagehide', listener);
}

export function tauriTransport(bridge: LlmDesktopBridge = tauriLlmBridge): LocalTransport {
  /**
   * One request's settle-once latch and its cancel wiring. `finish` resolves
   * exactly once; anything after that is ignored.
   */
  function track<T>(
    signal: AbortSignal,
    requestId: number,
    resolve: (result: TransportResult<T>) => void,
  ): { finish: (result: TransportResult<T>) => void; abandon: (result: TransportResult<T>) => void; done: () => boolean } {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (result: TransportResult<T>) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      resolve(result);
    };
    // Stop the Rust side too: it would otherwise stream into a dead callback.
    const abandon = (result: TransportResult<T>) => {
      if (settled) return;
      bridge.cancel({ requestId }).catch(() => {});
      finish(result);
    };
    const onAbort = () => abandon(fail('CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort), onPageHide(onAbort));
    return { finish, abandon, done: () => settled };
  }

  return {
    get(base, path, signal) {
      const refused = requestRefusal(base, path, LLM_LOCAL_GET_ROUTES);
      if (refused) return Promise.resolve(refused);
      if (!bridge.available()) return Promise.resolve(fail('NOT_DESKTOP'));
      if (signal.aborted) return Promise.resolve(fail('CANCELLED'));
      const requestId = nextRequestId();
      return new Promise((resolve) => {
        const { finish } = track(signal, requestId, resolve);
        let sent: Promise<unknown>;
        try {
          sent = bridge.models({ base, path, requestId });
        } catch (e) {
          finish(failureFromStatus(errorText(e)));
          return;
        }
        sent.then(
          (data) => {
            let bytes: Uint8Array;
            try {
              bytes = desktopBytes(data);
            } catch {
              finish(fail('BAD_RESPONSE', 'unreadable answer from the desktop bridge'));
              return;
            }
            finish({ ok: true, value: new TextDecoder().decode(bytes) });
          },
          (e: unknown) => finish(failureFromStatus(errorText(e))),
        );
      });
    },

    post(base, path, body, onBytes, signal) {
      const refused = requestRefusal(base, path, LLM_LOCAL_POST_ROUTES, body);
      if (refused) return Promise.resolve(refused);
      if (!bridge.available()) return Promise.resolve(fail('NOT_DESKTOP'));
      if (signal.aborted) return Promise.resolve(fail('CANCELLED'));
      const requestId = nextRequestId();
      return new Promise((resolve) => {
        let channel: DesktopChannel | null = null;
        const { finish, abandon, done } = track<void>(signal, requestId, (result) => {
          // Release the handler: a frame still in flight finds a no-op.
          if (channel) channel.onmessage = () => {};
          resolve(result);
        });
        channel = bridge.channel((message) => {
          if (done()) return;
          let bytes: Uint8Array;
          try {
            bytes = desktopBytes(message);
          } catch {
            abandon(fail('BAD_RESPONSE', 'unreadable frame from the desktop bridge'));
            return;
          }
          if (bytes[0] === LLM_FRAME_DATA) {
            if (bytes.length < 2) return;
            try {
              onBytes(bytes.subarray(1));
            } catch (e) {
              abandon(fail('BAD_RESPONSE', `the stream reader failed: ${errorText(e)}`));
            }
          } else if (bytes[0] === LLM_FRAME_END) {
            const status = new TextDecoder().decode(bytes.subarray(1));
            finish(status === '' ? { ok: true, value: undefined } : failureFromStatus(status));
          } else {
            abandon(fail('BAD_RESPONSE', 'unknown frame from the desktop bridge'));
          }
        });
        if (!channel) {
          finish(fail('NOT_DESKTOP'));
          return;
        }
        let sent: Promise<unknown>;
        try {
          sent = bridge.chat({ base, path, body, requestId, onEvent: channel });
        } catch (e) {
          finish(failureFromStatus(errorText(e)));
          return;
        }
        sent.then(
          () => {
            // Completion is the END frame, which may still be on its way.
          },
          (e: unknown) => finish(failureFromStatus(errorText(e))),
        );
      });
    },
  };
}
