/**
 * The GLB import's TEXTURE ENCODER (GLB Phase 5 Step 8): the images the
 * section builder needs, each one extracted from the dropped model and
 * re-encoded through the SAME `encodeImageFile` every dropped picture goes
 * through — the recorded exception to the drop-time "Convert image?" question
 * (CLAUDE.md, the drop-time conversion bullet): the answer is made by SLOT
 * (`slotEncodeClass`, owner rule Q12) and never asked, and a remembered
 * "never" does not apply.
 *
 * SEQUENTIAL, one encoder at a time in first-use order (the multi-file drop
 * rule: N concurrent encoders compound into one freeze), with an abort check
 * between images. The per-image budget is the encoder's own; the PROJECT
 * budget is enforced here, because only this loop knows the running total —
 * an encode that would push it over is retried at half the slot size (at most
 * `BUDGET_RETRIES` times, never below `BUDGET_RETRY_FLOOR`), and skipped as
 * 'budget' when the smallest still does not fit. The build REPLACES the
 * project, so the whole budget is free (`budgetChars`), and Ignore limits
 * lifts it to Infinity — never the slot sizes.
 *
 * DOM-only in production (File, createImageBitmap, canvas — inside
 * `encodeImageFile`); the encoder is INJECTABLE so the loop's decisions run
 * under node against a fake. Every image's bytes are a view into the dropped
 * file (transient, never stored); only the encoded `data:` URL leaves.
 */
import { encodeImageFile, type EncodeImageOptions, type EncodeImageResult } from './imageImport';
import { resolveImageDrop, type ImageOriginInfo } from './imageNode';
import { stashImageOrigin } from './imageOriginCache';
import { gltfImageFileName, type GltfModelReport } from './gltfReader';
import { imageSourceLossless, slotEncodeClass, type EncodeRequest } from './gltfImportPlan';
import type { GlbDownscaleReason, GlbSkipReason } from './glbImportReport';

/** The encoder's shape — `encodeImageFile`, or a test's fake of it. */
export type EncodeImageFn = (
  file: File,
  ignoreLimits: boolean,
  deviceMaxDim: number,
  mode: 'convert',
  opts: EncodeImageOptions,
) => Promise<EncodeImageResult>;

/** How many times an over-budget encode halves its slot size before it is
 *  skipped, and the smallest long side a retry may ask for. */
export const BUDGET_RETRIES = 4;
export const BUDGET_RETRY_FLOOR = 128;

/** One extracted image, encoded: what the section builder places. */
export interface GltfEncodedImage {
  /** The glTF image index. */
  readonly image: number;
  readonly payload: { dataUrl: string; width: number; height: number };
  /** The pre-snap original's stash (the drop's own escape hatch), when any. */
  readonly origin?: ImageOriginInfo;
  /** The Image node's display file name (`gltfImageFileName`). */
  readonly fileName: string;
}

/** What happened to ONE extracted image, for the report. `name` is the
 *  display file name (sanitised by the reader). */
export type GltfEncodeOutcome =
  | { readonly image: number; readonly name: string; readonly status: 'kept' }
  | {
      readonly image: number;
      readonly name: string;
      readonly status: 'downscaled';
      readonly width: number;
      readonly height: number;
      readonly reason: GlbDownscaleReason;
    }
  | { readonly image: number; readonly name: string; readonly status: 'skipped'; readonly reason: GlbSkipReason };

export interface EncodeGltfImagesOptions {
  /** The model's file name (the Image nodes' display names derive from it). */
  readonly modelName: string;
  /** The "Import at {res} px" choice: an extra long-side cap, or null. */
  readonly maxDim: number | null;
  readonly deviceMaxDim: number;
  readonly ignoreLimits: boolean;
  /** The project image budget still free — Infinity under Ignore limits. */
  readonly budgetChars: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
  /** Test seam: the encoder to run (default `encodeImageFile`). */
  readonly encode?: EncodeImageFn;
  /** Test seam: the origin stash (default `stashImageOrigin`). */
  readonly stash?: (payload: { dataUrl: string; width: number; height: number; fileName: string }) => string | null;
}

