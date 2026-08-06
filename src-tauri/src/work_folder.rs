//! Work-folder commands — the desktop backend for the toolbar's Work-folder
//! control: the user picks a local folder once, then saves shader exports into
//! it and loads the shaders it holds. The web File System Access API is not an
//! option here (WKWebView has no picker at all; WebView2 has one but re-prompts
//! every launch), so the native side owns the folder.
//!
//! Security shape, mirroring bench_server: the webview NEVER passes paths.
//! The picked root lives in managed state (persisted to a file under
//! app_config_dir so it survives restarts), and every file argument crossing
//! IPC is a bare name vetted by `safe_name` + a canonicalize containment
//! check — the command surface cannot be steered outside the linked folder.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// The picked work folder. `None` until picked or restored from the config
/// file; commands resolve lazily via `resolve_root` so a fresh launch works
/// without an explicit status call first.
#[derive(Default)]
pub struct WorkFolderState(Mutex<Option<PathBuf>>);

#[derive(Clone, Serialize)]
pub struct WorkFolderInfo {
    /// Absolute path, for tooltips only — the frontend never sends it back.
    pub path: String,
    /// The folder's leaf name, the UI label.
    pub name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkFolderEntry {
    pub file_name: String,
    /// The shader's authored name recovered from the FASTSHADERS_PROJECT_V1
    /// block inside a `.js` (None for zips and foreign scripts).
    pub display_name: Option<String>,
    pub size_bytes: u64,
    pub modified_ms: Option<u64>,
}

/// Refuse to read files past this size (a work folder is user-chosen and may
/// hold anything; the app's own exports stay well under it).
const MAX_READ_BYTES: u64 = 128 * 1024 * 1024;
/// Cap for the display-name scan — image-heavy exports run a few MB; anything
/// bigger keeps its file-name label instead of being pulled into memory on
/// every list.
const MAX_NAME_SCAN_BYTES: u64 = 8 * 1024 * 1024;
/// Suffix of the staging file a save writes before the atomic rename.
const TMP_SUFFIX: &str = ".tmp-fastshaders";
const NO_FOLDER: &str = "no work folder is linked";

const BEGIN_MARKER: &str = "/* FASTSHADERS_PROJECT_V1";

/// Win32 reserves these stems (the part before the FIRST dot) regardless of
/// extension — `con.js` opens the console device, `nul.js` writes to the void.
const WINDOWS_RESERVED_STEMS: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
    "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

fn lock<'a>(
    state: &'a tauri::State<'a, WorkFolderState>,
) -> Result<std::sync::MutexGuard<'a, Option<PathBuf>>, String> {
    state.0.lock().map_err(|_| "work-folder state poisoned".to_string())
}

/// Where the picked path is remembered across launches. Plain one-line text
/// file — the path IS the whole state.
fn config_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    Ok(dir.join("work-folder.txt"))
}

fn persist_root(app: &tauri::AppHandle, root: &PathBuf) {
    // Best-effort: a failed write only costs the user a re-pick next launch.
    if let Ok(file) = config_file(app) {
        if let Some(parent) = file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&file, root.to_string_lossy().as_bytes());
    }
}

fn forget_persisted(app: &tauri::AppHandle) {
    if let Ok(file) = config_file(app) {
        let _ = fs::remove_file(file);
    }
}

fn info_for(root: &PathBuf) -> WorkFolderInfo {
    WorkFolderInfo {
        path: root.to_string_lossy().into_owned(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
    }
}

/// Current root: managed state first, else the persisted path (re-validated —
/// a folder deleted or moved since last launch silently unlinks rather than
/// erroring every command).
fn resolve_root(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, WorkFolderState>,
) -> Result<Option<PathBuf>, String> {
    let mut guard = lock(state)?;
    if let Some(root) = guard.as_ref() {
        if root.is_dir() {
            return Ok(Some(root.clone()));
        }
        // Linked folder vanished mid-session.
        *guard = None;
        forget_persisted(app);
        return Ok(None);
    }
    let Ok(file) = config_file(app) else { return Ok(None) };
    let Ok(saved) = fs::read_to_string(&file) else { return Ok(None) };
    let root = PathBuf::from(saved.trim());
    if root.as_os_str().is_empty() || !root.is_dir() {
        forget_persisted(app);
        return Ok(None);
    }
    *guard = Some(root.clone());
    Ok(Some(root))
}

/// Bare-name whitelist for everything crossing IPC: no separators, no
/// traversal, no hidden files, and only the two shader extensions the
/// feature deals in. The read path additionally canonicalize-checks for
/// symlinks and the write path parent-checks the joined result.
fn safe_name(name: &str) -> bool {
    if name.is_empty()
        // Room for TMP_SUFFIX under the ubiquitous 255-byte component limit —
        // a longer name would pass here and then fail the staging write.
        || name.len() > 255 - TMP_SUFFIX.len()
        // ':' would make a Windows drive-relative path ("C:evil.js"), which
        // Path::join REPLACES the root with instead of appending to it.
        || name.contains(['/', '\\', '\0', ':'])
        || name.starts_with('.')
    {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    if !(lower.ends_with(".js") || lower.ends_with(".zip")) {
        return false;
    }
    let stem = lower.split('.').next().unwrap_or("");
    !WINDOWS_RESERVED_STEMS.contains(&stem)
}

/// Pull the authored shader name out of the FASTSHADERS_PROJECT_V1 block.
/// The block is a trailing comment whose JSON starts `{"version": 1,
/// "shaderName": "…"` (pretty-printed), so the name sits within a few hundred
/// bytes of the marker; the graph payload that follows can be megabytes, which
/// is why this scans from the marker and never parses the full JSON.
fn extract_shader_name(text: &str) -> Option<String> {
    let start = text.find(BEGIN_MARKER)?;
    // Byte-safe window: a fixed byte offset can land inside a multi-byte
    // character (Latvian names make that routine) and &str slicing PANICS
    // there — lossy-decode the byte window instead; a truncated char at the
    // edge becomes U+FFFD, well past the name this scans for.
    let bytes = text.as_bytes();
    let window = String::from_utf8_lossy(&bytes[start..(start + 4096).min(bytes.len())]);
    let key = "\"shaderName\":";
    let key_at = window.find(key)?;
    let rest = window[key_at + key.len()..].trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    // Escape-aware scan to the closing quote, then let serde do the unescaping
    // (names are user input — quotes, backslashes and non-ASCII are all legal).
    let bytes = rest.as_bytes();
    let mut i = 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => {
                let token = &rest[..=i];
                let name: String = serde_json::from_str(token).ok()?;
                let trimmed = name.trim();
                return if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
            }
            _ => i += 1,
        }
    }
    None
}

