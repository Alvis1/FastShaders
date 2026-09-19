//! Desktop auto-save: the file-backed home of the editor's `fs:graph` and
//! `fs:savedGroups` documents (Phase 6, "desktop room").
//!
//! localStorage holds ~5.24M characters per origin, and a desktop project may
//! carry ~32M characters of images, so the desktop webview writes here instead.
//!
//! Layout under `app_data_dir()/autosave/`:
//! - `graph.json` + `graph.prev.json` and `saved-groups.json` +
//!   `saved-groups.prev.json`: each document with a one-deep backup, rotated on
//!   every write.
//! - `*.corrupt-<ms>.json`: quarantined documents. Never read back, and kept,
//!   so nothing the user wrote is destroyed.
//! - `images/<sha256>.txt`: content-addressed image payloads (the `data:` URL
//!   text). The webview never names a file: Rust hashes the bytes and returns
//!   the digest.
//!
//! Invariants:
//! - a document is committed only when every image its `imageRef` keys name
//!   is on disk;
//! - an image read re-verifies its hash;
//! - GC keeps every image any `.json` in the directory names, so a backup, the
//!   current file or a quarantined file never loses its pixels;
//! - every write stages under its own name, so two concurrent writers of one
//!   image never touch each other's staging file.
//!
//! Security has the shape of work_folder.rs: no path crosses IPC, only a closed
//! slot vocabulary and 64-hex digests, and the capabilities stay bare
//! `core:default`.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

/// Emitted to the webview when a close or quit must wait for a flush
/// (`AUTOSAVE_FLUSH_EVENT` in utils/desktopAutosave.ts).
pub const FLUSH_EVENT: &str = "fs:autosave-flush";
/// Names the document slot of an `autosave_write` raw body (`SLOT_HEADER` in
/// utils/desktopAutosave.ts).
pub const SLOT_HEADER: &str = "x-fs-slot";

/// `request_flush` intents. The larger one wins when both arrive.
pub const INTENT_CLOSE_MAIN: u8 = 1;
pub const INTENT_EXIT_APP: u8 = 2;

const DIR: &str = "autosave";
const IMAGES_DIR: &str = "images";
const IMAGE_EXT: &str = "txt";
const TMP_SUFFIX: &str = ".tmp-fastshaders";
/// Documents carry no image bytes; this bounds Data-node CSV blobs, drawings
/// and node count.
const MAX_DOC_BYTES: u64 = 64 * 1024 * 1024;
/// = HARD_MAX_IMAGE_ENCODED_CHARS (utils/imageNode.ts): a `data:` URL is
/// ASCII, one byte per character.
const MAX_IMAGE_BYTES: u64 = 8_000_000;
/// A stored ref is the JSON string `"fsimg-<64 hex>"`.
const REF_PREFIX: &[u8] = b"\"fsimg-";
/// The one place the webview writes a ref: the `imageRef` key of an Image
/// node's values (`IMAGE_REF_KEY` in utils/imageNode.ts). JSON.stringify
/// emits no whitespace, and no string content can spell this token (a quote
/// inside a string is escaped), so it matches only a real `imageRef` key.
const IMAGE_REF_TOKEN: &[u8] = b"\"imageRef\":\"fsimg-";
const DIGEST_LEN: usize = 64;
/// How long a close or quit waits for the webview's `autosave_close_ready`.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
/// Numbers every staging file this process creates (see `staging_path`).
static STAGE_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub struct CloseState {
    flushing: AtomicBool,
    done: AtomicBool,
    intent: AtomicU8,
}

#[derive(Clone, serde::Serialize)]
pub struct AutosaveStatus {
    pub dir: String,
}

