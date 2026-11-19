// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod autosave;
mod bench_server;
mod llm;
mod podest_window;
mod work_folder;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        // Dialog plugin is Rust-side only (work_folder_pick calls DialogExt);
        // the webview gets no dialog permissions — see capabilities/default.json.
        .plugin(tauri_plugin_dialog::init())
        // Where any webview — and, on macOS, any frame — may navigate:
        // `navigation_guard` below.
        .plugin(navigation_guard())
        // A page load in the main window cancels the local-LLM request its
        // old page left running (llm.rs).
        .plugin(llm::page_load_guard())
        .manage(bench_server::BenchServerState::default())
        .manage(work_folder::WorkFolderState::default())
        .manage(autosave::CloseState::default())
        .manage(llm::LlmState::default())
        .invoke_handler(tauri::generate_handler![
            bench_server::bench_server_start,
            bench_server::bench_server_stop,
            bench_server::bench_server_status,
            podest_window::podest_open,
            work_folder::work_folder_status,
            work_folder::work_folder_pick,
            work_folder::work_folder_forget,
            work_folder::work_folder_open,
            work_folder::work_folder_list,
            work_folder::work_folder_read,
            work_folder::work_folder_write_bytes,
            autosave::autosave_status,
            autosave::autosave_read,
            autosave::autosave_write,
            autosave::autosave_image_put,
            autosave::autosave_image_get,
            autosave::autosave_gc,
            autosave::autosave_quarantine,
            autosave::autosave_close_ready,
            llm::llm_local_models,
            llm::llm_local_chat,
            llm::llm_local_cancel
        ])
        // Flush the webview's pending autosave before the MAIN window goes
        // (autosave.rs). Podest's window closes freely: it holds no document.
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if autosave::request_flush(window.app_handle(), autosave::INTENT_CLOSE_MAIN) {
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building FastShaders")
        .run(|app, event| {
            // A quit by user interaction (Cmd+Q, the last window closing)
            // carries `code: None`. Programmatic exits — finish_close's
            // `app.exit(0)` — carry `Some` and pass straight through.
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = &event
            {
                if app.get_webview_window("main").is_some()
                    && autosave::request_flush(app, autosave::INTENT_EXIT_APP)
                {
                    api.prevent_exit();
                }
            }
        });
}

/// The navigation allow-list. A navigation in any webview (the main window,
/// podest's window) and, on macOS, in any FRAME must land on one of the app's
/// own pages, a frame's `about:blank`/`about:srcdoc`, a blob one of those
/// pages minted, a mail hand-off, or — under `tauri dev` only — the dev
/// server.
///
/// Why: shader code runs in the preview's (and podest's stage's) sandboxed
/// srcdoc frame under that document's own CSP, and a meta policy does not
/// survive the frame navigating ITSELF: `location.href = "http://127.0.0.1:…"`
/// would swap the stage for a document of the shader's choosing with no
/// policy at all, free to talk to a local server. The desktop build has no
/// page CSP to refuse that (vite.config.ts suppresses it), so the host does.
/// A plugin hook rather than a builder call because the main window comes
/// from tauri.conf.json; Tauri runs plugin hooks for every webview.
///
/// The list is the app's own navigations, inventoried from the source
/// (docs/dev/platform-and-release.md): its pages (the editor, podest.html,
/// Hard reload's `?fsreload=`, the study entries), the frames' srcdoc and
/// blank documents, the three `mailto:` links, and EXPORT's `<a download>`
/// of a blob its own page minted — decided as a download before this hook on
/// macOS 11.3+, not a navigation in Chromium (so not in WebView2, read, not
/// measured), and admitted in case an engine reports it as one. Nothing the app does opens a `data:` document
/// or another host: `target="_blank"` and `window.open` open no window in
/// this shell (no new-window handler), so the website link and the VR popup
/// never navigate this webview.
///
/// Reach (wry 0.55): WKWebView asks `decidePolicyForNavigationAction` for
/// every frame, so on macOS this covers the stage and anything nested in it.
/// On Windows wry hooks WebView2's top-level `NavigationStarting` only, so
/// there the frames are covered by the preview iframe's `csp` attribute
/// (ShaderPreview.tsx) and podest's page-level `frame-src 'none'` instead. A
/// URL Tauri cannot parse is allowed before this runs (tauri-runtime-wry's
/// `unwrap_or(true)`).
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let dev = if tauri::is_dev() {
                webview.config().build.dev_url.as_ref()
            } else {
                None
            };
            navigation_allowed(url, dev, cfg!(windows))
        })
        .build()
}

/// The pure half of `navigation_guard`. The platform is a parameter so both
/// branches are tested on every OS.
fn navigation_allowed(url: &tauri::Url, dev_url: Option<&tauri::Url>, windows: bool) -> bool {
    match url.scheme() {
        // Every frame starts as about:blank; the stages are srcdoc frames.
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        // The contact link, the feedback dialog's "Open email" and the study's
        // "Email to researcher" hand off to the mail client; no document loads.
        "mailto" => true,
        // A blob carries the origin that minted it. One of the app's own pages
        // (`blob:tauri://localhost/…`) is admitted; a sandboxed stage can mint
        // only `blob:null/…` — its origin is opaque — and that is the escape.
        "blob" => {
            tauri::Url::parse(url.path()).is_ok_and(|minter| is_app_page(&minter, dev_url, windows))
        }
        _ => is_app_page(url, dev_url, windows),
    }
}

