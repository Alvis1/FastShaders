//! The bundled AI engine (P5): llama.cpp's `llama-server`, shipped UNEDITED as
//! the resource folder `engine/<tag>/` (tauri.conf.json maps
//! `engine-dist/` there; `scripts/fetch-engine.mjs` stages it) and pinned file
//! by file in `src-tauri/engine.json`, which this module compiles in. This half
//! is the SURVEY the setup pane runs when it opens: is there an engine for this
//! computer, is every file the one we pinned, does it run, and what does it
//! find (GPU devices), plus the memory and free disk the download step needs.
//!
//! ## Every file is checked before anything runs
//!
//! A file runs only after its size and SHA-256 matched the compiled-in pin, in
//! the folder it runs from, on this survey. A difference is `tampered` and
//! nothing is started.
//!
//! ## macOS: the app runs its OWN copy
//!
//! A browser marks the downloaded `.dmg` with `com.apple.quarantine`, mounting
//! it passes the mark to every file inside, and dragging the app out keeps it.
//! "Open Anyway" approves the APP; a quarantined Mach-O the app then spawns is
//! assessed on its own, and an unnotarized one is refused (measured 2026-11-19:
//! the exec blocks on a Gatekeeper prompt, `spctl` says "rejected"). So the
//! engine is copied, file by file and hash-checked as it is written, into
//! `app_data_dir()/engine/<tag>/`; a file this process writes carries no mark,
//! and any mark that does appear is removed only AFTER the file matched its
//! pin. Older tags there are deleted. The copy also works when macOS runs the
//! app from a read-only translocated path.
//!
//! ## Windows: it runs in place, and the folder holds nothing else
//!
//! The installer writes the files, so they carry no Mark of the Web, and the
//! engine runs from the install folder. ggml loads every `ggml-*.dll` it finds
//! beside the executable (its CPU variants and the Vulkan backend), so a file
//! there that is not pinned is `tampered` too: the folder must hold exactly the
//! pinned set. The tag is in the path, so an update never mixes two versions.
//!
//! ## Running it
//!
//! `--version` and `--list-devices` only, with the environment CLEARED (llama
//! reads `LLAMA_ARG_*`, `HF_ENDPOINT`, `MODEL_ENDPOINT` and more from it) but
//! for the few variables the OS itself needs (`KEPT_ENV`), no stdin, output
//! capped, and a deadline: a run that has not answered in `PROBE_TIMEOUT`
//! is killed and reported `blocked`, the shape a Gatekeeper hold takes.
//!
//! The answer crosses as RAW JSON bytes (`ipc::Response`), like llm.rs's model
//! list: the device names are the GPU driver's words, and nothing an outside
//! program prints is handed to Tauri's `Json` variant (desktopIpcContract.test).

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::{InvokeResponseBody, Response};
use tauri::Manager;

use crate::llm::{engine_call, excerpt_text, FORBIDDEN, MAIN_WEBVIEW};

/// THE pins (scripts/fetch-engine.mjs reads the same file).
const MANIFEST_JSON: &str = include_str!("../engine.json");
/// The resource folder (`bundle.resources`: `engine-dist/` → `engine/`).
const RESOURCE_DIR: &str = "engine";
/// macOS: the app's own copy, under `app_data_dir()`.
const INSTALL_DIR: &str = "engine";
/// A probe run that has not finished by then is killed: `blocked`.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// What one probe run's stdout or stderr may fill.
const PROBE_OUTPUT_CAP: usize = 64 * 1024;
/// Devices kept from `--list-devices`.
const MAX_DEVICES: usize = 16;
/// The engine's own floor (`LC_BUILD_VERSION minos 13.3` in every file).
const MIN_MACOS: (u32, u32) = (13, 3);
/// Characters kept of a device name, a version line or a failure detail.
const TEXT_CHARS: usize = 120;
/// Windows NTSTATUS exit codes of a process whose DLLs could not be bound:
/// STATUS_DLL_NOT_FOUND (0xC0000135) and STATUS_ENTRYPOINT_NOT_FOUND
/// (0xC0000139). Every engine DLL imports MSVCP140/VCRUNTIME140(_1), the
/// Visual C++ runtime, which a fresh Windows may lack or carry too old.
const RUNTIME_MISSING_CODES: [i32; 2] = [0xC000_0135_u32 as i32, 0xC000_0139_u32 as i32];

/// The only variables a probe run inherits.
#[cfg(windows)]
const KEPT_ENV: [&str; 5] = ["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP"];
#[cfg(not(windows))]
const KEPT_ENV: [&str; 1] = ["TMPDIR"];

/// Every `state` a survey can report (`ENGINE_SURVEY_STATES` in desktopIpc.ts).
pub const SURVEY_STATES: [&str; 9] = [
    "ok",
    "unsupported",
    "intel-mac",
    "old-mac",
    "missing",
    "tampered",
    "blocked",
    "runtime-missing",
    "failed",
];

/// Which pins this build runs, decided at compile time per architecture slice
/// (the universal macOS binary is two builds). Each build constructs only its
/// own variant; the tests construct the others.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Host {
    Engine(&'static str),
    /// D19: llama.cpp's x64 macOS build has no Metal, so none is bundled.
    IntelMac,
    Unsupported,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const HOST: Host = Host::Engine("macos-arm64");
#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
const HOST: Host = Host::IntelMac;
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const HOST: Host = Host::Engine("windows-x64");
#[cfg(not(any(
    target_os = "macos",
    all(target_os = "windows", target_arch = "x86_64")
)))]
const HOST: Host = Host::Unsupported;

/// macOS runs a copy; Windows runs the installed folder.
const COPY_OUT: bool = cfg!(target_os = "macos");

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug)]
struct Manifest {
    tag: String,
    platforms: HashMap<String, PlatformPins>,
    /// The models the app may download, the default first.
    #[serde(default)]
    models: Vec<ModelPin>,
}

/// One downloadable model: where the engine's own downloader finds it (a
/// Hugging Face repository and quantisation — it takes no revision), and what
/// the file must BE before the app loads it (its size and SHA-256, read from
/// the repository at `commit`).
#[derive(Deserialize, Debug, Clone)]
pub(crate) struct ModelPin {
    key: String,
    label: String,
    repo: String,
    quant: String,
    commit: String,
    file: String,
    sha256: String,
    size: u64,
}

/// `<owner>/<name>`, each one plain path segment.
fn safe_repo(repo: &str) -> bool {
    match repo.split_once('/') {
        Some((owner, name)) => safe_name(owner) && safe_name(name),
        None => false,
    }
}

fn valid_model(m: &ModelPin) -> bool {
    safe_name(&m.key)
        && !m.label.is_empty()
        && m.label.len() <= 40
        && m.label.bytes().all(|b| (0x20..0x7f).contains(&b))
        && safe_repo(&m.repo)
        && safe_name(&m.quant)
        && m.commit.len() == 40
        && m.commit
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && safe_name(&m.file)
        && m.file.ends_with(".gguf")
        && is_hex64(&m.sha256)
        && m.size > 0
}

#[derive(Deserialize, Debug, Clone)]
struct PlatformPins {
    server: String,
    files: Vec<FilePin>,
}

#[derive(Deserialize, Debug, Clone)]
struct FilePin {
    to: String,
    sha256: String,
    size: u64,
}

/// One path segment of plain characters, never starting with a dot (so never
/// `.`, `..` or one of this module's `.part` files).
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn parse_manifest(json: &str) -> Result<Manifest, String> {
    let m: Manifest = serde_json::from_str(json).map_err(|e| format!("engine.json: {e}"))?;
    if !safe_name(&m.tag) {
        return Err("engine.json: bad tag".into());
    }
    for (key, p) in &m.platforms {
        let mut seen = HashSet::new();
        for f in &p.files {
            if !safe_name(&f.to) || !seen.insert(f.to.to_ascii_lowercase()) {
                return Err(format!("engine.json: {key}: bad or repeated name {}", f.to));
            }
            if !is_hex64(&f.sha256) || f.size == 0 {
                return Err(format!("engine.json: {key}: {}: bad pin", f.to));
            }
        }
        if !p.files.iter().any(|f| f.to == p.server) {
            return Err(format!(
                "engine.json: {key}: the server is not a listed file"
            ));
        }
    }
    let mut keys = HashSet::new();
    for model in &m.models {
        if !valid_model(model) || !keys.insert(model.key.as_str()) {
            return Err(format!("engine.json: bad model pin {}", model.key));
        }
    }
    Ok(m)
}

/// The model this build downloads and runs: the manifest's first.
fn default_model() -> Option<&'static ModelPin> {
    manifest().ok().and_then(|m| m.models.first())
}

fn manifest() -> Result<&'static Manifest, String> {
    static PARSED: OnceLock<Result<Manifest, String>> = OnceLock::new();
    PARSED
        .get_or_init(|| parse_manifest(MANIFEST_JSON))
        .as_ref()
        .map_err(Clone::clone)
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/// Why a folder cannot be run.
#[derive(Debug, PartialEq, Eq)]
enum Prep {
    /// The resource folder is absent: a build made without `fetch:engine`.
    Missing(String),
    /// A file differs from its pin, is absent from a present folder, is not a
    /// regular file, or is not pinned at all.
    Tampered(String),
    /// The disk refused (permissions, full disk).
    Io(String),
}

/// Size and SHA-256 of a REGULAR file (a link is never followed) equal `pin`.
fn matches_pin(path: &Path, pin: &FilePin) -> Result<bool, io::Error> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.len() != pin.size {
        return Ok(false);
    }
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()) == pin.sha256)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn listed(pins: &PlatformPins) -> HashSet<&str> {
    pins.files.iter().map(|f| f.to.as_str()).collect()
}

/// Windows: the folder must hold exactly the pinned files, each matching.
fn verify_in_place(dir: &Path, pins: &PlatformPins) -> Result<(), Prep> {
    match fs::symlink_metadata(dir) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(Prep::Tampered(format!("{} is not a folder", RESOURCE_DIR))),
        Err(_) => return Err(Prep::Missing("the engine is not in this build".into())),
    }
    let names = listed(pins);
    for entry in fs::read_dir(dir).map_err(|e| Prep::Io(e.to_string()))? {
        let entry = entry.map_err(|e| Prep::Io(e.to_string()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !names.contains(name.as_str()) {
            return Err(Prep::Tampered(format!("unexpected file {name}")));
        }
    }
    for pin in &pins.files {
        match matches_pin(&dir.join(&pin.to), pin) {
            Ok(true) => {}
            Ok(false) => return Err(Prep::Tampered(format!("{} does not match its pin", pin.to))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Err(Prep::Tampered(format!("{} is missing", pin.to)))
            }
            Err(e) => return Err(Prep::Io(e.to_string())),
        }
    }
    Ok(())
}

/// macOS: bring `dst` to exactly the pinned files, copying from `src` only
/// what is absent or wrong, each one hashed AS IT IS WRITTEN and renamed into
/// place only when it matched. Everything else in `dst` is removed, and so is
/// every sibling of `dst` (another tag) inside its parent.
fn install_copy(src: &Path, dst: &Path, pins: &PlatformPins) -> Result<(), Prep> {
    match fs::symlink_metadata(src) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return Err(Prep::Tampered(format!("{} is not a folder", RESOURCE_DIR))),
        Err(_) => return Err(Prep::Missing("the engine is not in this build".into())),
    }
    let io_err = |e: io::Error| Prep::Io(e.to_string());
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(io_err)?;
        let keep = dst.file_name();
        for entry in fs::read_dir(parent).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            if Some(entry.file_name().as_os_str()) != keep {
                remove_entry(&entry.path()).map_err(io_err)?;
            }
        }
    }
    if let Ok(m) = fs::symlink_metadata(dst) {
        if !m.is_dir() {
            fs::remove_file(dst).map_err(io_err)?;
        }
    }
    fs::create_dir_all(dst).map_err(io_err)?;
    let names = listed(pins);
    for entry in fs::read_dir(dst).map_err(io_err)? {
        let entry = entry.map_err(io_err)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let regular = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !regular || !names.contains(name.as_str()) {
            remove_entry(&entry.path()).map_err(io_err)?;
        }
    }
    for pin in &pins.files {
        let target = dst.join(&pin.to);
        if matches_pin(&target, pin).unwrap_or(false) {
            clear_quarantine(&target);
            continue;
        }
        let from = src.join(&pin.to);
        match fs::symlink_metadata(&from) {
            Ok(m) if m.is_file() => {}
            Ok(_) => return Err(Prep::Tampered(format!("{} is not a regular file", pin.to))),
            Err(_) => return Err(Prep::Tampered(format!("{} is missing", pin.to))),
        }
        let part = dst.join(format!(".{}.part", pin.to));
        copy_verified(&from, &part, pin)?;
        set_mode(&part, &pin.to).map_err(io_err)?;
        clear_quarantine(&part);
        fs::rename(&part, &target).map_err(io_err)?;
    }
    Ok(())
}

