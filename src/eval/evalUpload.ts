/**
 * Delivery option B — automatic upload of the study package to the
 * researcher's own server (see EVAL_MODE_PLAN.md §4 Phase 5 and §7).
 *
 * The endpoint exists ONLY on alvismisjuns.lv (a PHP container; live since
 * 2026-08-29): `/fastshaders-eval/upload.php`, collected at
 * `/fastshaders-eval/list.php` (password-protected). It is deployed by
 * `scripts/deploy-eval-endpoint.sh`, which renders `server/*.php` with the
 * secrets from the gitignored `.vscode/eval-endpoint.json` — this repo is
 * public, so the listing password never enters it. Set `EVAL_UPLOAD_URL` to
 * '' to disable.
 *
 * `EVAL_UPLOAD_URL` is RELATIVE, so it resolves against whichever host served
 * the app. It is CSP-legal ('self') on every host, but it reaches the
 * endpoint from only one (measured 2026-09-11):
 *   - alvismisjuns.lv/fastshaders/ → the endpoint → 'ok';
 *   - fs.sferas.lv, the STUDY host participants are sent to (deploy:sferas),
 *     is a static nginx container with no endpoint → 404 → 'failed';
 *   - GitHub Pages → the POST reaches GitHub's edge → 405 → 'failed'.
 * Pointing the study host at alvismisjuns is a separate fix that needs server
 * work (CORS on upload.php for the OPTIONS preflight AND the POST,
 * `https://alvismisjuns.lv` in the sferas build's connect-src, and an
 * absolute URL here). Until then every fs.sferas.lv package degrades to the
 * download + mail floor, the standing rule that a server endpoint never
 * replaces the offline-capable path.
 *
 * The upload is ALWAYS in addition to the download, never instead of it —
 * the downloaded zip on the study machine is the in-person safety net, and a
 * failed/blocked upload degrades to exactly the flow that shipped first.
 *
 * The key is visible to anyone reading the bundle (this is a public site);
 * it exists to stop drive-by spam, not determined abuse — the server's size
 * cap, name pattern, zip magic check and non-public inbox are the real
 * controls.
 */

/** RELATIVE, so it resolves against the serving host; only alvismisjuns has the endpoint (see the header). Empty = disabled. */
export const EVAL_UPLOAD_URL: string = '/fastshaders-eval/upload.php';
/** Must match $SECRET in server/fastshaders-eval-upload.php. */
export const EVAL_UPLOAD_KEY: string = 'fsx-ecec3b0ce84df95b09ca';

const UPLOAD_TIMEOUT_MS = 30_000;
/**
 * Client-side mirror of the server's cap (`$MAX_BYTES` in
 * server/fastshaders-eval-upload.php; evalUpload.test.ts pins the two) —
 * refuse before shipping bytes. MiB: the N4 notice's fixed "64 MB" means this.
 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** 'too-large' = over MAX_UPLOAD_BYTES, never sent; the caller shows the size it measured. */
export type EvalUploadResult = 'disabled' | 'ok' | 'failed' | 'too-large';

/**
 * The two outcomes known before any network I/O, so the caller can show
 * them without a 'pending' frame. null = go ahead and POST. Disabled wins over
 * too-large, so a build with no endpoint never talks about size.
 */
export function precheckEvalUpload(
  byteLength: number,
  url: string = EVAL_UPLOAD_URL,
): 'disabled' | 'too-large' | null {
  if (!url) return 'disabled';
  if (byteLength > MAX_UPLOAD_BYTES) return 'too-large';
  return null;
}

/**
 * POST the finished package. Never throws. A package over MAX_UPLOAD_BYTES is
 * refused BEFORE any bytes ship and reported as 'too-large'; every other
 * failure (no endpoint on this host, network, timeout, server refusal)
 * collapses to 'failed'. Both render the attach-it-yourself instructions.
 *
 * `url`/`key` are parameters (defaulting to the constants) so the logic is
 * unit-testable without editing module constants.
 */
export async function uploadEvalPackage(
  fileName: string,
  bytes: Uint8Array,
  url: string = EVAL_UPLOAD_URL,
  key: string = EVAL_UPLOAD_KEY,
): Promise<EvalUploadResult> {
  const pre = precheckEvalUpload(bytes.length, url);
  if (pre) return pre;
  // Hoisted ONLY so the `finally` below can reach it — the controller and the
  // timer are still constructed inside the `try`, because this function's
  // contract is that it never throws and the caller fires it with
  // `void uploadEvalPackage(...).then(...)` and no `.catch` (SusModal).
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
    // Copy into a plain ArrayBuffer: satisfies BodyInit regardless of the
    // source view's buffer type, and detaches nothing the caller still holds.
    const body = new Uint8Array(bytes).buffer;
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/zip',
        'X-FS-Eval-Name': fileName,
        'X-FS-Eval-Key': key,
      },
      signal: ctrl.signal,
    });
    return res.ok ? 'ok' : 'failed';
  } catch {
    return 'failed';
  } finally {
    // `finally`, not a line after the await: a REJECTED fetch is the ordinary
    // case here (offline study machine, DNS/TLS failure, or a CORS rejection
    // once the URL points cross-origin — on today's relative URL a 404/405
    // RESOLVES with ok=false instead) and used to skip the clear outright,
    // stranding the timer plus its closure over the controller for the full
    // 30 s after the caller had already moved on. Aborting a settled
    // controller is a no-op, so this was only hygiene — but it is exactly the
    // shape that becomes a real leak the day a retry loop is added.
    if (timer !== undefined) clearTimeout(timer);
  }
}
