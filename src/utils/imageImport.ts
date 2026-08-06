/**
 * Drop-time image ingestion: decode a dropped file, re-encode it through a
 * canvas, and hand back a bounded `data:` URL for the Image node payload.
 *
 * The canvas round-trip is deliberate: it strips EXIF/GPS metadata (dropped
 * files are treated as untrusted), applies EXIF orientation so phone photos
 * land upright, caps dimensions to the target headset's texture size, and
 * converts everything to a compact web codec.
 *
 * WebP is the target format, as far as the running browser will actually go:
 *
 *   - Lossless WebP for sources that must stay exact (PNG, and lossless
 *     WebP re-drops) — measured bit-identical to PNG at ~2.1-2.6× smaller.
 *   - Lossy WebP q0.85 for photographic sources, with a quality ladder
 *     (0.85 → 0.75 → 0.65) tried before any dimension is thrown away.
 *   - PNG / JPEG only as the fallback where WebP isn't honoured. **WebKit
 *     silently returns PNG from a WebP request** — still true in 2026, and it
 *     covers the macOS Tauri build (WKWebView), not just Safari — so support
 *     and losslessness are PROBED at runtime and the format is never assumed.
 *     An image with alpha never falls through to JPEG (see `chooseFormat`).
 *
 * Dimensions are snapped to a power of two where that is nearly free; see
 * `imageCodec.ts` for the rules and why they are so conservative. The
 * pre-snap encode is returned alongside as `original` so the Image node's
 * "Revert to original" can restore it, and the snap is SKIPPED whenever that
 * pre-snap encode can't be produced — a destructive step never ships without
 * its escape hatch.
 *
 * DOM-only module (Image/canvas/createImageBitmap) — keep it out of
 * node-environment test imports; the pure validation lives in `imageNode.ts`
 * and the pure decisions in `imageCodec.ts`.
 */

import {
  MAX_IMAGE_ENCODED_CHARS,
  HARD_MAX_IMAGE_ENCODED_CHARS,
  MAX_IMAGE_DIM,
  MAX_IMAGE_DIM_RELAXED,
  MAX_SOURCE_PIXELS,
  validImageDataUrl,
} from './imageNode';
import {
  QUALITY_LADDER,
  POT_MIN_DISTINCT_COLORS,
  POT_WRAP_MARGIN,
  base64CharsForBytes,
  chooseFormat,
  potTarget,
  sourcePrefersLossless,
  type EncodeCandidate,
  type EncodeCaps,
  type PixelStats,
} from './imageCodec';

/** One finished encode: the payload plus the dimensions it was encoded at. */
export interface EncodedImage {
  dataUrl: string;
  mime: string;
  width: number;
  height: number;
}

/** What the user chose for this drop. `keep` still re-encodes through the
 *  canvas (EXIF strip, device cap, payload budget are not optional) but makes
 *  no format change and no power-of-two snap. */
export type ImageConvertMode = 'convert' | 'keep';

export type EncodeImageResult =
  | {
      ok: true;
      dataUrl: string;
      /** MIME actually produced — the browser decides, so this is measured,
       *  never assumed (a WebP request can come back as PNG). */
      mime: string;
      /** Whether this browser can encode WebP at all. Reported so the caller
       *  can explain a conversion that couldn't happen instead of leaving the
       *  user to wonder why their PNG is now a JPEG. */
      webpAvailable: boolean;
      /** Final (possibly downscaled and/or POT-snapped) encoded dimensions. */
      width: number;
      height: number;
      /** Original decoded source dimensions — the caller compares these against
       *  the device cap to decide whether to warn about downscaling. */
      sourceWidth: number;
      sourceHeight: number;
      /** True when the payload was snapped to a power of two. Only then is
       *  `original` populated, and only then does the node need a revert. */
      potApplied: boolean;
      /** The same image encoded WITHOUT the power-of-two snap — what the
       *  import would have produced otherwise. Stashed by the caller so the
       *  node can be reverted. Absent when no snap was applied. */
      original?: EncodedImage;
    }
  | {
      ok: false;
      reason: 'svg' | 'load' | 'pixels' | 'too-large';
      /** Source dimensions when known (for the limit dialog). */
      width?: number;
      height?: number;
    };