/// Copies `from` to a NEW file `part`, hashing every byte written; removes
/// `part` and refuses when the bytes are not the pinned ones.
fn copy_verified(from: &Path, part: &Path, pin: &FilePin) -> Result<(), Prep> {
    let io_err = |e: io::Error| Prep::Io(e.to_string());
    let _ = fs::remove_file(part);
    let mut input = File::open(from).map_err(io_err)?;
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(part)
        .map_err(io_err)?;
    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    let mut buf = vec![0u8; 64 * 1024];
    let result = loop {
        let n = match input.read(&mut buf) {
            Ok(0) => break Ok(()),
            Ok(n) => n,
            Err(e) => break Err(io_err(e)),
        };
        size += n as u64;
        if size > pin.size {
            break Err(Prep::Tampered(format!("{} does not match its pin", pin.to)));
        }
        hasher.update(&buf[..n]);
        if let Err(e) = out.write_all(&buf[..n]) {
            break Err(io_err(e));
        }
    };
    drop(out);
    let result = result.and_then(|()| {
        if size == pin.size && hex(&hasher.finalize()) == pin.sha256 {
            Ok(())
        } else {
            Err(Prep::Tampered(format!("{} does not match its pin", pin.to)))
        }
    });
    if result.is_err() {
        let _ = fs::remove_file(part);
    }
    result
}

/// Removes a file, a link (never what it points at) or a folder.
fn remove_entry(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Executables and libraries 0755, the licence texts 0644.
#[cfg(unix)]
fn set_mode(path: &Path, name: &str) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if name.starts_with("LICENSE") {
        0o644
    } else {
        0o755
    };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _name: &str) -> io::Result<()> {
    Ok(())
}

/// Best effort, on a file that already matched its pin: a file this process
/// wrote normally carries no mark at all.
#[cfg(target_os = "macos")]
fn clear_quarantine(path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    if let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) {
        // SAFETY: both arguments are NUL-terminated C strings that outlive the call.
        unsafe {
            libc::removexattr(
                c.as_ptr(),
                c"com.apple.quarantine".as_ptr(),
                libc::XATTR_NOFOLLOW,
            );
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn clear_quarantine(_path: &Path) {}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
enum ProbeError {
    Spawn(String),
    TimedOut,
    /// Unix: killed by a signal (AMFI kills code it refuses with SIGKILL).
    Signal(i32),
    Exit(i32, String),
}

/// Runs `server args…` from its own folder with a cleared environment and
/// returns stdout followed by stderr.
fn probe(server: &Path, args: &[&str], timeout: Duration) -> Result<String, ProbeError> {
    let mut cmd = Command::new(server);
    cmd.args(args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = server.parent() {
        cmd.current_dir(dir);
    }
    for key in KEPT_ENV {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: the app is a GUI process; a console child would
        // flash a console window.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| ProbeError::Spawn(e.to_string()))?;
    let out = read_capped(child.stdout.take());
    let err = read_capped(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ProbeError::TimedOut);
            }
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ProbeError::Spawn(e.to_string()));
            }
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    if status.success() {
        let mut text = String::from_utf8_lossy(&stdout).into_owned();
        text.push('\n');
        text.push_str(&String::from_utf8_lossy(&stderr));
        return Ok(text);
    }
    if let Some(signal) = exit_signal(&status) {
        return Err(ProbeError::Signal(signal));
    }
    Err(ProbeError::Exit(
        status.code().unwrap_or(-1),
        excerpt_text(&stderr, TEXT_CHARS),
    ))
}

#[cfg(unix)]
fn exit_signal(status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn exit_signal(_status: &ExitStatus) -> Option<i32> {
    None
}

/// Reads a pipe on its own thread (so a full pipe can never stall the child),
/// keeping the first `PROBE_OUTPUT_CAP` bytes and draining the rest.
fn read_capped<R: Read + Send + 'static>(pipe: Option<R>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut kept = Vec::new();
        let Some(mut pipe) = pipe else { return kept };
        let mut buf = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut buf) {
            if n == 0 {
                break;
            }
            let room = PROBE_OUTPUT_CAP.saturating_sub(kept.len());
            kept.extend_from_slice(&buf[..n.min(room)]);
        }
        kept
    })
}

/// The `version: …` line of `--version`.
fn parse_version(text: &str) -> Option<String> {
    text.lines()
        .find_map(|l| l.trim().strip_prefix("version: "))
        .map(|v| excerpt_text(v.as_bytes(), TEXT_CHARS))
        .filter(|v| !v.is_empty())
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    name: String,
    total_mib: u64,
    free_mib: u64,
}

/// `--list-devices` prints `  <id>: <name> (<total> MiB, <free> MiB free)`
/// per device; anything else is skipped.
fn parse_devices(text: &str) -> Vec<Device> {
    let mut devices = Vec::new();
    for line in text.lines() {
        if devices.len() == MAX_DEVICES {
            break;
        }
        let Some(rest) = line.strip_prefix("  ") else {
            continue;
        };
        let Some((id, rest)) = rest.split_once(": ") else {
            continue;
        };
        let Some((name, sizes)) = rest.rsplit_once(" (") else {
            continue;
        };
        let Some(sizes) = sizes.strip_suffix(" MiB free)") else {
            continue;
        };
        let Some((total, free)) = sizes.split_once(" MiB, ") else {
            continue;
        };
        let (Ok(total_mib), Ok(free_mib)) = (total.parse(), free.parse()) else {
            continue;
        };
        let id = excerpt_text(id.as_bytes(), 32);
        let name = excerpt_text(name.as_bytes(), TEXT_CHARS);
        if id.is_empty() || id.contains(' ') {
            continue;
        }
        devices.push(Device {
            id,
            name,
            total_mib,
            free_mib,
        });
    }
    devices
}

// ---------------------------------------------------------------------------
// The computer
// ---------------------------------------------------------------------------

/// `13.2.1` → false, `13.3` → true against (13, 3).
fn version_at_least(version: &str, min: (u32, u32)) -> bool {
    let mut parts = version.trim().split('.').map(|p| p.parse::<u32>().ok());
    let major = parts.next().flatten();
    let minor = parts.next().flatten().unwrap_or(0);
    match major {
        Some(major) => (major, minor) >= min,
        None => true, // unreadable: let the probe decide
    }
}

#[cfg(target_os = "macos")]
fn sysctl_bytes(name: &std::ffi::CStr) -> Option<Vec<u8>> {
    let mut len: libc::size_t = 0;
    // SAFETY: a size query (null buffer); `len` is a valid out-pointer.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || len == 0 || len > 4096 {
        return None;
    }
    let mut buf = vec![0u8; len];
    // SAFETY: `buf` holds `len` writable bytes, and `len` says so.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    buf.truncate(len);
    Some(buf)
}

#[cfg(target_os = "macos")]
fn total_ram() -> Option<u64> {
    let bytes = sysctl_bytes(c"hw.memsize")?;
    Some(u64::from_ne_bytes(bytes.get(..8)?.try_into().ok()?))
}

#[cfg(target_os = "macos")]
fn os_version() -> Option<String> {
    let bytes = sysctl_bytes(c"kern.osproductversion")?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim_end_matches('\0').trim();
    (!text.is_empty()).then(|| excerpt_text(text.as_bytes(), 32))
}

#[cfg(target_os = "macos")]
fn free_disk(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: zeroed is a valid statvfs; the call fills it.
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is NUL-terminated and `st` is a valid out-pointer.
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some(st.f_bavail as u64 * st.f_frsize as u64)
}

#[cfg(windows)]
fn total_ram() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    // SAFETY: zeroed is a valid MEMORYSTATUSEX once dwLength is set.
    let mut st: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    st.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    // SAFETY: `st` is a valid, sized out-pointer.
    (unsafe { GlobalMemoryStatusEx(&mut st) } != 0).then_some(st.ullTotalPhys)
}

#[cfg(windows)]
fn os_version() -> Option<String> {
    None
}

#[cfg(windows)]
fn free_disk(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free: u64 = 0;
    // SAFETY: `wide` is NUL-terminated; the two unused outputs may be null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(free)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn total_ram() -> Option<u64> {
    None
}

#[cfg(not(any(target_os = "macos", windows)))]
fn os_version() -> Option<String> {
    None
}

#[cfg(not(any(target_os = "macos", windows)))]
fn free_disk(_path: &Path) -> Option<u64> {
    None
}

/// Free space on the volume `path` will live on (its nearest existing folder).
fn free_disk_near(path: &Path) -> Option<u64> {
    path.ancestors().find(|p| p.exists()).and_then(free_disk)
}

// ---------------------------------------------------------------------------
// The survey
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Survey {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    engine: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    devices: Vec<Device>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ram_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disk_free_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    os_version: Option<String>,
    /// The server this survey verified and ran — for the commands that start
    /// it later. Never serialized: the webview has no use for a path.
    #[serde(skip)]
    server: Option<PathBuf>,
}

impl Survey {
    fn end(mut self, state: &'static str, detail: Option<String>) -> Self {
        debug_assert!(SURVEY_STATES.contains(&state), "{state}");
        self.state = state;
        self.detail = detail.map(|d| excerpt_text(d.as_bytes(), TEXT_CHARS));
        self
    }
}

fn probe_state(e: ProbeError) -> (&'static str, String) {
    match e {
        ProbeError::TimedOut => (
            "blocked",
            format!("no answer in {} s", PROBE_TIMEOUT.as_secs()),
        ),
        ProbeError::Signal(9) => ("blocked", "stopped by the system (signal 9)".into()),
        ProbeError::Signal(n) => ("failed", format!("stopped by signal {n}")),
        ProbeError::Exit(code, _) if RUNTIME_MISSING_CODES.contains(&code) => {
            ("runtime-missing", format!("exit code {:#x}", code as u32))
        }
        ProbeError::Exit(code, stderr) => ("failed", format!("exit code {code}: {stderr}")),
        ProbeError::Spawn(e) => ("failed", format!("could not start: {e}")),
    }
}

/// The whole survey. `resource_root` is `resource_dir()`, `data_root` is
/// `app_data_dir()`; either may be unknown.
fn survey(host: Host, resource_root: Option<PathBuf>, data_root: Option<PathBuf>) -> Survey {
    let tag = manifest().map(|m| m.tag.clone()).unwrap_or_default();
    let s = Survey {
        state: "failed",
        detail: None,
        engine: tag.clone(),
        version: None,
        devices: Vec::new(),
        ram_bytes: total_ram(),
        disk_free_bytes: data_root.as_deref().and_then(free_disk_near),
        os_version: os_version(),
        server: None,
    };
    let key = match host {
        Host::Engine(key) => key,
        Host::IntelMac => return s.end("intel-mac", None),
        Host::Unsupported => return s.end("unsupported", None),
    };
    if cfg!(target_os = "macos") {
        if let Some(v) = s.os_version.clone() {
            if !version_at_least(&v, MIN_MACOS) {
                return s.end("old-mac", Some(format!("macOS {v}")));
            }
        }
    }
    let pins = match manifest() {
        Ok(m) => match m.platforms.get(key) {
            Some(p) => p,
            None => return s.end("unsupported", Some(format!("no pins for {key}"))),
        },
        Err(e) => return s.end("failed", Some(e)),
    };
    let Some(resources) = resource_root else {
        return s.end("missing", Some("no resource folder".into()));
    };
    let src = resources.join(RESOURCE_DIR).join(&tag);
    let prepared = if COPY_OUT {
        match data_root {
            Some(data) => {
                let dst = data.join(INSTALL_DIR).join(&tag);
                install_copy(&src, &dst, pins).map(|()| dst)
            }
            None => Err(Prep::Io("no app data folder".into())),
        }
    } else {
        verify_in_place(&src, pins).map(|()| src)
    };
    let dir = match prepared {
        Ok(dir) => dir,
        Err(Prep::Missing(d)) => return s.end("missing", Some(d)),
        Err(Prep::Tampered(d)) => return s.end("tampered", Some(d)),
        Err(Prep::Io(d)) => return s.end("failed", Some(d)),
    };
    let server = dir.join(&pins.server);
    let version = match probe(&server, &["--version"], PROBE_TIMEOUT) {
        Ok(text) => parse_version(&text),
        Err(e) => {
            let (state, detail) = probe_state(e);
            return s.end(state, Some(detail));
        }
    };
    let devices = match probe(&server, &["--list-devices"], PROBE_TIMEOUT) {
        Ok(text) => parse_devices(&text),
        Err(e) => {
            let (state, detail) = probe_state(e);
            return s.end(state, Some(detail));
        }
    };
    Survey {
        version,
        devices,
        server: Some(server),
        ..s
    }
    .end("ok", None)
}

