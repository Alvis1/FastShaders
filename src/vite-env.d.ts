/// <reference types="vite/client" />

/** Injected by Vite at build time from package.json (see vite.config.ts `define`). */
declare const __APP_VERSION__: string;

/** True in the desktop (Tauri) build profile — FS_DESKTOP=1 (see vite.config.ts `define`). */
declare const __FS_DESKTOP__: boolean;

/**
 * Tauri v2 IPC bridge, injected by the desktop wrapper when
 * `app.withGlobalTauri` is true in tauri.conf.json. Only ever present (and
 * only ever accessed) in `__FS_DESKTOP__` builds — see the VR bench popover
 * in Toolbar.tsx.
 */
interface Window {
  __TAURI__?: {
    core: {
      invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
    };
  };
}