/// The closed slot vocabulary: (current file, one-deep backup).
fn slot_files(slot: &str) -> Result<(&'static str, &'static str), String> {
    match slot {
        "graph" => Ok(("graph.json", "graph.prev.json")),
        "savedGroups" => Ok(("saved-groups.json", "saved-groups.prev.json")),
        _ => Err("E_BAD_SLOT".into()),
    }
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("E_NO_DATA_DIR {e}"))?
        .join(DIR);
    fs::create_dir_all(dir.join(IMAGES_DIR)).map_err(|e| format!("E_IO {e}"))?;
    Ok(dir)
}

/// Exactly 64 lowercase hex digits: the only thing a digest may be, and so the
/// only file stem the images directory ever resolves.
fn is_digest(s: &str) -> bool {
    s.len() == DIGEST_LEN
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(DIGEST_LEN);
    for b in Sha256::digest(bytes) {
        out.push(HEX[usize::from(b >> 4)] as char);
        out.push(HEX[usize::from(b & 0x0f)] as char);
    }
    out
}

fn image_path(dir: &Path, digest: &str) -> PathBuf {
    dir.join(IMAGES_DIR).join(format!("{digest}.{IMAGE_EXT}"))
}

/// The three image types the editor stores, as a base64 `data:` URL with no
/// whitespace. The webview validates the payload fully; this only keeps the
/// store from holding anything else.
fn is_image_payload(b: &[u8]) -> bool {
    [
        &b"data:image/png;base64,"[..],
        &b"data:image/jpeg;base64,"[..],
        &b"data:image/webp;base64,"[..],
    ]
    .iter()
    .any(|p| b.starts_with(p))
        && b.iter().all(|c| c.is_ascii_graphic())
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Every `<prefix><64 hex>"` token in a JSON document.
fn scan_refs(bytes: &[u8], prefix: &[u8], out: &mut HashSet<String>) {
    let mut i = 0;
    while let Some(off) = find(&bytes[i..], prefix) {
        let start = i + off + prefix.len();
        let end = start + DIGEST_LEN;
        if end < bytes.len() && bytes[end] == b'"' {
            if let Ok(s) = std::str::from_utf8(&bytes[start..end]) {
                if is_digest(s) {
                    out.insert(s.to_string());
                }
            }
        }
        i = start;
    }
}

/// Every `"fsimg-<64 hex>"` string token in a JSON document: what GC keeps. A
/// user string can only produce a false POSITIVE (an extra file kept), never
/// hide a real ref: inside JSON a literal quote is escaped.
fn ref_digests(bytes: &[u8], out: &mut HashSet<String>) {
    scan_refs(bytes, REF_PREFIX, out);
}

/// The refs a document's `imageRef` keys name: what `autosave_write` requires
/// on disk. Narrower than `ref_digests` on purpose: a note or a group name
/// that merely contains `fsimg-<hex>` is not a ref, and refusing it would
/// refuse every later save of that document.
fn image_ref_digests(bytes: &[u8], out: &mut HashSet<String>) {
    scan_refs(bytes, IMAGE_REF_TOKEN, out);
}

/// The first image a document's `imageRef` keys name that is not on disk.
fn missing_image(dir: &Path, doc: &[u8]) -> Option<String> {
    let mut refs = HashSet::new();
    image_ref_digests(doc, &mut refs);
    refs.into_iter().find(|d| !image_path(dir, d).is_file())
}

/// A staging name no other call shares, `<name>.<pid>-<seq>.tmp-fastshaders`.
/// Async commands run concurrently, and the graph and the library can put the
/// same new image at once: with one shared staging name, one call removed or
/// renamed the other's file. `gc_dir` sweeps whatever a crash leaves.
fn staging_path(dir: &Path, name: &str) -> PathBuf {
    let seq = STAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    dir.join(format!("{name}.{}-{seq}{TMP_SUFFIX}", std::process::id()))
}

/// Write `bytes` to a fresh file at `tmp` via `create_new`, which never
/// follows a planted link: an existing entry is removed first.
fn stage(tmp: &Path, bytes: &[u8]) -> Result<(), String> {
    if tmp.symlink_metadata().is_ok() {
        fs::remove_file(tmp).map_err(|e| format!("E_IO {e}"))?;
    }
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp)
        .map_err(|e| format!("E_IO {e}"))?;
    if let Err(e) = f.write_all(bytes) {
        drop(f);
        let _ = fs::remove_file(tmp);
        return Err(format!("E_IO {e}"));
    }
    let _ = f.sync_all();
    Ok(())
}