/** SVG is rejected outright: it's markup, not pixels — rasterizing untrusted
 *  SVG has its own attack surface and the shader pipeline needs raster data. */
export function isSvgFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.svg') || file.type === 'image/svg+xml';
}

/** Broad drop-filter match: anything that looks like an image by extension OR
 *  MIME — including SVG, so a lone-SVG drop reaches placeImageFile and gets a
 *  visible rejection instead of a silent no-op. */
export function isImageFile(file: File): boolean {
  if (/\.(png|jpe?g|jfif|pjp(eg)?|webp|gif|bmp|avif|tiff?|ico|svg)$/.test(file.name.toLowerCase())) return true;
  return file.type.startsWith('image/');
}

interface DecodedSource {
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
}

/** Decode the file to something drawable. Prefers createImageBitmap with
 *  EXIF orientation applied; falls back to a plain bitmap, then to an
 *  HTMLImageElement via object URL. */
async function decodeSource(file: File): Promise<DecodedSource | null> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { source: bmp, width: bmp.width, height: bmp.height, cleanup: () => bmp.close() };
  } catch {
    /* option unsupported or decode failed — try the simpler forms */
  }
  try {
    const bmp = await createImageBitmap(file);
    return { source: bmp, width: bmp.width, height: bmp.height, cleanup: () => bmp.close() };
  } catch {
    /* fall through to <img> */
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      cleanup: () => URL.revokeObjectURL(url),
    };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

/**
 * ONE pass over the decoded pixels, answering everything the later decisions
 * need: does it have alpha (codec choice), is that alpha a hard cutout, and
 * is it a low-colour image (both POT skip rules).
 *
 * Measured at 2-7 ms on the sizes that reach it — the encoder is the cost in
 * this pipeline, not this scan, so it stays eager and exact rather than being
 * sampled. The colour count saturates at the threshold that uses it; a photo
 * crosses it within the first few thousand pixels.
 */
function scanPixels(ctx: CanvasRenderingContext2D, w: number, h: number): PixelStats {
  let alpha = false;
  let softAlpha = false;
  const colors = new Set<number>();
  let counting = true;
  try {
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 255) {
        alpha = true;
        if (a > 0) softAlpha = true;
      }
      if (counting) {
        colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        if (colors.size >= POT_MIN_DISTINCT_COLORS) counting = false;
      }
    }
  } catch {
    // Tainted canvas can't happen here (same-origin blob/bitmap only), but a
    // failed read must not kill the import: assume the cautious answer —
    // alpha present, and too few colours to resample.
    return { alpha: true, binaryAlpha: false, distinctColors: 0 };
  }
  return { alpha, binaryAlpha: alpha && !softAlpha, distinctColors: colors.size };
}

/** Encode a canvas to a Blob. Resolves null when the encoder refused. */
function encodeBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), mime, quality);
    } catch {
      resolve(null);
    }
  });
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    } catch {
      resolve(null);
    }
  });
}

let capsPromise: Promise<EncodeCaps> | null = null;

/**
 * What this browser really does with a WebP request, measured once per
 * session on an 8×8 gradient:
 *   1. does the returned blob's type say WebP at all (WebKit says PNG), and
 *   2. does a q=1 encode round-trip pixel-identically?
 *
 * (2) is probed rather than assumed because the HTML spec leaves `quality`
 * UA-defined for WebP — Chromium's "q=1 means lossless" is an implementation
 * detail, and if a future version changed it every PNG-sourced normal map
 * would silently start degrading with no signal.
 */