/// One of the app's own pages: `tauri://localhost/…` on macOS, and on Windows
/// `http(s)://tauri.localhost/…` — only there: elsewhere a `*.localhost` name
/// can resolve to loopback — or, under `tauri dev`, the dev server's origin.
fn is_app_page(url: &tauri::Url, dev_url: Option<&tauri::Url>, windows: bool) -> bool {
    match url.scheme() {
        "tauri" => !windows && url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" => {
            (windows && url.host_str() == Some("tauri.localhost") && url.port().is_none())
                || dev_url.is_some_and(|dev| url.origin() == dev.origin())
        }
        _ => false,
    }
}

#[cfg(test)]
mod navigation_tests {
    use super::navigation_allowed;
    use tauri::Url;

    /// tauri.conf.json's `devUrl`, as the guard receives it under `tauri dev`.
    const DEV: &str = "http://localhost:5173";

    fn allowed(url: &str, dev: Option<&str>, windows: bool) -> bool {
        let dev = dev.map(|d| Url::parse(d).expect("dev url"));
        navigation_allowed(&Url::parse(url).expect("url"), dev.as_ref(), windows)
    }

    /// Every navigation the app makes itself (the inventory in
    /// docs/dev/platform-and-release.md), on the platform that makes it.
    #[test]
    fn the_apps_own_navigations_pass() {
        for windows in [false, true] {
            // Every frame starts as about:blank; the preview, the intro's
            // stage and podest's stage are srcdoc frames.
            assert!(allowed("about:blank", None, windows));
            assert!(allowed("about:srcdoc", None, windows));
            // The contact link, the feedback dialog's "Open email" and the
            // study's "Email to researcher" hand off to the mail client.
            assert!(allowed(
                "mailto:a@example.com?subject=x&body=y",
                None,
                windows
            ));
        }
        // macOS: the app, podest's window, Hard reload, a study entry.
        assert!(allowed("tauri://localhost/", None, false));
        assert!(allowed("tauri://localhost/index.html", None, false));
        assert!(allowed("tauri://localhost/podest.html", None, false));
        assert!(allowed(
            "tauri://localhost/?fsreload=1763550000000",
            None,
            false
        ));
        assert!(allowed("tauri://localhost/evalp/", None, false));
        // Windows: the same pages on WebView2's host, either scheme.
        assert!(allowed("http://tauri.localhost/", None, true));
        assert!(allowed("http://tauri.localhost/podest.html", None, true));
        assert!(allowed(
            "https://tauri.localhost/?fsreload=1763550000000",
            None,
            true
        ));
        // EXPORT's anchor: a blob the app's own page minted. A download, which
        // on macOS 11.3+ and in WebView2 never reaches the hook at all.
        assert!(allowed(
            "blob:tauri://localhost/0b2c3d4e-0000-4000-8000-000000000000",
            None,
            false
        ));
        assert!(allowed(
            "blob:http://tauri.localhost/0b2c3d4e-0000-4000-8000-000000000000",
            None,
            true
        ));
    }

    #[test]
    fn the_dev_server_passes_only_under_tauri_dev() {
        let dev = Some(DEV);
        assert!(allowed("http://localhost:5173/", dev, false));
        assert!(allowed("http://localhost:5173/podest.html", dev, true));
        assert!(allowed("blob:http://localhost:5173/0b2c3d4e", dev, false));
        assert!(!allowed("http://localhost:5173/", None, false));
        assert!(!allowed("blob:http://localhost:5173/0b2c3d4e", None, false));
        assert!(!allowed("http://localhost:5174/", dev, false));
        assert!(!allowed("http://127.0.0.1:5173/", dev, false));
        assert!(!allowed("https://localhost:5173/", dev, false));
        assert!(!allowed("ws://localhost:5173/", dev, false));
    }

    #[test]
    fn a_stage_cannot_swap_its_document() {
        for windows in [false, true] {
            for url in [
                // The escape itself: a document of the shader's choosing,
                // with no policy, free to talk to a local server.
                "https://example.com/",
                "http://127.0.0.1:1234/v1/chat/completions",
                "http://localhost:11434/api/chat",
                "http://localhost/",
                "http://[::1]:1234/",
                "ws://127.0.0.1:1234/",
                "file:///etc/hosts",
                // A document a sandboxed stage mints for itself: its blob
                // carries the frame's OPAQUE origin; a data: one has none.
                "blob:null/1b2c3d4e-0000-4000-8000-000000000000",
                "blob:https://example.com/1b2c3d4e",
                "blob:",
                "blob:blob:tauri://localhost/x",
                "data:text/html,<p>x</p>",
                "data:text/html;base64,PHA+eDwvcD4=",
                "about:config",
                "javascript:void(0)",
                "tauri://example.com/",
                "asset://localhost/x",
                "ftp://example.com/",
            ] {
                assert!(
                    !allowed(url, Some(DEV), windows),
                    "{url} passed (windows: {windows})"
                );
            }
        }
        // Each platform's app host is refused on the other one, and with a port.
        assert!(!allowed("http://tauri.localhost/", None, false));
        assert!(!allowed("http://tauri.localhost:1234/", None, true));
        assert!(!allowed("tauri://localhost/", None, true));
        assert!(!allowed("tauri://localhost:8080/", None, false));
        assert!(!allowed("blob:tauri://localhost/x", None, true));
        assert!(!allowed("blob:http://tauri.localhost/x", None, false));
    }
}
