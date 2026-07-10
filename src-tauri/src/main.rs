// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bench_server;

fn main() {
    tauri::Builder::default()
        .manage(bench_server::BenchServerState::default())
        .invoke_handler(tauri::generate_handler![
            bench_server::bench_server_start,
            bench_server::bench_server_stop,
            bench_server::bench_server_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running FastShaders");
}
