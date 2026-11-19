//! Local-LLM bridge: the desktop app's way to reach a model server running on
//! THIS computer (LM Studio, llama.cpp, Ollama) for the prompt-to-graph
//! generator. Rust makes the request because the webview cannot: a fetch from
//! `tauri://localhost` (or `http://tauri.localhost` on Windows) is cross-origin
//! to `http://127.0.0.1:1234`, so it needs the server's CORS switch, and Ollama
//! answers the Windows app's origin with 403. This client sends no origin
//! header at all, so neither applies.
//!
//! ## The boundary
//!
//! - **Caller**: every command refuses unless `webview.label()` is `main`.
//!   Capabilities do not scope APP commands (build.rs declares no
//!   `AppManifest`), so the podest window could otherwise call these too; the
//!   label is the only caller identity a command has.
//! - **Target**: a base URL parsed by `parse_base`, a strict hand-written check
//!   that accepts exactly `http://` + `127.0.0.1` | `localhost` | `[::1]` + an
//!   explicit port 1–65535 + an optional trailing `/`, and nothing else (no
//!   userinfo, no `127.1`, no hex/decimal IPv4, no IPv4-mapped IPv6, no path,
//!   query or fragment). It connects by `SocketAddr` with no DNS lookup:
//!   `localhost` tries 127.0.0.1 first, then ::1, because LM Studio, Ollama and
//!   llama.cpp listen on IPv4 only. `src-tauri/tests/llm-urls.json` holds the
//!   cases this parser and the frontend's `normalizeLocalBase` share.
//! - **Paths**: the exact allow-lists `GET_ROUTES` / `POST_ROUTES`.
//! - **Headers**: `Host` exactly as the base spells it, `Content-Type` and
//!   `Content-Length` (POST), `Accept`, `Accept-Encoding: identity` and
//!   `Connection: close`. Nothing else, so no browser-style origin and no
//!   `Expect`.
//! - **Answers**: only `200` is success. A 3xx is refused (never followed); any
//!   other status becomes `E_HTTP <status>: <excerpt>`, the excerpt at most 300
//!   characters with control and invisible characters removed. Bodies may be
//!   Content-Length, chunked (decoded here: `ChunkDecoder`) or close-delimited.
//! - **Caps**: request 1 MiB, streamed body 8 MiB, model list 1 MiB, response
//!   head 16 KiB.
//! - **Time**: connect 3 s per address; then a first-byte window for the BODY
//!   (300 s: a just-in-time model load plus prompt processing happen before
//!   the first token), 120 s allowed between received bytes after that, and
//!   900 s in all. The model list uses a shorter set (`LIST_TIMEOUTS`).
//! - **One request at a time**: a second one gets `E_BUSY`.
//!
//! ## The read loop
//!
//! The socket is non-blocking and polled every 20 ms, checking cancel, the
//! first-byte, between-chunks and total deadlines by `Instant`. Nothing relies
//! on `shutdown` waking a blocked `recv` (undocumented on Windows) or on
//! `SO_RCVTIMEO` (a timed-out blocking receive leaves a Winsock socket in an
//! indeterminate state). A cancel registered before the request reached the
//! slot is remembered (`early_cancel`), and the request id is registered
//! before connecting, so no cancel is lost. A page load in the main window
//! cancels whatever its old page left running (`page_load_guard`, a plugin
//! hook main.rs registers), or the slot would answer `E_BUSY` until that
//! stream timed out. The exchange runs under `spawn_blocking`, never on an
//! async worker.
//!
//! ## Channel protocol (`llm_local_chat`)
//!
//! Mirrored by `src/llm/transport/tauriTransport.ts`; the tags are
//! `LLM_FRAME_DATA` / `LLM_FRAME_END` in `src/utils/desktopIpc.ts`.
//!
//! 1. Every message is `InvokeResponseBody::Raw` (JS receives an ArrayBuffer).
//!    Byte 0 is the tag: `FRAME_DATA` (1) — the rest is response-body bytes,
//!    de-chunked, in order, batched at about 16 KiB or 50 ms; `FRAME_END` (2) —
//!    the rest is the final status as UTF-8: empty when a 200 body ended
//!    cleanly, else an `E_…` string.
//! 2. Exactly one END is sent, always last, for every outcome the command body
//!    decides — a refused URL or `E_BUSY` included — and the command resolves
//!    `Ok` only AFTER sending it. Frames of 1 KiB or more are fetched by the
//!    webview asynchronously and can land after that promise resolves, so JS
//!    completes on END, never on the promise.
//! 3. The command REJECTS only when no frame was or will be sent: the caller
//!    is not the main webview (`E_FORBIDDEN`), or Tauri refused the arguments
//!    before the body ran. JS treats a rejection as final too.
//!
//! **Why raw only**: a `String` sent through `Channel<InvokeResponseBody>`
//! converts to the `Json` variant, which Tauri pastes UNQUOTED into an `eval`
//! in the main window — whatever answers on the loopback port could then run
//! script beside every command. Raw bytes become a numeric array or a fetched
//! ArrayBuffer. desktopIpcContract.test.ts pins that this file never builds
//! the `Json` variant and sends nothing but `Raw`. The model list returns raw
//! bytes the same way (`ipc::Response`); its `E_…` errors travel as the
//! command's serde-serialized error string, which is quoted, not pasted.
//!
//! Errors are `E_<CODE>` strings parsed by `parseDesktopError`
//! (src/utils/desktopIpc.ts): BAD_URL, BAD_ROUTE, BUSY, UNREACHABLE <why>,
//! TIMEOUT <why>, CANCELLED, TOO_LARGE <n> <limit>, HTTP <status>: <excerpt>,
//! BAD_RESPONSE <why>, FORBIDDEN.

use std::io::{self, ErrorKind, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::webview::PageLoadEvent;
use tauri::Manager;

/// The only webview these commands answer.
const MAIN_WEBVIEW: &str = "main";
/// The refusal for any other caller; it never reaches the main window.
const FORBIDDEN: &str = "E_FORBIDDEN";

/// Paths a GET may request (`LLM_LOCAL_GET_ROUTES`). `/api/v1/models` is LM
/// Studio's native list, the only route that reports a loaded model's context
/// length; `/api/tags` and `/api/version` are Ollama's.
const GET_ROUTES: [&str; 4] = ["/v1/models", "/api/v1/models", "/api/tags", "/api/version"];
/// Paths a POST may request (`LLM_LOCAL_POST_ROUTES`): OpenAI-compatible chat
/// (LM Studio, llama.cpp) and Ollama's native chat.
const POST_ROUTES: [&str; 2] = ["/v1/chat/completions", "/api/chat"];
/// The host spellings `parse_base` accepts (`LLM_LOOPBACK_HOSTS`).
const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

/// = `LLM_MAX_REQUEST_BYTES`: the largest chat request body.
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
/// = `LLM_MAX_STREAM_BYTES`: the most body bytes one chat answer may stream.
const MAX_STREAM_BYTES: usize = 8 * 1024 * 1024;
/// = `LLM_MAX_MODEL_LIST_BYTES`: the largest GET body.
const MAX_MODEL_LIST_BYTES: usize = 1024 * 1024;
/// The response head (status line and headers).
const MAX_HEADER_BYTES: usize = 16 * 1024;

/// Channel frame tags, byte 0 of every message (`LLM_FRAME_DATA` /
/// `LLM_FRAME_END`). 0 is never a tag, so an empty or zeroed message is
/// detectably wrong.
const FRAME_DATA: u8 = 1;
const FRAME_END: u8 = 2;

/// How often the read loop wakes when the socket has nothing.
const POLL: Duration = Duration::from_millis(20);
/// A data frame is sent once this much body is pending…
const BATCH_BYTES: usize = 16 * 1024;
/// …or once the oldest pending byte has waited this long.
const BATCH_INTERVAL: Duration = Duration::from_millis(50);
const READ_CHUNK: usize = 16 * 1024;

/// What an `E_HTTP` excerpt keeps.
const EXCERPT_CHARS: usize = 300;
/// How much of an error body is read for that excerpt…
const EXCERPT_SOURCE_BYTES: usize = 4 * 1024;
/// …and for how long after the error status arrived.
const ERROR_BODY_WAIT: Duration = Duration::from_secs(2);

/// 1xx heads skipped before the real one (none of the target servers sends
/// any: nothing here asks for `100 Continue`).
const MAX_INTERIM_RESPONSES: u8 = 4;
/// A chunk-size line, extensions included.
const MAX_CHUNK_LINE_BYTES: usize = 1024;
/// The trailer section after the last chunk.
const MAX_TRAILER_BYTES: usize = 8 * 1024;

/// How long a new request waits for a CANCELLED one to leave the slot — the
/// user pressed Cancel and then Generate again before the old loop noticed.
/// Covers connect attempts in progress (3 s per address, two for `localhost`),
/// which a cancel cannot interrupt.
const HOLDER_EXIT_WAIT: Duration = Duration::from_secs(7);
/// How long a cancel that arrived before its request is remembered.
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug)]
struct Timeouts {
    /// Each connect attempt.
    connect: Duration,
    /// From connect until the first BODY byte (not the head: a server may send
    /// its 200 head at once and stream nothing until the model is loaded).
    first_byte: Duration,
    /// Between received bytes once the body has started.
    between_chunks: Duration,
    /// The whole request.
    total: Duration,
}

