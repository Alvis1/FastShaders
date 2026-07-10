//! LAN benchmark server: serves the bundled ShaderCarousel suite over plain
//! HTTP on 0.0.0.0 so a VR headset on the same network can run the benches.
//!
//! Read-only and GET-only, path-sanitized, rooted in the bundled resource dir.
//! Plain HTTP is deliberate: a self-signed cert would still throw a warning
//! interstitial on the headset, so instead the toolbar popover documents the
//! two secure-context workarounds (Quest Browser "insecure origins treated as
//! secure" flag, or `adb reverse`) — see Toolbar.tsx.

use serde::Serialize;
use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Preferred port — fixed so the address survives restarts and browser
/// history/flag entries on the headset stay valid. Falls back to an
/// ephemeral port when taken.
const PREFERRED_PORT: u16 = 5199;

#[derive(Default)]
pub struct BenchServerState(Mutex<Option<RunningServer>>);

struct RunningServer {
    server: Arc<tiny_http::Server>,
    port: u16,
}

#[derive(Clone, Serialize)]
pub struct BenchServerInfo {
    pub url: String,
    pub ip: String,
    pub port: u16,
}

/// Locate the ShaderCarousel assets. Bundled builds (and `tauri dev`, which
/// also materializes resources) find them in the resource dir; a plain
/// debug run without a prior desktop-profile web build falls back to the
/// repo checkout next to src-tauri.
fn carousel_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = app.path().resource_dir() {
        let root = dir.join("ShaderCarousel");
        if root.join("index.html").exists() {
            return Ok(root);
        }
    }
    #[cfg(debug_assertions)]
    {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ShaderCarousel");
        if dev.join("index.html").exists() {
            return Ok(dev);
        }
    }
    Err("ShaderCarousel assets not found (rebuild the app — the desktop build bundles them as a resource)".into())
}

/// Best-effort LAN address for display. `local_ip()` consults the routing
/// table, so it returns the interface a headset on the same network would
/// actually reach.
fn lan_ip() -> Option<IpAddr> {
    match local_ip_address::local_ip() {
        Ok(ip) if !ip.is_loopback() => Some(ip),
        _ => None,
    }
}

fn info_for(port: u16) -> BenchServerInfo {
    let ip = lan_ip()
        .map(|i| i.to_string())
        .unwrap_or_else(|| "localhost".into());
    BenchServerInfo {
        url: format!("http://{ip}:{port}/"),
        ip,
        port,
    }
}

/// Map a request URL to a relative filesystem path. Rejects traversal and
/// backslashes outright; the caller's canonicalize check additionally covers
/// symlinks. Query strings and fragments are dropped.
fn sanitize(url_path: &str) -> Option<PathBuf> {
    let path = url_path.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .ok()?;
    let mut clean = PathBuf::new();
    for part in decoded.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains('\\') || part.contains('\0') {
            return None;
        }
        clean.push(part);
    }
    Some(clean)
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "obj" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "glb" => "model/gltf-binary",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

type ByteResponse = tiny_http::Response<std::io::Cursor<Vec<u8>>>;

fn text_response(code: u16, msg: &str) -> ByteResponse {
    tiny_http::Response::from_string(msg).with_status_code(code)
}

fn build_response(root: &Path, request: &tiny_http::Request) -> ByteResponse {
    if request.method() != &tiny_http::Method::Get {
        return text_response(405, "method not allowed");
    }
    let Some(rel) = sanitize(request.url()) else {
        return text_response(400, "bad path");
    };
    let mut path = root.join(&rel);
    if path.is_dir() {
        path = path.join("index.html");
    }
    let (Ok(canon), Ok(canon_root)) = (path.canonicalize(), root.canonicalize()) else {
        return text_response(404, "not found");
    };
    if !canon.starts_with(&canon_root) {
        return text_response(403, "forbidden");
    }
    match fs::read(&canon) {
        Ok(bytes) => {
            let mut resp = tiny_http::Response::from_data(bytes);
            resp.add_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], mime_for(&canon).as_bytes())
                    .expect("static header"),
            );
            // The headset must always see the carousel shipped with THIS
            // app version, never a stale cached bench.
            resp.add_header(
                tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..])
                    .expect("static header"),
            );
            resp
        }
        Err(_) => text_response(404, "not found"),
    }
}

