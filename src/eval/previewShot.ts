/**
 * Screenshot of the 3D preview, for the package (EVAL_MODE_PLAN.md §7.23).
 *
 * The blinded quality-rating panel needs an image of what each participant
 * actually made — judges cannot run forty shaders. The stage is a sandboxed
 * iframe on an opaque origin, so the parent CANNOT read its canvas; the image
 * has to be asked for and sent back (`fs:shot` → `fs:shot-result`, handled by
 * EVAL_BRIDGE_SCRIPT in tslToPreviewHTML).
 *
 * Best-effort by design: no preview mounted, a backend that refuses
 * `toDataURL`, or a stage that never answers all resolve to null, and the
 * package simply ships without `preview.png`. A missing image must never cost
 * a session — everything else in the bundle is unaffected.
 */

/** How long to wait for the stage before giving up on the image. */
const SHOT_TIMEOUT_MS = 4000;
/** A PNG data URL far larger than this is not worth the zip space. */
const MAX_SHOT_CHARS = 8_000_000;

/** Decode a `data:image/png;base64,…` URL to bytes. Null if it is not one. */
export function pngDataUrlToBytes(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    // PNG magic — the stage is adversarial (it runs the loaded shader), so
    // what it hands back is checked rather than trusted.
    if (out.length < 8 || out[0] !== 0x89 || out[1] !== 0x50 || out[2] !== 0x4e || out[3] !== 0x47) {
      return null;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Ask the preview iframe for a PNG of the current frame. Resolves to the
 * bytes, or null when there is no preview, the stage declines, or it does not
 * answer within the timeout.
 */
export function capturePreviewShot(timeoutMs = SHOT_TIMEOUT_MS): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const frame = document.querySelector<HTMLIFrameElement>('.shader-preview__iframe');
    const win = frame?.contentWindow;
    if (!win) {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (v: Uint8Array | null) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
      resolve(v);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== win) return;
      const d = e.data as { type?: string; ok?: boolean; dataUrl?: unknown };
      if (!d || d.type !== 'fs:shot-result') return;
      if (!d.ok || typeof d.dataUrl !== 'string' || d.dataUrl.length > MAX_SHOT_CHARS) {
        finish(null);
        return;
      }
      finish(pngDataUrlToBytes(d.dataUrl));
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    window.addEventListener('message', onMessage);
    try {
      win.postMessage({ type: 'fs:shot' }, '*');
    } catch {
      finish(null);
    }
  });
}