/// A chat completion: model load and prompt processing precede the first token.
const CHAT_TIMEOUTS: Timeouts = Timeouts {
    connect: Duration::from_secs(3),
    first_byte: Duration::from_secs(300),
    between_chunks: Duration::from_secs(120),
    total: Duration::from_secs(900),
};
/// A model list or version: the servers answer these at once, even while a
/// generation runs, so a stalled answer is a stuck server.
const LIST_TIMEOUTS: Timeouts = Timeouts {
    connect: Duration::from_secs(3),
    first_byte: Duration::from_secs(30),
    between_chunks: Duration::from_secs(30),
    total: Duration::from_secs(60),
};

// ---------------------------------------------------------------------------
// State: the one in-flight request and its cancel flag
// ---------------------------------------------------------------------------

/// Managed state (main.rs `.manage(llm::LlmState::default())`).
#[derive(Default)]
pub struct LlmState(Arc<Shared>);

/// A plugin with one hook: when the MAIN window starts loading a page (a
/// reload, the toolbar's hard reload), cancel the request its old page left
/// running — that page is gone, nothing else would ever cancel it, and the slot
/// would answer `E_BUSY` until the stream timed out. A plugin rather than the
/// builder's own `on_page_load`, which keeps only the LAST hook set; plugin
/// hooks all run. `Started` fires for main-frame documents only (WKWebView's
/// navigation commit, WebView2's top-level `ContentLoading`), so the preview
/// iframe's constant rebuilds never reach it.
pub fn page_load_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("llm-bridge")
        .on_page_load(|webview, payload| {
            if webview.label() == MAIN_WEBVIEW && payload.event() == PageLoadEvent::Started {
                if let Some(state) = webview.try_state::<LlmState>() {
                    state.0.cancel_all();
                }
            }
        })
        .build()
}

#[derive(Default)]
struct Shared(Mutex<Slot>);

#[derive(Default)]
struct Slot {
    current: Option<InFlight>,
    /// A cancel for an id that was not in flight: honoured if that id arrives
    /// within `EARLY_CANCEL_TTL` (the cancel command can run before the chat
    /// command's body does).
    early_cancel: Option<(u64, Instant)>,
}

struct InFlight {
    id: u64,
    cancel: Arc<AtomicBool>,
}

/// Holding the slot. Dropping it frees the slot.
struct Lease<'a> {
    shared: &'a Shared,
    id: u64,
    cancel: Arc<AtomicBool>,
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        let mut slot = self.shared.lock();
        let mine = slot
            .current
            .as_ref()
            .is_some_and(|c| c.id == self.id && Arc::ptr_eq(&c.cancel, &self.cancel));
        if mine {
            slot.current = None;
        }
    }
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Slot> {
        // The slot holds plain data; a panic elsewhere cannot leave it torn.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn acquire(&self, id: u64) -> Result<Lease<'_>, Failure> {
        let give_up = Instant::now() + HOLDER_EXIT_WAIT;
        loop {
            {
                let mut slot = self.lock();
                match slot
                    .current
                    .as_ref()
                    .map(|c| c.cancel.load(Ordering::SeqCst))
                {
                    None => {
                        let cancel = Arc::new(AtomicBool::new(false));
                        if let Some((early, at)) = slot.early_cancel {
                            if early == id {
                                slot.early_cancel = None;
                                if at.elapsed() <= EARLY_CANCEL_TTL {
                                    cancel.store(true, Ordering::SeqCst);
                                }
                            }
                        }
                        slot.current = Some(InFlight {
                            id,
                            cancel: Arc::clone(&cancel),
                        });
                        return Ok(Lease {
                            shared: self,
                            id,
                            cancel,
                        });
                    }
                    // The holder was cancelled and is on its way out.
                    Some(true) if Instant::now() < give_up => {}
                    Some(_) => return Err(Failure::Busy),
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn cancel(&self, id: u64) {
        let mut slot = self.lock();
        match slot.current.as_ref() {
            Some(c) if c.id == id => c.cancel.store(true, Ordering::SeqCst),
            _ => slot.early_cancel = Some((id, Instant::now())),
        }
    }

    fn cancel_all(&self) {
        let mut slot = self.lock();
        if let Some(c) = slot.current.as_ref() {
            c.cancel.store(true, Ordering::SeqCst);
        }
        slot.early_cancel = None;
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// GET an allow-listed path (a model list, a server version) and return the
/// whole body as RAW bytes — an ArrayBuffer in the webview, decoded there.
#[tauri::command]
pub async fn llm_local_models(
    webview: tauri::Webview,
    state: tauri::State<'_, LlmState>,
    base: String,
    path: String,
    request_id: u64,
) -> Result<Response, String> {
    if webview.label() != MAIN_WEBVIEW {
        return Err(FORBIDDEN.to_string());
    }
    let shared = Arc::clone(&state.0);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let request = HttpRequest {
            base: &base,
            method: Method::Get,
            path: &path,
            body: &[],
        };
        let mut body = Vec::new();
        let result = perform(&shared, request_id, &request, LIST_TIMEOUTS, &mut |batch| {
            body.extend_from_slice(&batch);
            true
        });
        result.map(|()| body)
    })
    .await
    .unwrap_or_else(|e| Err(Failure::BadResponse(format!("bridge task failed: {e}"))));
    outcome
        .map(|bytes| Response::new(InvokeResponseBody::Raw(bytes)))
        .map_err(|f| f.status())
}

/// POST a chat request and stream the answer's body over `on_event` — the
/// channel protocol in the module header. Resolves only after the END frame.
#[tauri::command]
pub async fn llm_local_chat(
    webview: tauri::Webview,
    state: tauri::State<'_, LlmState>,
    base: String,
    path: String,
    body: String,
    request_id: u64,
    on_event: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    if webview.label() != MAIN_WEBVIEW {
        return Err(FORBIDDEN.to_string());
    }
    let shared = Arc::clone(&state.0);
    let events = on_event.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let request = HttpRequest {
            base: &base,
            method: Method::Post,
            path: &path,
            body: body.as_bytes(),
        };
        perform(&shared, request_id, &request, CHAT_TIMEOUTS, &mut |batch| {
            // A failed send means the webview is gone: stop, the server sees
            // the disconnect.
            events
                .send(InvokeResponseBody::Raw(frame(FRAME_DATA, &batch)))
                .is_ok()
        })
    })
    .await
    .unwrap_or_else(|e| Err(Failure::BadResponse(format!("bridge task failed: {e}"))));
    // Exactly one END, always last.
    let _ = on_event.send(InvokeResponseBody::Raw(frame(
        FRAME_END,
        end_status(&outcome).as_bytes(),
    )));
    Ok(())
}

/// Cancel request `request_id`: the read loop notices within one poll and
/// closes the socket, so the server sees the disconnect and stops generating.
/// A cancel for a request that has not reached the slot yet is remembered.
#[tauri::command]
pub async fn llm_local_cancel(
    webview: tauri::Webview,
    state: tauri::State<'_, LlmState>,
    request_id: u64,
) -> Result<(), String> {
    if webview.label() != MAIN_WEBVIEW {
        return Err(FORBIDDEN.to_string());
    }
    state.0.cancel(request_id);
    Ok(())
}

fn frame(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 1);
    out.push(tag);
    out.extend_from_slice(payload);
    out
}

