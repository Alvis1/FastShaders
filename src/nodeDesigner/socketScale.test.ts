import { describe, it, expect } from 'vitest';
import {
  SOCK_SNAP,
  symSnap,
  clampToBody,
  scaleSocketOffsets,
  scaleSocketOffsetsRaw,
} from './socketScale';

/** The real shipped shapes, with the height each was authored against. */
const SHIPPED: Array<[string, Record<string, number>, number]> = [
  ['mul', { a: -12, b: 12 }, 42],
  ['dot', { a: -24, b: 20 }, 63],
  ['clamp', { x: -28, min: -8, max: 24, out: 8 }, 72],
  ['remap', { x: -32, inLow: -12, inHigh: 0, outLow: 20, outHigh: 32, out: 28 }, 83],
  ['uv', { out: -52, channel: -44, tilingU: 12, tilingV: 24, rotation: 36 }, 105],
];

describe('symSnap', () => {
  it('is symmetric about zero — Math.round is NOT', () => {
    // The trap, at a real half-step (6 = 1.5 grid units): Math.round(-1.5) is
    // −1 but Math.round(1.5) is 2, so the designer's own drag expression turns
    // a symmetric ±n pair lopsided — −4 against +8.
    expect(Math.round(-1.5) * SOCK_SNAP).toBe(-4);
    expect(Math.round(1.5) * SOCK_SNAP).toBe(8);
    expect(symSnap(-6)).toBe(-8);
    expect(symSnap(6)).toBe(8);
    expect(symSnap(-18)).toBe(-20);
    expect(symSnap(18)).toBe(20);
    for (const v of [2, 6, 10, 13.7, 51.9]) {
      expect(symSnap(-v)).toBe(-symSnap(v));
    }
  });

  it('degrades a non-finite input to 0 rather than NaN', () => {
    expect(symSnap(Number.NaN)).toBe(0);
    expect(symSnap(Infinity)).toBe(0);
  });
});

describe('clampToBody', () => {
  it('is LOOSE enough to preserve uv\'s authored out: -52 at height 105', () => {
    // The designer's stricter drag bound ((h/2 − 5) snapped) gives −44 and
    // would yank that socket the instant anyone nudged the corner.
    expect(clampToBody(-52, 105)).toBe(-52);
  });

  it('keeps an offset within half the body', () => {
    expect(clampToBody(400, 100)).toBe(48);
    expect(clampToBody(-400, 100)).toBe(-48);
  });
});

describe('scaleSocketOffsets', () => {
  it('is a strict no-op when the height does not change', () => {
    // Guards a width-only drag AND an unauthored operator node, whose ±12.5
    // defaults are off-grid and must not be quantized by a gesture that
    // changed nothing.
    const base = { a: -12.5, b: 12.5 };
    expect(scaleSocketOffsets(base, 42, 42)).toBe(base);
  });

  it('keeps a symmetric operator pair symmetric', () => {
    expect(scaleSocketOffsets({ a: -12, b: 12 }, 42, 63)).toEqual({ a: -20, b: 20 });
    // The naive snap would have produced −16 / +20 here.
    const naive = (v: number) => Math.round((v * 63) / 42 / SOCK_SNAP) * SOCK_SNAP;
    expect(naive(-12)).toBe(-16);
    expect(naive(12)).toBe(20);
  });

  it('scales every shipped shape proportionally, within half a snap step', () => {
    for (const [name, base, h0] of SHIPPED) {
      for (const factor of [0.5, 2, 4]) {
        const h1 = Math.round(h0 * factor);
        const scaled = scaleSocketOffsets(base, h0, h1);
        const bound = Math.floor((h1 / 2) / SOCK_SNAP) * SOCK_SNAP;
        for (const key of Object.keys(base)) {
          const ideal = base[key] * (h1 / h0);
          // Proportional to within half a snap step — UNLESS staying inside the
          // body binds first, which it must (uv's −52 wants −26.2 on a 53px
          // body, whose half is 24). Keeping the socket on the card wins.
          if (Math.abs(ideal) > bound) {
            expect(Math.abs(scaled[key]), `${name}.${key} at ×${factor} (clamped)`).toBe(bound);
          } else {
            expect(
              Math.abs(scaled[key] - ideal),
              `${name}.${key} at ×${factor}`,
            ).toBeLessThanOrEqual(SOCK_SNAP / 2);
          }
        }
      }
    }
  });

  it('never lets a socket leave the body it was scaled into', () => {
    // This is what removes the shrink-spill: at h91 remap's authored offsets
    // are inside, and the ratio is preserved, so they stay inside at any size.
    for (const [name, base, h0] of SHIPPED) {
      for (const h1 of [28, 40, 60, h0, h0 * 2, 400]) {
        const scaled = scaleSocketOffsets(base, h0, Math.round(h1));
        for (const key of Object.keys(scaled)) {
          expect(Math.abs(scaled[key]), `${name}.${key} at h${h1}`).toBeLessThanOrEqual(h1 / 2);
        }
      }
    }
  });

  it('leaves the base alone for a degenerate reference height', () => {
    // h0 is measured from the DOM in the auto-height case and can be 0 on a
    // card that has not mounted yet — that must not produce NaN offsets.
    const base = { a: -12, b: 12 };
    for (const h0 of [0, -10, Number.NaN]) {
      expect(scaleSocketOffsets(base, h0, 80)).toBe(base);
    }
    expect(scaleSocketOffsets(base, 42, Number.NaN)).toBe(base);
    expect(scaleSocketOffsets({}, 42, 84)).toEqual({});
  });
});

describe('repeated resizes', () => {
  it('the RAW shadow round-trips exactly', () => {
    // Why the session shadow exists: derived from the exact products, a
    // grow-then-shrink returns the original numbers.
    const base: Record<string, number> = { a: -12, b: 12, out: 20 };
    const grown = scaleSocketOffsetsRaw(base, 60 / 42);
    const back = scaleSocketOffsetsRaw(grown, 42 / 60);
    for (const k of Object.keys(base)) expect(back[k]).toBeCloseTo(base[k], 10);
  });

  it('snapping alone would drift, but stays bounded', () => {
    // Documents the error the shadow removes: re-snapping each leg of a
    // grow/shrink walk accumulates, but never past half a step per leg.
    let cur: Record<string, number> = { a: -20, b: 20 };
    let h = 54;
    for (const next of [48, 54, 60, 54]) {
      cur = scaleSocketOffsets(cur, h, next);
      h = next;
    }
    expect(Math.abs(Math.abs(cur.a) - 20)).toBeLessThanOrEqual(SOCK_SNAP);
    expect(cur.a).toBe(-cur.b); // symmetry survives the whole walk
  });
});