export interface EncodeGltfImagesResult {
  /** glTF image index → its encode; an image that was skipped is absent. */
  readonly encoded: Map<number, GltfEncodedImage>;
  /** One per request, in request order. */
  readonly outcomes: GltfEncodeOutcome[];
  /** Characters of `data:` URL placed so far. */
  readonly usedChars: number;
  /** Images past the 64 MP guard that were decoded at a smaller size (N10). */
  readonly decodeDownscaled: { count: number; maxSide: number };
  /** The abort signal fired before every request was encoded. */
  readonly aborted: boolean;
}

/** The dimensions a request's header declares, when both are usable. */
function sourceDimsOf(img: { width: number | null; height: number | null }): { width: number; height: number } | undefined {
  const ok = (v: number | null): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
  return ok(img.width) && ok(img.height) ? { width: img.width, height: img.height } : undefined;
}

/**
 * Why a stored image is smaller than its source. `budget` when this loop
 * retried for the PROJECT budget; `image-cap` when only the encoder's own
 * PER-IMAGE halving ran (a separate, much smaller cap — reporting it as the
 * project's budget is false while the project is nowhere near full);
 * otherwise the TIGHTEST of the three caps the source was fitted to (the
 * chosen import size first — it is the one the user picked — then the slot's
 * size, then the device's); 'slot' for a shrink no cap explains (the
 * power-of-two snap).
 */
function downscaleReason(
  projectBudget: boolean,
  imageCap: boolean,
  longSide: number,
  caps: { res: number; slot: number; device: number },
): GlbDownscaleReason {
  if (projectBudget) return 'budget';
  if (imageCap) return 'image-cap';
  const tightest = Math.min(caps.res, caps.slot, caps.device);
  if (longSide <= tightest) return 'slot';
  if (caps.res === tightest) return 'import-res';
  if (caps.slot === tightest) return 'slot';
  return 'device';
}

/**
 * Encode the images of `requests` (from `encodeRequests`), in order. Never
 * throws for a bad image: a request whose image the reader did not hand out,
 * or that the encoder refuses, is an outcome, not an error. Resolves early,
 * with `aborted: true`, once `signal` fires — what was encoded so far is
 * returned so the caller can drop it.
 */
