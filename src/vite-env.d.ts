/// <reference types="vite/client" />

/** Injected by Vite at build time from package.json (see vite.config.ts `define`). */
declare const __APP_VERSION__: string;

/** True in the desktop (Tauri) build profile — FS_DESKTOP=1 (see vite.config.ts `define`). */
declare const __FS_DESKTOP__: boolean;

/**
 * Tauri v2 IPC bridge, injected by the desktop wrapper when
 * `app.withGlobalTauri` is true in tauri.conf.json. Only ever present (and
 * only ever accessed) in `__FS_DESKTOP__` builds, and only through
 * utils/tauriBridge.ts. `invoke` takes a raw `Uint8Array`/`ArrayBuffer` body
 * plus request headers as well as a JSON object; `event.listen` is covered by
 * `core:event:default`, which the bare `core:default` capability includes.
 */
interface Window {
  __TAURI__?: {
    core: {
      invoke<T>(
        cmd: string,
        args?: Record<string, unknown> | Uint8Array | ArrayBuffer,
        options?: { headers: Record<string, string> },
      ): Promise<T>;
    };
    event: {
      listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
    };
  };
}
