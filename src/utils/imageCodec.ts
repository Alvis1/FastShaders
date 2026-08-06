/**
 * Pure decision layer for the drop-time image re-encode: which pixel
 * dimensions to target, and which codecs to try in which order.
 *
 * Split out of `imageImport.ts` (DOM-only, untestable under the node env) so
 * every rule that can be reasoned about without a canvas is node-testable.
 *
 * ── Power of two ──────────────────────────────────────────────────────────
 * POT is NOT required by anything in this stack. three r184 has no
 * `makePowerOfTwo` / `textureNeedsPowerOfTwo` path left (that was WebGL1/ES2);
 * WebGL2 and WebGPU both sample NPOT textures with RepeatWrapping and full
 * mipmap chains. So the snap is a hygiene convenience, and since it buys no
 * correctness it must cost close to nothing:
 *
 *   - NEAREST power of two per axis, never ceil. ceil inflates 1920×1080 by
 *     +102% pixels, which blows the payload budget and makes the caller's
 *     halving retry silently quarter the image; nearest costs +1%.
 *   - Declined outright when the move is expensive: more than
 *     POT_MAX_UPSCALE growth or POT_MAX_DOWNSCALE shrink on that axis. So
 *     1280×720 stays 1280×720 rather than losing 43% of its pixels.
 *   - Skipped for images the resample would visibly damage: binary-alpha
 *     cutouts (bilinear frays every edge and interacts with alphaTest) and
 *     low-colour-count sources — pixel art, UI sprites, masks, flat vector
 *     exports, where a 100×100 two-colour tile comes back with 60+ colours
 *     and a several-times-larger payload. There is no nearest-neighbour
 *     escape hatch downstream (graphToCode sets LinearFilter only for data
 *     maps), so the only safe move is not to resample them.
 *
 * Everything the snap DOES damage is recoverable: the caller keeps the
 * pre-POT encode as the Image node's "original" (see imageOriginCache), and
 * POT is skipped whenever that stash can't be produced.
 */

/** Nearest-POT is taken only when it costs at most this much growth on an
 *  axis (1920 → 2048 is 1.067; 1080 → 2048 would be 1.90 and is declined). */
export const POT_MAX_UPSCALE = 1.25;
/** …and at most this much shrink (1000 → 1024 rounds up; 1280 → 1024 would
 *  throw away 20% of the axis and is declined). */
export const POT_MAX_DOWNSCALE = 1.15;
/** Below this many distinct colours an image reads as pixel art / UI / a mask
 *  — resampling it is destructive and usually makes it BIGGER. */
export const POT_MIN_DISTINCT_COLORS = 256;
/** Never snap an axis below this — the caller's own floor for retries. */
export const POT_MIN_DIM = 64;
/** WebGPU's guaranteed maxTextureDimension2D; also the cap ceiling. */
export const MAX_TEXTURE_DIM = 8192;

/** Lossy quality steps tried IN ORDER before giving up and halving the
 *  dimensions — one re-encode saves 30-45% of the bytes, halving throws away
 *  75% of the pixels. */
export const QUALITY_LADDER = [0.85, 0.75, 0.65] as const;

/** Wrapped padding (source px) drawn around a tile before a POT resample, so
 *  the resampler sees the pixels the texture actually wraps onto instead of
 *  canvas edge-clamp. `repeat` defaults ON for Image nodes and seamless tiles
 *  are a primary use, so without this a POT snap puts a visible seam on every
 *  tile boundary. */
export const POT_WRAP_MARGIN = 8;

export type ImageEncodeMime = 'image/webp' | 'image/png' | 'image/jpeg';

/** What the running browser will actually DO — both probed at runtime, never
 *  inferred from a UA string or from `quality === 1`. WebKit silently returns
 *  PNG from `toDataURL('image/webp', …)`, and the HTML spec leaves `quality`
 *  UA-defined for WebP, so Chromium's q1.0 → lossless mapping is an
 *  implementation detail that has to be measured. */