export function probeEncodeCaps(): Promise<EncodeCaps> {
  if (capsPromise) return capsPromise;
  capsPromise = (async (): Promise<EncodeCaps> => {
    const none: EncodeCaps = { webp: false, webpLossless: false };
    try {
      if (typeof document === 'undefined') return none;
      const N = 8;
      const canvas = document.createElement('canvas');
      canvas.width = N;
      canvas.height = N;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return none;
      // A gradient with odd values in every channel — a lossy codec cannot
      // reproduce it exactly, a lossless one must.
      const img = ctx.createImageData(N, N);
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const i = (y * N + x) * 4;
          img.data[i] = (x * 31 + y * 7) & 255;
          img.data[i + 1] = (x * 17 + y * 53) & 255;
          img.data[i + 2] = (x * 73 + y * 11) & 255;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);

      const blob = await encodeBlob(canvas, 'image/webp', 1);
      if (!blob || blob.type !== 'image/webp') return none;

      // Decode it back and compare — this is the losslessness measurement.
      let lossless = false;
      try {
        const bmp = await createImageBitmap(blob);
        const check = document.createElement('canvas');
        check.width = N;
        check.height = N;
        const cctx = check.getContext('2d', { willReadFrequently: true });
        if (cctx) {
          cctx.drawImage(bmp, 0, 0);
          const back = cctx.getImageData(0, 0, N, N).data;
          lossless = true;
          for (let i = 0; i < back.length; i++) {
            if (back[i] !== img.data[i]) {
              lossless = false;
              break;
            }
          }
        }
        bmp.close();
      } catch {
        lossless = false;
      }
      return { webp: true, webpLossless: lossless };
    } catch {
      return none;
    }
  })();
  return capsPromise;
}

/** Test seam: force the probed capabilities (also resets the memo). */
export function __setEncodeCapsForTest(caps: EncodeCaps | null): void {
  capsPromise = caps ? Promise.resolve(caps) : null;
}

/**
 * Try each candidate at the CURRENT dimensions and return the first payload
 * that fits `budget`, walking the quality ladder on the last lossy candidate
 * before giving up. Returning null tells the caller to halve the image —
 * the genuinely last resort.
 */
async function encodeWithinBudget(
  canvas: HTMLCanvasElement,
  candidates: EncodeCandidate[],
  budget: number,
): Promise<EncodedImage | null> {
  let lossyMime: string | null = null;

  /** Materialize + validate. The budget is checked on the BLOB first, so a
   *  rejected candidate never allocates its multi-megabyte string (a 2048²
   *  PNG is ~10 M chars, i.e. ~20 MB of UTF-16, per attempt). The final
   *  whitelist check is the same one every consumer applies — an encoder that
   *  produced an untyped blob would otherwise yield a payload that validates
   *  as garbage downstream and renders as the inert black fallback. */
  const finish = async (blob: Blob): Promise<EncodedImage | null> => {
    if (base64CharsForBytes(blob.size, blob.type) > budget) return null;
    const dataUrl = await blobToDataUrl(blob);
    if (!dataUrl || dataUrl.length > budget || !validImageDataUrl(dataUrl)) return null;
    return { dataUrl, mime: blob.type, width: canvas.width, height: canvas.height };
  };

  for (const cand of candidates) {
    const blob = await encodeBlob(canvas, cand.mime, cand.quality);
    // A refused format falls back to PNG with its own type; skip it rather
    // than storing PNG bytes under a WebP assumption.
    if (!blob || blob.type !== cand.mime) continue;
    // The ladder walks the FIRST lossy candidate, not the last: chooseFormat
    // orders WebP ahead of JPEG, so taking the last would drop a photo to
    // JPEG q0.65 when WebP q0.75 was both smaller and better.
    if (!cand.lossless && lossyMime === null) lossyMime = cand.mime;
    const done = await finish(blob);
    if (done) return done;
  }

  // Quality ladder: cheaper than throwing pixels away.
  if (lossyMime) {
    for (const q of QUALITY_LADDER.slice(1)) {
      const blob = await encodeBlob(canvas, lossyMime, q);
      if (!blob || blob.type !== lossyMime) continue;
      const done = await finish(blob);
      if (done) return done;
    }
  }
  return null;
}

