/**
 * Delivery option B — automatic upload of the study package to the
 * researcher's own server (see EVAL_MODE_PLAN.md §4 Phase 5 and §7).
 *
 * LIVE since 2026-08-29 on the alvismisjuns deploy: every submitted package
 * is POSTed to `/fastshaders-eval/upload.php` and appears at
 * `/fastshaders-eval/list.php` (password-protected). Set `EVAL_UPLOAD_URL`
 * back to '' to disable. The endpoint itself is deployed by
 * `scripts/deploy-eval-endpoint.sh`, which renders `server/*.php` with the
 * secrets from the gitignored `.vscode/eval-endpoint.json` — this repo is
 * public, so the listing password never enters it.
 *
 * Why this is CSP-legal on the study host: the alvismisjuns deploy already
 * carries `https://alvismisjuns.lv` in `connect-src` (the deploy script's
 * FS_PREVIEW_ORIGIN), and a same-origin path like
 * `/fastshaders-eval/upload.php` is `'self'` anyway. On GitHub Pages the
 * fetch is CSP-blocked → 'failed' → the mailto path stands, per the standing
 * rule that a server endpoint never replaces the offline-capable path.
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

/** e.g. '/fastshaders-eval/upload.php' (same-origin on alvismisjuns). Empty = disabled. */
export const EVAL_UPLOAD_URL: string = '/fastshaders-eval/upload.php';
/** Must match $SECRET in server/fastshaders-eval-upload.php. */
export const EVAL_UPLOAD_KEY: string = 'fsx-ecec3b0ce84df95b09ca';

const UPLOAD_TIMEOUT_MS = 30_000;
/** Client-side mirror of the server's cap — refuse before shipping bytes. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export type EvalUploadResult = 'disabled' | 'ok' | 'failed';

/**
 * POST the finished package. Never throws — every failure mode (CSP block,
 * network, timeout, server refusal) collapses to 'failed', which the caller
 * renders as the ordinary attach-it-yourself instructions.
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
  if (!url) return 'disabled';
  if (bytes.length > MAX_UPLOAD_BYTES) return 'failed';
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
    // case here (offline study machine, DNS/TLS failure, CSP block on GitHub
    // Pages) and used to skip the clear outright, stranding the timer plus its
    // closure over the controller for the full 30 s after the caller had
    // already moved on. Aborting a settled controller is a no-op, so this was
    // only hygiene — but it is exactly the shape that becomes a real leak the
    // day a retry loop is added.
    if (timer !== undefined) clearTimeout(timer);
  }
}
