/**
 * Pure decision layer for the drop-time image re-encode: which pixel
 * dimensions to target, and which codecs to try in which order.
 *
 * Split out of `imageImport.ts` (DOM-only, untestable under the node env) so
 * every rule that can be reasoned about without a canvas is node-testable.
 *
 * ── Power of two ──────────────────────────────────────────────────────────
 * ALWAYS, under "convert" (owner rule, 2026-09-10: "use power of two always;
 * jump up if it is near 80 percent"). Per axis, INDEPENDENTLY:
 *
 *   - already a power of two → unchanged;
 *   - at or above POT_ROUND_UP_RATIO (80 %) of the next power of two → round
 *     UP to it (1920 → 2048, 1700 → 2048), unless that exceeds the device cap;
 *   - otherwise → round DOWN (1080 → 1024, 1600 → 1024, 1280 → 1024).
 *
 * So the largest growth on an axis is 1/0.8 = 1.25× and the largest shrink
 * just under 1.6×; 1920×1080 lands on 2048×1024 (+1 % pixels), never on a
 * square. Nothing in three r184 REQUIRES POT — WebGL2 and WebGPU both sample
 * NPOT textures with RepeatWrapping and full mips — so this is a deliberate
 * texture-hygiene choice, and it is what makes the resolution ladder a clean
 * 2048 / 1024 / 512 / 256 sequence.
 *
 * What it replaced: a conservative snap that took the NEAREST power of two
 * only when the move was within 1.25× up / 1.15× down (so 1280×720 stayed
 * NPOT), and skipped binary-alpha cutouts and low-colour sources entirely
 * because a bilinear resample frays a cutout's edge and blurs pixel art.
 * Those skips are GONE with "always" — such images are now resampled too, and
 * that damage is real. The escape hatch is unchanged: the caller keeps the
 * pre-POT encode as the node's "original" (see imageOriginCache), "Revert to
 * original" restores it exactly, and declining conversion at drop time ("No"
 * in the import dialog) still stores the image untouched.
 */

/** An axis at or above this fraction of the NEXT power of two rounds UP to it;
 *  below it rounds DOWN (owner rule: "jump up if it is near 80 percent"). */
export const POT_ROUND_UP_RATIO = 0.8;
/** The floor `clampPotCap` bounds a device cap to. */
export const POT_MIN_DIM = 64;
/** WebGPU's guaranteed maxTextureDimension2D; also the cap ceiling. */
export const MAX_TEXTURE_DIM = 8192;

/**
 * The resolution ladder offered by the Image node's settings menu — POWER-OF-
 * TWO sizes derived from the ORIGINAL source, so a user who dropped a 4 K photo
 * onto a node that only ever shows a blurred backdrop can spend a tenth of the
 * bandwidth on it.
 *
 * The top rung is the original snapped by the SAME rule the drop applies
 * (`potTarget`, 80 % round-up, capped at the device) — so a freshly converted
 * image is ON the ladder at its top rung — and each further rung halves both
 * axes, which keeps every rung a power of two. Anchored to the ORIGINAL rather
 * than to what is currently stored, which is what makes the choice reversible:
 * an anchor that moved with each pick could only ever descend.
 *
 * `original` marks a rung whose size IS the source's (a source that was
 * already a power of two within the cap); picking it restores the original
 * rather than re-encoding it. Any other source's exact size is not a rung —
 * "Revert to original" is the way back to it.
 *
 * The floor is a SHORT-side rule, so a panorama is not cut off early by its
 * long side still being generous. It is 8 px (owner, 2026-09-10: "allow to go
 * as low as 8px") — it was 64 behind a fixed list of four rungs, but a tiny
 * texture is a legitimate thing to want: a palette strip, a pixel-art source,
 * a deliberately blocky look with Nearest filtering. So the ladder halves until
 * the short side would drop below the floor, and a 2048×1024 original offers
 * eight rungs down to 16×8.
 */
export const RESOLUTION_MIN_DIM = 8;

export interface ResolutionStep {
  /** `${width}x${height}` — the option's identity in the menu. */
  key: string;
  width: number;
  height: number;
  /** This rung is exactly the source's own size. */
  original: boolean;
}

export function resolutionLadder(
  width: number,
  height: number,
  cap: number = MAX_TEXTURE_DIM,
): ResolutionStep[] {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return [];
  if (width < 1 || height < 1) return [];
  const limit = Number.isFinite(cap) && cap >= 1 ? cap : MAX_TEXTURE_DIM;
  const srcW = Math.round(width);
  const srcH = Math.round(height);
  const anchor = potTarget(srcW, srcH, limit);
  const out: ResolutionStep[] = [];
  let w = anchor.width;
  let h = anchor.height;
  // Halving a power of two is a power of two, so every rung stays one; below
  // the floor there is nothing further down either.
  while (Number.isInteger(w) && Number.isInteger(h) && Math.min(w, h) >= RESOLUTION_MIN_DIM) {
    out.push({ key: `${w}x${h}`, width: w, height: h, original: w === srcW && h === srcH });
    w /= 2;
    h /= 2;
  }
  return out;
}

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

/** One pass over the decoded pixels; drives the codec choice (an image with
 *  alpha never becomes a JPEG). It also carried a binary-alpha flag and a
 *  distinct-colour count for the POT skip rules until 2026-09-10, when the
 *  snap became unconditional and nothing read them any more. */
export interface PixelStats {
  /** Any pixel with alpha < 255. */
  alpha: boolean;
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

/** The power of two an axis snaps to: unchanged if it already is one, the
 *  NEXT one when the axis is at least POT_ROUND_UP_RATIO of it and it fits the
 *  cap, the previous one otherwise. Never above the (POT-floored) cap. */
export function potAxis(n: number, cap: number): number {
  const v = Math.max(1, Math.round(n));
  const safeCap = clampPotCap(cap);
  const lo = 2 ** Math.floor(Math.log2(v));
  if (v === lo) return Math.min(v, safeCap);
  const hi = lo * 2;
  if (hi <= safeCap && v >= POT_ROUND_UP_RATIO * hi) return hi;
  return Math.min(lo, safeCap);
}

/** Round an axis DOWN to a power of two (never above the cap) — the drop's
 *  fallback when a rounded-UP target will not encode within the budget. */
export function potFloorAxis(n: number, cap: number): number {
  const v = Math.max(1, Math.round(n));
  return Math.min(2 ** Math.floor(Math.log2(v)), clampPotCap(cap));
}

export interface PotTarget {
  width: number;
  height: number;
  /** False when the size is already a power of two on both axes — the caller
   *  must then keep the 1:1 blit rather than resampling to the same size. */
  applied: boolean;
}

/** POT target for an already-capped size. Axes are decided INDEPENDENTLY:
 *  1920×1080 → 2048×1024 rather than a square. */
export function potTarget(width: number, height: number, cap: number): PotTarget {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const pw = potAxis(w, cap);
  const ph = potAxis(h, cap);
  return { width: pw, height: ph, applied: pw !== w || ph !== h };
}

/** The same, rounding both axes DOWN — always ≤ the input, so it fits any
 *  budget the input fit. */
export function potFloorTarget(width: number, height: number, cap: number): PotTarget {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const pw = potFloorAxis(w, cap);
  const ph = potFloorAxis(h, cap);
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
