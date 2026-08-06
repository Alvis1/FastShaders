import { describe, it, expect } from 'vitest';
import {
  POT_MIN_DISTINCT_COLORS,
  base64CharsForBytes,
  chooseFormat,
  clampPotCap,
  isLosslessWebpBytes,
  potAxis,
  potTarget,
  shouldSkipPot,
  sourcePrefersLossless,
  type EncodeCaps,
  type PixelStats,
} from './imageCodec';

const stats = (over: Partial<PixelStats> = {}): PixelStats => ({
  alpha: false,
  binaryAlpha: false,
  distinctColors: POT_MIN_DISTINCT_COLORS,
  ...over,
});

describe('potAxis', () => {
  // The whole point of the guards: a snap that is nearly free is taken, an
  // expensive one is declined. `nearest` (not ceil) is what keeps 1920 from
  // becoming 2048×2048 — measured at +102% pixels, which blows the payload
  // budget and gets the image halved by the caller's retry.
  it.each([
    // [n, cap, expected, why]
    [1920, 2048, 2048, 'cheap round-up (+6.7%)'],
    [1080, 2048, 1024, 'round-up is +90% so declined; round-down is −5% so taken'],
    [1000, 2048, 1024, 'cheap round-up (+2.4%)'],
    [500, 2048, 512, 'cheap round-up (+2.4%)'],
    [1280, 2048, 1280, 'both directions too expensive — stays NPOT'],
    [720, 2048, 720, 'both directions too expensive — stays NPOT'],
    [2048, 2048, 2048, 'already POT'],
    [1, 2048, 1, 'already POT'],
    [1100, 2048, 1024, 'cheap round-down (−7%)'],
  ])('potAxis(%i, cap %i) = %i (%s)', (n, cap, expected) => {
    expect(potAxis(n, cap)).toBe(expected);
  });

  it('never rounds an axis UP past the device cap', () => {
    // 1920 would snap to 2048, but a 1024-cap device must not be handed one.
    expect(potAxis(1920, 1024)).toBe(1920);
    expect(potAxis(1000, 1024)).toBe(1024);
  });

  it('tolerates a hostile cap — an imported cost profile can carry anything', () => {
    // resolveDeviceTextureDim prefers a user-imported profile's maxTextureDim
    // over the built-in presets, and that value is only checked for finiteness.
    expect(clampPotCap(3000)).toBe(2048); // floored to POT: an upscale target
    expect(clampPotCap(0)).toBe(1024); //     must never exceed the real cap
    expect(clampPotCap(NaN)).toBe(1024);
    expect(clampPotCap(-5)).toBe(1024);
    expect(clampPotCap(1e9)).toBe(8192); // clamped to WebGPU's guaranteed max
    expect(potAxis(1000, 1e9)).toBe(1024);
  });
});

describe('potTarget', () => {
  it('decides each axis independently (1920×1080 → 2048×1024, never a square)', () => {
    // +1% pixels in total. A ceil rule would give 2048×2048 — +102%, which
    // blows the payload budget and gets the image halved instead.
    expect(potTarget(1920, 1080, 2048)).toEqual({ width: 2048, height: 1024, applied: true });
  });

  it('reports applied:false when both axes decline, so the caller keeps the 1:1 blit', () => {
    expect(potTarget(1280, 720, 2048)).toEqual({ width: 1280, height: 720, applied: false });
    expect(potTarget(512, 256, 2048)).toEqual({ width: 512, height: 256, applied: false });
  });

  it('skips binary-alpha cutouts — bilinear resampling frays every edge', () => {
    expect(potTarget(1000, 1000, 2048, stats({ alpha: true, binaryAlpha: true })).applied).toBe(false);
  });

  it('skips low-colour sources — pixel art / UI / masks get destroyed AND grow', () => {
    expect(potTarget(100, 100, 2048, stats({ distinctColors: 2 })).applied).toBe(false);
    expect(potTarget(1000, 1000, 2048, stats({ distinctColors: 12 })).applied).toBe(false);
    // A photograph sails through.
    expect(potTarget(1000, 1000, 2048, stats({ distinctColors: 4096 })).applied).toBe(true);
  });

  it('shouldSkipPot is the shared rule', () => {
    expect(shouldSkipPot(stats({ alpha: true, binaryAlpha: true }))).toBe(true);
    expect(shouldSkipPot(stats({ distinctColors: POT_MIN_DISTINCT_COLORS - 1 }))).toBe(true);
    expect(shouldSkipPot(stats())).toBe(false);
    // Soft (anti-aliased) alpha is NOT a cutout and must not block the snap.
    expect(shouldSkipPot(stats({ alpha: true, binaryAlpha: false }))).toBe(false);
  });
});