export interface EncodeCaps {
  /** A WebP request really comes back as WebP. */
  webp: boolean;
  /** …and a q=1 WebP round-trips pixel-identically. */
  webpLossless: boolean;
}

/** One pass over the decoded pixels; drives both the codec choice and the
 *  POT skip rules. `distinctColors` saturates (see POT_MIN_DISTINCT_COLORS) —
 *  it answers "few or many", not "how many". */
export interface PixelStats {
  /** Any pixel with alpha < 255. */
  alpha: boolean;
  /** Alpha is present and only ever 0 or 255 — a hard cutout mask. */
  binaryAlpha: boolean;
  /** Distinct RGB values, counted up to POT_MIN_DISTINCT_COLORS then capped. */
  distinctColors: number;
}

export interface EncodeCandidate {
  mime: ImageEncodeMime;
  /** Omitted for PNG (always lossless). */
  quality?: number;
  lossless: boolean;
}

/** Bound and normalize a device texture cap before it steers the POT rules.
 *  `resolveDeviceTextureDim` prefers a user-imported cost profile over the
 *  built-in presets, and an imported profile may carry any finite positive
 *  number — so the cap is NOT trustworthy as a power of two. */
export function clampPotCap(cap: number): number {
  const n = Number.isFinite(cap) ? Math.floor(cap) : 0;
  // Non-positive is not "tiny", it is unset/garbage — fall back to the
  // conservative default rather than clamping it up to the 64px floor, which
  // would decline every snap on the whole image.
  const bounded = n > 0 ? Math.min(MAX_TEXTURE_DIM, Math.max(POT_MIN_DIM, n)) : 1024;
  // Floor to POT: an upscale target must never exceed the real cap.
  return 2 ** Math.floor(Math.log2(bounded));
}

/** Nearest power of two for one axis, or `n` unchanged when the move is too
 *  expensive in either direction. */
export function potAxis(n: number, cap: number): number {
  const v = Math.max(1, Math.round(n));
  const safeCap = clampPotCap(cap);
  const lo = 2 ** Math.floor(Math.log2(v));
  if (v === lo) return v; // already POT
  const hi = lo * 2;
  if (hi <= safeCap && hi / v <= POT_MAX_UPSCALE) return hi;
  if (lo >= POT_MIN_DIM && v / lo <= POT_MAX_DOWNSCALE) return lo;
  return v;
}

/** True when the resample itself would be the damage — see the module note. */
export function shouldSkipPot(stats: PixelStats): boolean {
  return stats.binaryAlpha || stats.distinctColors < POT_MIN_DISTINCT_COLORS;
}

export interface PotTarget {
  width: number;
  height: number;
  /** False when both axes declined (or the image was skipped) — the caller
   *  must then keep the 1:1 blit rather than resampling to the same size. */
  applied: boolean;
}

/** POT target for an already-capped size. Axes are decided INDEPENDENTLY:
 *  1920×1080 → 2048×1024 rather than a square. */
export function potTarget(width: number, height: number, cap: number, stats?: PixelStats): PotTarget {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (stats && shouldSkipPot(stats)) return { width: w, height: h, applied: false };
  const pw = potAxis(w, cap);
  const ph = potAxis(h, cap);
  return { width: pw, height: ph, applied: pw !== w || ph !== h };
}

/**
 * Ordered encode candidates. The list is a FALL-THROUGH, not a preference:
 * the caller takes the first one that fits the payload budget at the current
 * dimensions, and only halves the image once every candidate has failed.
 *
 * That ordering is load-bearing. Making the lossless branch absolute (no
 * lossy fallback) sounds protective and isn't: a 2048² PNG screenshot is
 * ~10M base64 chars, so with nothing to fall through to it would be halved
 * repeatedly and land at 256-512px, where today it is stored at full
 * resolution as WebP.
 *
 * HARD INVARIANT, asserted by test: an image with alpha never yields a JPEG
 * candidate. On Apple engines `webp` is false, and JPEG would flatten every
 * transparent pixel to opaque black.
 */
