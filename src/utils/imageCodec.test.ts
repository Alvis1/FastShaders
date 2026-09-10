import { describe, it, expect } from 'vitest';
import {
  POT_ROUND_UP_RATIO,
  base64CharsForBytes,
  chooseFormat,
  clampPotCap,
  isLosslessWebpBytes,
  potAxis,
  potFloorAxis,
  potFloorTarget,
  potTarget,
  resolutionLadder,
  RESOLUTION_MIN_DIM,
  sourcePrefersLossless,
  type EncodeCaps,
} from './imageCodec';

const isPot = (n: number) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

describe('potAxis — power of two ALWAYS, round up at 80 %', () => {
  // Owner rule (2026-09-10): "use power of two always; jump up if it is near
  // 80 percent". An axis at or above 80 % of the NEXT power of two rounds up
  // to it; anything else rounds down. No axis is ever left NPOT.
  it.each([
    // [n, cap, expected, why]
    [1920, 2048, 2048, '94 % of 2048 → up'],
    [1700, 2048, 2048, '83 % of 2048 → up'],
    [1600, 2048, 1024, '78 % of 2048 → down'],
    [1080, 2048, 1024, '53 % of 2048 → down'],
    [1280, 2048, 1024, '63 % of 2048 → down (the old rule left it NPOT)'],
    [820, 2048, 1024, '80.1 % of 1024 → up'],
    [819, 2048, 512, '79.98 % of 1024 → down'],
    [720, 2048, 512, '70 % of 1024 → down'],
    [500, 2048, 512, '98 % of 512 → up'],
    [400, 2048, 256, '78 % of 512 → down'],
    [103, 2048, 128, '80.5 % of 128 → up'],
    [100, 2048, 64, '78 % of 128 → down'],
    [2048, 2048, 2048, 'already POT'],
    [1, 2048, 1, 'already POT'],
  ])('potAxis(%i, cap %i) = %i (%s)', (n, cap, expected) => {
    expect(potAxis(n, cap)).toBe(expected);
  });

  it('is the 0.8 threshold the owner named', () => {
    expect(POT_ROUND_UP_RATIO).toBe(0.8);
  });

  it('never rounds an axis UP past the device cap — it rounds down instead', () => {
    // 1920 would snap to 2048, but a 1024-cap device must not be handed one;
    // "always" means the result is still a power of two, so it goes DOWN.
    expect(potAxis(1920, 1024)).toBe(1024);
    expect(potAxis(1000, 1024)).toBe(1024);
    // An axis already beyond the cap lands ON the cap, never above it.
    expect(potAxis(5000, 2048)).toBe(2048);
    expect(potAxis(4096, 2048)).toBe(2048);
  });

  it('returns a power of two ≤ the cap for EVERY size', () => {
    for (let n = 1; n <= 5000; n += 7) {
      for (const cap of [1024, 2048, 3000]) {
        const p = potAxis(n, cap);
        expect(isPot(p)).toBe(true);
        expect(p).toBeLessThanOrEqual(clampPotCap(cap));
        // ...and the growth never exceeds the 80 % rule's 1.25×.
        expect(p / n).toBeLessThanOrEqual(1 / POT_ROUND_UP_RATIO + 1e-9);
      }
    }
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

describe('potFloorAxis — the budget fallback', () => {
  it('rounds DOWN, never above the cap', () => {
    expect(potFloorAxis(1920, 2048)).toBe(1024);
    expect(potFloorAxis(2048, 2048)).toBe(2048);
    expect(potFloorAxis(5000, 2048)).toBe(2048);
    expect(potFloorAxis(1, 2048)).toBe(1);
  });
});

describe('potTarget', () => {
  it('decides each axis independently (1920×1080 → 2048×1024, never a square)', () => {
    // +1% pixels in total. A ceil rule would give 2048×2048 — +102%, which
    // blows the payload budget and gets the image halved instead.
    expect(potTarget(1920, 1080, 2048)).toEqual({ width: 2048, height: 1024, applied: true });
  });

  it('snaps what the old conservative rule declined', () => {
    // 1280×720 stayed NPOT under the nearest-within-1.25×/1.15× rule.
    expect(potTarget(1280, 720, 2048)).toEqual({ width: 1024, height: 512, applied: true });
  });

  it('reports applied:false only when the size is ALREADY a power of two', () => {
    expect(potTarget(512, 256, 2048)).toEqual({ width: 512, height: 256, applied: false });
    expect(potTarget(512, 300, 2048).applied).toBe(true);
  });

  it('no longer skips pixel art or cutouts — "always" means always', () => {
    // The skip rules took a PixelStats argument; there is no such parameter
    // now, so a 100×100 two-colour tile snaps like anything else (→ 64×64).
    expect(potTarget.length).toBe(3);
    expect(potTarget(100, 100, 2048)).toEqual({ width: 64, height: 64, applied: true });
  });
});

describe('potFloorTarget', () => {
  it('is never larger than its input, so it fits any budget the input fit', () => {
    expect(potFloorTarget(1920, 1080, 2048)).toEqual({ width: 1024, height: 1024, applied: true });
    for (const [w, h] of [[1920, 1080], [1700, 900], [3000, 2000], [512, 512]]) {
      const t = potFloorTarget(w, h, 2048);
      expect(t.width).toBeLessThanOrEqual(Math.max(w, 1));
      expect(t.height).toBeLessThanOrEqual(Math.max(h, 1));
      expect(isPot(t.width) && isPot(t.height)).toBe(true);
    }
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
    const head = 'RIFF\u0000\u0000\u0000\u0000WEBP' + fourcc;
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

describe('resolutionLadder', () => {
  it('offers POWER-OF-TWO rungs: the snapped original, then halvings of it', () => {
    // Anchored to the original through the drop's own rule, so a freshly
    // converted 1920×1080 photo (stored as 2048×1024) sits on the top rung.
    expect(resolutionLadder(1920, 1080, 2048)).toEqual([
      { key: '2048x1024', width: 2048, height: 1024, original: false },
      { key: '1024x512', width: 1024, height: 512, original: false },
      { key: '512x256', width: 512, height: 256, original: false },
      { key: '256x128', width: 256, height: 128, original: false },
      { key: '128x64', width: 128, height: 64, original: false },
      { key: '64x32', width: 64, height: 32, original: false },
      { key: '32x16', width: 32, height: 16, original: false },
      { key: '16x8', width: 16, height: 8, original: false },
    ]);
  });

  it('goes down to an 8 px short side and no further', () => {
    // Owner, 2026-09-10: "allow to go as low as 8px".
    expect(RESOLUTION_MIN_DIM).toBe(8);
    for (const [w, h] of [[1920, 1080], [1024, 1024], [4096, 256], [100, 5000]]) {
      const steps = resolutionLadder(w, h, 2048);
      const last = steps[steps.length - 1];
      expect(Math.min(last.width, last.height), `${w}x${h}`).toBe(8);
    }
  });

  it('marks the rung that IS the source when the source is already POT', () => {
    const steps = resolutionLadder(1024, 1024, 2048);
    expect(steps[0]).toEqual({ key: '1024x1024', width: 1024, height: 1024, original: true });
    expect(steps.slice(1).every((s) => !s.original)).toBe(true);
  });

  it('every rung is a power of two on both axes, for any source', () => {
    for (const [w, h] of [[1920, 1080], [1280, 720], [3000, 2000], [777, 333], [4096, 256], [100, 5000]]) {
      for (const s of resolutionLadder(w, h, 2048)) {
        expect(isPot(s.width) && isPot(s.height)).toBe(true);
        expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(2048);
      }
    }
  });

  it('stops on the SHORT side, so a panorama is not cut off early', () => {
    // 4096×256: the long side still has room when the short side reaches 8.
    const steps = resolutionLadder(4096, 256);
    expect(steps.map((s) => s.key)).toEqual([
      '4096x256', '2048x128', '1024x64', '512x32', '256x16', '128x8',
    ]);
  });

  it('offers nothing below the floor', () => {
    // 5 rounds down to 4 (5 < 80 % of 8), which is under the 8 floor.
    expect(resolutionLadder(5, 4096)).toEqual([]);
    expect(resolutionLadder(RESOLUTION_MIN_DIM, RESOLUTION_MIN_DIM)).toEqual([
      { key: '8x8', width: 8, height: 8, original: true },
    ]);
  });

  it('never offers a rung above the device cap', () => {
    // The top of the ladder can exceed the cap when the user switched to a
    // smaller headset profile after the drop; the anchor lands ON the cap.
    expect(resolutionLadder(2048, 2048, 1024).map((s) => s.key)).toEqual([
      '1024x1024', '512x512', '256x256', '128x128', '64x64', '32x32', '16x16', '8x8',
    ]);
  });

  it('refuses junk dimensions', () => {
    // width/height come off a node's `values`, i.e. out of a .fastshader file.
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(resolutionLadder(bad, 1024)).toEqual([]);
      expect(resolutionLadder(1024, bad)).toEqual([]);
    }
    // A junk cap falls back to the hard texture ceiling rather than emptying
    // the ladder — a bad profile must not remove the control.
    expect(resolutionLadder(512, 512, NaN)).toHaveLength(7);
  });

  it('never repeats a size', () => {
    const steps = resolutionLadder(1920, 1080, 2048);
    expect(new Set(steps.map((s) => s.key)).size).toBe(steps.length);
  });
});