/// Stage and rename over `dest`: work_folder.rs's pattern. `prev` rotates the
/// old file out first; a crash between the two renames leaves `prev`, which
/// boot reads.
fn write_atomic(dir: &Path, name: &str, bytes: &[u8], prev: Option<&str>) -> Result<(), String> {
    let dest = dir.join(name);
    let tmp = staging_path(dir, name);
    stage(&tmp, bytes)?;
    if let Some(p) = prev {
        if dest.exists() {
            let _ = fs::rename(&dest, dir.join(p));
        }
    }
    // Direct rename: atomic replace on Unix, MOVEFILE_REPLACE_EXISTING on
    // Windows. The remove+retry runs only if a filesystem refuses the replace.
    if let Err(first) = fs::rename(&tmp, &dest) {
        let _ = fs::remove_file(&dest);
        if fs::rename(&tmp, &dest).is_err() {
            let _ = fs::remove_file(&tmp);
            return Err(format!("E_IO {first}"));
        }
    }
    Ok(())
}

/// Whether `path` holds exactly the bytes whose SHA-256 is `digest`.
fn holds_digest(path: &Path, digest: &str) -> bool {
    fs::read(path).is_ok_and(|b| sha256_hex(&b) == digest)
}

/// Store an image payload under its digest in `dir/images` and return the
/// digest. Content-addressed, so a file at the destination that hashes to the
/// digest already holds these bytes: that is success, and it is never removed
/// (another call may have just committed it and reported Ok).
fn store_image(dir: &Path, bytes: &[u8]) -> Result<String, String> {
    let digest = sha256_hex(bytes);
    let dest = image_path(dir, &digest);
    if holds_digest(&dest, &digest) {
        return Ok(digest);
    }
    let tmp = staging_path(&dir.join(IMAGES_DIR), &format!("{digest}.{IMAGE_EXT}"));
    stage(&tmp, bytes)?;
    if let Err(e) = fs::rename(&tmp, &dest) {
        let _ = fs::remove_file(&tmp);
        if !holds_digest(&dest, &digest) {
            return Err(format!("E_IO {e}"));
        }
    }
    Ok(digest)
}

/// Delete every image no `.json` in `dir` names, plus staging leftovers in both
/// directories (it runs before a session's first write, so none is live).
/// Returns how many images it removed. A `.json` it cannot read aborts the
/// whole pass before anything is deleted: an unread document may name any of
/// them.
fn gc_dir(dir: &Path) -> Result<u32, String> {
    let mut keep = HashSet::new();
    // Entry errors propagate here (no `.flatten()`): a document the listing
    // could not report is as unread as one that could not be opened.
    for e in fs::read_dir(dir).map_err(|e| format!("E_IO {e}"))? {
        let p = e.map_err(|e| format!("E_IO {e}"))?.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            if p.to_str().is_some_and(|n| n.ends_with(TMP_SUFFIX)) {
                let _ = fs::remove_file(&p);
            }
            continue;
        }
        match fs::read(&p) {
            Ok(b) => ref_digests(&b, &mut keep),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("E_IO {e}")),
        }
    }
    let suffix = format!(".{IMAGE_EXT}");
    let mut removed = 0;
    for e in fs::read_dir(dir.join(IMAGES_DIR))
        .map_err(|e| format!("E_IO {e}"))?
        .flatten()
    {
        let Ok(name) = e.file_name().into_string() else {
            continue;
        };
        if name.ends_with(TMP_SUFFIX) {
            let _ = fs::remove_file(e.path());
            continue;
        }
        let Some(stem) = name.strip_suffix(suffix.as_str()) else {
            continue;
        };
        if is_digest(stem) && !keep.contains(stem) && fs::remove_file(e.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
pub async fn autosave_status(app: tauri::AppHandle) -> Result<AutosaveStatus, String> {
    Ok(AutosaveStatus {
        dir: root(&app)?.to_string_lossy().into_owned(),
    })
}

/// A document's bytes; an EMPTY body means the file is absent.
#[tauri::command]
pub async fn autosave_read(
    app: tauri::AppHandle,
    slot: String,
    which: String,
) -> Result<tauri::ipc::Response, String> {
    let dir = root(&app)?;
    let (cur, prev) = slot_files(&slot)?;
    let name = match which.as_str() {
        "current" => cur,
        "previous" => prev,
        _ => return Err("E_BAD_WHICH".into()),
    };
    let path = dir.join(name);
    match fs::metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(tauri::ipc::Response::new(Vec::new()))
        }
        Err(e) => return Err(format!("E_IO {e}")),
        Ok(m) if m.len() > MAX_DOC_BYTES => {
            return Err(format!("E_TOO_LARGE {} {}", m.len(), MAX_DOC_BYTES))
        }
        Ok(_) => {}
    }
    Ok(tauri::ipc::Response::new(
        fs::read(&path).map_err(|e| format!("E_IO {e}"))?,
    ))
}