/// One survey at a time (a second gets `E_BUSY`): two would copy into the
/// same folder. `runner` is everything that happens after a survey passed:
/// the model's download and the engine process (below).
#[derive(Default)]
pub struct EngineState {
    survey: Arc<Mutex<()>>,
    runner: Arc<Runner>,
}

impl EngineState {
    pub(crate) fn runner(&self) -> Arc<Runner> {
        Arc::clone(&self.runner)
    }

    /// The app is exiting: stop every engine process (main.rs `RunEvent::Exit`).
    pub fn shutdown(&self) {
        self.runner.shutdown();
    }
}

/// Survey this computer for the bundled engine. Resolves with RAW JSON bytes
/// (`Survey`), or rejects with `E_FORBIDDEN` / `E_BUSY`.
#[tauri::command]
pub async fn llm_engine_survey(
    webview: tauri::Webview,
    state: tauri::State<'_, EngineState>,
) -> Result<Response, String> {
    if webview.label() != MAIN_WEBVIEW {
        return Err(FORBIDDEN.to_string());
    }
    let app = webview.app_handle().clone();
    let resource_root = app.path().resource_dir().ok();
    let data_root = app.path().app_data_dir().ok();
    let slot = Arc::clone(&state.survey);
    let runner = state.runner();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let Ok(_held) = slot.try_lock() else {
            return Err("E_BUSY".to_string());
        };
        let result = survey(HOST, resource_root, data_root);
        // Only a server a survey verified and ran is ever started later.
        runner.set_server(result.server.clone());
        serde_json::to_vec(&result).map_err(|e| format!("E_BAD_RESPONSE {e}"))
    })
    .await
    .unwrap_or_else(|e| Err(format!("E_BAD_RESPONSE survey task failed: {e}")))?;
    Ok(Response::new(InvokeResponseBody::Raw(bytes)))
}

// ---------------------------------------------------------------------------
// The model and the running engine
// ---------------------------------------------------------------------------
//
// One pinned model file (`ModelPin`), and at most ONE engine process at a time:
//
// - **Download.** The engine's own downloader fetches the file (it has the
//   TLS; the app has no HTTP-over-TLS crate): `llama-server` in ROUTER mode,
//   `LLAMA_CACHE` = a staging folder, `--no-models-autoload` so nothing is
//   loaded, and ONE request, `POST /models`, whose body Rust builds from the
//   pin. The app then only WATCHES the staging folder: the downloader names
//   its file by the SHA-256 the repository claims, so a name other than the
//   pinned hash means the file changed upstream, before a byte of it is kept.
//   Measured on b12359 (2026-11-20): the partial file is
//   `<sha256>.downloadInProgress`, killing the router keeps it, and posting
//   again resumes from it.
// - **Check.** llama.cpp never hashes what it downloads. The router is
//   stopped, the app hashes the file itself, and only a match is renamed into
//   `models/` with a marker (size, modified time, hash) that spares the next
//   start a 3 GB re-hash.
// - **Serve.** `llama-server -m <that file> --offline`: single-model mode, no
//   router (a router's per-model workers answer WITHOUT the key), no network.
//   Loopback, a free port, a key made per start — both known to Rust only —
//   no web UI, no CORS, a pinned context. It starts on the first chat, stops
//   after `IDLE_STOP` without one, and stops with the app.
//
// Every process is spawned like `probe`: its own folder, a cleared
// environment, no stdin. On macOS it leads its own process group, which is
// what gets killed (the downloader is a child of the router); on Windows it
// lives in its own Job Object, ended on a stop and closed by the system with
// the app, crash included.
// macOS has no such object, so the pids are also written to a file and a
// later launch kills what a crash left — only a process that is still OUR
// server binary.

/// Under `app_local_data_dir()`: never a roaming or synced folder.
const LLM_DIR: &str = "llm";
const STAGING_DIR: &str = "staging";
const MODELS_DIR: &str = "models";
const PID_FILE: &str = "engine.pid";
/// The downloader's name for a file it has not finished (measured, b12359).
const PARTIAL_SUFFIX: &str = ".downloadInProgress";
const MARKER_SUFFIX: &str = ".ok";
/// Free space a download must leave on the disk.
const DISK_MARGIN: u64 = 2 * 1024 * 1024 * 1024;
/// The served context: holds the medium prompt, its output and a repair round
/// (`LOCAL_MIN_CONTEXT` is 12,288), and stops `--fit` taking all GPU memory.
const SERVED_CONTEXT: &str = "16384";
/// The name the served model answers to (`src/llm/engineModel.ts`).
const SERVED_ALIAS: &str = "fastshaders";
const ROUTER_START_WAIT: Duration = Duration::from_secs(20);
/// A cold load reads 3 GB from the disk.
const LOAD_WAIT: Duration = Duration::from_secs(180);
/// No partial file this long after the request: no connection.
const FIRST_BYTE_WAIT: Duration = Duration::from_secs(45);
/// No growth this long: the connection is gone.
const STALL_WAIT: Duration = Duration::from_secs(60);
const DOWNLOAD_POLL: Duration = Duration::from_millis(400);
const HEALTH_POLL: Duration = Duration::from_millis(200);
/// The engine stops after this long without a chat ("wakes on Generate").
const IDLE_STOP: Duration = Duration::from_secs(600);
const IDLE_POLL: Duration = Duration::from_secs(30);
/// Starts that failed, or runs that died, within the window before the app
/// stops trying by itself.
const MAX_FAILED_STARTS: usize = 3;
const FAILED_START_WINDOW: Duration = Duration::from_secs(600);
const STDERR_TAIL: usize = 4096;
const MAX_MARKER_BYTES: u64 = 1024;
const MAX_PID_FILE_BYTES: u64 = 256;

/// The model states, as `src/utils/desktopIpc.ts` lists them
/// (desktopIpcContract.test.ts pins the pair).
pub const MODEL_STATES: [&str; 8] = [
    "none",
    "partial",
    "downloading",
    "offline",
    "checking",
    "bad-hash",
    "low-disk",
    "ready",
];
/// The engine process's states, the same way.
pub const SERVER_STATES: [&str; 4] = ["stopped", "starting", "ready", "failed"];

struct Paths {
    root: PathBuf,
}

impl Paths {
    fn staging(&self) -> PathBuf {
        self.root.join(STAGING_DIR)
    }
    fn models(&self) -> PathBuf {
        self.root.join(MODELS_DIR)
    }
    fn model_file(&self, pin: &ModelPin) -> PathBuf {
        self.models().join(&pin.file)
    }
    fn marker(&self, pin: &ModelPin) -> PathBuf {
        self.models().join(format!("{}{MARKER_SUFFIX}", pin.file))
    }
    /// Where the downloader keeps this repository's files (the Hugging Face
    /// cache layout, measured on b12359).
    fn blobs(&self, pin: &ModelPin) -> PathBuf {
        self.staging()
            .join(format!("models--{}", pin.repo.replace('/', "--")))
            .join("blobs")
    }
    fn pid_file(&self) -> PathBuf {
        self.root.join(PID_FILE)
    }
}

/// What the downloader has put in the repository's blob folder.
#[derive(Debug, PartialEq, Eq)]
enum Blobs {
    Nothing,
    Partial(u64),
    /// The whole file, under its pinned name and size.
    Complete,
    /// A name or size the pin does not allow: the file changed upstream.
    Foreign(String),
}

fn scan_blobs(dir: &Path, pin: &ModelPin) -> Blobs {
    let Ok(entries) = fs::read_dir(dir) else {
        return Blobs::Nothing;
    };
    let partial_name = format!("{}{PARTIAL_SUFFIX}", pin.sha256);
    let mut found = Blobs::Nothing;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // A link is never followed, and never counts as the file.
        let len = match fs::symlink_metadata(entry.path()) {
            Ok(meta) if meta.is_file() => meta.len(),
            _ => return Blobs::Foreign(name),
        };
        if name == pin.sha256 && len == pin.size {
            found = Blobs::Complete;
        } else if name == partial_name && len <= pin.size {
            if found != Blobs::Complete {
                found = Blobs::Partial(len);
            }
        } else {
            return Blobs::Foreign(name);
        }
    }
    found
}

fn modified_secs(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

#[derive(Serialize, Deserialize)]
struct Marker {
    sha256: String,
    size: u64,
    modified: u64,
}

/// Is the model file in place, a regular file, and the one the app checked
/// (same size and modified time as when it was hashed)?
fn model_ready(paths: &Paths, pin: &ModelPin) -> bool {
    let Ok(meta) = fs::symlink_metadata(paths.model_file(pin)) else {
        return false;
    };
    if !meta.is_file() || meta.len() != pin.size {
        return false;
    }
    let marker = paths.marker(pin);
    match fs::symlink_metadata(&marker) {
        Ok(m) if m.is_file() && m.len() <= MAX_MARKER_BYTES => {}
        _ => return false,
    }
    let Ok(text) = fs::read(&marker) else {
        return false;
    };
    match serde_json::from_slice::<Marker>(&text) {
        Ok(m) => m.sha256 == pin.sha256 && m.size == pin.size && m.modified == modified_secs(&meta),
        Err(_) => false,
    }
}

fn as_file_pin(pin: &ModelPin) -> FilePin {
    FilePin {
        to: pin.file.clone(),
        sha256: pin.sha256.clone(),
        size: pin.size,
    }
}

/// Hash `from` against the pin; a match is renamed into `models/` and marked.
/// Anything else is deleted. `Err` says why, for the detail line.
fn check_and_place(paths: &Paths, pin: &ModelPin, from: &Path) -> Result<(), String> {
    match matches_pin(from, &as_file_pin(pin)) {
        Ok(true) => {}
        Ok(false) => {
            let _ = fs::remove_file(from);
            return Err("the file's hash is not the pinned one".into());
        }
        Err(e) => return Err(format!("could not read the download: {e}")),
    }
    let target = paths.model_file(pin);
    fs::create_dir_all(paths.models()).map_err(|e| e.to_string())?;
    let _ = remove_entry(&target);
    fs::rename(from, &target).map_err(|e| e.to_string())?;
    let meta = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    let marker = Marker {
        sha256: pin.sha256.clone(),
        size: pin.size,
        modified: modified_secs(&meta),
    };
    let text = serde_json::to_vec(&marker).map_err(|e| e.to_string())?;
    fs::write(paths.marker(pin), text).map_err(|e| e.to_string())
}

/// The body of the ONE request the router gets: the pinned repository, no
/// sidecar files. Built here, so the webview never names a repository.
fn download_body(pin: &ModelPin) -> Vec<u8> {
    serde_json::json!({
        "model": format!("{}:{}", pin.repo, pin.quant),
        "sidecars": [],
    })
    .to_string()
    .into_bytes()
}

/// A key for one engine start: 256 bits drawn through std's `RandomState`,
/// whose keys the OS seeds. It only has to be unguessable to another page or
/// program on this computer for as long as the process lives.
fn random_key() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let mut key = String::with_capacity(64);
    for round in 0..4u64 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(round);
        hasher.write_u128(nanos);
        hasher.write_u32(std::process::id());
        key.push_str(&format!("{:016x}", hasher.finish()));
    }
    key
}

/// A port nothing listens on right now: bound, read, released.
fn free_port() -> io::Result<u16> {
    Ok(TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?
        .local_addr()?
        .port())
}

// ---------------------------------------------------------------------------
// One engine process
// ---------------------------------------------------------------------------

struct Proc {
    child: Child,
    tail: Arc<Mutex<Vec<u8>>>,
    done: bool,
    /// Windows: the Job Object this process and its children live in.
    job: Option<Job>,
}

impl Proc {
    /// `server args…`, in its own folder, with nothing in its environment but
    /// `KEPT_ENV` and `envs`.
    fn spawn(server: &Path, args: &[OsString], envs: &[(&str, OsString)]) -> io::Result<Proc> {
        let mut cmd = Command::new(server);
        cmd.args(args)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(dir) = server.parent() {
            cmd.current_dir(dir);
        }
        for key in KEPT_ENV {
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
        for (key, value) in envs {
            cmd.env(key, value);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // Its own process group: the router's downloader is its child, and
            // the group is what `kill` ends.
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn()?;
        let job = Job::holding(&child);
        let tail = Arc::new(Mutex::new(Vec::new()));
        if let Some(mut pipe) = child.stderr.take() {
            let kept = Arc::clone(&tail);
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = pipe.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let mut kept = kept.lock().unwrap_or_else(PoisonError::into_inner);
                    kept.extend_from_slice(&buf[..n]);
                    let extra = kept.len().saturating_sub(STDERR_TAIL);
                    kept.drain(..extra);
                }
            });
        }
        Ok(Proc {
            child,
            tail,
            done: false,
            job,
        })
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn alive(&mut self) -> bool {
        if self.done {
            return false;
        }
        if matches!(self.child.try_wait(), Ok(None)) {
            return true;
        }
        // It ended by itself and is reaped: end what it left behind (the
        // router's downloader) NOW, and never signal this pid again — a pid
        // that has been reaped can be handed to another program.
        self.done = true;
        self.end_group();
        false
    }

