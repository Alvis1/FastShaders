/**
 * Drop-time image ingestion: decode a dropped file, re-encode it through a
 * canvas, and hand back a bounded `data:` URL for the Image node payload.
 *
 * The canvas round-trip is deliberate: it strips EXIF/GPS metadata (dropped
 * files are treated as untrusted), applies EXIF orientation so phone photos
 * land upright, caps dimensions, and converts everything to a compact web
 * codec. Encode preference: WebP q0.85 → PNG when the image has alpha →
 * JPEG when the browser can't encode WebP (Safari silently returns a PNG
 * data URL from `toDataURL('image/webp')` — detect by the returned MIME
 * prefix, never assume).
 *
 * DOM-only module (Image/canvas/createImageBitmap) — keep it out of
 * node-environment test imports; the pure validation lives in `imageNode.ts`.
 */

import {
  MAX_IMAGE_ENCODED_CHARS,
  HARD_MAX_IMAGE_ENCODED_CHARS,
  MAX_IMAGE_DIM,
  MAX_IMAGE_DIM_RELAXED,
  MAX_SOURCE_PIXELS,
} from './imageNode';

export type EncodeImageResult =
  | {
      ok: true;
      dataUrl: string;
      /** Final (possibly downscaled) encoded dimensions. */
      width: number;
      height: number;
      /** Original decoded source dimensions — the caller compares these against
       *  the device cap to decide whether to warn about downscaling. */
      sourceWidth: number;
      sourceHeight: number;
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

/** Any pixel with alpha < 255 → the image needs an alpha-capable codec. */
function hasAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

/** Encode a canvas with the WebP → PNG(alpha) → JPEG preference. */
function encodeCanvas(
  canvas: HTMLCanvasElement,
  alpha: boolean,
  preferLossless: boolean,
  budget: number,
): string {
  if (preferLossless) {
    // PNG sources are how data maps (normal/height) usually arrive — a lossy
    // WebP round-trip would corrupt them (the user only flips the node to
    // 'data' mode AFTER import, when the pixels are already baked). Stay
    // lossless whenever the budget allows; fall through to lossy otherwise.
    const png = canvas.toDataURL('image/png');
    if (png.length <= budget) return png;
  }
  if (alpha) {
    const png = canvas.toDataURL('image/png');
    // WebP carries alpha too and is usually much smaller — use it when the
    // browser really encodes it (Safari falls back to PNG silently).
    const webp = canvas.toDataURL('image/webp', 0.85);
    return webp.startsWith('data:image/webp') && webp.length < png.length ? webp : png;
  }
  const webp = canvas.toDataURL('image/webp', 0.85);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', 0.85);
}

/**
 * Decode + re-encode a dropped image into a bounded data-URL payload.
 *
 * `deviceMaxDim` caps the longest side to the selected target headset's
 * recommended texture size (see `VR_HEADSETS[].maxTextureDim`); the caller
 * warns when the source exceeded it. `ignoreLimits` relaxes the soft caps
 * (dimension cap floored at `MAX_IMAGE_DIM_RELAXED`, no per-image char cap, no
 * source-pixel guard) but the hard ceiling still applies. Within limits, an
 * over-budget encode retries at halved dimensions ("more textures at smaller
 * res" beats one huge one) before giving up with `too-large` — the caller then
 * offers the override dialog.
 */
export async function encodeImageFile(
  file: File,
  ignoreLimits: boolean,
  deviceMaxDim: number = MAX_IMAGE_DIM,
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

    // Normal drops cap the longest side at the selected device's recommended
    // texture size; ignoring limits relaxes to at least MAX_IMAGE_DIM_RELAXED
    // (never below the device cap, so a high-end target keeps its headroom).
    const dimCap = ignoreLimits
      ? Math.max(deviceMaxDim, MAX_IMAGE_DIM_RELAXED)
      : deviceMaxDim;
    let scale = Math.min(1, dimCap / Math.max(decoded.width, decoded.height));
    const budget = ignoreLimits ? HARD_MAX_IMAGE_ENCODED_CHARS : MAX_IMAGE_ENCODED_CHARS;
    // PNG sources stay lossless when they fit — see encodeCanvas.
    const preferLossless =
      file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');

    const MIN_DIM = 64;
    let alphaKnown: boolean | null = null;

    // Downscale-retry: halve until the encode fits the per-image budget.
    for (;;) {
      const w = Math.max(1, Math.round(decoded.width * scale));
      const h = Math.max(1, Math.round(decoded.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return { ok: false, reason: 'load' };
      ctx.drawImage(decoded.source, 0, 0, w, h);
      if (alphaKnown === null) alphaKnown = hasAlpha(ctx, w, h);

      const dataUrl = encodeCanvas(canvas, alphaKnown, preferLossless, budget);
      if (dataUrl.length <= budget) {
        return {
          ok: true,
          dataUrl,
          width: w,
          height: h,
          sourceWidth: decoded.width,
          sourceHeight: decoded.height,
        };
      }
      if (Math.max(w, h) <= MIN_DIM) break;
      scale /= 2;
    }
    return { ok: false, reason: 'too-large', width: decoded.width, height: decoded.height };
  } finally {
    decoded.cleanup();
  }
}
