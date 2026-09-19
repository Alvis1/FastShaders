/**
 * The app's ONE Tauri IPC boundary.
 *
 * Both desktop call sites — the Toolbar's LAN bench server and the Work-folder
 * control — used to hold a private copy of this four-line guard plus a
 * byte-identical `errorText`, so `grep -rn __TAURI__ src` returned two
 * implementations of the same three lines. That matters more than the lines it
 * saves: desktop paths can only be exercised on a real `tauri build` run, so a
 * correction applied to one copy is exactly the kind of thing that goes
 * unnoticed as missing from the other.
 *
 * Only ever called from `__FS_DESKTOP__` branches, where the wrapper injects
 * the global (`app.withGlobalTauri` in tauri.conf.json). The plain-browser run
 * of a desktop bundle is covered by REJECTING rather than throwing, so every
 * caller's existing `.catch` already handles it — a throw would escape the
 * synchronous part of an `async` handler at some call sites and not others.
 *
 * Keeping it in `utils/` (not beside WorkFolder) is deliberate: Toolbar.tsx
 * ships to the web build too, and this module has no desktop-only imports, so
 * nothing here widens what the web bundle pulls in.
 *
 * `args` is either the usual JSON object or a RAW body (`Uint8Array` /
 * `ArrayBuffer`), which Tauri hands the command as `ipc::Request::body()`
 * untouched — that is how the Work folder saves a 256 MiB zip without the 33%
 * base64 inflation into one JSON string. A raw body has no room for named
 * arguments, so anything else the command needs rides `options.headers`
 * (utils/desktopIpc.ts names them).
 */
export type DesktopInvokeArgs = Record<string, unknown> | Uint8Array | ArrayBuffer;
export interface DesktopInvokeOptions {
  headers: Record<string, string>;
}

export function invokeDesktop<T>(
  cmd: string,
  args?: DesktopInvokeArgs,
  options?: DesktopInvokeOptions,
): Promise<T> {
  const bridge = window.__TAURI__;
  if (!bridge) return Promise.reject(new Error('Desktop bridge unavailable'));
  return bridge.core.invoke<T>(cmd, args, options);
}

/** Tauri command failures reject with a plain string (Result<_, String>). */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