/** Draw `source` into `canvas` at its full size. */
function drawInto(canvas: HTMLCanvasElement, source: CanvasImageSource, w: number, h: number): CanvasRenderingContext2D | null {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return ctx;
}

/**
 * Resample `src` to `dw × dh` THROUGH a wrapped border.
 *
 * A plain `drawImage` resample clamps at the edges, so a seamless tile comes
 * back with its border blended against a duplicated edge instead of against
 * the pixels it wraps onto — a visible seam on every tile boundary, in a node
 * whose "Repeat (tile the image)" setting defaults to ON. Copying a margin of
 * the opposite edges around the image first makes the resampler see the true
 * neighbours; the margin is then cropped away.
 */
function drawWrappedResize(
  dest: HTMLCanvasElement,
  src: HTMLCanvasElement,
  dw: number,
  dh: number,
): boolean {
  const sw = src.width;
  const sh = src.height;
  const m = Math.min(POT_WRAP_MARGIN, Math.floor(sw / 2), Math.floor(sh / 2));
  if (m <= 0) {
    return drawInto(dest, src, dw, dh) !== null;
  }

  const pad = document.createElement('canvas');
  pad.width = sw + m * 2;
  pad.height = sh + m * 2;
  const pctx = pad.getContext('2d');
  if (!pctx) return false;

  // Centre, then the four wrapped edges, then the four wrapped corners.
  pctx.drawImage(src, m, m);
  pctx.drawImage(src, sw - m, 0, m, sh, 0, m, m, sh); // right edge → left margin
  pctx.drawImage(src, 0, 0, m, sh, sw + m, m, m, sh); // left edge → right margin
  pctx.drawImage(src, 0, sh - m, sw, m, m, 0, sw, m); // bottom edge → top margin
  pctx.drawImage(src, 0, 0, sw, m, m, sh + m, sw, m); // top edge → bottom margin
  pctx.drawImage(src, sw - m, sh - m, m, m, 0, 0, m, m);
  pctx.drawImage(src, 0, sh - m, m, m, sw + m, 0, m, m);
  pctx.drawImage(src, sw - m, 0, m, m, 0, sh + m, m, m);
  pctx.drawImage(src, 0, 0, m, m, sw + m, sh + m, m, m);

  // Scale the padded image, then crop the (scaled) margin back off.
  const scaleX = dw / sw;
  const scaleY = dh / sh;
  const dm = { x: m * scaleX, y: m * scaleY };
  dest.width = dw;
  dest.height = dh;
  const dctx = dest.getContext('2d', { willReadFrequently: true });
  if (!dctx) return false;
  dctx.clearRect(0, 0, dw, dh);
  dctx.drawImage(
    pad,
    0, 0, pad.width, pad.height,
    -dm.x, -dm.y, pad.width * scaleX, pad.height * scaleY,
  );
  return true;
}

/**
 * Decode + re-encode a dropped image into a bounded data-URL payload.
 *
 * `deviceMaxDim` caps the longest side to the selected target headset's
 * recommended texture size (see `VR_HEADSETS[].maxTextureDim`); the caller
 * warns when the source exceeded it. `ignoreLimits` relaxes the soft caps
 * (dimension cap floored at `MAX_IMAGE_DIM_RELAXED`, no per-image char cap, no
 * source-pixel guard) but the hard ceiling still applies. Within limits, an
 * over-budget encode walks the quality ladder and then retries at halved
 * dimensions ("more textures at smaller res" beats one huge one) before giving
 * up with `too-large` — the caller then offers the override dialog.
 */