describe('chooseFormat', () => {
  const all: EncodeCaps = { webp: true, webpLossless: true };
  const lossyOnly: EncodeCaps = { webp: true, webpLossless: false };
  const none: EncodeCaps = { webp: false, webpLossless: false }; // WebKit

  it('HARD INVARIANT: an image with alpha never yields a JPEG candidate', () => {
    // JPEG has no alpha channel — on Apple engines (webp:false) this is the
    // difference between a transparent PNG and a black-backed one.
    for (const caps of [all, lossyOnly, none]) {
      for (const preferLossless of [true, false]) {
        const list = chooseFormat(caps, { preferLossless, alpha: true });
        expect(list.some((c) => c.mime === 'image/jpeg')).toBe(false);
        expect(list.length).toBeGreaterThan(0);
      }
    }
  });

  it('prefers lossless WebP for sources that must stay exact, PNG behind it', () => {
    const list = chooseFormat(all, { preferLossless: true, alpha: false });
    expect(list[0]).toEqual({ mime: 'image/webp', quality: 1, lossless: true });
    expect(list[1]).toEqual({ mime: 'image/png', lossless: true });
  });

  it('KEEPS a lossy fall-through behind the lossless candidates', () => {
    // Making the lossless branch absolute would hand every over-budget PNG to
    // the caller's halving retry: a 2048² screenshot is ~10M base64 chars, so
    // it would land at 256-512px where today it is stored at full resolution.
    const list = chooseFormat(all, { preferLossless: true, alpha: false });
    const lossyAt = list.findIndex((c) => !c.lossless);
    expect(lossyAt).toBeGreaterThan(0);
    expect(list.slice(0, lossyAt).every((c) => c.lossless)).toBe(true);
  });

  it('falls back to PNG (never lossless WebP) when the probe says q=1 is lossy', () => {
    const list = chooseFormat(lossyOnly, { preferLossless: true, alpha: false });
    expect(list[0]).toEqual({ mime: 'image/png', lossless: true });
  });

  it('uses WebP q0.85 first for photographic sources', () => {
    const list = chooseFormat(all, { preferLossless: false, alpha: false });
    expect(list[0]).toEqual({ mime: 'image/webp', quality: 0.85, lossless: false });
    expect(list[1].mime).toBe('image/jpeg');
  });

  it('allowWebp:false keeps the image in its own family — declining conversion', () => {
    // "Keep as-is" at drop time. The canvas round-trip still happens (EXIF
    // strip, device cap, payload budget) but the FORMAT must not change.
    expect(chooseFormat(all, { preferLossless: true, alpha: false, allowWebp: false })).toEqual([
      { mime: 'image/png', lossless: true },
      { mime: 'image/jpeg', quality: 0.85, lossless: false },
    ]);
    expect(chooseFormat(all, { preferLossless: false, alpha: false, allowWebp: false })).toEqual([
      { mime: 'image/jpeg', quality: 0.85, lossless: false },
    ]);
    // …and still never JPEG for an image with alpha.
    expect(chooseFormat(all, { preferLossless: false, alpha: true, allowWebp: false })).toEqual([
      { mime: 'image/png', lossless: true },
    ]);
  });

  it('degrades to PNG/JPEG where WebP is not honoured', () => {
    expect(chooseFormat(none, { preferLossless: false, alpha: false })).toEqual([
      { mime: 'image/jpeg', quality: 0.85, lossless: false },
    ]);
    expect(chooseFormat(none, { preferLossless: false, alpha: true })).toEqual([
      { mime: 'image/png', lossless: true },
    ]);
    // PNG first, but JPEG still behind it — that fall-through is today's
    // behaviour for an over-budget PNG on WebKit and must not be dropped.
    expect(chooseFormat(none, { preferLossless: true, alpha: false })).toEqual([
      { mime: 'image/png', lossless: true },
      { mime: 'image/jpeg', quality: 0.85, lossless: false },
    ]);
  });
});

describe('base64CharsForBytes', () => {
  it('matches the real length of a data: URL for those bytes', () => {
    // 3 bytes → 4 chars, and the prefix counts.
    expect(base64CharsForBytes(3, 'image/webp')).toBe('data:image/webp;base64,'.length + 4);
    expect(base64CharsForBytes(4, 'image/png')).toBe('data:image/png;base64,'.length + 8);
    expect(base64CharsForBytes(0, 'image/png')).toBe('data:image/png;base64,'.length);
  });
});

describe('isLosslessWebpBytes / sourcePrefersLossless', () => {
  const riff = (fourcc: string, extra: number[] = []) => {
    const head = 'RIFF    WEBP' + fourcc;
    const bytes = new Uint8Array(head.length + extra.length);
    for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i);
    bytes.set(extra, head.length);
    return bytes;
  };

  it('reads the container, not the extension', () => {
    expect(isLosslessWebpBytes(riff('VP8L'))).toBe(true);
    expect(isLosslessWebpBytes(riff('VP8 '))).toBe(false);
    expect(isLosslessWebpBytes(new Uint8Array(4))).toBe(false);
    expect(isLosslessWebpBytes(new Uint8Array(0))).toBe(false);
  });

  it('walks VP8X chunks to find the image data', () => {
    // VP8X header (8 + 10 bytes) then a chunk.
    const pad = new Array(10).fill(0);
    const lossless = riff('VP8X', [...new Array(4).fill(0), ...pad, ...'VP8L'.split('').map((c) => c.charCodeAt(0)), 1, 0, 0, 0]);
    expect(isLosslessWebpBytes(lossless)).toBe(true);
    const lossy = riff('VP8X', [...new Array(4).fill(0), ...pad, ...'VP8 '.split('').map((c) => c.charCodeAt(0)), 1, 0, 0, 0]);
    expect(isLosslessWebpBytes(lossy)).toBe(false);
  });

  it('treats PNG as lossless-preferring and JPEG as not', () => {
    expect(sourcePrefersLossless('normal.png', 'image/png')).toBe(true);
    expect(sourcePrefersLossless('normal.PNG', '')).toBe(true);
    expect(sourcePrefersLossless('photo.jpg', 'image/jpeg')).toBe(false);
  });

  it('a re-dropped .webp export is lossless-preferring only if it really is lossless', () => {
    // exportBundle tells users to re-drop an edited image from images/, and
    // those files are WebP now. Treating a LOSSY one as lossless would force a
    // lossless re-encode of DCT ringing — bigger than the file it came from,
    // over budget, and then halved.
    expect(sourcePrefersLossless('tile.webp', 'image/webp', riff('VP8L'))).toBe(true);
    expect(sourcePrefersLossless('tile.webp', 'image/webp', riff('VP8 '))).toBe(false);
    expect(sourcePrefersLossless('tile.webp', 'image/webp')).toBe(false); // head unreadable
  });
});