#[tauri::command]
pub fn work_folder_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkFolderState>,
) -> Result<Option<WorkFolderInfo>, String> {
    Ok(resolve_root(&app, &state)?.map(|r| info_for(&r)))
}

/// Native folder picker. `async` is load-bearing: async commands run off the
/// main thread, which is what makes `blocking_pick_folder` safe (on the main
/// thread it deadlocks against the event loop — the dialog plugin dispatches
/// to the main thread internally).
#[tauri::command]
pub async fn work_folder_pick(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkFolderState>,
    title: Option<String>,
) -> Result<Option<WorkFolderInfo>, String> {
    let picked = app
        .dialog()
        .file()
        // Display-only, so accepting it over IPC is harmless — it lets the
        // frontend pass the t()-localized title.
        .set_title(title.as_deref().unwrap_or("Choose a work folder for shaders"))
        .blocking_pick_folder();
    let Some(file_path) = picked else { return Ok(None) }; // user cancelled
    let root = file_path
        .into_path()
        .map_err(|e| format!("unusable folder path: {e}"))?;
    if !root.is_dir() {
        return Err("the picked path is not a folder".into());
    }
    *lock(&state)? = Some(root.clone());
    persist_root(&app, &root);
    Ok(Some(info_for(&root)))
}

#[tauri::command]
pub fn work_folder_forget(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkFolderState>,
) -> Result<(), String> {
    *lock(&state)? = None;
    forget_persisted(&app);
    Ok(())
}

/// `async` (like every command below that touches files): sync commands run
/// on the main thread, and a folder of multi-MB exports — or a network drive —
/// would freeze the whole window for the duration of the reads.
#[tauri::command]
pub async fn work_folder_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkFolderState>,
) -> Result<Vec<WorkFolderEntry>, String> {
    let Some(root) = resolve_root(&app, &state)? else {
        return Err(NO_FOLDER.into());
    };
    let dir = fs::read_dir(&root).map_err(|e| format!("could not read the folder: {e}"))?;
    let mut entries = Vec::new();
    for entry in dir.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        if !safe_name(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let display_name = if name.to_ascii_lowercase().ends_with(".js")
            && meta.len() <= MAX_NAME_SCAN_BYTES
        {
            fs::read(entry.path())
                .ok()
                .and_then(|bytes| extract_shader_name(&String::from_utf8_lossy(&bytes)))
        } else {
            None
        };
        entries.push(WorkFolderEntry {
            file_name: name,
            display_name,
            size_bytes: meta.len(),
            modified_ms: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64),
        });
    }
    Ok(entries)
}