/// Commit a document: the RAW body is its UTF-8 JSON and the slot rides the
/// `x-fs-slot` header. Refused when it names an image that is not on disk.
#[tauri::command]
pub async fn autosave_write(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("E_BAD_BODY".into());
    };
    let slot = request
        .headers()
        .get(SLOT_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "E_BAD_SLOT".to_string())?;
    let (cur, prev) = slot_files(slot)?;
    if bytes.len() as u64 > MAX_DOC_BYTES {
        return Err(format!("E_TOO_LARGE {} {}", bytes.len(), MAX_DOC_BYTES));
    }
    let dir = root(&app)?;
    if let Some(d) = missing_image(&dir, bytes) {
        return Err(format!("E_MISSING_IMAGE {d}"));
    }
    write_atomic(&dir, cur, bytes, Some(prev))
}

/// Store an image payload (the RAW body) and return its SHA-256 hex digest.
#[tauri::command]
pub async fn autosave_image_put(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("E_BAD_BODY".into());
    };
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(format!("E_TOO_LARGE {} {}", bytes.len(), MAX_IMAGE_BYTES));
    }
    if !is_image_payload(bytes) {
        return Err("E_BAD_IMAGE".into());
    }
    store_image(&root(&app)?, bytes)
}

/// An image payload by digest, re-verified against its name.
#[tauri::command]
pub async fn autosave_image_get(
    app: tauri::AppHandle,
    digest: String,
) -> Result<tauri::ipc::Response, String> {
    if !is_digest(&digest) {
        return Err("E_BAD_DIGEST".into());
    }
    let path = image_path(&root(&app)?, &digest);
    let meta = fs::metadata(&path).map_err(|_| "E_NOT_FOUND".to_string())?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!("E_TOO_LARGE {} {}", meta.len(), MAX_IMAGE_BYTES));
    }
    let bytes = fs::read(&path).map_err(|e| format!("E_IO {e}"))?;
    if sha256_hex(&bytes) != digest {
        return Err("E_CORRUPT_IMAGE".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn autosave_gc(app: tauri::AppHandle) -> Result<u32, String> {
    gc_dir(&root(&app)?)
}

/// Move a slot's current document aside as `<stem>.corrupt-<ms>.json`, so boot
/// can fall back to the backup and the next write does not rotate an
/// unreadable file over it.
#[tauri::command]
pub async fn autosave_quarantine(app: tauri::AppHandle, slot: String) -> Result<(), String> {
    let dir = root(&app)?;
    let (cur, _) = slot_files(&slot)?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stem = cur.trim_end_matches(".json");
    fs::rename(dir.join(cur), dir.join(format!("{stem}.corrupt-{ms}.json")))
        .map_err(|e| format!("E_IO {e}"))
}

/// The webview's answer to `fs:autosave-flush`. Sync: it touches no file.
#[tauri::command]
pub fn autosave_close_ready(
    app: tauri::AppHandle,
    state: tauri::State<'_, CloseState>,
) -> Result<(), String> {
    finish_close(&app, &state);
    Ok(())
}

fn finish_close(app: &tauri::AppHandle, state: &CloseState) {
    if state.done.swap(true, Ordering::SeqCst) {
        return;
    }
    if state.intent.load(Ordering::SeqCst) == INTENT_EXIT_APP {
        app.exit(0);
    } else if let Some(w) = app.get_webview_window("main") {
        let _ = w.destroy();
    }
}

/// main.rs's hooks. `true` means the caller must prevent the close or exit: a
/// flush was requested, or one is already in flight. The first request emits
/// `fs:autosave-flush` and arms the timeout; `autosave_close_ready` or the
/// timeout then finishes whichever intent is the larger.
pub fn request_flush(app: &tauri::AppHandle, intent: u8) -> bool {
    let state = app.state::<CloseState>();
    if state.done.load(Ordering::SeqCst) {
        return false;
    }
    state.intent.fetch_max(intent, Ordering::SeqCst);
    if !state.flushing.swap(true, Ordering::SeqCst) {
        let _ = app.emit(FLUSH_EVENT, ());
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(CLOSE_TIMEOUT);
            let st = handle.state::<CloseState>();
            finish_close(&handle, &st);
        });
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory under the system temp dir, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!(
                "fs-autosave-test-{tag}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(dir.join(IMAGES_DIR)).expect("scratch dir");
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn digest_of(c: char) -> String {
        c.to_string().repeat(DIGEST_LEN)
    }

    fn refs_in(doc: &str) -> Vec<String> {
        let mut out = HashSet::new();
        ref_digests(doc.as_bytes(), &mut out);
        let mut v: Vec<String> = out.into_iter().collect();
        v.sort();
        v
    }

    fn image_refs_in(doc: &str) -> Vec<String> {
        let mut out = HashSet::new();
        image_ref_digests(doc.as_bytes(), &mut out);
        let mut v: Vec<String> = out.into_iter().collect();
        v.sort();
        v
    }

    /// Every staging leftover under `dir` (not recursive).
    fn staged_in(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(TMP_SUFFIX))
            .collect()
    }

    #[test]
    fn is_digest_accepts_only_64_lowercase_hex() {
        assert!(is_digest(&digest_of('a')));
        assert!(is_digest(&"0123456789abcdef".repeat(4)));
        assert!(!is_digest(&"a".repeat(63)));
        assert!(!is_digest(&"a".repeat(65)));
        assert!(!is_digest(&digest_of('A')));
        assert!(!is_digest(&digest_of('g')));
        assert!(!is_digest(""));
        assert!(!is_digest(&format!("../{}", "a".repeat(61))));
    }

    #[test]
    fn slot_files_is_a_closed_vocabulary() {
        assert_eq!(slot_files("graph"), Ok(("graph.json", "graph.prev.json")));
        assert_eq!(
            slot_files("savedGroups"),
            Ok(("saved-groups.json", "saved-groups.prev.json"))
        );
        for bad in ["x", "../graph", "Graph", "graph.json", "", "saved-groups"] {
            assert_eq!(slot_files(bad), Err("E_BAD_SLOT".to_string()), "{bad}");
        }
    }

    #[test]
    fn sha256_hex_matches_the_published_vectors() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert!(is_digest(&sha256_hex(b"data:image/png;base64,AAAA")));
    }

    #[test]
    fn ref_digests_finds_valid_tokens_only() {
        let a = digest_of('a');
        let b = digest_of('b');
        // One valid token.
        assert_eq!(
            refs_in(&format!(r#"{{"imageRef":"fsimg-{a}"}}"#)),
            vec![a.clone()]
        );
        // Two, and the same one twice counts once.
        assert_eq!(
            refs_in(&format!(r#"["fsimg-{a}","fsimg-{b}","fsimg-{a}"]"#)),
            vec![a.clone(), b.clone()]
        );
        // 63 hex digits, upper case, a non-hex digit.
        assert!(refs_in(&format!(r#"["fsimg-{}"]"#, &a[1..])).is_empty());
        assert!(refs_in(&format!(r#"["fsimg-{}"]"#, digest_of('A'))).is_empty());
        assert!(refs_in(&format!(r#"["fsimg-{}g"]"#, &a[1..])).is_empty());
        // 64 digits not followed by the closing quote (a longer string).
        assert!(refs_in(&format!(r#"["fsimg-{a}0"]"#)).is_empty());
        // A token at the very end of the buffer, unterminated.
        assert!(refs_in(&format!(r#"["fsimg-{a}"#)).is_empty());
        // Terminated by the buffer's last byte.
        assert_eq!(refs_in(&format!(r#""fsimg-{a}""#)), vec![a.clone()]);
        // A decoy prefix right before a real token does not hide it.
        assert_eq!(refs_in(&format!(r#""fsimg-"fsimg-{b}""#)), vec![b.clone()]);
        // No prefix at all.
        assert!(refs_in(&format!(r#"["img1-{a}"]"#)).is_empty());
        assert!(refs_in("").is_empty());
    }

    #[test]
    fn image_ref_digests_counts_only_the_image_ref_key() {
        let a = digest_of('a');
        // What the webview writes for an Image node.
        assert_eq!(
            image_refs_in(&format!(
                r#"{{"values":{{"imageB64":"","imageRef":"fsimg-{a}"}}}}"#
            )),
            vec![a.clone()]
        );
        // A note's text that IS a ref, and a group name ending in one (the
        // escaped quote): neither is a ref here, while GC's broad scan still
        // keeps them (a false positive there only keeps a file).
        for doc in [
            format!(r#"{{"data":{{"text":"fsimg-{a}"}}}}"#),
            format!(r#"[{{"name":"see \"fsimg-{a}","nodes":[]}}]"#),
        ] {
            assert!(image_refs_in(&doc).is_empty(), "{doc}");
            assert_eq!(refs_in(&doc), vec![a.clone()], "{doc}");
        }
        // A key look-alike inside a string: its quotes are escaped.
        assert!(image_refs_in(&format!(r#"{{"text":"\"imageRef\":\"fsimg-{a}\""}}"#)).is_empty());
    }

    #[test]
    fn missing_image_refuses_only_an_image_ref_that_is_not_on_disk() {
        let s = Scratch::new("missing");
        let (a, b) = (digest_of('a'), digest_of('b'));
        fs::write(image_path(&s.0, &a), b"data:image/png;base64,AAAA").unwrap();
        let on_disk = format!(r#"{{"nodes":[{{"values":{{"imageRef":"fsimg-{a}"}}}}]}}"#);
        assert_eq!(missing_image(&s.0, on_disk.as_bytes()), None);
        let gone = format!(r#"{{"nodes":[{{"values":{{"imageRef":"fsimg-{b}"}}}}]}}"#);
        assert_eq!(missing_image(&s.0, gone.as_bytes()), Some(b.clone()));
        // A note whose text merely spells a ref never blocks a save.
        let note = format!(r#"{{"nodes":[{{"data":{{"text":"fsimg-{b}"}}}}]}}"#);
        assert_eq!(missing_image(&s.0, note.as_bytes()), None);
    }

    #[test]
    fn is_image_payload_takes_the_three_stored_types() {
        assert!(is_image_payload(b"data:image/png;base64,AAAA"));
        assert!(is_image_payload(b"data:image/jpeg;base64,/9j/4AAQ=="));
        assert!(is_image_payload(b"data:image/webp;base64,UklGRg+/"));
        assert!(!is_image_payload(b"data:image/svg+xml;base64,PHN2Zz4="));
        assert!(!is_image_payload(b"data:image/gif;base64,R0lGOD"));
        assert!(!is_image_payload(b"hello"));
        assert!(!is_image_payload(b"data:image/png;base64,AA AA"));
        assert!(!is_image_payload(b"data:image/png;base64,AAAA\n"));
        assert!(!is_image_payload(b""));
    }

    #[test]
    fn write_atomic_creates_then_rotates_the_backup() {
        let s = Scratch::new("rotate");
        write_atomic(&s.0, "graph.json", b"one", Some("graph.prev.json")).unwrap();
        assert_eq!(fs::read(s.0.join("graph.json")).unwrap(), b"one");
        assert!(!s.0.join("graph.prev.json").exists());

        write_atomic(&s.0, "graph.json", b"two", Some("graph.prev.json")).unwrap();
        assert_eq!(fs::read(s.0.join("graph.json")).unwrap(), b"two");
        assert_eq!(fs::read(s.0.join("graph.prev.json")).unwrap(), b"one");

        write_atomic(&s.0, "graph.json", b"three", Some("graph.prev.json")).unwrap();
        assert_eq!(fs::read(s.0.join("graph.json")).unwrap(), b"three");
        assert_eq!(fs::read(s.0.join("graph.prev.json")).unwrap(), b"two");
        assert!(staged_in(&s.0).is_empty());
    }

    #[test]
    fn write_atomic_without_prev_keeps_no_backup() {
        let s = Scratch::new("noprev");
        let images = s.0.join(IMAGES_DIR);
        write_atomic(&images, "x.txt", b"a", None).unwrap();
        write_atomic(&images, "x.txt", b"b", None).unwrap();
        assert_eq!(fs::read(images.join("x.txt")).unwrap(), b"b");
        let names: Vec<_> = fs::read_dir(&images).unwrap().flatten().collect();
        assert_eq!(names.len(), 1);
    }

    #[test]
    fn every_call_stages_under_its_own_name() {
        let s = Scratch::new("names");
        let a = staging_path(&s.0, "x.txt");
        let b = staging_path(&s.0, "x.txt");
        assert_ne!(a, b);
        for p in [&a, &b] {
            let n = p.file_name().unwrap().to_str().unwrap();
            assert!(n.starts_with("x.txt.") && n.ends_with(TMP_SUFFIX), "{n}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn stage_never_writes_through_a_planted_link() {
        let s = Scratch::new("link");
        let outside = s.0.join("outside.txt");
        fs::write(&outside, b"keep me").unwrap();
        let tmp = s.0.join(format!("graph.json{TMP_SUFFIX}"));
        std::os::unix::fs::symlink(&outside, &tmp).unwrap();
        stage(&tmp, b"doc").unwrap();
        assert_eq!(fs::read(&outside).unwrap(), b"keep me");
        assert!(!tmp.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&tmp).unwrap(), b"doc");
    }

    #[test]
    fn store_image_stores_once_and_takes_a_matching_file_as_done() {
        let s = Scratch::new("store");
        let payload = b"data:image/png;base64,AAAA";
        let d = store_image(&s.0, payload).unwrap();
        assert_eq!(d, sha256_hex(payload));
        assert_eq!(fs::read(image_path(&s.0, &d)).unwrap(), payload);
        assert_eq!(store_image(&s.0, payload).unwrap(), d);
        // A damaged file under the digest is replaced.
        fs::write(image_path(&s.0, &d), b"damaged").unwrap();
        assert_eq!(store_image(&s.0, payload).unwrap(), d);
        assert_eq!(fs::read(image_path(&s.0, &d)).unwrap(), payload);
        assert!(staged_in(&s.0.join(IMAGES_DIR)).is_empty());
    }

    /// The graph and the library saving one new image at once: both calls
    /// must succeed, and the image must be on disk afterwards. With one shared
    /// staging name, one call removed or renamed the other's staging file.
    #[test]
    fn two_concurrent_puts_of_one_image_both_succeed() {
        use std::sync::{Arc, Barrier};
        let mut payload = b"data:image/png;base64,".to_vec();
        payload.resize(payload.len() + (2 << 20), b'A');
        let payload = Arc::new(payload);
        let digest = sha256_hex(&payload);
        for round in 0..12 {
            let s = Scratch::new(&format!("race{round}"));
            let barrier = Arc::new(Barrier::new(2));
            let workers: Vec<_> = (0..2)
                .map(|_| {
                    let (dir, p, b) = (s.0.clone(), Arc::clone(&payload), Arc::clone(&barrier));
                    std::thread::spawn(move || {
                        b.wait();
                        store_image(&dir, &p)
                    })
                })
                .collect();
            for w in workers {
                assert_eq!(w.join().unwrap(), Ok(digest.clone()), "round {round}");
            }
            assert!(
                holds_digest(&image_path(&s.0, &digest), &digest),
                "round {round}"
            );
            assert!(staged_in(&s.0.join(IMAGES_DIR)).is_empty(), "round {round}");
        }
    }

    #[test]
    fn gc_dir_keeps_every_named_image_and_deletes_the_rest() {
        let s = Scratch::new("gc");
        let (d1, d2, d3, d4) = (
            digest_of('1'),
            digest_of('2'),
            digest_of('3'),
            digest_of('4'),
        );
        let images = s.0.join(IMAGES_DIR);
        for d in [&d1, &d2, &d3, &d4] {
            fs::write(
                images.join(format!("{d}.{IMAGE_EXT}")),
                b"data:image/png;base64,AAAA",
            )
            .unwrap();
        }
        let staged = images.join(format!("{}.{IMAGE_EXT}{TMP_SUFFIX}", digest_of('5')));
        fs::write(&staged, b"half").unwrap();
        fs::write(images.join("notes.txt"), b"not a digest").unwrap();
        fs::write(s.0.join("graph.json"), format!(r#"{{"a":"fsimg-{d1}"}}"#)).unwrap();
        fs::write(s.0.join("graph.prev.json"), format!(r#"["fsimg-{d2}"]"#)).unwrap();
        // A quarantined document is unparseable JSON, but its refs still count.
        fs::write(
            s.0.join("saved-groups.corrupt-123.json"),
            format!(r#"["fsimg-{d3}", tru"#),
        )
        .unwrap();
        // A staged document is not a document: it keeps nothing, and it is
        // swept (staging names are unique per call, so no later write reuses it).
        let staged_doc = s.0.join(format!("graph.json.1-2{TMP_SUFFIX}"));
        fs::write(&staged_doc, format!(r#"["fsimg-{d4}"]"#)).unwrap();

        assert_eq!(gc_dir(&s.0).unwrap(), 1);
        for d in [&d1, &d2, &d3] {
            assert!(images.join(format!("{d}.{IMAGE_EXT}")).exists(), "{d} kept");
        }
        assert!(!images.join(format!("{d4}.{IMAGE_EXT}")).exists());
        assert!(!staged.exists());
        assert!(!staged_doc.exists());
        assert!(images.join("notes.txt").exists());
        // A second pass has nothing left to do.
        assert_eq!(gc_dir(&s.0).unwrap(), 0);
    }

    #[test]
    fn gc_dir_deletes_nothing_when_a_document_cannot_be_read() {
        let s = Scratch::new("gcfail");
        let d = digest_of('9');
        let img = s.0.join(IMAGES_DIR).join(format!("{d}.{IMAGE_EXT}"));
        fs::write(&img, b"data:image/png;base64,AAAA").unwrap();
        // A directory named like a document: reading it fails on every OS.
        fs::create_dir(s.0.join("graph.json")).unwrap();
        assert!(gc_dir(&s.0).unwrap_err().starts_with("E_IO"));
        assert!(img.exists());
    }
}