/// The END frame's payload: empty for success, else the `E_…` status.
fn end_status(outcome: &Result<(), Failure>) -> String {
    match outcome {
        Ok(()) => String::new(),
        Err(failure) => failure.status(),
    }
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Failure {
    BadUrl,
    BadRoute,
    Busy,
    Unreachable(String),
    Timeout(String),
    Cancelled,
    TooLarge { n: u64, limit: u64 },
    Http { status: u16, excerpt: String },
    BadResponse(String),
}

impl Failure {
    /// The `E_<CODE>` string the frontend parses.
    fn status(&self) -> String {
        match self {
            Failure::BadUrl => "E_BAD_URL".to_string(),
            Failure::BadRoute => "E_BAD_ROUTE".to_string(),
            Failure::Busy => "E_BUSY".to_string(),
            Failure::Unreachable(why) => format!("E_UNREACHABLE {why}"),
            Failure::Timeout(why) => format!("E_TIMEOUT {why}"),
            Failure::Cancelled => "E_CANCELLED".to_string(),
            Failure::TooLarge { n, limit } => format!("E_TOO_LARGE {n} {limit}"),
            Failure::Http { status, excerpt } => {
                format!("E_HTTP {status}: {excerpt}").trim_end().to_string()
            }
            Failure::BadResponse(why) => format!("E_BAD_RESPONSE {why}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Base URL and routes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct Base {
    /// One of `LOOPBACK_HOSTS`, as typed.
    host: &'static str,
    port: u16,
}

impl Base {
    /// The `Host` header: exactly the base's own spelling.
    fn host_header(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    /// Where to connect, in order. No resolver is involved.
    fn addrs(&self) -> Vec<SocketAddr> {
        let v4 = SocketAddr::from((Ipv4Addr::LOCALHOST, self.port));
        let v6 = SocketAddr::from((Ipv6Addr::LOCALHOST, self.port));
        match self.host {
            "localhost" => vec![v4, v6],
            "[::1]" => vec![v6],
            _ => vec![v4],
        }
    }
}

/// The strict base check (module header). Every other spelling is refused.
fn parse_base(text: &str) -> Option<Base> {
    let rest = text.strip_prefix("http://")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let (host, port) = rest.rsplit_once(':')?;
    let host = LOOPBACK_HOSTS.iter().copied().find(|h| *h == host)?;
    Some(Base {
        host,
        port: parse_port(port)?,
    })
}

/// 1–65535 in plain ASCII digits, no sign, no leading zero.
fn parse_port(text: &str) -> Option<u16> {
    if text.is_empty()
        || text.len() > 5
        || text.starts_with('0')
        || !text.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    text.parse::<u16>().ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Method {
    Get,
    Post,
}

fn route_allowed(method: Method, path: &str) -> bool {
    match method {
        Method::Get => GET_ROUTES.contains(&path),
        Method::Post => POST_ROUTES.contains(&path),
    }
}

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

struct HttpRequest<'a> {
    base: &'a str,
    method: Method,
    path: &'a str,
    body: &'a [u8],
}

/// Validate, take the slot, run the exchange. Body bytes of a 200 answer go to
/// `sink` in batches; a `false` from it stops the request as cancelled.
fn perform(
    shared: &Shared,
    request_id: u64,
    request: &HttpRequest<'_>,
    timeouts: Timeouts,
    sink: &mut dyn FnMut(Vec<u8>) -> bool,
) -> Result<(), Failure> {
    let base = parse_base(request.base).ok_or(Failure::BadUrl)?;
    if !route_allowed(request.method, request.path) {
        return Err(Failure::BadRoute);
    }
    if request.body.len() > MAX_REQUEST_BYTES {
        return Err(Failure::TooLarge {
            n: request.body.len() as u64,
            limit: MAX_REQUEST_BYTES as u64,
        });
    }
    let cap = match request.method {
        Method::Get => MAX_MODEL_LIST_BYTES,
        Method::Post => MAX_STREAM_BYTES,
    };
    let lease = shared.acquire(request_id)?;
    exchange(&base, request, cap, timeouts, &lease.cancel, sink)
}

fn request_bytes(base: &Base, request: &HttpRequest<'_>) -> Vec<u8> {
    let host = base.host_header();
    let head = match request.method {
        Method::Get => format!(
            "GET {} HTTP/1.1\r\nHost: {host}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n",
            request.path
        ),
        Method::Post => format!(
            "POST {} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccept: text/event-stream, application/x-ndjson, application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n",
            request.path,
            request.body.len()
        ),
    };
    let mut bytes = head.into_bytes();
    bytes.extend_from_slice(request.body);
    bytes
}

fn connect(base: &Base, timeout: Duration, cancel: &AtomicBool) -> Result<TcpStream, Failure> {
    let mut problems = Vec::new();
    for addr in base.addrs() {
        if cancel.load(Ordering::SeqCst) {
            return Err(Failure::Cancelled);
        }
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => return Ok(stream),
            Err(e) => problems.push(format!("{addr}: {}", describe_connect_error(&e, timeout))),
        }
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(Failure::Cancelled);
    }
    let mut why = problems.join("; ");
    if base.host == "[::1]" {
        why.push_str(" (LM Studio and Ollama listen on 127.0.0.1, not ::1)");
    }
    Err(Failure::Unreachable(why))
}

fn describe_connect_error(e: &io::Error, timeout: Duration) -> String {
    match e.kind() {
        ErrorKind::ConnectionRefused => "connection refused".to_string(),
        // On Windows a refused loopback connect retries for about 2 s, so a
        // timeout here still means nothing is accepting connections.
        ErrorKind::TimedOut | ErrorKind::WouldBlock => {
            format!("no answer within {}", seconds(timeout))
        }
        _ => e.to_string(),
    }
}

fn seconds(d: Duration) -> String {
    if d >= Duration::from_secs(1) {
        format!("{} s", d.as_secs())
    } else {
        format!("{} ms", d.as_millis())
    }
}

fn would_wait(e: &io::Error) -> bool {
    matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted)
}

fn flush(pending: &mut Vec<u8>, sink: &mut dyn FnMut(Vec<u8>) -> bool) -> Result<(), Failure> {
    if pending.is_empty() || sink(std::mem::take(pending)) {
        Ok(())
    } else {
        Err(Failure::Cancelled)
    }
}

/// The first deadline `now` has passed, if any.
fn overdue(
    t: &Timeouts,
    started: Instant,
    connected: Instant,
    last_rx: Instant,
    body_seen: bool,
    now: Instant,
) -> Option<Failure> {
    if now.duration_since(started) >= t.total {
        return Some(Failure::Timeout(format!(
            "the request ran past {}",
            seconds(t.total)
        )));
    }
    if !body_seen {
        if now.duration_since(connected) >= t.first_byte {
            return Some(Failure::Timeout(format!(
                "nothing arrived within {}",
                seconds(t.first_byte)
            )));
        }
    } else if now.duration_since(last_rx) >= t.between_chunks {
        return Some(Failure::Timeout(format!(
            "the stream stalled for {}",
            seconds(t.between_chunks)
        )));
    }
    None
}

/// The non-blocking exchange (module header, "The read loop").
fn exchange(
    base: &Base,
    request: &HttpRequest<'_>,
    body_cap: usize,
    t: Timeouts,
    cancel: &AtomicBool,
    sink: &mut dyn FnMut(Vec<u8>) -> bool,
) -> Result<(), Failure> {
    let started = Instant::now();
    let mut stream = connect(base, t.connect, cancel)?;
    if let Err(e) = stream.set_nonblocking(true) {
        return Err(Failure::Unreachable(format!("socket setup failed: {e}")));
    }
    let connected = Instant::now();
    let outgoing = request_bytes(base, request);
    let mut written = 0;
    let mut write_problem: Option<String> = None;
    let mut reader = ResponseReader::new(body_cap);
    let mut buf = vec![0u8; READ_CHUNK];
    let mut pending: Vec<u8> = Vec::new();
    let mut pending_since: Option<Instant> = None;
    let mut last_rx = connected;
    let mut error_since: Option<Instant> = None;

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(Failure::Cancelled);
        }
        let now = Instant::now();
        if error_since.is_some_and(|since| now.duration_since(since) >= ERROR_BODY_WAIT) {
            return reader.outcome();
        }
        if let Some(late) = overdue(&t, started, connected, last_rx, reader.body_seen, now) {
            // An error status already in hand says more than the timer does.
            return if reader.error_status().is_some() {
                reader.outcome()
            } else {
                Err(late)
            };
        }

        let mut progressed = false;
        if written < outgoing.len() {
            match stream.write(&outgoing[written..]) {
                Ok(0) => {
                    write_problem = Some("the server stopped reading the request".to_string());
                    written = outgoing.len();
                }
                Ok(n) => {
                    written += n;
                    progressed = true;
                }
                Err(e) if would_wait(&e) => {}
                Err(e) => {
                    // The server may have answered early (and closed): read on.
                    write_problem = Some(format!("sending the request failed: {e}"));
                    written = outgoing.len();
                }
            }
        }

        match stream.read(&mut buf) {
            Ok(0) => {
                if !reader.has_status() {
                    if let Some(problem) = write_problem {
                        return Err(Failure::BadResponse(problem));
                    }
                }
                reader.eof()?;
                flush(&mut pending, sink)?;
                return reader.outcome();
            }
            Ok(n) => {
                progressed = true;
                last_rx = now;
                let before = pending.len();
                reader.feed(&buf[..n], &mut pending)?;
                if pending.len() > before && pending_since.is_none() {
                    pending_since = Some(now);
                }
                if error_since.is_none() && reader.error_status().is_some() {
                    error_since = Some(now);
                }
                if reader.complete {
                    flush(&mut pending, sink)?;
                    return reader.outcome();
                }
            }
            Err(e) if would_wait(&e) => {}
            Err(e) => {
                if reader.error_status().is_some() {
                    return reader.outcome();
                }
                return Err(Failure::BadResponse(match write_problem {
                    Some(problem) => problem,
                    None => format!("the connection failed: {e}"),
                }));
            }
        }

        if pending_since.is_some_and(|since| {
            pending.len() >= BATCH_BYTES || now.duration_since(since) >= BATCH_INTERVAL
        }) {
            flush(&mut pending, sink)?;
            pending_since = None;
        }
        if !progressed {
            thread::sleep(POLL);
        }
    }
}

// ---------------------------------------------------------------------------
// Response parsing (push-based: fed whatever each non-blocking read returned)
// ---------------------------------------------------------------------------

/// How the body after the head ends.
enum Framing {
    /// 204 / 304: no body.
    Empty,
    /// Content-Length: this many bytes are still due.
    Length(u64),
    Chunked(ChunkDecoder),
    /// Neither: the body ends when the server closes.
    UntilClose,
}

struct ResponseReader {
    cap: usize,
    head: Vec<u8>,
    interim: u8,
    status: Option<u16>,
    /// `None` while the head is still arriving.
    framing: Option<Framing>,
    /// A body byte (framing included) has arrived: the first-byte window is over.
    body_seen: bool,
    delivered: usize,
    excerpt: Vec<u8>,
    /// Replaces the excerpt when the body is not read (a redirect, a
    /// compressed error body).
    excerpt_note: Option<&'static str>,
    complete: bool,
}

struct Head {
    status: u16,
    chunked: bool,
    content_length: Option<u64>,
    /// Set when the server compressed the body although asked not to.
    content_encoding: Option<String>,
}

impl ResponseReader {
    fn new(cap: usize) -> Self {
        ResponseReader {
            cap,
            head: Vec::new(),
            interim: 0,
            status: None,
            framing: None,
            body_seen: false,
            delivered: 0,
            excerpt: Vec::new(),
            excerpt_note: None,
            complete: false,
        }
    }

    fn has_status(&self) -> bool {
        self.status.is_some()
    }

    fn error_status(&self) -> Option<u16> {
        self.status.filter(|s| *s != 200)
    }

    fn outcome(&self) -> Result<(), Failure> {
        match self.status {
            Some(200) => Ok(()),
            Some(status) => Err(Failure::Http {
                status,
                excerpt: match self.excerpt_note {
                    Some(note) => note.to_string(),
                    None => excerpt_text(&self.excerpt, EXCERPT_CHARS),
                },
            }),
            None => Err(Failure::BadResponse("no response".to_string())),
        }
    }

    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), Failure> {
        if self.complete || input.is_empty() {
            return Ok(());
        }
        let Some(framing) = self.framing.as_mut() else {
            return self.feed_head(input, out);
        };
        self.body_seen = true;
        let mut decoded = Vec::new();
        let framed: Result<bool, String> = match framing {
            Framing::Empty => Ok(true),
            Framing::Length(due) => {
                let n = (*due).min(input.len() as u64) as usize;
                decoded.extend_from_slice(&input[..n]);
                *due -= n as u64;
                Ok(*due == 0)
            }
            Framing::Chunked(decoder) => decoder
                .feed(input, &mut decoded)
                .map(|()| decoder.is_done()),
            Framing::UntilClose => {
                decoded.extend_from_slice(input);
                Ok(false)
            }
        };
        self.take_body(&decoded, out)?;
        match framed {
            Ok(ended) => {
                if ended {
                    self.complete = true;
                }
                Ok(())
            }
            // A broken error body still leaves its status to report.
            Err(_) if self.error_status().is_some() => {
                self.complete = true;
                Ok(())
            }
            Err(why) => Err(Failure::BadResponse(why)),
        }
    }

    fn take_body(&mut self, bytes: &[u8], out: &mut Vec<u8>) -> Result<(), Failure> {
        if bytes.is_empty() {
            return Ok(());
        }
        if self.status == Some(200) {
            self.delivered += bytes.len();
            if self.delivered > self.cap {
                return Err(Failure::TooLarge {
                    n: self.delivered as u64,
                    limit: self.cap as u64,
                });
            }
            out.extend_from_slice(bytes);
        } else {
            let room = EXCERPT_SOURCE_BYTES - self.excerpt.len();
            self.excerpt
                .extend_from_slice(&bytes[..bytes.len().min(room)]);
            if self.excerpt.len() >= EXCERPT_SOURCE_BYTES {
                self.complete = true;
            }
        }
        Ok(())
    }

    fn feed_head(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), Failure> {
        let too_long =
            || Failure::BadResponse(format!("response head over {MAX_HEADER_BYTES} bytes"));
        self.head.extend_from_slice(input);
        let Some((head_end, body_start)) = find_head_end(&self.head) else {
            return if self.head.len() > MAX_HEADER_BYTES {
                Err(too_long())
            } else {
                Ok(())
            };
        };
        if body_start > MAX_HEADER_BYTES {
            return Err(too_long());
        }
        let rest = self.head.split_off(body_start);
        let raw = std::mem::take(&mut self.head);
        let head = parse_head(&raw[..head_end])?;

        if (100..200).contains(&head.status) {
            if head.status == 101 {
                return Err(Failure::BadResponse(
                    "the server switched protocols".to_string(),
                ));
            }
            self.interim += 1;
            if self.interim > MAX_INTERIM_RESPONSES {
                return Err(Failure::BadResponse(
                    "too many interim responses".to_string(),
                ));
            }
            return self.feed(&rest, out);
        }

        self.status = Some(head.status);
        let framing = if head.status == 204 || head.status == 304 {
            Framing::Empty
        } else if head.chunked {
            Framing::Chunked(ChunkDecoder::default())
        } else if let Some(n) = head.content_length {
            Framing::Length(n)
        } else {
            Framing::UntilClose
        };
        if head.status == 200 {
            if let Some(encoding) = head.content_encoding {
                return Err(Failure::BadResponse(format!(
                    "compressed response (content-encoding {encoding})"
                )));
            }
            if let Framing::Length(n) = framing {
                if n > self.cap as u64 {
                    return Err(Failure::TooLarge {
                        n,
                        limit: self.cap as u64,
                    });
                }
            }
        } else if (300..400).contains(&head.status) {
            self.excerpt_note = Some("redirect refused");
            self.complete = true;
        } else if head.content_encoding.is_some() {
            self.excerpt_note = Some("compressed error body");
            self.complete = true;
        }
        if matches!(framing, Framing::Empty | Framing::Length(0)) {
            self.complete = true;
        }
        self.framing = Some(framing);
        if self.complete {
            return Ok(());
        }
        self.feed(&rest, out)
    }

    /// The socket reached EOF.
    fn eof(&mut self) -> Result<(), Failure> {
        if self.complete {
            return Ok(());
        }
        let Some(framing) = self.framing.as_ref() else {
            let why = if self.head.is_empty() && self.interim == 0 {
                "the server closed the connection without answering"
            } else {
                "the connection closed inside the response head"
            };
            return Err(Failure::BadResponse(why.to_string()));
        };
        if self.error_status().is_some() {
            self.complete = true;
            return Ok(());
        }
        match framing {
            Framing::Empty | Framing::UntilClose => {}
            Framing::Length(due) => {
                return Err(Failure::BadResponse(format!(
                    "the connection closed {due} bytes before the body ended"
                )));
            }
            Framing::Chunked(decoder) => {
                if !decoder.eof_ok() {
                    return Err(Failure::BadResponse(
                        "the connection closed inside a chunk".to_string(),
                    ));
                }
            }
        }
        self.complete = true;
        Ok(())
    }
}