export async function encodeGltfImages(
  m: GltfModelReport,
  requests: readonly EncodeRequest[],
  o: EncodeGltfImagesOptions,
): Promise<EncodeGltfImagesResult> {
  const encode = o.encode ?? encodeImageFile;
  const stash = o.stash ?? ((p) => stashImageOrigin(p, Date.now()));
  const encoded = new Map<number, GltfEncodedImage>();
  const outcomes: GltfEncodeOutcome[] = [];
  const decodeDownscaled = { count: 0, maxSide: 0 };
  let usedChars = 0;
  const total = requests.length;
  const budget = typeof o.budgetChars === 'number' && o.budgetChars >= 0 ? o.budgetChars : Infinity;
  const res = typeof o.maxDim === 'number' && Number.isFinite(o.maxDim) && o.maxDim >= 1 ? Math.floor(o.maxDim) : Infinity;

  // The first report carries the TOTAL before anything is encoded, so the
  // dialog reads "0 of N" through the first (often the longest) encode.
  if (total > 0) o.onProgress?.(0, total);
  for (let i = 0; i < total; i++) {
    if (o.signal?.aborted) {
      return { encoded, outcomes, usedChars, decodeDownscaled, aborted: true };
    }
    const req = requests[i];
    const img = Number.isInteger(req.image) ? m.images[req.image] : undefined;
    const name = gltfImageFileName(m, req.image, o.modelName);
    // The reader hands bytes out only for a readable image; anything else was
    // already reported by `encodeRequests` as unextractable, so a request
    // here without bytes is a caller error and reads as undecodable.
    if (!img || !img.bytes || img.status !== 'ok' || !img.mime) {
      outcomes.push({ image: req.image, name, status: 'skipped', reason: 'decode' });
      o.onProgress?.(i + 1, total);
      continue;
    }
    const cls = slotEncodeClass(req.slot, imageSourceLossless(img));
    if (!cls) {
      outcomes.push({ image: req.image, name, status: 'skipped', reason: 'unsupported-format' });
      o.onProgress?.(i + 1, total);
      continue;
    }
    // A copy: the reader's bytes are a view into the dropped buffer (possibly
    // a SharedArrayBuffer-typed view), and Blob wants a plain ArrayBuffer.
    const file = new File([img.bytes.slice().buffer as ArrayBuffer], name, { type: img.mime });
    const sourceDims = sourceDimsOf(img);
    const baseOpts: EncodeImageOptions = {
      preferLossless: cls.preferLossless,
      losslessOnly: cls.losslessOnly,
      allowHugeSource: true,
      ...(sourceDims ? { sourceDims } : {}),
    };

    // The slot's size, capped by the chosen import size; halved on a budget
    // retry. Ignore limits lifts the encoder's budgets, never `maxDim`.
    let maxDim = Math.min(cls.maxDim, res);
    let result: EncodeImageResult | null = null;
    let budgetRetried = false;
    for (let attempt = 0; ; attempt++) {
      let r: EncodeImageResult;
      try {
        r = await encode(file, o.ignoreLimits, o.deviceMaxDim, 'convert', { ...baseOpts, maxDim });
      } catch {
        r = { ok: false, reason: 'load' };
      }
      if (!r.ok) {
        result = r;
        break;
      }
      if (o.ignoreLimits || usedChars + r.dataUrl.length <= budget) {
        result = r;
        break;
      }
      const next = Math.floor(maxDim / 2);
      if (attempt >= BUDGET_RETRIES || next < BUDGET_RETRY_FLOOR) {
        result = null;
        break;
      }
      budgetRetried = true;
      maxDim = next;
      if (o.signal?.aborted) return { encoded, outcomes, usedChars, decodeDownscaled, aborted: true };
    }

    if (result === null) {
      outcomes.push({ image: req.image, name, status: 'skipped', reason: 'budget' });
    } else if (!result.ok) {
      // `too-large` is the encoder giving up on its own PER-IMAGE budget (not
      // the project's); everything else is a decode that did not happen.
      outcomes.push({ image: req.image, name, status: 'skipped', reason: result.reason === 'too-large' ? 'image-cap' : 'decode' });
    } else {
      const resolved = resolveImageDrop(result, name, stash);
      usedChars += resolved.payload.dataUrl.length;
      encoded.set(req.image, {
        image: req.image,
        payload: { dataUrl: resolved.payload.dataUrl, width: resolved.payload.width, height: resolved.payload.height },
        ...(resolved.origin ? { origin: resolved.origin } : {}),
        fileName: name,
      });
      if (result.decodeDownscaled) {
        decodeDownscaled.count++;
        decodeDownscaled.maxSide = Math.max(decodeDownscaled.maxSide, result.width, result.height);
      }
      const placedLong = Math.max(resolved.payload.width, resolved.payload.height);
      const sourceLong = Math.max(result.sourceWidth, result.sourceHeight);
      if (placedLong < sourceLong) {
        const deviceCap = o.ignoreLimits ? Infinity : o.deviceMaxDim;
        outcomes.push({
          image: req.image,
          name,
          status: 'downscaled',
          width: resolved.payload.width,
          height: resolved.payload.height,
          reason: downscaleReason(budgetRetried, result.budgetScaled, sourceLong, {
            res,
            slot: cls.maxDim,
            device: deviceCap,
          }),
        });
      } else {
        outcomes.push({ image: req.image, name, status: 'kept' });
      }
    }
    o.onProgress?.(i + 1, total);
  }
  return { encoded, outcomes, usedChars, decodeDownscaled, aborted: false };
}
