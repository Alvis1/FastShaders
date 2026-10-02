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
 * WHICH URL is decided per BUILD. The default is RELATIVE, so it resolves
 * against whichever host served the app and stays CSP-legal ('self'):
 *   - alvismisjuns.lv/fastshaders/ (and www.) → the endpoint → 'ok';
 *   - GitHub Pages → the POST reaches GitHub's edge → 405 → 'failed'.
 * fs.sferas.lv, the STUDY host participants are sent to, is a static nginx
 * container with no endpoint, so the relative URL 404ed there and every study
 * package read "Upload failed." (reported 2026-10-02). Its build therefore
 * names alvismisjuns's endpoint ABSOLUTELY — `FS_EVAL_UPLOAD_URL` in
 * scripts/deploy-sferas.sh, which vite.config.ts also adds to that build's
 * connect-src — and upload.php answers the CORS preflight AND the POST for
 * exactly that origin. Without the POST's Allow-Origin the browser would hide
 * the response, and a package the server STORED would still read 'failed'.
 * deploy-sferas.sh fails its verification if the preflight is not answered.
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

/**
 * The build's FS_EVAL_UPLOAD_URL override when there is one (the fs.sferas.lv
 * build's absolute alvismisjuns URL), else the RELATIVE default, which only
 * alvismisjuns serves (see the header). Empty = disabled. The `typeof` guard
 * keeps the module importable in bare node, where no Vite define exists.
 */
export const EVAL_UPLOAD_URL: string =
  (typeof __FS_EVAL_UPLOAD_URL__ === 'string' && __FS_EVAL_UPLOAD_URL__) || '/fastshaders-eval/upload.php';
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
    // case here (offline study machine, DNS/TLS failure, or — on the
    // cross-origin sferas build — a refused preflight or a connect-src that
    // lacks the endpoint; a 404/405 on a relative URL RESOLVES with ok=false
    // instead) and used to skip the clear outright,
    // stranding the timer plus its closure over the controller for the full
    // 30 s after the caller had already moved on. Aborting a settled
    // controller is a no-op, so this was only hygiene — but it is exactly the
    // shape that becomes a real leak the day a retry loop is added.
    if (timer !== undefined) clearTimeout(timer);
  }
}