/// `(head_end, body_start)`: `buf[..head_end]` holds the status line and the
/// header lines, the blank line sits between the two. CRLF or bare LF.
fn find_head_end(buf: &[u8]) -> Option<(usize, usize)> {
    let mut line_start = 0;
    for (i, &b) in buf.iter().enumerate() {
        if b != b'\n' {
            continue;
        }
        let line = &buf[line_start..i];
        if line_start > 0 && (line.is_empty() || line == b"\r") {
            return Some((line_start, i + 1));
        }
        line_start = i + 1;
    }
    None
}

fn parse_head(raw: &[u8]) -> Result<Head, Failure> {
    let bad = |why: &str| Failure::BadResponse(why.to_string());
    let mut lines = raw
        .split(|&b| b == b'\n')
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line));
    let status_line = lines.next().unwrap_or_default();
    let rest = status_line
        .strip_prefix(b"HTTP/1.1 ")
        .or_else(|| status_line.strip_prefix(b"HTTP/1.0 "))
        .ok_or_else(|| bad("not an HTTP/1.x response"))?;
    let digits = rest
        .get(..3)
        .filter(|d| d.iter().all(u8::is_ascii_digit))
        .ok_or_else(|| bad("malformed status line"))?;
    if rest.len() > 3 && rest[3] != b' ' {
        return Err(bad("malformed status line"));
    }
    let status = digits
        .iter()
        .fold(0u16, |acc, d| acc * 10 + u16::from(d - b'0'));
    if !(100..=599).contains(&status) {
        return Err(bad("status code out of range"));
    }
    let mut head = Head {
        status,
        chunked: false,
        content_length: None,
        content_encoding: None,
    };
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if line[0] == b' ' || line[0] == b'\t' {
            return Err(bad("folded header line"));
        }
        let colon = line
            .iter()
            .position(|&b| b == b':')
            .ok_or_else(|| bad("header line without a colon"))?;
        let name = &line[..colon];
        let value = trim_ows(&line[colon + 1..]);
        if name.is_empty() || !name.iter().all(|&b| is_token_byte(b)) {
            return Err(bad("malformed header name"));
        }
        if name.eq_ignore_ascii_case(b"content-length") {
            let n = parse_decimal(value).ok_or_else(|| bad("malformed content-length"))?;
            if head.content_length.is_some_and(|m| m != n) {
                return Err(bad("conflicting content-length headers"));
            }
            head.content_length = Some(n);
        } else if name.eq_ignore_ascii_case(b"transfer-encoding") {
            if !value.eq_ignore_ascii_case(b"chunked") {
                return Err(bad("unsupported transfer-encoding"));
            }
            head.chunked = true;
        } else if name.eq_ignore_ascii_case(b"content-encoding")
            && !value.is_empty()
            && !value.eq_ignore_ascii_case(b"identity")
        {
            head.content_encoding = Some(excerpt_text(value, 40));
        }
    }
    Ok(head)
}

fn trim_ows(mut value: &[u8]) -> &[u8] {
    while let [b' ' | b'\t', rest @ ..] = value {
        value = rest;
    }
    while let [rest @ .., b' ' | b'\t'] = value {
        value = rest;
    }
    value
}

/// RFC 9110 `tchar`.
fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

fn parse_decimal(value: &[u8]) -> Option<u64> {
    if value.is_empty() || value.len() > 19 || !value.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(value).ok()?.parse().ok()
}

