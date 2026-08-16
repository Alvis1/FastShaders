//! Opens the Podest full-screen shader player in its own app window.
//!
//! This exists because `target="_blank"` has no meaning in a Tauri webview:
//! neither WKWebView nor WebView2 opens a new window for it without a host
//! handler, so the toolbar's "P" link — which works on the web — was inert in
//! the desktop build. Podest is a SECOND presentation surface, not a modal, so
//! a real OS window (movable to a second display, fullscreenable on its own)
//! is what it should have been all along.
//!
//! Deliberately a Rust command rather than the frontend's `WebviewWindow` API:
//! creating a window from JS needs `core:webview:allow-create-webview-window`
//! in `capabilities/default.json`, and this project keeps that file at bare
//! `core:default` — app commands registered in `invoke_handler` are covered by
//! it, so this route adds a window without widening the webview's ACL at all.
//!
//! The new window is labelled `podest` and is therefore NOT listed in the
//! capability's `windows` array, so its webview gets no IPC permissions
//! whatsoever. That is correct and intentional: podest.html is a self-contained
//! page that never invokes a Tauri command.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Window label. Also the reuse key — a second click focuses the existing
/// window instead of failing on the duplicate label.
const PODEST_LABEL: &str = "podest";

#[tauri::command]
pub fn podest_open(app: tauri::AppHandle) -> Result<(), String> {
    // Already open: raise it. `unminimize` first, or focusing a minimized
    // window leaves it in the dock with nothing visible happening — which
    // reads exactly like the button being broken, the failure this whole
    // command exists to fix.
    if let Some(existing) = app.get_webview_window(PODEST_LABEL) {
        let _ = existing.unminimize();
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // `WebviewUrl::App` resolves against `frontendDist` in a built app and
    // against `devUrl` under `tauri dev`, so this one line covers
    // tauri://localhost, http://tauri.localhost (Windows/WebView2) and
    // http://localhost:5173 without naming any of them. podest.html ships as
    // a `public/` file, so it is present in every profile's dist.
    WebviewWindowBuilder::new(&app, PODEST_LABEL, WebviewUrl::App("podest.html".into()))
        .title("FastShaders — Podest")
        .inner_size(1280.0, 800.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        // REQUIRED, for the same reason the main window sets `dragDropEnabled:
        // false` in tauri.conf.json: with the OS-level drag-drop handler
        // active, the webview never receives HTML5 drop events. Podest is
        // drag-drop-FIRST — dropping a .js/.zip shader or a .glb model on it is
        // the entire way you load anything — so omitting this would ship a
        // window that cannot be given a shader at all.
        //
        // Note the builder spells this as a no-argument `disable_…`, not the
        // config key's `drag_drop_enabled(false)`.
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}