export async function encodeImageFile(
  file: File,
  ignoreLimits: boolean,
  deviceMaxDim: number = MAX_IMAGE_DIM,
  mode: ImageConvertMode = 'convert',
): Promise<EncodeImageResult> {
  if (isSvgFile(file)) return { ok: false, reason: 'svg' };

  const decoded = await decodeSource(file);
  if (!decoded || decoded.width < 1 || decoded.height < 1) {
    return { ok: false, reason: 'load' };
  }

  try {
    if (!ignoreLimits && decoded.width * decoded.height > MAX_SOURCE_PIXELS) {
      return { ok: false, reason: 'pixels', width: decoded.width, height: decoded.height };
    }

    const caps = await probeEncodeCaps();

    // Whether this source must stay bit-exact. Read from the file HEAD for
    // WebP (lossy vs lossless container), not from the extension — the app's
    // own export/re-drop loop hands back `.webp` files of both kinds.
    let head: Uint8Array | undefined;
    if (/\.webp$/i.test(file.name) || file.type === 'image/webp') {
      try {
        head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
      } catch {
        /* unreadable slice — treated as lossy below */
      }
    }
    const preferLossless = sourcePrefersLossless(file.name, file.type, head);

    // Normal drops cap the longest side at the selected device's recommended
    // texture size; ignoring limits relaxes to at least MAX_IMAGE_DIM_RELAXED
    // (never below the device cap, so a high-end target keeps its headroom).
    const dimCap = ignoreLimits
      ? Math.max(deviceMaxDim, MAX_IMAGE_DIM_RELAXED)
      : deviceMaxDim;
    let scale = Math.min(1, dimCap / Math.max(decoded.width, decoded.height));
    const budget = ignoreLimits ? HARD_MAX_IMAGE_ENCODED_CHARS : MAX_IMAGE_ENCODED_CHARS;

    const MIN_DIM = 64;
    let stats: PixelStats | null = null;
    // Reused across retry passes — a fresh canvas per pass allocated (and
    // leaked to GC) tens of MB on every halving.
    const baseCanvas = document.createElement('canvas');
    const potCanvas = document.createElement('canvas');

    for (;;) {
      const w = Math.max(1, Math.round(decoded.width * scale));
      const h = Math.max(1, Math.round(decoded.height * scale));
      const ctx = drawInto(baseCanvas, decoded.source, w, h);
      if (!ctx) return { ok: false, reason: 'load' };
      // The scan describes the pixels, which don't change across retries.
      if (!stats) stats = scanPixels(ctx, w, h);

      const candidates = chooseFormat(caps, {
        preferLossless,
        alpha: stats.alpha,
        allowWebp: mode === 'convert',
      });

      // The un-snapped encode first: it is both the fallback payload AND the
      // "original" the node reverts to, so the power-of-two snap below can
      // only ever ship with its escape hatch already in hand.
      const base = await encodeWithinBudget(baseCanvas, candidates, budget);
      if (!base) {
        if (Math.max(w, h) <= MIN_DIM) break;
        scale /= 2;
        continue;
      }

      // The power-of-two snap is part of "convert" — declining conversion
      // keeps the pixels exactly as the capped 1:1 blit produced them.
      const pot =
        mode === 'convert'
          ? potTarget(w, h, dimCap, stats)
          : { width: w, height: h, applied: false };
      if (pot.applied && drawWrappedResize(potCanvas, baseCanvas, pot.width, pot.height)) {
        const snapped = await encodeWithinBudget(potCanvas, candidates, budget);
        // A snap that doesn't fit the budget is simply declined — never a
        // reason to throw away half the resolution.
        if (snapped) {
          return {
            ok: true,
            dataUrl: snapped.dataUrl,
            mime: snapped.mime,
            webpAvailable: caps.webp,
            width: snapped.width,
            height: snapped.height,
            sourceWidth: decoded.width,
            sourceHeight: decoded.height,
            potApplied: true,
            original: base,
          };
        }
      }

      return {
        ok: true,
        dataUrl: base.dataUrl,
        mime: base.mime,
        webpAvailable: caps.webp,
        width: base.width,
        height: base.height,
        sourceWidth: decoded.width,
        sourceHeight: decoded.height,
        potApplied: false,
      };
    }
    return { ok: false, reason: 'too-large', width: decoded.width, height: decoded.height };
  } finally {
    decoded.cleanup();
  }
}