    fn end_group(&self) {
        if let Some(job) = &self.job {
            job.end();
        }
        kill_group(self.pid());
    }

    /// The end of what it wrote to stderr, as one cleaned line.
    fn last_words(&self) -> String {
        let tail = self.tail.lock().unwrap_or_else(PoisonError::into_inner);
        let text = String::from_utf8_lossy(&tail);
        let line = text
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("");
        excerpt_text(line.as_bytes(), TEXT_CHARS)
    }

    fn kill(&mut self) {
        if self.done {
            return;
        }
        self.done = true;
        self.end_group();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        self.kill();
    }
}

/// End the process group `pid` leads (macOS). On Windows the process's Job
/// Object does it (`Job::end`); elsewhere the caller's own `Child::kill`.
#[cfg(target_os = "macos")]
fn kill_group(pid: u32) {
    if let Ok(pgid) = i32::try_from(pid) {
        if pgid > 1 {
            // SAFETY: plain syscall; a group that is already gone is ESRCH.
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn kill_group(_pid: u32) {}

/// Windows: ONE Job Object per engine process, flagged kill-on-close. The
/// process's own children (the router's downloader) are born inside it, so
/// `end` stops the whole tree, and the system closes the handle — ending the
/// tree — when the app goes, however it goes.
#[cfg(windows)]
struct Job(usize);

#[cfg(windows)]
impl Job {
    fn holding(child: &Child) -> Option<Job> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY: plain Win32 calls on a handle this function owns until it
        // returns it; `info` is a zeroed plain-data struct of the size passed.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
                CloseHandle(job);
                return None;
            }
            Some(Job(job as usize))
        }
    }

    fn end(&self) {
        // SAFETY: the handle is live until this value drops.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0 as _, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: closing the handle this value owns, once.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

#[cfg(not(windows))]
struct Job;

#[cfg(not(windows))]
impl Job {
    fn holding(_child: &Child) -> Option<Job> {
        None
    }
    fn end(&self) {}
}

/// The executable a live process runs, or None (gone, or not ours to read).
#[cfg(target_os = "macos")]
fn process_path(pid: u32) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let pid = i32::try_from(pid).ok()?;
    let mut buf = vec![0u8; 4096];
    // SAFETY: the buffer is writable for the length passed.
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    Some(PathBuf::from(OsString::from_vec(buf)))
}

#[cfg(not(target_os = "macos"))]
fn process_path(_pid: u32) -> Option<PathBuf> {
    None
}

/// Kill what a crashed launch left running: every pid in the file that is
/// still THIS server binary (a reused pid is some other program, left alone).
fn kill_strays(pid_file: &Path, server: &Path) {
    let small =
        fs::symlink_metadata(pid_file).is_ok_and(|m| m.is_file() && m.len() <= MAX_PID_FILE_BYTES);
    if small {
        let ours = fs::canonicalize(server).ok();
        for pid in fs::read_to_string(pid_file)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.trim().parse::<u32>().ok())
        {
            let running = process_path(pid).and_then(|p| fs::canonicalize(p).ok());
            if running.is_some() && running == ours {
                kill_group(pid);
            }
        }
    }
    let _ = fs::remove_file(pid_file);
}

fn write_pids(pid_file: &Path, pids: &[u32]) {
    if pids.is_empty() {
        let _ = fs::remove_file(pid_file);
        return;
    }
    let text: String = pids.iter().map(|p| format!("{p}\n")).collect();
    let _ = fs::write(pid_file, text);
}

#[derive(Debug, PartialEq, Eq)]
enum Wait {
    Cancelled,
    Exited(String),
    TimedOut,
}

/// Poll `GET /health` until the engine answers 200 (a model server answers
/// 503 while it loads).
fn wait_healthy(
    proc: &mut Proc,
    port: u16,
    key: &str,
    limit: Duration,
    cancel: &AtomicBool,
) -> Result<(), Wait> {
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(Wait::Cancelled);
        }
        if !proc.alive() {
            return Err(Wait::Exited(proc.last_words()));
        }
        if engine_call(port, key, None, "/health", cancel).is_ok() {
            return Ok(());
        }
        if started.elapsed() >= limit {
            return Err(Wait::TimedOut);
        }
        thread::sleep(HEALTH_POLL);
    }
}

fn os(text: &str) -> OsString {
    OsString::from(text)
}

fn router_args(port: u16) -> Vec<OsString> {
    [
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
        "--no-webui",
        "--no-slots",
        "--no-models-autoload",
        "--models-max",
        "1",
        "--cors-origins",
        "localhost",
    ]
    .iter()
    .map(|a| os(a))
    .collect()
}

fn serve_args(port: u16, model: &Path) -> Vec<OsString> {
    let mut args = vec![os("-m"), model.as_os_str().to_os_string()];
    args.extend(
        [
            "--offline",
            "--no-mmproj",
            "--alias",
            SERVED_ALIAS,
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--no-webui",
            "--no-slots",
            "--cors-origins",
            "localhost",
            "-c",
            SERVED_CONTEXT,
            "-np",
            "1",
        ]
        .iter()
        .map(|a| os(a)),
    );
    args
}

fn engine_env(paths: &Paths, key: &str) -> Vec<(&'static str, OsString)> {
    vec![
        ("LLAMA_CACHE", paths.staging().into_os_string()),
        ("LLAMA_API_KEY", os(key)),
    ]
}

// ---------------------------------------------------------------------------
// The download
// ---------------------------------------------------------------------------

/// How a download run ended.
#[derive(Debug, PartialEq, Eq)]
enum DownloadEnd {
    /// The file is in `models/`, checked.
    Ready,
    /// Stopped on request (pause, cancel, the app exiting).
    Stopped,
    /// No connection, or the engine failed: whatever arrived is kept.
    Offline(String),
    /// The file is not the pinned one: nothing of it is kept.
    BadHash(String),
}

/// Run one download to its end. `on_pid` hears the router's pid when it
/// starts and `None` when it is gone; `on_progress` hears the bytes on disk,
/// and `u64::MAX` once, when the hash check starts.
fn run_download(
    server: &Path,
    paths: &Paths,
    pin: &ModelPin,
    stop: &AtomicBool,
    on_pid: &dyn Fn(Option<u32>),
    on_progress: &dyn Fn(u64),
) -> DownloadEnd {
    let blobs = paths.blobs(pin);
    // A file that finished before a crash: check it, no network.
    if scan_blobs(&blobs, pin) != Blobs::Complete {
        if let Err(e) = fs::create_dir_all(paths.staging()) {
            return DownloadEnd::Offline(format!("could not create the download folder: {e}"));
        }
        let port = match free_port() {
            Ok(p) => p,
            Err(e) => return DownloadEnd::Offline(format!("no free port: {e}")),
        };
        let key = random_key();
        let mut router = match Proc::spawn(server, &router_args(port), &engine_env(paths, &key)) {
            Ok(p) => p,
            Err(e) => return DownloadEnd::Offline(format!("could not start: {e}")),
        };
        on_pid(Some(router.pid()));
        let end = drive_router(&mut router, port, &key, &blobs, pin, stop, on_progress);
        router.kill();
        on_pid(None);
        if let Some(end) = end {
            if matches!(end, DownloadEnd::BadHash(_)) {
                let _ = fs::remove_dir_all(paths.staging());
            }
            return end;
        }
    }
    on_progress(u64::MAX);
    let checked = check_and_place(paths, pin, &blobs.join(&pin.sha256));
    let _ = fs::remove_dir_all(paths.staging());
    match checked {
        Ok(()) => DownloadEnd::Ready,
        Err(why) => DownloadEnd::BadHash(why),
    }
}

/// Ask the running router for the file and watch the folder until it is
/// whole (`None`) or the run ends some other way.
fn drive_router(
    router: &mut Proc,
    port: u16,
    key: &str,
    blobs: &Path,
    pin: &ModelPin,
    stop: &AtomicBool,
    on_progress: &dyn Fn(u64),
) -> Option<DownloadEnd> {
    match wait_healthy(router, port, key, ROUTER_START_WAIT, stop) {
        Ok(()) => {}
        Err(Wait::Cancelled) => return Some(DownloadEnd::Stopped),
        Err(Wait::Exited(why)) => {
            return Some(DownloadEnd::Offline(format!("the engine stopped: {why}")))
        }
        Err(Wait::TimedOut) => {
            return Some(DownloadEnd::Offline("the engine did not start".into()))
        }
    }
    if let Err(status) = engine_call(port, key, Some(("/models", &download_body(pin))), "", stop) {
        if stop.load(Ordering::SeqCst) {
            return Some(DownloadEnd::Stopped);
        }
        return Some(DownloadEnd::Offline(status));
    }
    let mut last = (0u64, Instant::now());
    let mut seen_file = false;
    loop {
        if stop.load(Ordering::SeqCst) {
            return Some(DownloadEnd::Stopped);
        }
        match scan_blobs(blobs, pin) {
            Blobs::Complete => return None,
            Blobs::Foreign(name) => {
                return Some(DownloadEnd::BadHash(format!(
                    "the model changed upstream ({})",
                    excerpt_text(name.as_bytes(), 80)
                )))
            }
            Blobs::Partial(done) => {
                seen_file = true;
                on_progress(done);
                if done != last.0 {
                    last = (done, Instant::now());
                }
            }
            Blobs::Nothing => {}
        }
        if !router.alive() {
            return Some(DownloadEnd::Offline(format!(
                "the engine stopped: {}",
                router.last_words()
            )));
        }
        let limit = if seen_file {
            STALL_WAIT
        } else {
            FIRST_BYTE_WAIT
        };
        if last.1.elapsed() >= limit {
            return Some(DownloadEnd::Offline(format!(
                "no data for {} s",
                limit.as_secs()
            )));
        }
        thread::sleep(DOWNLOAD_POLL);
    }
}

// ---------------------------------------------------------------------------
// The runner: the one download and the one served engine
// ---------------------------------------------------------------------------

/// What the worker says about the model; `Idle` means "ask the disk".
#[derive(Debug, Clone, PartialEq, Eq, Default)]
enum ModelWork {
    #[default]
    Idle,
    Downloading(u64),
    Checking,
    Offline(String),
    BadHash(String),
    LowDisk {
        need: u64,
        free: u64,
    },
}

#[derive(Default)]
enum Serve {
    #[default]
    Stopped,
    Starting,
    Ready {
        proc: Proc,
        port: u16,
        key: String,
    },
    Failed(String),
}

#[derive(Default)]
struct Inner {
    /// The server a survey verified and ran this launch.
    server: Option<PathBuf>,
    /// `app_local_data_dir()/llm`.
    root: Option<PathBuf>,
    work: ModelWork,
    /// Set while a download worker runs; storing `true` stops it.
    stop_download: Option<Arc<AtomicBool>>,
    /// A stopping worker also deletes what it downloaded (Cancel).
    drop_partial: bool,
    serve: Serve,
    in_use: bool,
    last_use: Option<Instant>,
    idle_watch: bool,
    failed_starts: VecDeque<Instant>,
    /// Every engine process alive right now, for the exit and the pid file.
    pids: Vec<u32>,
    strays_killed: bool,
}

#[derive(Default)]
pub(crate) struct Runner {
    inner: Mutex<Inner>,
}

/// Why the engine is not ready for a chat.
pub(crate) enum StartError {
    Cancelled,
    Failed(String),
}

/// A chat in flight: the engine's port and key, and the mark that keeps the
/// idle timer off it. Dropping it starts the idle clock.
pub(crate) struct Session {
    runner: Arc<Runner>,
    port: u16,
    key: String,
}

impl Session {
    pub(crate) fn port(&self) -> u16 {
        self.port
    }
    pub(crate) fn key(&self) -> &str {
        &self.key
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let mut inner = self.runner.lock();
        inner.in_use = false;
        inner.last_use = Some(Instant::now());
    }
}

impl Inner {
    fn paths(&self) -> Option<Paths> {
        self.root.clone().map(|root| Paths { root })
    }