export function chooseFormat(
  caps: EncodeCaps,
  opts: { preferLossless: boolean; alpha: boolean; allowWebp?: boolean },
): EncodeCandidate[] {
  const png: EncodeCandidate = { mime: 'image/png', lossless: true };
  const list: EncodeCandidate[] = [];
  // `allowWebp: false` is the user declining conversion at drop time. The
  // canvas round-trip still happens (EXIF strip, device cap, payload budget)
  // — only the format CHANGE is off, so the image stays in its own family.
  const webp = caps.webp && opts.allowWebp !== false;

  if (opts.preferLossless) {
    // Lossless WebP first where the browser really delivers it: measured
    // bit-identical to PNG at ~2.1-2.6× smaller.
    if (webp && caps.webpLossless) list.push({ mime: 'image/webp', quality: 1, lossless: true });
    list.push(png);
  }

  // Lossy tier — the primary path for photos, and the over-budget
  // fall-through for the lossless branch above.
  if (webp) list.push({ mime: 'image/webp', quality: QUALITY_LADDER[0], lossless: false });

  if (opts.alpha) {
    if (!list.some((c) => c.mime === 'image/png')) list.push(png);
  } else {
    list.push({ mime: 'image/jpeg', quality: QUALITY_LADDER[0], lossless: false });
  }
  return list;
}

/** Exact base64 length of a `data:<mime>;base64,<payload>` URL for a blob of
 *  `byteLength` bytes — lets the budget be checked on the blob, before the
 *  multi-megabyte string is ever materialized. */
export function base64CharsForBytes(byteLength: number, mime: string): number {
  const prefix = `data:${mime};base64,`.length;
  return prefix + Math.ceil(Math.max(0, byteLength) / 3) * 4;
}

const ascii = (bytes: Uint8Array, at: number): string =>
  String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

/**
 * Is this `.webp` file a LOSSLESS (VP8L) stream?
 *
 * Keying "re-encode losslessly" off the `.webp` extension alone would break
 * the app's own documented round-trip: exportBundle tells users to re-drop an
 * edited image from `images/`, and those files are now WebP. Treating a LOSSY
 * webp as lossless forces a lossless re-encode of DCT ringing — which codes
 * far larger than the file it came from, blows the budget, and gets halved.
 * So read the container: RIFF….WEBP then `VP8L` (lossless), `VP8 ` (lossy),
 * or `VP8X` (extended — walk its chunks).
 */
export function isLosslessWebpBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  if (ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WEBP') return false;

  const fourcc = ascii(bytes, 12);
  if (fourcc === 'VP8L') return true;
  if (fourcc !== 'VP8X') return false;

  // Extended format: a chunk list follows the 8-byte header + 10-byte payload.
  // Walk it (bounded) looking for the image data chunk.
  let at = 12 + 8 + 10;
  for (let guard = 0; guard < 16 && at + 8 <= bytes.length; guard++) {
    const id = ascii(bytes, at);
    if (id === 'VP8L') return true;
    if (id === 'VP8 ') return false;
    const size =
      bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24);
    if (!(size > 0)) return false;
    at += 8 + size + (size & 1); // chunks are padded to even length
  }
  return false;
}

/**
 * Should this SOURCE be kept lossless if the budget allows?
 *
 * PNG is how normal/height maps arrive, and the app only learns an image is a
 * data map when the user ticks "Data map" AFTER import — by then the pixels
 * are baked. Measured on a 512×512 tangent-space normal map, lossy WebP
 * q0.85 costs 43° max / 1.76° mean angular error after normalMap()'s remap
 * (~10× the 8-bit quantization floor) and collapses 236 distinct red levels
 * to 206 — that is the banding. Lossless costs nothing.
 */
export function sourcePrefersLossless(
  fileName: string,
  fileType: string,
  headBytes?: Uint8Array,
): boolean {
  const lower = fileName.toLowerCase();
  if (fileType === 'image/png' || lower.endsWith('.png')) return true;
  if (fileType === 'image/webp' || lower.endsWith('.webp')) {
    return headBytes ? isLosslessWebpBytes(headBytes) : false;
  }
  return false;
}