/// Raw bytes back to the webview (`tauri::ipc::Response` → ArrayBuffer on the
/// JS side) — no base64 inflation for multi-MB zips.
#[tauri::command]
pub async fn work_folder_read(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkFolderState>,
    file_name: String,
) -> Result<tauri::ipc::Response, String> {
    let Some(root) = resolve_root(&app, &state)? else {
        return Err(NO_FOLDER.into());
    };
    if !safe_name(&file_name) {
        return Err("invalid file name".into());
    }
    let path = root.join(&file_name);
    // Canonicalize both ends so a symlink planted inside the folder cannot
    // point the read outside it (bench_server's containment pattern).
    let (Ok(canon), Ok(canon_root)) = (path.canonicalize(), root.canonicalize()) else {
        return Err("file not found".into());
    };
    if !canon.starts_with(&canon_root) {
        return Err("file is outside the work folder".into());
    }
    let meta = fs::metadata(&canon).map_err(|e| format!("could not stat: {e}"))?;
    if meta.len() > MAX_READ_BYTES {
        return Err("file is too large".into());
    }
    let bytes = fs::read(&canon).map_err(|e| format!("could not read: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn work_folder_write(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkFolderState>,
    file_name: String,
    data_b64: String,
) -> Result<(), String> {
    let Some(root) = resolve_root(&app, &state)? else {
        return Err(NO_FOLDER.into());
    };
    if !safe_name(&file_name) {
        return Err("invalid file name".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| format!("bad payload: {e}"))?;
    let dest = root.join(&file_name);
    let tmp = root.join(format!("{file_name}{TMP_SUFFIX}"));
    // Belt over safe_name's braces: both must still be DIRECT children of the
    // root — a name Path::join treated as prefixed/rooted would not be.
    if dest.parent() != Some(root.as_path()) || tmp.parent() != Some(root.as_path()) {
        return Err("invalid file name".into());
    }
    // Stage via create_new (O_EXCL): never follows a planted symlink and never
    // truncates an existing file. A leftover tmp from a crashed save is
    // removed first — symlink_metadata so the removal hits a link itself.
    if tmp.symlink_metadata().is_ok() {
        fs::remove_file(&tmp).map_err(|e| format!("could not clear stale tmp: {e}"))?;
    }
    let mut staged = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| format!("could not stage: {e}"))?;
    use std::io::Write;
    staged
        .write_all(&bytes)
        .map_err(|e| format!("could not write: {e}"))?;
    let _ = staged.sync_all();
    drop(staged);
    // Direct rename: atomic replace on Unix, and std's Windows rename uses
    // MOVEFILE_REPLACE_EXISTING — a remove-first would open the very
    // no-file-at-all crash window the tmp dance exists to close. The
    // remove+retry runs only if a filesystem refuses the replace outright.
    if let Err(first) = fs::rename(&tmp, &dest) {
        let _ = fs::remove_file(&dest);
        fs::rename(&tmp, &dest).map_err(|_| format!("could not replace: {first}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_name_accepts_shader_files() {
        assert!(safe_name("my-shader.js"));
        assert!(safe_name("bundle.ZIP"));
        assert!(safe_name("Shader With Spaces.js"));
    }

    #[test]
    fn safe_name_rejects_traversal_and_junk() {
        assert!(!safe_name(""));
        assert!(!safe_name("../evil.js"));
        assert!(!safe_name("a/b.js"));
        assert!(!safe_name("a\\b.js"));
        assert!(!safe_name(".hidden.js"));
        assert!(!safe_name("shader.exe"));
        assert!(!safe_name("shader.js\0"));
        assert!(!safe_name(&format!("{}.js", "x".repeat(300))));
    }

    #[test]
    fn safe_name_rejects_windows_traps() {
        // Drive-relative: Path::join would REPLACE the root with these.
        assert!(!safe_name("C:evil.js"));
        // Reserved device stems, any case, either extension.
        assert!(!safe_name("con.js"));
        assert!(!safe_name("COM1.js"));
        assert!(!safe_name("nul.zip"));
        assert!(safe_name("console.js")); // exact stem match only, not prefix
        // Room for the tmp suffix under the 255-byte component limit.
        assert!(!safe_name(&format!("{}.js", "x".repeat(250))));
        assert!(safe_name(&format!("{}.js", "x".repeat(230))));
    }

    #[test]
    fn shader_name_survives_multibyte_at_window_edge() {
        // A 2-byte char straddling the marker+4096 byte boundary must not
        // panic the scan (this exact shape crashed the &str slice it replaced).
        let mut file = format!(
            "{}\n{{\n  \"version\": 1,\n  \"shaderName\": \"Mans ēnotājs\",\n  \"pad\": \"",
            BEGIN_MARKER
        );
        while file.len() < 4095 {
            file.push('x');
        }
        file.push('ē'); // occupies bytes 4095..4097 — crosses the boundary
        file.push_str("\" }");
        assert_eq!(extract_shader_name(&file), Some("Mans ēnotājs".to_string()));
    }

    #[test]
    fn extracts_shader_name_from_project_block() {
        let file = format!(
            "export const schema = {{}};\n\n{}\n{{\n  \"version\": 1,\n  \"shaderName\": \"My Shader\",\n  \"graph\": {{}}\n}}\nEND_FASTSHADERS_PROJECT */\n",
            BEGIN_MARKER
        );
        assert_eq!(extract_shader_name(&file), Some("My Shader".to_string()));
    }

    #[test]
    fn shader_name_handles_escapes_and_absence() {
        let file = format!(
            "{}\n{{\n  \"version\": 1,\n  \"shaderName\": \"Q\\\"uote \\\\ team\",\n}}",
            BEGIN_MARKER
        );
        assert_eq!(extract_shader_name(&file), Some("Q\"uote \\ team".to_string()));
        assert_eq!(extract_shader_name("plain script, no block"), None);
        let empty = format!("{}\n{{ \"version\": 1, \"shaderName\": \"  \" }}", BEGIN_MARKER);
        assert_eq!(extract_shader_name(&empty), None);
    }
}