/// Display text for an error body: lossy UTF-8; every run of control or
/// whitespace characters becomes one space; bidi controls, zero-width and
/// other invisible characters are dropped; at most `limit` characters.
fn excerpt_text(bytes: &[u8], limit: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::new();
    let mut gap = false;
    for ch in text.chars() {
        if is_invisible(ch) {
            continue;
        }
        if ch.is_control() || ch.is_whitespace() {
            gap = true;
            continue;
        }
        if gap && !out.is_empty() {
            out.push(' ');
        }
        gap = false;
        out.push(ch);
    }
    if let Some((cut, _)) = out.char_indices().nth(limit) {
        out.truncate(cut);
    }
    out.truncate(out.trim_end().len());
    out
}

fn is_invisible(ch: char) -> bool {
    matches!(
        ch,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

// ---------------------------------------------------------------------------
// Chunked transfer coding (RFC 9112 §7.1), push-based
// ---------------------------------------------------------------------------
//
// Hand-written rather than tiny_http's `chunked_transfer` (already compiled):
// that decoder PULLS from a blocking `Read` — a `WouldBlock` mid size-line
// would lose its state in this non-blocking loop — grows the size line without
// bound, rejects trailers, and reports EOF inside a chunk as a clean end.

#[derive(Default)]
enum ChunkState {
    /// Reading a chunk-size line (hex size, optional `;extensions`).
    #[default]
    Size,
    /// Inside chunk data: this many bytes are still due.
    Data(u64),
    /// After the data: the line break. `true` once its CR has been seen.
    DataEnd(bool),
    /// After the last (zero) chunk: trailer lines until a blank one.
    Trailer,
    Done,
}

#[derive(Default)]
struct ChunkDecoder {
    state: ChunkState,
    line: Vec<u8>,
    trailer_bytes: usize,
}

impl ChunkDecoder {
    fn is_done(&self) -> bool {
        matches!(self.state, ChunkState::Done)
    }

    /// EOF is acceptable once every chunk has arrived: done, or after the
    /// zero chunk with no trailer line half-read (some servers close before
    /// the final blank line; no data is missing then).
    fn eof_ok(&self) -> bool {
        match self.state {
            ChunkState::Done => true,
            ChunkState::Trailer => self.line.is_empty(),
            _ => false,
        }
    }

    fn feed(&mut self, mut input: &[u8], out: &mut Vec<u8>) -> Result<(), String> {
        while !input.is_empty() {
            match self.state {
                ChunkState::Size => match input.iter().position(|&b| b == b'\n') {
                    None => {
                        self.push_line(input, MAX_CHUNK_LINE_BYTES)?;
                        input = &[];
                    }
                    Some(i) => {
                        self.push_line(&input[..i], MAX_CHUNK_LINE_BYTES)?;
                        input = &input[i + 1..];
                        let size = parse_chunk_size(&self.line)?;
                        self.line.clear();
                        self.state = if size == 0 {
                            ChunkState::Trailer
                        } else {
                            ChunkState::Data(size)
                        };
                    }
                },
                ChunkState::Data(due) => {
                    let n = due.min(input.len() as u64) as usize;
                    out.extend_from_slice(&input[..n]);
                    input = &input[n..];
                    let left = due - n as u64;
                    self.state = if left == 0 {
                        ChunkState::DataEnd(false)
                    } else {
                        ChunkState::Data(left)
                    };
                }
                ChunkState::DataEnd(seen_cr) => {
                    let byte = input[0];
                    input = &input[1..];
                    self.state = match (seen_cr, byte) {
                        (false, b'\r') => ChunkState::DataEnd(true),
                        (_, b'\n') => ChunkState::Size,
                        _ => return Err("missing line break after chunk data".to_string()),
                    };
                }
                ChunkState::Trailer => match input.iter().position(|&b| b == b'\n') {
                    None => {
                        self.trailer_bytes += input.len();
                        self.push_line(input, MAX_TRAILER_BYTES)?;
                        input = &[];
                    }
                    Some(i) => {
                        self.trailer_bytes += i + 1;
                        if self.trailer_bytes > MAX_TRAILER_BYTES {
                            return Err("chunked trailer too long".to_string());
                        }
                        self.push_line(&input[..i], MAX_TRAILER_BYTES)?;
                        input = &input[i + 1..];
                        let blank = self.line.is_empty() || self.line == b"\r";
                        self.line.clear();
                        if blank {
                            self.state = ChunkState::Done;
                        }
                    }
                },
                // Connection: close — anything after the body is ignored.
                ChunkState::Done => input = &[],
            }
        }
        Ok(())
    }

    fn push_line(&mut self, bytes: &[u8], cap: usize) -> Result<(), String> {
        if self.line.len() + bytes.len() > cap {
            return Err("chunk-size line too long".to_string());
        }
        self.line.extend_from_slice(bytes);
        Ok(())
    }
}

fn parse_chunk_size(line: &[u8]) -> Result<u64, String> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let size = match line.iter().position(|&b| b == b';') {
        Some(i) => &line[..i],
        None => line,
    };
    let size = trim_ows(size);
    if size.is_empty() || size.len() > 16 || !size.iter().all(u8::is_ascii_hexdigit) {
        return Err("bad chunk size".to_string());
    }
    let text = std::str::from_utf8(size).map_err(|_| "bad chunk size".to_string())?;
    u64::from_str_radix(text, 16).map_err(|_| "bad chunk size".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread::JoinHandle;

    /// Short, injectable timeouts. The fake servers below run on this
    /// machine and answer at once, so seconds of slack keep a loaded CI runner
    /// (Windows included) green while the tests stay fast.
    fn quick() -> Timeouts {
        Timeouts {
            connect: Duration::from_secs(2),
            first_byte: Duration::from_secs(5),
            between_chunks: Duration::from_secs(5),
            total: Duration::from_secs(30),
        }
    }

    enum Step {
        Send(Vec<u8>),
        Wait(Duration),
        /// Wait (at most this long) for the client to close the connection.
        AwaitClose(Duration),
    }

    struct Seen {
        head: String,
        body: Vec<u8>,
        client_closed: bool,
    }

    /// A one-connection fake server on its own 127.0.0.1:0 listener: reads the
    /// request (head, then a Content-Length body), then plays `steps`.
    fn fake_server(steps: Vec<Step>) -> (String, JoinHandle<Seen>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = thread::spawn(move || {
            let (mut sock, _) = listener.accept().expect("accept");
            sock.set_read_timeout(Some(Duration::from_secs(10)))
                .expect("timeout");
            let (head, body) = read_request(&mut sock);
            let mut client_closed = false;
            for step in steps {
                match step {
                    Step::Send(bytes) => {
                        if sock.write_all(&bytes).is_err() {
                            client_closed = true;
                            break;
                        }
                    }
                    Step::Wait(d) => thread::sleep(d),
                    Step::AwaitClose(limit) => client_closed = await_close(&mut sock, limit),
                }
            }
            Seen {
                head,
                body,
                client_closed,
            }
        });
        (format!("http://127.0.0.1:{port}"), handle)
    }

    fn read_request(sock: &mut TcpStream) -> (String, Vec<u8>) {
        let mut data = Vec::new();
        let mut byte = [0u8; 1];
        while !data.ends_with(b"\r\n\r\n") {
            match sock.read(&mut byte) {
                Ok(1) => data.push(byte[0]),
                _ => break,
            }
        }
        let head = String::from_utf8_lossy(&data).into_owned();
        let length = head
            .lines()
            .filter_map(|l| l.split_once(':'))
            .find(|(n, _)| n.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.trim().parse::<usize>().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; length];
        sock.read_exact(&mut body).expect("request body");
        (head, body)
    }

    fn await_close(sock: &mut TcpStream, limit: Duration) -> bool {
        sock.set_read_timeout(Some(limit)).expect("timeout");
        let mut scratch = [0u8; 256];
        loop {
            match sock.read(&mut scratch) {
                Ok(0) => return true,
                Ok(_) => continue,
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                    return false
                }
                Err(_) => return true,
            }
        }
    }

    fn chunk(data: &[u8]) -> Vec<u8> {
        let mut out = format!("{:x}\r\n", data.len()).into_bytes();
        out.extend_from_slice(data);
        out.extend_from_slice(b"\r\n");
        out
    }

    fn run(
        base: &str,
        method: Method,
        path: &str,
        body: &[u8],
        t: Timeouts,
    ) -> (Result<(), Failure>, Vec<Vec<u8>>) {
        let shared = Shared::default();
        let request = HttpRequest {
            base,
            method,
            path,
            body,
        };
        let mut frames = Vec::new();
        let result = perform(&shared, 1, &request, t, &mut |batch| {
            frames.push(batch);
            true
        });
        (result, frames)
    }

    // --- base URL and routes ------------------------------------------------

    #[derive(serde::Deserialize)]
    struct UrlCase {
        input: String,
        rust: bool,
        normalized: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct UrlVectors {
        cases: Vec<UrlCase>,
    }

    #[test]
    fn base_parser_matches_the_shared_vectors() {
        let vectors: UrlVectors =
            serde_json::from_str(include_str!("../tests/llm-urls.json")).expect("llm-urls.json");
        assert!(
            vectors.cases.len() >= 40,
            "the shared vector file lost rows"
        );
        for case in &vectors.cases {
            assert_eq!(
                parse_base(&case.input).is_some(),
                case.rust,
                "parse_base({:?})",
                case.input
            );
            // What the frontend's normalizer produces must pass this boundary.
            if let Some(normalized) = &case.normalized {
                assert!(
                    parse_base(normalized).is_some(),
                    "normalized {normalized:?} (from {:?}) is refused",
                    case.input
                );
            }
        }
    }

    #[test]
    fn base_parser_maps_hosts_to_loopback_addresses_only() {
        let v4 = parse_base("http://127.0.0.1:1234").expect("v4");
        assert_eq!(v4.addrs(), vec!["127.0.0.1:1234".parse().expect("addr")]);
        assert_eq!(v4.host_header(), "127.0.0.1:1234");
        let local = parse_base("http://localhost:11434/").expect("localhost");
        assert_eq!(
            local.addrs(),
            vec![
                "127.0.0.1:11434".parse::<SocketAddr>().expect("addr"),
                "[::1]:11434".parse().expect("addr")
            ]
        );
        assert_eq!(local.host_header(), "localhost:11434");
        let v6 = parse_base("http://[::1]:8080").expect("v6");
        assert_eq!(v6.addrs(), vec!["[::1]:8080".parse().expect("addr")]);
        assert_eq!(v6.host_header(), "[::1]:8080");
        for addr in [v4.addrs(), local.addrs(), v6.addrs()].concat() {
            assert!(addr.ip().is_loopback());
        }
    }

    #[test]
    fn routes_are_exact() {
        for path in GET_ROUTES {
            assert!(route_allowed(Method::Get, path), "{path}");
            assert!(!route_allowed(Method::Post, path), "{path}");
        }
        for path in POST_ROUTES {
            assert!(route_allowed(Method::Post, path), "{path}");
            assert!(!route_allowed(Method::Get, path), "{path}");
        }
        for path in [
            "",
            "/",
            "/v1/models/",
            "/V1/models",
            "/v1/models?x=1",
            "v1/models",
            "/v1/../v1/models",
            "/v1/completions",
            "/api/generate",
            "/api/pull",
            "/v1/models\r\nX: y",
            "/v1/chat/completions ",
        ] {
            assert!(!route_allowed(Method::Get, path), "{path:?}");
            assert!(!route_allowed(Method::Post, path), "{path:?}");
        }
    }

    #[test]
    fn refusals_need_no_network() {
        let (r, _) = run("http://127.1:1234", Method::Get, "/v1/models", &[], quick());
        assert_eq!(r, Err(Failure::BadUrl));
        let (r, _) = run(
            "http://127.0.0.1:1234",
            Method::Post,
            "/v1/models",
            b"{}",
            quick(),
        );
        assert_eq!(r, Err(Failure::BadRoute));
        let (r, _) = run(
            "http://127.0.0.1:1234",
            Method::Get,
            "/api/chat",
            &[],
            quick(),
        );
        assert_eq!(r, Err(Failure::BadRoute));
        let big = vec![b'x'; MAX_REQUEST_BYTES + 1];
        let (r, _) = run(
            "http://127.0.0.1:1234",
            Method::Post,
            "/api/chat",
            &big,
            quick(),
        );
        assert_eq!(
            r,
            Err(Failure::TooLarge {
                n: (MAX_REQUEST_BYTES + 1) as u64,
                limit: MAX_REQUEST_BYTES as u64
            })
        );
        assert_eq!(r.unwrap_err().status(), "E_TOO_LARGE 1048577 1048576");
    }

    // --- frames and status strings -----------------------------------------

    #[test]
    fn frames_carry_a_tag_byte_then_the_payload() {
        assert_eq!(frame(FRAME_DATA, b"ab"), vec![1, b'a', b'b']);
        assert_eq!(frame(FRAME_END, b""), vec![2]);
        assert_eq!(end_status(&Ok(())), "");
        assert_eq!(end_status(&Err(Failure::Busy)), "E_BUSY");
        assert_eq!(
            Failure::Http {
                status: 404,
                excerpt: String::new()
            }
            .status(),
            "E_HTTP 404:"
        );
        assert_eq!(
            Failure::Timeout("the stream stalled for 120 s".into()).status(),
            "E_TIMEOUT the stream stalled for 120 s"
        );
    }

    #[test]
    fn excerpts_drop_control_and_invisible_characters_and_stop_at_300() {
        assert_eq!(
            excerpt_text(b"{\"error\":\n\t\"model\x07 not\r\nfound\"}\n", 300),
            "{\"error\": \"model not found\"}"
        );
        assert_eq!(
            excerpt_text("a\u{202E}b\u{200B}c\u{2028}d\u{0085}e".as_bytes(), 300),
            "abc d e"
        );
        assert_eq!(excerpt_text(b"  \x1b[31mred\x1b[0m ", 300), "[31mred [0m");
        let long = "ā".repeat(400);
        assert_eq!(excerpt_text(long.as_bytes(), 300).chars().count(), 300);
        assert_eq!(excerpt_text(b"\xff\xfeok", 300), "\u{FFFD}\u{FFFD}ok");
    }

    // --- chunked decoding ----------------------------------------------------

    fn decode(parts: &[&[u8]]) -> Result<(Vec<u8>, bool), String> {
        let mut decoder = ChunkDecoder::default();
        let mut out = Vec::new();
        for part in parts {
            decoder.feed(part, &mut out)?;
        }
        Ok((out, decoder.is_done()))
    }

    #[test]
    fn chunked_decoder_survives_every_split_point() {
        let wire: &[u8] = b"4;name=\"v\"\r\nWiki\r\n5 ;x\r\npedia\r\nE\r\n in\r\n\r\nchunks.\r\n0\r\nExpires: never\r\nX-A: 1\r\n\r\n";
        let want: &[u8] = b"Wikipedia in\r\n\r\nchunks.";
        for i in 0..=wire.len() {
            for j in i..=wire.len() {
                let (out, done) =
                    decode(&[&wire[..i], &wire[i..j], &wire[j..]]).expect("valid stream");
                assert_eq!(out, want, "split at {i}/{j}");
                assert!(done, "split at {i}/{j}");
            }
        }
        let bytes: Vec<&[u8]> = wire.chunks(1).collect();
        assert_eq!(decode(&bytes).expect("byte by byte"), (want.to_vec(), true));
    }

    #[test]
    fn chunked_decoder_takes_bare_line_feeds_and_uppercase_hex() {
        assert_eq!(
            decode(&[b"A\nabcdefghij\n0\n\n"]).expect("bare LF"),
            (b"abcdefghij".to_vec(), true)
        );
    }

    #[test]
    fn chunked_decoder_refuses_malformed_input() {
        for bad in [
            &b"zz\r\nab\r\n"[..],
            b"1g\r\na\r\n",
            b"\r\n",
            b";ext\r\n",
            b"-1\r\n",
            b"0x5\r\nhello\r\n",
            b"10000000000000000\r\n",
            b"3\r\nabcX",
            b"3\r\nabc\r\r",
        ] {
            assert!(
                decode(&[bad]).is_err(),
                "{:?}",
                String::from_utf8_lossy(bad)
            );
        }
        let long_line = [b"1;".as_slice(), &[b'x'; 2000]].concat();
        assert!(decode(&[&long_line]).is_err(), "size line is capped");
        let long_trailer = [b"0\r\n".as_slice(), &[b'x'; 9000]].concat();
        assert!(decode(&[&long_trailer]).is_err(), "trailer is capped");
    }

    #[test]
    fn eof_inside_a_chunk_is_not_an_end() {
        let mut decoder = ChunkDecoder::default();
        let mut out = Vec::new();
        decoder.feed(b"5\r\nab", &mut out).expect("partial");
        assert!(!decoder.eof_ok());
        let mut decoder = ChunkDecoder::default();
        decoder.feed(b"2\r\nab\r\n", &mut out).expect("one chunk");
        assert!(!decoder.eof_ok(), "no zero chunk yet");
        decoder.feed(b"0\r\n", &mut out).expect("last chunk");
        assert!(
            decoder.eof_ok(),
            "every byte arrived; only the blank line is missing"
        );
    }

    // --- fake servers --------------------------------------------------------

    #[test]
    fn streams_a_chunked_sse_body_in_order() {
        let (base, server) = fake_server(vec![
            Step::Send(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
                    .to_vec(),
            ),
            Step::Send(chunk(b"data: {\"n\":1}\n\n")),
            Step::Wait(Duration::from_millis(100)),
            Step::Send(chunk(b"data: {\"n\":2}\n\n")),
            Step::Wait(Duration::from_millis(100)),
            Step::Send(b"6;ext=1\r\ndata: \r\n0\r\nX-Trailer: t\r\n\r\n".to_vec()),
        ]);
        let (result, frames) = run(
            &base,
            Method::Post,
            "/v1/chat/completions",
            br#"{"stream":true}"#,
            quick(),
        );
        assert_eq!(result, Ok(()));
        assert_eq!(
            frames.concat(),
            b"data: {\"n\":1}\n\ndata: {\"n\":2}\n\ndata: ".to_vec()
        );
        assert!(frames.iter().all(|f| !f.is_empty()));
        let seen = server.join().expect("server");
        assert_eq!(seen.body, br#"{"stream":true}"#);
    }

    #[test]
    fn small_writes_are_batched_into_few_frames() {
        let mut burst = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        let mut want = Vec::new();
        for i in 0..200 {
            let line = format!("data: {i}\n\n");
            burst.extend_from_slice(&chunk(line.as_bytes()));
            want.extend_from_slice(line.as_bytes());
        }
        burst.extend_from_slice(b"0\r\n\r\n");
        let (base, server) = fake_server(vec![Step::Send(burst)]);
        let (result, frames) = run(&base, Method::Post, "/api/chat", b"{}", quick());
        assert_eq!(result, Ok(()));
        assert_eq!(frames.concat(), want);
        assert!(frames.len() <= 3, "{} frames for one burst", frames.len());
        server.join().expect("server");
    }

    #[test]
    fn sends_host_as_typed_and_only_the_listed_headers() {
        let (base, server) = fake_server(vec![Step::Send(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".to_vec(),
        )]);
        // `localhost` connects to 127.0.0.1 first, where this server listens.
        let base = base.replace("127.0.0.1", "localhost");
        let (result, frames) = run(&base, Method::Post, "/api/chat", b"{\"x\":1}", quick());
        assert_eq!(result, Ok(()));
        assert_eq!(frames.concat(), b"{}");
        let seen = server.join().expect("server");
        let mut lines = seen.head.split("\r\n").filter(|l| !l.is_empty());
        assert_eq!(lines.next(), Some("POST /api/chat HTTP/1.1"));
        let headers: Vec<(String, String)> = lines
            .map(|l| {
                let (name, value) = l.split_once(": ").expect("header");
                (name.to_ascii_lowercase(), value.to_string())
            })
            .collect();
        let names: Vec<&str> = headers.iter().map(|(n, _)| n.as_str()).collect();
        // The exact set: no origin, no expect, nothing a browser would add.
        assert_eq!(
            names,
            [
                "host",
                "content-type",
                "content-length",
                "accept",
                "accept-encoding",
                "connection"
            ]
        );
        assert_eq!(headers[0].1, base.trim_start_matches("http://"));
        assert_eq!(headers[1].1, "application/json");
        assert_eq!(headers[2].1, "7");
        assert_eq!(headers[4].1, "identity");
        assert_eq!(headers[5].1, "close");
        assert_eq!(seen.body, b"{\"x\":1}");
    }

    #[test]
    fn a_get_carries_no_body_headers() {
        let (base, server) = fake_server(vec![Step::Send(
            b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"data\":[]}".to_vec(),
        )]);
        // HTTP/1.0 with no length: the body ends at close.
        let (result, frames) = run(&base, Method::Get, "/v1/models", &[], quick());
        assert_eq!(result, Ok(()));
        assert_eq!(frames.concat(), b"{\"data\":[]}");
        let seen = server.join().expect("server");
        let names: Vec<String> = seen
            .head
            .split("\r\n")
            .skip(1)
            .filter(|l| !l.is_empty())
            .map(|l| l.split_once(':').expect("header").0.to_ascii_lowercase())
            .collect();
        assert_eq!(names, ["host", "accept", "accept-encoding", "connection"]);
        assert!(seen.head.starts_with("GET /v1/models HTTP/1.1\r\n"));
        assert!(seen.body.is_empty());
    }

    #[test]
    fn a_404_becomes_e_http_with_a_cleaned_excerpt() {
        let body = "{\"error\":\n\t\"model\u{7} not\r\nfound\u{202E}\"}";
        let response = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let (base, server) = fake_server(vec![Step::Send(response.into_bytes())]);
        let (result, frames) = run(&base, Method::Post, "/v1/chat/completions", b"{}", quick());
        let excerpt = "{\"error\": \"model not found\"}".to_string();
        assert_eq!(
            result,
            Err(Failure::Http {
                status: 404,
                excerpt: excerpt.clone()
            })
        );
        assert_eq!(
            result.unwrap_err().status(),
            format!("E_HTTP 404: {excerpt}")
        );
        assert!(frames.is_empty(), "an error body is never streamed as data");
        server.join().expect("server");
    }

    #[test]
    fn an_error_body_that_never_ends_still_reports_its_status() {
        let (base, server) = fake_server(vec![
            Step::Send(
                b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 100\r\n\r\nboom".to_vec(),
            ),
            Step::AwaitClose(Duration::from_secs(10)),
        ]);
        let (result, _) = run(&base, Method::Post, "/api/chat", b"{}", quick());
        assert_eq!(
            result,
            Err(Failure::Http {
                status: 500,
                excerpt: "boom".into()
            })
        );
        assert!(server.join().expect("server").client_closed);
    }

    #[test]
    fn a_redirect_is_refused_not_followed() {
        let (base, server) = fake_server(vec![Step::Send(
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/elsewhere\r\nContent-Length: 0\r\n\r\n"
                .to_vec(),
        )]);
        let (result, frames) = run(&base, Method::Get, "/v1/models", &[], quick());
        assert_eq!(
            result,
            Err(Failure::Http {
                status: 302,
                excerpt: "redirect refused".into()
            })
        );
        assert!(frames.is_empty());
        server.join().expect("server");
    }

    #[test]
    fn interim_responses_are_skipped() {
        let (base, server) = fake_server(vec![Step::Send(
            b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec(),
        )]);
        let (result, frames) = run(&base, Method::Post, "/api/chat", b"{}", quick());
        assert_eq!(result, Ok(()));
        assert_eq!(frames.concat(), b"ok");
        server.join().expect("server");
    }

    #[test]
    fn an_oversize_body_is_refused() {
        // Declared: refused from the head, before any body byte.
        let (base, server) = fake_server(vec![
            Step::Send(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                    MAX_STREAM_BYTES + 1
                )
                .into_bytes(),
            ),
            Step::AwaitClose(Duration::from_secs(10)),
        ]);
        let (result, frames) = run(&base, Method::Post, "/api/chat", b"{}", quick());
        assert_eq!(
            result,
            Err(Failure::TooLarge {
                n: (MAX_STREAM_BYTES + 1) as u64,
                limit: MAX_STREAM_BYTES as u64
            })
        );
        assert!(frames.is_empty());
        assert!(server.join().expect("server").client_closed);

        // Streamed: refused once the running total passes the model-list cap.
        let mut body = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        let piece = vec![b'x'; 64 * 1024];
        for _ in 0..17 {
            body.extend_from_slice(&chunk(&piece));
        }
        body.extend_from_slice(b"0\r\n\r\n");
        let (base, server) = fake_server(vec![Step::Send(body)]);
        let (result, _) = run(&base, Method::Get, "/v1/models", &[], quick());
        match result {
            Err(Failure::TooLarge { n, limit }) => {
                assert_eq!(limit, MAX_MODEL_LIST_BYTES as u64);
                assert!(n > limit);
            }
            other => panic!("expected TOO_LARGE, got {other:?}"),
        }
        server.join().expect("server");
    }

    #[test]
    fn a_body_cut_short_is_a_bad_response() {
        let (base, server) = fake_server(vec![Step::Send(
            b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc".to_vec(),
        )]);
        let (result, _) = run(&base, Method::Get, "/api/tags", &[], quick());
        assert!(matches!(result, Err(Failure::BadResponse(_))), "{result:?}");
        server.join().expect("server");

        let (base, server) = fake_server(vec![Step::Send(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nab".to_vec(),
        )]);
        let (result, _) = run(&base, Method::Post, "/api/chat", b"{}", quick());
        assert_eq!(
            result,
            Err(Failure::BadResponse(
                "the connection closed inside a chunk".into()
            ))
        );
        server.join().expect("server");
    }

    #[test]
    fn a_compressed_answer_is_refused() {
        let (base, server) = fake_server(vec![Step::Send(
            b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 3\r\n\r\n\x1f\x8b\x08"
                .to_vec(),
        )]);
        let (result, _) = run(&base, Method::Get, "/v1/models", &[], quick());
        assert_eq!(
            result,
            Err(Failure::BadResponse(
                "compressed response (content-encoding gzip)".into()
            ))
        );
        server.join().expect("server");
    }

    #[test]
    fn not_http_is_a_bad_response() {
        let (base, server) = fake_server(vec![Step::Send(b"SSH-2.0-OpenSSH_9.6\r\n\r\n".to_vec())]);
        let (result, _) = run(&base, Method::Get, "/v1/models", &[], quick());
        assert_eq!(
            result,
            Err(Failure::BadResponse("not an HTTP/1.x response".into()))
        );
        server.join().expect("server");

        let (base, server) = fake_server(vec![Step::Send(Vec::new())]);
        let (result, _) = run(&base, Method::Get, "/v1/models", &[], quick());
        assert_eq!(
            result,
            Err(Failure::BadResponse(
                "the server closed the connection without answering".into()
            ))
        );
        server.join().expect("server");
    }

    #[test]
    fn a_silent_server_times_out_on_the_first_byte() {
        let (base, server) = fake_server(vec![Step::AwaitClose(Duration::from_secs(10))]);
        let t = Timeouts {
            first_byte: Duration::from_millis(300),
            ..quick()
        };
        let (result, _) = run(&base, Method::Post, "/v1/chat/completions", b"{}", t);
        assert_eq!(
            result,
            Err(Failure::Timeout("nothing arrived within 300 ms".into()))
        );
        assert!(server.join().expect("server").client_closed);
    }

    #[test]
    fn a_head_without_a_body_is_still_waiting_for_the_first_byte() {
        // LM Studio-style: the 200 head at once, the first token much later.
        let (base, server) = fake_server(vec![
            Step::Send(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec()),
            Step::AwaitClose(Duration::from_secs(10)),
        ]);
        let t = Timeouts {
            first_byte: Duration::from_millis(600),
            between_chunks: Duration::from_millis(200),
            ..quick()
        };
        let (result, _) = run(&base, Method::Post, "/v1/chat/completions", b"{}", t);
        assert_eq!(
            result,
            Err(Failure::Timeout("nothing arrived within 600 ms".into()))
        );
        server.join().expect("server");
    }

    #[test]
    fn a_stalled_stream_times_out_between_chunks() {
        let (base, server) = fake_server(vec![
            Step::Send(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec()),
            Step::Send(chunk(b"data: 1\n\n")),
            Step::AwaitClose(Duration::from_secs(10)),
        ]);
        let t = Timeouts {
            between_chunks: Duration::from_millis(300),
            ..quick()
        };
        let (result, frames) = run(&base, Method::Post, "/v1/chat/completions", b"{}", t);
        assert_eq!(
            result,
            Err(Failure::Timeout("the stream stalled for 300 ms".into()))
        );
        assert_eq!(
            frames.concat(),
            b"data: 1\n\n",
            "what arrived was delivered first"
        );
        assert!(server.join().expect("server").client_closed);
    }

    #[test]
    fn cancel_mid_stream_closes_the_connection() {
        let (base, server) = fake_server(vec![
            Step::Send(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec()),
            Step::Send(chunk(b"data: first\n\n")),
            Step::AwaitClose(Duration::from_secs(10)),
        ]);
        let shared = Arc::new(Shared::default());
        let (tx, rx) = mpsc::channel();
        let worker = {
            let shared = Arc::clone(&shared);
            thread::spawn(move || {
                let request = HttpRequest {
                    base: &base,
                    method: Method::Post,
                    path: "/v1/chat/completions",
                    body: b"{}",
                };
                perform(&shared, 7, &request, quick(), &mut |batch| {
                    tx.send(batch).is_ok()
                })
            })
        };
        let first = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("first frame");
        assert_eq!(first, b"data: first\n\n");
        let asked = Instant::now();
        shared.cancel(7);
        assert_eq!(worker.join().expect("worker"), Err(Failure::Cancelled));
        assert!(
            asked.elapsed() < Duration::from_secs(2),
            "cancel is noticed within a poll"
        );
        assert!(
            server.join().expect("server").client_closed,
            "the server sees the disconnect"
        );
        assert!(shared.lock().current.is_none(), "the slot is free again");
    }

    #[test]
    fn one_request_at_a_time() {
        let (base, server) = fake_server(vec![
            Step::Send(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec()),
            Step::Send(chunk(b"data: 1\n\n")),
            Step::AwaitClose(Duration::from_secs(10)),
        ]);
        let shared = Arc::new(Shared::default());
        let (tx, rx) = mpsc::channel();
        let worker = {
            let shared = Arc::clone(&shared);
            thread::spawn(move || {
                let request = HttpRequest {
                    base: &base,
                    method: Method::Post,
                    path: "/api/chat",
                    body: b"{}",
                };
                perform(&shared, 1, &request, quick(), &mut |batch| {
                    tx.send(batch).is_ok()
                })
            })
        };
        rx.recv_timeout(Duration::from_secs(10))
            .expect("first frame");
        // Refused before any connection is attempted.
        assert_eq!(shared.acquire(2).err(), Some(Failure::Busy));
        shared.cancel(1);
        assert_eq!(worker.join().expect("worker"), Err(Failure::Cancelled));
        server.join().expect("server");
        assert!(shared.acquire(2).is_ok());
    }

    #[test]
    fn a_new_request_waits_for_a_cancelled_one_to_leave() {
        let shared = Shared::default();
        let first = shared.acquire(1).expect("first");
        shared.cancel(1);
        thread::scope(|scope| {
            let waiter = scope.spawn(|| shared.acquire(2).map(|lease| lease.id));
            thread::sleep(Duration::from_millis(100));
            drop(first);
            assert_eq!(waiter.join().expect("waiter"), Ok(2));
        });
    }

    #[test]
    fn a_cancel_that_arrives_first_is_honoured() {
        let shared = Shared::default();
        shared.cancel(5);
        {
            let other = shared.acquire(6).expect("other id");
            assert!(
                !other.cancel.load(Ordering::SeqCst),
                "another id is untouched"
            );
        }
        let lease = shared.acquire(5).expect("lease");
        assert!(lease.cancel.load(Ordering::SeqCst));
        drop(lease);
        // Consumed: a later request with the same id runs.
        assert!(!shared
            .acquire(5)
            .expect("again")
            .cancel
            .load(Ordering::SeqCst));

        // Cancelled before it started: no connection is attempted at all.
        shared.cancel(9);
        let request = HttpRequest {
            base: "http://127.0.0.1:1",
            method: Method::Get,
            path: "/v1/models",
            body: &[],
        };
        let result = perform(&shared, 9, &request, quick(), &mut |_| true);
        assert_eq!(result, Err(Failure::Cancelled));
    }

    #[test]
    fn cancel_all_ends_the_current_request() {
        let shared = Shared::default();
        let lease = shared.acquire(3).expect("lease");
        shared.cancel(4); // an early cancel for something else
        Shared::default().cancel_all(); // nothing in flight: a no-op
        shared.cancel_all();
        assert!(lease.cancel.load(Ordering::SeqCst));
        drop(lease);
        assert!(shared.lock().early_cancel.is_none());
    }

    #[test]
    fn nothing_listening_is_unreachable() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            listener.local_addr().expect("addr").port()
        };
        // A closed port: refused at once on macOS/Linux; on Windows the
        // refusal can take ~2 s and a short connect timeout fires first —
        // both are UNREACHABLE.
        let t = Timeouts {
            connect: Duration::from_millis(500),
            ..quick()
        };
        let (result, _) = run(
            &format!("http://127.0.0.1:{port}"),
            Method::Get,
            "/v1/models",
            &[],
            t,
        );
        assert!(matches!(result, Err(Failure::Unreachable(_))), "{result:?}");
    }

    /// Against the real LM Studio on this machine. Opt-in:
    /// `FS_LLM_LIVE=1 cargo test live_lm_studio -- --ignored --nocapture`
    /// (`FS_LLM_LIVE_BASE` overrides http://127.0.0.1:1234,
    /// `FS_LLM_LIVE_MODEL` picks the model; else the first one listed).
    #[test]
    #[ignore = "needs a local LM Studio server; set FS_LLM_LIVE=1"]
    fn live_lm_studio() {
        if std::env::var("FS_LLM_LIVE").as_deref() != Ok("1") {
            eprintln!("skipped: set FS_LLM_LIVE=1");
            return;
        }
        let base = std::env::var("FS_LLM_LIVE_BASE")
            .unwrap_or_else(|_| "http://127.0.0.1:1234".to_string());
        let shared = Arc::new(Shared::default());

        let mut list = Vec::new();
        let models = HttpRequest {
            base: &base,
            method: Method::Get,
            path: "/v1/models",
            body: &[],
        };
        perform(&shared, 1, &models, LIST_TIMEOUTS, &mut |b| {
            list.extend_from_slice(&b);
            true
        })
        .expect("GET /v1/models");
        let listed: serde_json::Value = serde_json::from_slice(&list).expect("model list JSON");
        eprintln!("models: {listed}");
        let mut native = Vec::new();
        let native_list = HttpRequest {
            path: "/api/v1/models",
            ..models
        };
        perform(&shared, 2, &native_list, LIST_TIMEOUTS, &mut |b| {
            native.extend_from_slice(&b);
            true
        })
        .expect("GET /api/v1/models");
        serde_json::from_slice::<serde_json::Value>(&native).expect("native list JSON");

        let model = std::env::var("FS_LLM_LIVE_MODEL").unwrap_or_else(|_| {
            listed["data"][0]["id"]
                .as_str()
                .expect("a listed model (load one, or set FS_LLM_LIVE_MODEL)")
                .to_string()
        });
        let chat = |max_tokens: u32| {
            serde_json::json!({
                "model": model,
                "stream": true,
                "max_tokens": max_tokens,
                "messages": [{"role": "user", "content": "Count from 1 to 200, one number per line."}],
            })
            .to_string()
        };

        // A short streamed answer, end to end.
        let short = chat(24);
        let mut streamed = Vec::new();
        let mut frames = 0;
        let request = HttpRequest {
            base: &base,
            method: Method::Post,
            path: "/v1/chat/completions",
            body: short.as_bytes(),
        };
        perform(&shared, 3, &request, CHAT_TIMEOUTS, &mut |b| {
            frames += 1;
            streamed.extend_from_slice(&b);
            true
        })
        .expect("streamed chat");
        let text = String::from_utf8_lossy(&streamed);
        eprintln!("{frames} frames, {} bytes", streamed.len());
        assert!(text.contains("data:"), "an SSE stream: {text}");
        assert!(text.contains("[DONE]"), "the stream ended: {text}");

        // Cancel a long one after its first frame.
        let long = chat(2000);
        let (tx, rx) = mpsc::channel();
        let worker = {
            let shared = Arc::clone(&shared);
            let base = base.clone();
            thread::spawn(move || {
                let request = HttpRequest {
                    base: &base,
                    method: Method::Post,
                    path: "/v1/chat/completions",
                    body: long.as_bytes(),
                };
                perform(&shared, 4, &request, CHAT_TIMEOUTS, &mut |b| {
                    tx.send(b).is_ok()
                })
            })
        };
        rx.recv_timeout(Duration::from_secs(300))
            .expect("first frame of the long answer");
        shared.cancel(4);
        assert_eq!(worker.join().expect("worker"), Err(Failure::Cancelled));
        eprintln!("cancelled mid-stream; LM Studio's log should show the request ended");
    }
}