    fn track(&mut self, pid: u32, alive: bool) {
        self.pids.retain(|p| *p != pid);
        if alive {
            self.pids.push(pid);
        }
        if let Some(paths) = self.paths() {
            write_pids(&paths.pid_file(), &self.pids);
        }
    }

    fn stop_serve(&mut self) {
        if let Serve::Ready { mut proc, .. } = std::mem::take(&mut self.serve) {
            let pid = proc.pid();
            proc.kill();
            self.track(pid, false);
        }
        self.in_use = false;
    }

    fn recent_failures(&mut self) -> usize {
        while self
            .failed_starts
            .front()
            .is_some_and(|t| t.elapsed() >= FAILED_START_WINDOW)
        {
            self.failed_starts.pop_front();
        }
        self.failed_starts.len()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelStatus {
    key: String,
    label: String,
    size_bytes: u64,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    done_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    need_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatus {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    model: ModelStatus,
    server: ServerStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    disk_free_bytes: Option<u64>,
}

fn clean(detail: &str) -> Option<String> {
    Some(excerpt_text(detail.as_bytes(), TEXT_CHARS))
}

impl Runner {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Plain data and process handles; a panic elsewhere leaves nothing torn.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set_server(&self, server: Option<PathBuf>) {
        let mut inner = self.lock();
        inner.server = server;
        Self::kill_strays_once(&mut inner);
    }

    fn set_root(&self, local_data: Option<PathBuf>) {
        let mut inner = self.lock();
        if inner.root.is_none() {
            inner.root = local_data.map(|d| d.join(LLM_DIR));
        }
        Self::kill_strays_once(&mut inner);
    }

    /// Once per launch, as soon as both the folder and the server are known.
    fn kill_strays_once(inner: &mut Inner) {
        if inner.strays_killed {
            return;
        }
        if let (Some(paths), Some(server)) = (inner.paths(), inner.server.clone()) {
            inner.strays_killed = true;
            if inner.pids.is_empty() {
                kill_strays(&paths.pid_file(), &server);
            }
        }
    }

    fn status(&self) -> Result<Vec<u8>, String> {
        let pin = default_model().ok_or("E_NOT_READY no model is pinned")?;
        let mut inner = self.lock();
        // A served engine that died is noticed here, not only on the next chat.
        let died = match &mut inner.serve {
            Serve::Ready { proc, .. } => {
                if proc.alive() {
                    None
                } else {
                    Some((proc.pid(), proc.last_words()))
                }
            }
            _ => None,
        };
        if let Some((pid, why)) = died {
            inner.serve = Serve::Failed(format!("the engine stopped: {why}"));
            inner.failed_starts.push_back(Instant::now());
            inner.track(pid, false);
        }
        let paths = inner.paths();
        let (state, done, need, detail) = match &inner.work {
            ModelWork::Downloading(done) => ("downloading", Some(*done), None, None),
            ModelWork::Checking => ("checking", None, None, None),
            ModelWork::Offline(why) => (
                "offline",
                paths
                    .as_ref()
                    .and_then(|p| match scan_blobs(&p.blobs(pin), pin) {
                        Blobs::Partial(n) => Some(n),
                        _ => None,
                    }),
                None,
                clean(why),
            ),
            ModelWork::BadHash(why) => ("bad-hash", None, None, clean(why)),
            ModelWork::LowDisk { need, .. } => ("low-disk", None, Some(*need), None),
            ModelWork::Idle => match &paths {
                Some(p) if model_ready(p, pin) => ("ready", None, None, None),
                Some(p) => match scan_blobs(&p.blobs(pin), pin) {
                    Blobs::Partial(n) => ("partial", Some(n), None, None),
                    Blobs::Complete => ("partial", Some(pin.size), None, None),
                    _ => ("none", None, None, None),
                },
                None => ("none", None, None, None),
            },
        };
        let (server_state, server_detail) = match &inner.serve {
            Serve::Stopped => ("stopped", None),
            Serve::Starting => ("starting", None),
            Serve::Ready { .. } => ("ready", None),
            Serve::Failed(why) => ("failed", clean(why)),
        };
        debug_assert!(MODEL_STATES.contains(&state) && SERVER_STATES.contains(&server_state));
        let status = Status {
            model: ModelStatus {
                key: pin.key.clone(),
                label: pin.label.clone(),
                size_bytes: pin.size,
                state,
                done_bytes: done,
                need_bytes: need,
                detail,
            },
            server: ServerStatus {
                state: server_state,
                detail: server_detail,
            },
            disk_free_bytes: paths.as_ref().and_then(|p| free_disk_near(&p.root)),
        };
        serde_json::to_vec(&status).map_err(|e| format!("E_BAD_RESPONSE {e}"))
    }

    /// Start (or resume) the download on a worker thread.
    fn start_download(self: &Arc<Self>) -> Result<(), String> {
        let pin = default_model().ok_or("E_NOT_READY no model is pinned")?;
        let mut inner = self.lock();
        if inner.stop_download.is_some() {
            return Ok(()); // already running
        }
        let server = inner.server.clone().ok_or("E_NOT_READY survey first")?;
        let paths = inner.paths().ok_or("E_NOT_READY no data folder")?;
        if model_ready(&paths, pin) {
            inner.work = ModelWork::Idle;
            return Ok(());
        }
        let have = match scan_blobs(&paths.blobs(pin), pin) {
            Blobs::Partial(n) => n,
            Blobs::Complete => pin.size,
            _ => 0,
        };
        if let Some(free) = free_disk_near(&paths.root) {
            let need = (pin.size - have).saturating_add(DISK_MARGIN);
            if free < need {
                inner.work = ModelWork::LowDisk { need, free };
                return Ok(());
            }
        }
        inner.stop_serve();
        let stop = Arc::new(AtomicBool::new(false));
        inner.stop_download = Some(Arc::clone(&stop));
        inner.drop_partial = false;
        inner.work = ModelWork::Downloading(have);
        drop(inner);
        let runner = Arc::clone(self);
        thread::spawn(move || {
            let end = run_download(
                &server,
                &paths,
                pin,
                &stop,
                &|pid| {
                    let mut inner = runner.lock();
                    match pid {
                        Some(pid) => inner.track(pid, true),
                        None => {
                            let pids = std::mem::take(&mut inner.pids);
                            inner.pids = pids
                                .into_iter()
                                .filter(|p| matches!(&inner.serve, Serve::Ready { proc, .. } if proc.pid() == *p))
                                .collect();
                            write_pids(&paths.pid_file(), &inner.pids);
                        }
                    }
                },
                &|done| {
                    let mut inner = runner.lock();
                    inner.work = if done == u64::MAX {
                        ModelWork::Checking
                    } else {
                        ModelWork::Downloading(done)
                    };
                },
            );
            let mut inner = runner.lock();
            inner.stop_download = None;
            if end == DownloadEnd::Stopped && inner.drop_partial {
                let _ = fs::remove_dir_all(paths.staging());
            }
            inner.drop_partial = false;
            inner.work = match end {
                DownloadEnd::Ready | DownloadEnd::Stopped => ModelWork::Idle,
                DownloadEnd::Offline(why) => ModelWork::Offline(why),
                DownloadEnd::BadHash(why) => ModelWork::BadHash(why),
            };
        });
        Ok(())
    }

    /// Stop the download worker and wait for it to let go of the router.
    fn stop_download(&self, drop_partial: bool) {
        let stop = {
            let mut inner = self.lock();
            inner.drop_partial = drop_partial;
            if inner.stop_download.is_none() {
                // Nothing running: a Cancel still clears what is on the disk.
                if drop_partial {
                    if let Some(paths) = inner.paths() {
                        let _ = fs::remove_dir_all(paths.staging());
                    }
                }
                inner.work = ModelWork::Idle;
                return;
            }
            inner.stop_download.clone()
        };
        if let Some(stop) = stop {
            stop.store(true, Ordering::SeqCst);
        }
        let give_up = Instant::now() + Duration::from_secs(5);
        while self.lock().stop_download.is_some() && Instant::now() < give_up {
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// Delete the model: the checked file, its marker and any download.
    fn delete_model(&self) {
        self.stop_download(true);
        let mut inner = self.lock();
        inner.stop_serve();
        inner.serve = Serve::Stopped;
        inner.work = ModelWork::Idle;
        if let (Some(paths), Some(pin)) = (inner.paths(), default_model()) {
            let _ = fs::remove_file(paths.model_file(pin));
            let _ = fs::remove_file(paths.marker(pin));
            let _ = fs::remove_dir_all(paths.staging());
        }
    }

    /// "Unload now", and the way out of `failed`: stop it and forget the
    /// failures, so the next chat starts it again.
    fn stop_engine(&self) {
        let mut inner = self.lock();
        inner.stop_serve();
        inner.serve = Serve::Stopped;
        inner.failed_starts.clear();
    }

    fn shutdown(&self) {
        let stop = self.lock().stop_download.clone();
        if let Some(stop) = stop {
            stop.store(true, Ordering::SeqCst);
        }
        let mut inner = self.lock();
        inner.stop_serve();
        // Whatever a worker still holds (the router, a server mid-start).
        for pid in std::mem::take(&mut inner.pids) {
            kill_group(pid);
        }
        if let Some(paths) = inner.paths() {
            let _ = fs::remove_file(paths.pid_file());
        }
    }

    /// The engine, running and loaded, for one chat: started here when it is
    /// not. `cancel` is the chat's own flag.
    pub(crate) fn ensure_ready(
        self: &Arc<Self>,
        cancel: &AtomicBool,
    ) -> Result<Session, StartError> {
        let fail = |why: &str| Err(StartError::Failed(why.to_string()));
        let pin = match default_model() {
            Some(pin) => pin,
            None => return fail("no model is pinned"),
        };
        let (server, paths) = {
            let mut inner = self.lock();
            let live = match &mut inner.serve {
                Serve::Ready { proc, port, key } => {
                    if proc.alive() {
                        Some(Ok((*port, key.clone())))
                    } else {
                        Some(Err((proc.pid(), proc.last_words())))
                    }
                }
                _ => None,
            };
            match live {
                Some(Ok((port, key))) => {
                    inner.in_use = true;
                    return Ok(Session {
                        runner: Arc::clone(self),
                        port,
                        key,
                    });
                }
                Some(Err((pid, _))) => {
                    inner.serve = Serve::Stopped;
                    inner.failed_starts.push_back(Instant::now());
                    inner.track(pid, false);
                }
                None => {}
            }
            if matches!(inner.serve, Serve::Starting) {
                return fail("the built-in AI is already starting");
            }
            if inner.stop_download.is_some() {
                return fail("the model is still downloading");
            }
            if inner.recent_failures() >= MAX_FAILED_STARTS {
                let why = "the built-in AI stopped 3 times in a row";
                inner.serve = Serve::Failed(why.to_string());
                return fail(why);
            }
            let (Some(server), Some(paths)) = (inner.server.clone(), inner.paths()) else {
                return fail("the built-in AI was not checked yet");
            };
            if !model_ready(&paths, pin) {
                return fail("the model is not downloaded");
            }
            inner.serve = Serve::Starting;
            (server, paths)
        };
        let started = self.start_serving(&server, &paths, pin, cancel);
        let mut inner = self.lock();
        match started {
            Ok((proc, port, key)) => {
                inner.serve = Serve::Ready {
                    proc,
                    port,
                    key: key.clone(),
                };
                inner.in_use = true;
                inner.last_use = Some(Instant::now());
                if !inner.idle_watch {
                    inner.idle_watch = true;
                    let runner = Arc::clone(self);
                    thread::spawn(move || runner.watch_idle());
                }
                Ok(Session {
                    runner: Arc::clone(self),
                    port,
                    key,
                })
            }
            Err(Wait::Cancelled) => {
                inner.serve = Serve::Stopped;
                Err(StartError::Cancelled)
            }
            Err(end) => {
                let why = match end {
                    Wait::Exited(words) => format!("the engine stopped: {words}"),
                    _ => format!("the model did not load in {} s", LOAD_WAIT.as_secs()),
                };
                inner.failed_starts.push_back(Instant::now());
                inner.serve = Serve::Failed(why.clone());
                Err(StartError::Failed(why))
            }
        }
    }

    fn start_serving(
        &self,
        server: &Path,
        paths: &Paths,
        pin: &ModelPin,
        cancel: &AtomicBool,
    ) -> Result<(Proc, u16, String), Wait> {
        let port = free_port().map_err(|e| Wait::Exited(format!("no free port: {e}")))?;
        let key = random_key();
        let args = serve_args(port, &paths.model_file(pin));
        let mut proc = Proc::spawn(server, &args, &engine_env(paths, &key))
            .map_err(|e| Wait::Exited(format!("could not start: {e}")))?;
        let pid = proc.pid();
        self.lock().track(pid, true);
        match wait_healthy(&mut proc, port, &key, LOAD_WAIT, cancel) {
            Ok(()) => Ok((proc, port, key)),
            Err(end) => {
                proc.kill();
                self.lock().track(pid, false);
                Err(end)
            }
        }
    }

    /// Stops the engine once it has sat unused for `IDLE_STOP`; ends when
    /// there is no engine to watch.
    fn watch_idle(&self) {
        loop {
            thread::sleep(IDLE_POLL);
            let mut inner = self.lock();
            if !matches!(inner.serve, Serve::Ready { .. }) {
                inner.idle_watch = false;
                return;
            }
            let idle = !inner.in_use && inner.last_use.is_some_and(|t| t.elapsed() >= IDLE_STOP);
            if idle {
                inner.stop_serve();
                inner.idle_watch = false;
                return;
            }
        }
    }
}

/// The commands below share this: the caller is the main webview, the data
/// folder is known, and the work runs off the async workers. Each resolves
/// with the status as RAW JSON bytes.
async fn engine_command(
    webview: tauri::Webview,
    state: tauri::State<'_, EngineState>,
    work: impl FnOnce(&Arc<Runner>) -> Result<(), String> + Send + 'static,
) -> Result<Response, String> {
    if webview.label() != MAIN_WEBVIEW {
        return Err(FORBIDDEN.to_string());
    }
    let local_data = webview.app_handle().path().app_local_data_dir().ok();
    let runner = state.runner();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        runner.set_root(local_data);
        work(&runner)?;
        runner.status()
    })
    .await
    .unwrap_or_else(|e| Err(format!("E_BAD_RESPONSE engine task failed: {e}")))?;
    Ok(Response::new(InvokeResponseBody::Raw(bytes)))
}

/// The model's and the engine's state. Starts nothing.
#[tauri::command]
pub async fn llm_engine_status(
    webview: tauri::Webview,
    state: tauri::State<'_, EngineState>,
) -> Result<Response, String> {
    engine_command(webview, state, |_| Ok(())).await
}

/// `start` (also: resume, download again), `pause` (keeps what arrived) or
/// `cancel` (deletes it). The webview names no model: there is one pin.
#[tauri::command]
pub async fn llm_engine_download(
    webview: tauri::Webview,
    state: tauri::State<'_, EngineState>,
    action: String,
) -> Result<Response, String> {
    engine_command(webview, state, move |runner| match action.as_str() {
        "start" => runner.start_download(),
        "pause" => {
            runner.stop_download(false);
            Ok(())
        }
        "cancel" => {
            runner.stop_download(true);
            Ok(())
        }
        _ => Err("E_BAD_ROUTE".to_string()),
    })
    .await
}

/// Delete the downloaded model (and stop the engine that runs it).
#[tauri::command]
pub async fn llm_engine_delete(
    webview: tauri::Webview,
    state: tauri::State<'_, EngineState>,
) -> Result<Response, String> {
    engine_command(webview, state, |runner| {
        runner.delete_model();
        Ok(())
    })
    .await
}

/// Stop the engine now; the next chat starts it again.
#[tauri::command]
pub async fn llm_engine_stop(
    webview: tauri::Webview,
    state: tauri::State<'_, EngineState>,
) -> Result<Response, String> {
    engine_command(webview, state, |runner| {
        runner.stop_engine();
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A fresh directory under the system temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "fs-engine-test-{tag}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).expect("scratch dir");
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sha(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    /// Pins for a fake engine of `files`, its server the first one.
    fn fake(dir: &Path, files: &[(&str, &[u8])]) -> PlatformPins {
        fs::create_dir_all(dir).unwrap();
        let mut pins = Vec::new();
        for (name, bytes) in files {
            fs::write(dir.join(name), bytes).unwrap();
            pins.push(FilePin {
                to: (*name).into(),
                sha256: sha(bytes),
                size: bytes.len() as u64,
            });
        }
        PlatformPins {
            server: files[0].0.into(),
            files: pins,
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn the_shipped_manifest_parses_and_pins_both_platforms() {
        let m = manifest().expect("engine.json parses");
        assert_eq!(m.tag, "b12359");
        let mac = &m.platforms["macos-arm64"];
        let win = &m.platforms["windows-x64"];
        assert_eq!(mac.server, "llama-server");
        assert_eq!(win.server, "llama-server.exe");
        for p in [mac, win] {
            assert!(p.files.iter().any(|f| f.to == "LICENSE"));
        }
        // The RPC backend is linked on macOS, so it ships there; on Windows it
        // is a loadable backend, and is left out on purpose.
        assert!(mac.files.iter().any(|f| f.to == "libggml-rpc.1.dylib"));
        assert!(!win.files.iter().any(|f| f.to.contains("rpc")));
    }

    #[test]
    fn the_manifest_refuses_bad_names_pins_and_an_unlisted_server() {
        let ok = r#"{"tag":"b1","platforms":{"p":{"server":"s","files":[{"to":"s","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1}]}}}"#;
        assert!(parse_manifest(ok).is_ok());
        for bad in [
            ok.replace(r#""to":"s""#, r#""to":"../s""#),
            ok.replace(r#""to":"s""#, r#""to":".s""#),
            ok.replace(r#""to":"s""#, r#""to":"a/s""#),
            ok.replace(r#""server":"s""#, r#""server":"t""#),
            ok.replace("aaaaaaaa", "AAAAAAAA"),
            ok.replace(r#""size":1"#, r#""size":0"#),
            ok.replace(r#""tag":"b1""#, r#""tag":"..""#),
        ] {
            assert!(parse_manifest(&bad).is_err(), "{bad}");
        }
        let twice = ok.replace(
            r#"[{"to":"s""#,
            r#"[{"to":"S","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1},{"to":"s""#,
        );
        assert!(
            parse_manifest(&twice).is_err(),
            "a name differing only by case repeats"
        );
    }

    #[test]
    fn install_copy_writes_exactly_the_pins_and_removes_the_rest() {
        let s = Scratch::new("install");
        let src = s.0.join("res");
        let pins = fake(
            &src,
            &[("server", b"#!/bin/sh\necho hi\n"), ("LICENSE", b"MIT")],
        );
        let root = s.0.join("data").join(INSTALL_DIR);
        let dst = root.join("b2");
        fs::create_dir_all(root.join("b1")).unwrap(); // an older tag
        fs::create_dir_all(&dst).unwrap();
        fs::write(dst.join("stray.dylib"), b"x").unwrap();
        fs::write(dst.join(".server.part"), b"half").unwrap();
        fs::write(dst.join("server"), b"wrong").unwrap();
        install_copy(&src, &dst, &pins).expect("installs");
        assert_eq!(names(&dst), ["LICENSE", "server"]);
        assert_eq!(names(&root), ["b2"]);
        assert_eq!(
            fs::read(dst.join("server")).unwrap(),
            b"#!/bin/sh\necho hi\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |n: &str| fs::metadata(dst.join(n)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode("server"), 0o755);
            assert_eq!(mode("LICENSE"), 0o644);
        }
        // A second run with everything in place copies nothing: the source can go.
        fs::remove_file(src.join("server")).unwrap();
        install_copy(&src, &dst, &pins).expect("already installed");
    }

    #[test]
    fn install_copy_refuses_a_source_that_differs_and_leaves_nothing_half_written() {
        let s = Scratch::new("tampered");
        let src = s.0.join("res");
        let pins = fake(&src, &[("server", b"good")]);
        fs::write(src.join("server"), b"evil").unwrap();
        let dst = s.0.join("data").join(INSTALL_DIR).join("b2");
        let err = install_copy(&src, &dst, &pins).unwrap_err();
        assert!(matches!(err, Prep::Tampered(_)), "{err:?}");
        assert!(names(&dst).is_empty());
        // Longer than the pin: refused while copying.
        fs::write(src.join("server"), b"good and then some").unwrap();
        assert!(matches!(
            install_copy(&src, &dst, &pins),
            Err(Prep::Tampered(_))
        ));
        assert!(names(&dst).is_empty());
    }

    #[test]
    fn install_copy_says_missing_without_the_folder_and_tampered_without_a_file() {
        let s = Scratch::new("missing");
        let src = s.0.join("res");
        let pins = fake(&src, &[("server", b"a"), ("LICENSE", b"b")]);
        let dst = s.0.join("data").join(INSTALL_DIR).join("b2");
        fs::remove_file(src.join("LICENSE")).unwrap();
        assert!(matches!(
            install_copy(&src, &dst, &pins),
            Err(Prep::Tampered(_))
        ));
        fs::remove_dir_all(&src).unwrap();
        assert!(matches!(
            install_copy(&src, &dst, &pins),
            Err(Prep::Missing(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_never_passes_for_a_pinned_file() {
        let s = Scratch::new("link");
        let src = s.0.join("res");
        let pins = fake(&src, &[("server", b"real")]);
        fs::write(s.0.join("elsewhere"), b"real").unwrap();
        fs::remove_file(src.join("server")).unwrap();
        std::os::unix::fs::symlink(s.0.join("elsewhere"), src.join("server")).unwrap();
        assert!(!matches_pin(&src.join("server"), &pins.files[0]).unwrap());
        let dst = s.0.join("data").join(INSTALL_DIR).join("b2");
        assert!(matches!(
            install_copy(&src, &dst, &pins),
            Err(Prep::Tampered(_))
        ));
        assert!(matches!(
            verify_in_place(&src, &pins),
            Err(Prep::Tampered(_))
        ));
    }

    #[test]
    fn verify_in_place_wants_exactly_the_pinned_set() {
        let s = Scratch::new("inplace");
        let dir = s.0.join("engine").join("b2");
        let pins = fake(
            &dir,
            &[("llama-server.exe", b"mz"), ("ggml-cpu-x64.dll", b"dll")],
        );
        assert_eq!(verify_in_place(&dir, &pins), Ok(()));
        fs::write(dir.join("ggml-rpc.dll"), b"loaded by the backend scan").unwrap();
        assert!(
            matches!(verify_in_place(&dir, &pins), Err(Prep::Tampered(d)) if d.contains("ggml-rpc.dll"))
        );
        fs::remove_file(dir.join("ggml-rpc.dll")).unwrap();
        fs::write(dir.join("ggml-cpu-x64.dll"), b"DLL").unwrap();
        assert!(matches!(
            verify_in_place(&dir, &pins),
            Err(Prep::Tampered(_))
        ));
        fs::remove_dir_all(&dir).unwrap();
        assert!(matches!(
            verify_in_place(&dir, &pins),
            Err(Prep::Missing(_))
        ));
    }

    #[test]
    fn parses_the_device_list_and_skips_everything_else() {
        let text = "ggml_metal_init: noise\nAvailable devices:\n  MTL0: Apple M4 Max (110100 MiB, 110100 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)\n  Vulkan0: NVIDIA GeForce RTX 3060 (Laptop) (6144 MiB, 5800 MiB free)\n  bad line\n  X: no sizes\n";
        let d = parse_devices(text);
        assert_eq!(d.len(), 3);
        assert_eq!(
            d[0],
            Device {
                id: "MTL0".into(),
                name: "Apple M4 Max".into(),
                total_mib: 110100,
                free_mib: 110100
            }
        );
        assert_eq!(d[2].name, "NVIDIA GeForce RTX 3060 (Laptop)");
        assert_eq!(d[2].free_mib, 5800);
        let many: String = (0..40)
            .map(|i| format!("  D{i}: G ({i} MiB, {i} MiB free)\n"))
            .collect();
        assert_eq!(parse_devices(&many).len(), MAX_DEVICES);
        // A name is display text: control and invisible characters go.
        let odd = parse_devices("  MTL0: Bad\u{202E}Name\u{0007} (1 MiB, 1 MiB free)\n");
        assert_eq!(odd[0].name, "BadName");
    }

    #[test]
    fn parses_the_version_line() {
        let text = "\nversion: 1.0.0-dev (build 12359, commit b1b770d90)\nbuilt with AppleClang\n";
        assert_eq!(
            parse_version(text).as_deref(),
            Some("1.0.0-dev (build 12359, commit b1b770d90)")
        );
        assert_eq!(parse_version("nothing here"), None);
    }

    #[test]
    fn compares_macos_versions_against_the_floor() {
        assert!(!version_at_least("13.2.1", MIN_MACOS));
        assert!(!version_at_least("12.7", MIN_MACOS));
        assert!(version_at_least("13.3", MIN_MACOS));
        assert!(version_at_least("13.3.1", MIN_MACOS));
        assert!(version_at_least("27.0.1", MIN_MACOS));
        assert!(version_at_least("garbage", MIN_MACOS));
    }

    #[test]
    fn maps_every_probe_failure_to_a_survey_state() {
        assert_eq!(probe_state(ProbeError::TimedOut).0, "blocked");
        assert_eq!(probe_state(ProbeError::Signal(9)).0, "blocked");
        assert_eq!(probe_state(ProbeError::Signal(11)).0, "failed");
        assert_eq!(
            probe_state(ProbeError::Exit(0xC000_0135_u32 as i32, String::new())).0,
            "runtime-missing"
        );
        assert_eq!(
            probe_state(ProbeError::Exit(0xC000_0139_u32 as i32, String::new())).0,
            "runtime-missing"
        );
        assert_eq!(
            probe_state(ProbeError::Exit(1, "boom".into())).1,
            "exit code 1: boom"
        );
        assert_eq!(probe_state(ProbeError::Spawn("denied".into())).0, "failed");
        for (state, _) in [
            probe_state(ProbeError::TimedOut),
            probe_state(ProbeError::Exit(1, String::new())),
            probe_state(ProbeError::Exit(0xC000_0135_u32 as i32, String::new())),
        ] {
            assert!(SURVEY_STATES.contains(&state));
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_probe_runs_with_a_cleared_environment_and_a_deadline() {
        let s = Scratch::new("probe");
        let script = s.0.join("server");
        // HOME is set wherever tests run; the probe must not pass it on.
        assert!(std::env::var_os("HOME").is_some());
        fs::write(&script, "#!/bin/sh\nif [ \"$1\" = slow ]; then /bin/sleep 5; fi\necho \"version: home=$(/usr/bin/env | /usr/bin/grep -c '^HOME=')\"\nexit 0\n").unwrap();
        set_mode(&script, "server").unwrap();
        let out = probe(&script, &["fast"], Duration::from_secs(5)).expect("runs");
        assert_eq!(parse_version(&out).as_deref(), Some("home=0"));
        let started = Instant::now();
        assert_eq!(
            probe(&script, &["slow"], Duration::from_millis(300)),
            Err(ProbeError::TimedOut)
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        fs::write(&script, "#!/bin/sh\necho oops >&2\nexit 3\n").unwrap();
        assert_eq!(
            probe(&script, &[], Duration::from_secs(5)),
            Err(ProbeError::Exit(3, "oops".into()))
        );
        assert!(matches!(
            probe(&s.0.join("absent"), &[], Duration::from_secs(1)),
            Err(ProbeError::Spawn(_))
        ));
    }

    #[test]
    fn the_host_without_an_engine_says_why_before_touching_any_file() {
        let s = survey(Host::IntelMac, None, None);
        assert_eq!(s.state, "intel-mac");
        let s = survey(Host::Unsupported, None, None);
        assert_eq!(s.state, "unsupported");
        assert_eq!(s.engine, "b12359");
    }

    #[test]
    fn a_build_without_the_resource_folder_is_missing() {
        let scratch = Scratch::new("nobuild");
        let host = Host::Engine(if COPY_OUT {
            "macos-arm64"
        } else {
            "windows-x64"
        });
        let s = survey(
            host,
            Some(scratch.0.join("res")),
            Some(scratch.0.join("data")),
        );
        if cfg!(target_os = "macos")
            && !os_version()
                .map(|v| version_at_least(&v, MIN_MACOS))
                .unwrap_or(true)
        {
            assert_eq!(s.state, "old-mac");
        } else {
            assert_eq!(s.state, "missing");
        }
    }

    #[test]
    fn the_survey_serializes_in_camel_case_without_absent_fields() {
        let s = Survey {
            state: "ok",
            detail: None,
            engine: "b1".into(),
            version: Some("v".into()),
            devices: vec![Device {
                id: "MTL0".into(),
                name: "G".into(),
                total_mib: 2,
                free_mib: 1,
            }],
            ram_bytes: Some(8),
            disk_free_bytes: None,
            os_version: None,
            server: None,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(
            json,
            r#"{"state":"ok","engine":"b1","version":"v","devices":[{"id":"MTL0","name":"G","totalMib":2,"freeMib":1}],"ramBytes":8}"#
        );
    }

    /// The go/no-go check on a real Mac (P5): the staged engine, every file
    /// marked as a browser download marks it, surveyed the way the app does.
    /// Run `npm run fetch:engine` first, then
    /// `cargo test real_quarantined_engine -- --ignored --nocapture`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn real_quarantined_engine_runs_from_its_own_copy() {
        let tag = &manifest().unwrap().tag;
        let staged = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("engine-dist")
            .join(tag);
        assert!(staged.is_dir(), "run `npm run fetch:engine` first");
        let s = Scratch::new("real");
        let res = s.0.join("res");
        let src = res.join(RESOURCE_DIR).join(tag);
        fs::create_dir_all(&src).unwrap();
        for entry in fs::read_dir(&staged).unwrap() {
            let entry = entry.unwrap();
            let to = src.join(entry.file_name());
            fs::copy(entry.path(), &to).unwrap();
            let marked = Command::new("/usr/bin/xattr")
                .args(["-w", "com.apple.quarantine", "0081;00000000;Safari;"])
                .arg(&to)
                .status()
                .unwrap();
            assert!(marked.success());
        }
        let result = survey(HOST, Some(res), Some(s.0.join("data")));
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
        assert_eq!(result.state, "ok", "{:?}", result.detail);
        assert!(result.devices.iter().any(|d| d.id.starts_with("MTL")));
    }

    // ── The model and the running engine ──

    fn tiny_pin(bytes: &[u8]) -> ModelPin {
        ModelPin {
            key: "tiny".into(),
            label: "Tiny".into(),
            repo: "owner/tiny-GGUF".into(),
            quant: "Q4_0".into(),
            commit: "0".repeat(40),
            file: "tiny.gguf".into(),
            sha256: sha(bytes),
            size: bytes.len() as u64,
        }
    }

    #[test]
    fn the_manifest_pins_one_valid_default_model() {
        let m = manifest().unwrap();
        assert_eq!(m.models.len(), 1);
        let pin = default_model().unwrap();
        assert!(valid_model(pin));
        assert_eq!(pin.key, "gemma-4-e2b");
        // Under 8 GB of memory with room for the context.
        assert!(pin.size > 1 << 30 && pin.size < 4 << 30);
    }

    #[test]
    fn a_model_pin_is_refused_unless_every_field_is_plain() {
        let good = tiny_pin(b"x");
        assert!(valid_model(&good));
        let bad = |edit: &dyn Fn(&mut ModelPin)| {
            let mut pin = good.clone();
            edit(&mut pin);
            valid_model(&pin)
        };
        assert!(!bad(&|p| p.repo = "owner".into()));
        assert!(!bad(&|p| p.repo = "owner/../x".into()));
        assert!(!bad(&|p| p.repo = "owner/name/extra".into()));
        assert!(!bad(&|p| p.repo = "owner/name?x=1".into()));
        assert!(!bad(&|p| p.quant = "Q4:evil".into()));
        assert!(!bad(&|p| p.file = "../tiny.gguf".into()));
        assert!(!bad(&|p| p.file = "tiny.bin".into()));
        assert!(!bad(&|p| p.commit = "main".into()));
        assert!(!bad(&|p| p.sha256 = "ABC".into()));
        assert!(!bad(&|p| p.size = 0));
        assert!(!bad(&|p| p.label = "two\nlines".into()));
        assert!(!bad(&|p| p.key = ".hidden".into()));
        // A second model with the first one's key is refused too.
        let json = MANIFEST_JSON.replacen("\"models\": [", "\"models\": [{\"key\":\"gemma-4-e2b\",\"label\":\"X\",\"repo\":\"a/b\",\"quant\":\"q\",\"commit\":\"0000000000000000000000000000000000000000\",\"file\":\"x.gguf\",\"sha256\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"size\":1},", 1);
        assert!(parse_manifest(&json).is_err());
    }

    #[test]
    fn the_download_request_names_the_pinned_repository_and_no_sidecars() {
        let body: serde_json::Value =
            serde_json::from_slice(&download_body(&tiny_pin(b"x"))).unwrap();
        assert_eq!(
            body,
            serde_json::json!({ "model": "owner/tiny-GGUF:Q4_0", "sidecars": [] })
        );
    }

    #[test]
    fn the_staging_folder_is_read_by_name_and_size_never_through_a_link() {
        let s = Scratch::new("blobs");
        let bytes = b"model bytes";
        let pin = tiny_pin(bytes);
        let paths = Paths { root: s.0.clone() };
        let blobs = paths.blobs(&pin);
        assert!(blobs.ends_with("staging/models--owner--tiny-GGUF/blobs"));
        assert_eq!(scan_blobs(&blobs, &pin), Blobs::Nothing);
        fs::create_dir_all(&blobs).unwrap();
        assert_eq!(scan_blobs(&blobs, &pin), Blobs::Nothing);
        let partial = blobs.join(format!("{}{PARTIAL_SUFFIX}", pin.sha256));
        fs::write(&partial, &bytes[..4]).unwrap();
        assert_eq!(scan_blobs(&blobs, &pin), Blobs::Partial(4));
        fs::rename(&partial, blobs.join(&pin.sha256)).unwrap();
        // The pinned name at the wrong size is not the file.
        assert!(matches!(scan_blobs(&blobs, &pin), Blobs::Foreign(_)));
        fs::write(blobs.join(&pin.sha256), bytes).unwrap();
        assert_eq!(scan_blobs(&blobs, &pin), Blobs::Complete);
        // Any other name: the repository now offers a different file.
        fs::write(blobs.join("f".repeat(64)), b"other").unwrap();
        assert!(matches!(scan_blobs(&blobs, &pin), Blobs::Foreign(_)));
        fs::remove_file(blobs.join("f".repeat(64))).unwrap();
        // A partial longer than the whole file is not ours either.
        fs::remove_file(blobs.join(&pin.sha256)).unwrap();
        fs::write(&partial, [0u8; 64]).unwrap();
        assert!(matches!(scan_blobs(&blobs, &pin), Blobs::Foreign(_)));
        #[cfg(unix)]
        {
            fs::remove_file(&partial).unwrap();
            fs::write(s.0.join("elsewhere"), bytes).unwrap();
            std::os::unix::fs::symlink(s.0.join("elsewhere"), blobs.join(&pin.sha256)).unwrap();
            assert!(matches!(scan_blobs(&blobs, &pin), Blobs::Foreign(_)));
        }
    }

    #[test]
    fn only_a_file_with_the_pinned_hash_is_placed_and_marked() {
        let s = Scratch::new("place");
        let bytes = b"the right bytes";
        let pin = tiny_pin(bytes);
        let paths = Paths { root: s.0.clone() };
        let blobs = paths.blobs(&pin);
        fs::create_dir_all(&blobs).unwrap();
        assert!(!model_ready(&paths, &pin));

        // Same size, other bytes: refused and deleted.
        let wrong = blobs.join(&pin.sha256);
        fs::write(&wrong, b"the wrong bytes").unwrap();
        assert!(check_and_place(&paths, &pin, &wrong).is_err());
        assert!(!wrong.exists());
        assert!(!model_ready(&paths, &pin));

        fs::write(&wrong, bytes).unwrap();
        check_and_place(&paths, &pin, &wrong).unwrap();
        assert!(model_ready(&paths, &pin));
        assert_eq!(fs::read(paths.model_file(&pin)).unwrap(), bytes);

        // The marker is what says "checked": without it the file is unknown…
        let marker = fs::read(paths.marker(&pin)).unwrap();
        fs::remove_file(paths.marker(&pin)).unwrap();
        assert!(!model_ready(&paths, &pin));
        // …and it stops matching a file whose size changed.
        fs::write(paths.marker(&pin), &marker).unwrap();
        assert!(model_ready(&paths, &pin));
        fs::write(paths.model_file(&pin), b"the right byteZ!").unwrap();
        assert!(!model_ready(&paths, &pin));
        // A marker for another hash is not this pin's.
        fs::write(paths.model_file(&pin), bytes).unwrap();
        fs::write(
            paths.marker(&pin),
            br#"{"sha256":"00","size":15,"modified":0}"#,
        )
        .unwrap();
        assert!(!model_ready(&paths, &pin));
    }

    #[test]
    fn every_start_gets_a_fresh_long_key_and_a_usable_port() {
        let a = random_key();
        let b = random_key();
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        assert!(free_port().unwrap() >= 1024);
    }

    #[test]
    fn the_engine_is_started_closed_and_offline() {
        let router = router_args(4321);
        let has = |args: &[OsString], flag: &str| args.iter().any(|a| a == flag);
        for flag in ["--no-models-autoload", "--no-webui", "--no-slots"] {
            assert!(has(&router, flag), "{flag}");
        }
        let serve = serve_args(4321, Path::new("/m/tiny.gguf"));
        for flag in ["--offline", "--no-webui", "--no-slots", "--no-mmproj"] {
            assert!(has(&serve, flag), "{flag}");
        }
        for args in [&router, &serve] {
            let text: Vec<String> = args
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            let after = |flag: &str| {
                text.iter()
                    .position(|a| a == flag)
                    .map(|i| text[i + 1].clone())
            };
            assert_eq!(after("--host").as_deref(), Some("127.0.0.1"));
            assert_eq!(after("--port").as_deref(), Some("4321"));
            assert_eq!(after("--cors-origins").as_deref(), Some("localhost"));
            // Never a flag the plan forbids, and the key is never an argument
            // (other programs can read a process's arguments).
            for banned in [
                "--rpc",
                "--tools",
                "--agent",
                "--props",
                "--sleep-idle-seconds",
                "--api-key",
                "-hf",
                "--model-url",
                "--connect",
            ] {
                assert!(!text.iter().any(|a| a == banned), "{banned}");
            }
        }
        let text: Vec<String> = serve
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(&text[..2], ["-m", "/m/tiny.gguf"]);
        assert!(text.windows(2).any(|w| w == ["-c", SERVED_CONTEXT]));
        assert!(text.windows(2).any(|w| w == ["-np", "1"]));
        let s = Scratch::new("env");
        let env = engine_env(&Paths { root: s.0.clone() }, "k");
        let names: Vec<&str> = env.iter().map(|(k, _)| *k).collect();
        assert_eq!(names, ["LLAMA_CACHE", "LLAMA_API_KEY"]);
    }

    #[test]
    fn the_pid_file_is_written_cleared_and_never_trusted_when_large() {
        let s = Scratch::new("pids");
        let file = s.0.join(PID_FILE);
        write_pids(&file, &[11, 22]);
        assert_eq!(fs::read_to_string(&file).unwrap(), "11\n22\n");
        write_pids(&file, &[]);
        assert!(!file.exists());
        // Stray cleanup removes the file whatever it holds; a pid that is not
        // our server (here: no such program path) is left alone.
        fs::write(&file, "1\nnot a pid\n4294967295\n").unwrap();
        kill_strays(&file, &s.0.join("llama-server"));
        assert!(!file.exists());
        fs::write(&file, vec![b'9'; 4096]).unwrap();
        kill_strays(&file, &s.0.join("llama-server"));
        assert!(!file.exists());
    }

    #[test]
    fn the_status_names_only_listed_states_and_starts_nothing() {
        let s = Scratch::new("status");
        let runner = Arc::new(Runner::default());
        runner.set_root(Some(s.0.clone()));
        let read = |r: &Runner| -> serde_json::Value {
            serde_json::from_slice(&r.status().unwrap()).unwrap()
        };
        let first = read(&runner);
        assert_eq!(first["model"]["state"], "none");
        assert_eq!(first["model"]["key"], "gemma-4-e2b");
        assert_eq!(first["model"]["sizeBytes"], default_model().unwrap().size);
        assert_eq!(first["server"]["state"], "stopped");
        assert!(first["model"].get("doneBytes").is_none());
        // A partial file left on the disk is reported as one.
        let pin = default_model().unwrap();
        let paths = Paths {
            root: s.0.join(LLM_DIR),
        };
        fs::create_dir_all(paths.blobs(pin)).unwrap();
        fs::write(
            paths
                .blobs(pin)
                .join(format!("{}{PARTIAL_SUFFIX}", pin.sha256)),
            [0u8; 9],
        )
        .unwrap();
        let partial = read(&runner);
        assert_eq!(partial["model"]["state"], "partial");
        assert_eq!(partial["model"]["doneBytes"], 9);
        // Without a surveyed server nothing can start.
        assert_eq!(
            runner.start_download(),
            Err("E_NOT_READY survey first".to_string())
        );
        assert!(matches!(
            runner.ensure_ready(&AtomicBool::new(false)),
            Err(StartError::Failed(_))
        ));
        // Cancel clears the partial file; nothing was ever spawned.
        runner.stop_download(true);
        assert_eq!(read(&runner)["model"]["state"], "none");
        assert!(runner.lock().pids.is_empty());
    }

    #[test]
    fn three_failures_in_the_window_stop_the_retries_until_asked() {
        let runner = Arc::new(Runner::default());
        {
            let mut inner = runner.lock();
            for _ in 0..MAX_FAILED_STARTS {
                inner.failed_starts.push_back(Instant::now());
            }
            assert_eq!(inner.recent_failures(), MAX_FAILED_STARTS);
        }
        match runner.ensure_ready(&AtomicBool::new(false)) {
            Err(StartError::Failed(why)) => assert!(why.contains("3 times"), "{why}"),
            _ => panic!("expected a refusal"),
        }
        runner.stop_engine();
        assert_eq!(runner.lock().recent_failures(), 0);
    }

    /// The staged engine, when `npm run fetch:engine` has run.
    #[cfg(target_os = "macos")]
    fn staged_server() -> PathBuf {
        let m = manifest().unwrap();
        let server = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("engine-dist")
            .join(&m.tag)
            .join(&m.platforms["macos-arm64"].server);
        assert!(server.is_file(), "run `npm run fetch:engine` first");
        server
    }

    /// The REAL download path against the real engine and Hugging Face, with a
    /// 19 MB public test model: router, one request, the folder watch, the
    /// hash check, the move. `cargo test real_download -- --ignored --nocapture`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn real_download_is_checked_and_placed() {
        let pin = ModelPin {
            key: "tiny".into(),
            label: "Tiny".into(),
            repo: "ggml-org/tiny-llamas".into(),
            quant: "Q4_0".into(),
            commit: "99dd1a73db5a37100bd4ae633f4cfce6560e1567".into(),
            file: "stories15M-q4_0.gguf".into(),
            sha256: "6151b1929d7f5aa3385d9ddef3393e55587c0a55de661562322bc51dfda93a04".into(),
            size: 19_077_344,
        };
        let s = Scratch::new("dl");
        let paths = Paths { root: s.0.clone() };
        let pids = Mutex::new(Vec::new());
        let seen = Mutex::new(Vec::new());
        let end = run_download(
            &staged_server(),
            &paths,
            &pin,
            &AtomicBool::new(false),
            &|pid| pids.lock().unwrap().push(pid),
            &|done| seen.lock().unwrap().push(done),
        );
        assert_eq!(end, DownloadEnd::Ready);
        assert!(model_ready(&paths, &pin));
        assert!(!paths.staging().exists(), "the staging folder is gone");
        let pids = pids.lock().unwrap();
        assert!(matches!(pids.as_slice(), [Some(_), None]), "{pids:?}");
        assert_eq!(seen.lock().unwrap().last(), Some(&u64::MAX));

        // The same repository under a WRONG pin: nothing of it is kept.
        let wrong = ModelPin {
            sha256: "0".repeat(64),
            ..pin.clone()
        };
        let s2 = Scratch::new("dl-wrong");
        let paths2 = Paths { root: s2.0.clone() };
        let end = run_download(
            &staged_server(),
            &paths2,
            &wrong,
            &AtomicBool::new(false),
            &|_| {},
            &|_| {},
        );
        assert!(matches!(end, DownloadEnd::BadHash(_)), "{end:?}");
        assert!(!model_ready(&paths2, &wrong));
        assert!(!paths2.staging().exists());
    }

    /// The REAL serve path: the engine loads a GGUF already on this computer
    /// (`FS_TEST_GGUF=/path/to/model.gguf`), answers a chat through the bridge
    /// with its key, refuses one without, and stops.
    /// `FS_TEST_GGUF=… cargo test real_engine_serves -- --ignored --nocapture`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn real_engine_serves_a_chat_and_stops() {
        let gguf = PathBuf::from(std::env::var_os("FS_TEST_GGUF").expect("set FS_TEST_GGUF"));
        let s = Scratch::new("serve");
        let paths = Paths { root: s.0.clone() };
        let port = free_port().unwrap();
        let key = random_key();
        let started = Instant::now();
        let mut proc = Proc::spawn(
            &staged_server(),
            &serve_args(port, &gguf),
            &engine_env(&paths, &key),
        )
        .unwrap();
        let never = AtomicBool::new(false);
        assert_eq!(
            wait_healthy(&mut proc, port, &key, LOAD_WAIT, &never),
            Ok(())
        );
        println!("loaded in {:.1} s", started.elapsed().as_secs_f32());
        let chat = br#"{"model":"fastshaders","messages":[{"role":"user","content":"Say OK."}],"max_tokens":8,"temperature":0}"#;
        let answer =
            engine_call(port, &key, Some(("/v1/chat/completions", chat)), "", &never).unwrap();
        let answer: serde_json::Value = serde_json::from_slice(&answer).unwrap();
        println!("{}", answer["choices"][0]["message"]["content"]);
        assert!(answer["choices"][0]["message"]["content"].is_string());
        // Without the key nothing answers.
        let refused = engine_call(
            port,
            "wrong",
            Some(("/v1/chat/completions", chat)),
            "",
            &never,
        )
        .unwrap_err();
        assert!(refused.starts_with("E_HTTP 401"), "{refused}");
        let pid = proc.pid();
        proc.kill();
        assert!(process_path(pid).is_none(), "the engine is gone");
    }

    /// The WHOLE path with the pinned model, as the app drives it: the runner
    /// downloads the real 3.1 GB file, the app's own hash check passes, the
    /// engine loads it and answers a chat, stops, and the model is deleted.
    /// Needs the network and ~4 GB of temp space.
    /// `cargo test real_runner -- --ignored --nocapture`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn real_runner_downloads_checks_and_serves_the_pinned_model() {
        let s = Scratch::new("runner");
        let runner = Arc::new(Runner::default());
        runner.set_root(Some(s.0.clone()));
        runner.set_server(Some(staged_server()));
        let read = |r: &Runner| -> serde_json::Value {
            serde_json::from_slice(&r.status().unwrap()).unwrap()
        };
        assert_eq!(read(&runner)["model"]["state"], "none");
        runner.start_download().unwrap();
        let started = Instant::now();
        let mut last_print = Instant::now();
        loop {
            let status = read(&runner);
            let state = status["model"]["state"].as_str().unwrap().to_string();
            match state.as_str() {
                "ready" => break,
                "downloading" | "checking" => {}
                other => panic!("download ended as {other}: {}", status["model"]["detail"]),
            }
            if last_print.elapsed() >= Duration::from_secs(10) {
                last_print = Instant::now();
                println!(
                    "{state} {} of {}",
                    status["model"]["doneBytes"], status["model"]["sizeBytes"]
                );
            }
            assert!(
                started.elapsed() < Duration::from_secs(1800),
                "took too long"
            );
            thread::sleep(Duration::from_millis(500));
        }
        println!(
            "downloaded and checked in {:.0} s",
            started.elapsed().as_secs_f32()
        );
        let paths = Paths {
            root: s.0.join(LLM_DIR),
        };
        assert!(!paths.staging().exists());
        assert!(runner.lock().pids.is_empty());
        assert!(!paths.pid_file().exists());

        let cancel = AtomicBool::new(false);
        let loading = Instant::now();
        let session = match runner.ensure_ready(&cancel) {
            Ok(session) => session,
            Err(StartError::Failed(why)) => panic!("the engine did not start: {why}"),
            Err(StartError::Cancelled) => panic!("cancelled"),
        };
        println!("loaded in {:.1} s", loading.elapsed().as_secs_f32());
        assert_eq!(read(&runner)["server"]["state"], "ready");
        assert_eq!(
            fs::read_to_string(paths.pid_file())
                .unwrap()
                .lines()
                .count(),
            1
        );
        let chat = br#"{"model":"fastshaders","messages":[{"role":"user","content":"Reply with the single word: ready"}],"max_tokens":200,"temperature":0}"#;
        let answer = engine_call(
            session.port(),
            session.key(),
            Some(("/v1/chat/completions", chat)),
            "",
            &cancel,
        )
        .unwrap();
        let answer: serde_json::Value = serde_json::from_slice(&answer).unwrap();
        println!("answer: {}", answer["choices"][0]["message"]);
        assert!(answer["choices"][0]["message"].is_object());
        // A second chat reuses the running engine.
        let again = match runner.ensure_ready(&cancel) {
            Ok(again) => again,
            Err(_) => panic!("the running engine was not reused"),
        };
        assert_eq!(again.port(), session.port());
        drop(again);
        drop(session);

        runner.stop_engine();
        assert_eq!(read(&runner)["server"]["state"], "stopped");
        assert!(!paths.pid_file().exists());
        runner.delete_model();
        assert_eq!(read(&runner)["model"]["state"], "none");
        assert!(!paths.model_file(default_model().unwrap()).exists());
    }
}
