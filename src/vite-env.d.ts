/// <reference types="vite/client" />

/** Injected by Vite at build time from package.json (see vite.config.ts `define`). */
declare const __APP_VERSION__: string;

/** True in the desktop (Tauri) build profile — FS_DESKTOP=1 (see vite.config.ts `define`). */
declare const __FS_DESKTOP__: boolean;

/** The URL every build posts a finished study package to: FS_EVAL_UPLOAD_URL, else DEFAULT_EVAL_UPLOAD_URL — ViA's endpoint (see vite.config.ts `define`). */
declare const __FS_EVAL_UPLOAD_URL__: string;

/**
 * True when this build may offer the Claude route of "Generate nodes from
 * text": the dev server, the desktop app (neither has a page CSP), or a web
 * build whose CSP names https://api.anthropic.com through FS_LLM_CLOUD_ORIGINS
 * — ONE value drives both, so the option never appears where the policy would
 * refuse it (vite.config.ts `llmCloudDefinePlugin`).
 */
declare const __FS_LLM_CLOUD__: boolean;

/**
 * Tauri v2 IPC bridge, injected by the desktop wrapper when
 * `app.withGlobalTauri` is true in tauri.conf.json. Only ever present (and
 * only ever accessed) in `__FS_DESKTOP__` builds, and only through
 * utils/tauriBridge.ts. `invoke` takes a raw `Uint8Array`/`ArrayBuffer` body
 * plus request headers as well as a JSON object; `event.listen` is covered by
 * `core:event:default`, which the bare `core:default` capability includes.
 * `Channel` is Tauri's streaming channel (@tauri-apps/api's class): put one
 * inside a command's args and Rust can send it messages — delivered in the
 * order sent, and unregistered once Rust drops it. Its delivery needs no
 * permission (Tauri exempts the internal fetch from the ACL).
 */
interface TauriIpcChannel {
  readonly id: number;
  onmessage: (message: unknown) => void;
}

interface Window {
  __TAURI__?: {
    core: {
      invoke<T>(
        cmd: string,
        args?: Record<string, unknown> | Uint8Array | ArrayBuffer,
        options?: { headers: Record<string, string> },
      ): Promise<T>;
      Channel: new () => TauriIpcChannel;
    };
    event: {
      listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
    };
  };
}
