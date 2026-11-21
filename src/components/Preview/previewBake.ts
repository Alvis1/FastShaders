/**
 * BAKE TO TEXTURE — the parent's channel to the sandboxed stage
 * (docs/dev/baking.md; the stage's half is BAKE_SCRIPT in
 * engine/tslToPreviewHTML.ts).
 *
 * ShaderPreview REGISTERS the one live baker: it owns the iframe, knows which
 * image payloads the document already holds (`fs:image-assets` must reach the
 * stage before a module that names them), and knows what the pane shows. The
 * bake flow only ASKS (`requestPreviewBake`, `previewBakeContext`), so nothing
 * outside the preview touches the iframe, and with no preview mounted (the
 * embed, a pane that never booted) the answer is a plain refusal.
 *
 * What comes back is checked by the caller (`validateBakeReply`,
 * utils/bakePixels.ts) — the stage runs the user's shader.
 */
import type { AppNode } from '@/types';
import type { BakeContext, BakeLayout, BakeMeshFilter } from '@/utils/bakePlan';

export interface PreviewBakeRequest {
  /** The module text (`bakeModuleText`), placeholders and all. */
  code: string;
  /** The nodes `code` was generated from — its image payloads live on them. */
  nodes: AppNode[];
  size: number;
  layout: BakeLayout;
  /** Mesh layout only: which shown meshes to rasterize. */
  filter: BakeMeshFilter | null;
}

/** The stage's reply, unvalidated: `fs:bake-result` as posted, or a refusal. */
export type PreviewBakeReply = { ok: false; error: string } | (Record<string, unknown> & { ok: true });

export interface PreviewBaker {
  bake: (req: PreviewBakeRequest) => Promise<PreviewBakeReply>;
  context: () => BakeContext;
}

/** How long a bake may take before the parent stops waiting. A 2048² float
 *  readback of a heavy shader on a software renderer is seconds, not minutes. */
export const BAKE_TIMEOUT_MS = 30_000;

let baker: PreviewBaker | null = null;

/** Register the live baker; the returned function unregisters exactly it. */
export function registerPreviewBaker(b: PreviewBaker): () => void {
  baker = b;
  return () => {
    if (baker === b) baker = null;
  };
}

/** What the pane shows, for the planner. No preview: nothing to render on. */
export function previewBakeContext(): BakeContext {
  return baker ? baker.context() : { geometry: null, splatShown: false };
}

export function requestPreviewBake(req: PreviewBakeRequest): Promise<PreviewBakeReply> {
  if (!baker) return Promise.resolve({ ok: false, error: 'no-preview' });
  return baker.bake(req);
}

/**
 * Post one bake to `win` and wait for ITS reply — `id`-matched and from that
 * window only (any frame can post a `fs:bake-result`). Shared by ShaderPreview,
 * which posts the image assets first.
 */
export function postBakeAndWait(
  win: Window,
  id: number,
  message: Record<string, unknown>,
  timeoutMs = BAKE_TIMEOUT_MS,
): Promise<PreviewBakeReply> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: PreviewBakeReply) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
      resolve(r);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== win) return;
      const d = e.data as { type?: unknown; id?: unknown; ok?: unknown; error?: unknown } | null;
      if (!d || d.type !== 'fs:bake-result' || d.id !== id) return;
      if (d.ok === true) finish(d as PreviewBakeReply);
      else finish({ ok: false, error: typeof d.error === 'string' ? d.error.slice(0, 200) : 'failed' });
    };
    const timer = window.setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    window.addEventListener('message', onMessage);
    try {
      win.postMessage({ ...message, type: 'fs:bake', id }, '*');
    } catch {
      finish({ ok: false, error: 'post-failed' });
    }
  });
}
