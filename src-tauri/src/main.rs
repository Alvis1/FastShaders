// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod autosave;
mod bench_server;
mod podest_window;
mod work_folder;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        // Dialog plugin is Rust-side only (work_folder_pick calls DialogExt);
        // the webview gets no dialog permissions — see capabilities/default.json.
        .plugin(tauri_plugin_dialog::init())
        .manage(bench_server::BenchServerState::default())
        .manage(work_folder::WorkFolderState::default())
        .manage(autosave::CloseState::default())
        .invoke_handler(tauri::generate_handler![
            bench_server::bench_server_start,
            bench_server::bench_server_stop,
            bench_server::bench_server_status,
            podest_window::podest_open,
            work_folder::work_folder_status,
            work_folder::work_folder_pick,
            work_folder::work_folder_forget,
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
            autosave::autosave_close_ready
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
