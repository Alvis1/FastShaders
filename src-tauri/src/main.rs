// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bench_server;
mod work_folder;

fn main() {
    tauri::Builder::default()
        // Dialog plugin is Rust-side only (work_folder_pick calls DialogExt);
        // the webview gets no dialog permissions — see capabilities/default.json.
        .plugin(tauri_plugin_dialog::init())
        .manage(bench_server::BenchServerState::default())
        .manage(work_folder::WorkFolderState::default())
        .invoke_handler(tauri::generate_handler![
            bench_server::bench_server_start,
            bench_server::bench_server_stop,
            bench_server::bench_server_status,
            work_folder::work_folder_status,
            work_folder::work_folder_pick,
            work_folder::work_folder_forget,
            work_folder::work_folder_list,
            work_folder::work_folder_read,
            work_folder::work_folder_write
        ])
        .run(tauri::generate_context!())
        .expect("error while running FastShaders");
}