fn serve_loop(server: Arc<tiny_http::Server>, root: PathBuf) {
    // Ends when `unblock()` is called from bench_server_stop.
    for request in server.incoming_requests() {
        let response = build_response(&root, &request);
        // A client that hung up mid-response is not our problem — move on.
        let _ = request.respond(response);
    }
}

#[tauri::command]
pub fn bench_server_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, BenchServerState>,
) -> Result<BenchServerInfo, String> {
    let mut guard = state.0.lock().map_err(|_| "server state poisoned".to_string())?;
    if let Some(running) = guard.as_ref() {
        return Ok(info_for(running.port));
    }
    let root = carousel_root(&app)?;
    let server = tiny_http::Server::http(("0.0.0.0", PREFERRED_PORT))
        .or_else(|_| tiny_http::Server::http(("0.0.0.0", 0)))
        .map_err(|e| format!("could not bind a port: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .unwrap_or(PREFERRED_PORT);
    let server = Arc::new(server);
    let loop_server = Arc::clone(&server);
    // Detached on purpose — see bench_server_stop for why it is never joined.
    std::thread::spawn(move || serve_loop(loop_server, root));
    *guard = Some(RunningServer { server, port });
    Ok(info_for(port))
}

#[tauri::command]
pub fn bench_server_stop(state: tauri::State<'_, BenchServerState>) -> Result<(), String> {
    // Take the server out of the state and RELEASE THE LOCK before touching
    // the socket: this synchronous command runs on the IPC/main thread, and a
    // client that stalls mid-response keeps the serve thread blocked inside
    // respond() indefinitely (tiny_http has no write timeout, and its
    // unblock marker queues FIFO behind in-flight requests). Joining that
    // thread here would freeze the whole app — and doing it under the mutex
    // would additionally deadlock every later start/status call. So: unblock,
    // drop our Arc, and let the serve thread wind down on its own; the
    // listener socket closes when the last Arc<Server> drops. A restart while
    // an old thread still drains falls back to an ephemeral port.
    let running = {
        let mut guard = state.0.lock().map_err(|_| "server state poisoned".to_string())?;
        guard.take()
    };
    if let Some(running) = running {
        running.server.unblock();
    }
    Ok(())
}

#[tauri::command]
pub fn bench_server_status(
    state: tauri::State<'_, BenchServerState>,
) -> Result<Option<BenchServerInfo>, String> {
    let guard = state.0.lock().map_err(|_| "server state poisoned".to_string())?;
    Ok(guard.as_ref().map(|r| info_for(r.port)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_passes_normal_paths() {
        assert_eq!(sanitize("/"), Some(PathBuf::new()));
        assert_eq!(
            sanitize("/bench-inout/bench.js?x=1#frag"),
            Some(PathBuf::from("bench-inout/bench.js"))
        );
        assert_eq!(
            sanitize("/lib/three/three.webgpu.js"),
            Some(PathBuf::from("lib/three/three.webgpu.js"))
        );
    }

    #[test]
    fn sanitize_rejects_traversal() {
        assert_eq!(sanitize("/../secret"), None);
        assert_eq!(sanitize("/a/../../b"), None);
        assert_eq!(sanitize("/%2e%2e/secret"), None); // percent-decoded ".."
        assert_eq!(sanitize("/a\\b"), None);
    }

    #[test]
    fn mime_covers_bench_assets() {
        assert_eq!(mime_for(Path::new("index.html")), "text/html; charset=utf-8");
        assert_eq!(mime_for(Path::new("bench.js")), "text/javascript; charset=utf-8");
        assert_eq!(mime_for(Path::new("x.bin")), "application/octet-stream");
    }
}
