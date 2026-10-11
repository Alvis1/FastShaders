import { describe, it, expect, vi } from 'vitest';
import {
  readColorRamp,
  parseRampStops,
  formatRampStops,
  evaluateRamp,
  rampHalfTable,
  rampFetch,
  rampRangeOver,
  rampCss,
  linearToHex,
  addStopAt,
  insertStopNear,
  removeStop,
  moveStop,
  indexAfterMove,
  flipStops,
  setStopHex,
  setStopAlpha,
  isRampInterp,
  RAMP_INTERPS,
  DEFAULT_RAMP_STOPS,
  RAMP_MAX_STOPS,
  type ColorRamp,
  type RampInterp,
} from './colorRamp';
import { srgbToLinear01 } from './colorUtils';
import { fetchHalf } from './lutTable';
import { getNodeValues } from '@/types';
import { makeNode } from '@/test-utils';

/**
 * utils/colorRamp.ts — THE reader of a Color Ramp node's stored ramp and the
 * CPU twin of `fsColorRamp`. The reader is total on adversarial `values` (a
 * `.fastshader` is adversarial input) and every consumer reads the ROUNDED
 * canonical ramp; the evaluator is Blender's BKE_colorband_evaluate, held here
 * to an independent transcription of the C.
 */

const ramp = (stops?: unknown, interp?: unknown): ColorRamp => readColorRamp({ stops, interp });
const stopsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => `${(i / Math.max(n - 1, 1)).toFixed(4)} #${(i * 7).toString(16).padStart(2, '0')}80ff ${(1 - i / 64).toFixed(3)}`).join(',');

describe('readColorRamp — total on unknown, canonical everywhere', () => {
  it('absent, empty and non-object values read the default ramp, not rejected', () => {
    for (const v of [undefined, null, 5, 'x', [], {}, { stops: '' }, { stops: undefined }]) {
      const r = readColorRamp(v);
      expect(r.canonical).toBe(DEFAULT_RAMP_STOPS);
      expect(r.interp).toBe('linear');
      expect([r.rejectedStops, r.rejectedInterp]).toEqual([false, false]);
      expect(r.stops.map((s) => [s.pos, s.hex, s.alpha])).toEqual([[0, '#000000', 1], [1, '#ffffff', 1]]);
    }
  });

  it('a non-string or unreadable stored value is the default AND rejected — never a throw', () => {
    const poison: unknown[] = [
      [1], { toString: 1 }, Symbol('s'), { [Symbol.toPrimitive]: () => { throw new Error('boom'); } }, 7, null, true,
      '0 #fff 1', '0 #zz0000 1', '-1 #000000 1', '1e-3 #000000 1', '0x1 #000000 1', 'x'.repeat(1025),
      Array(33).fill('0 #000000 1').join(','), '0 #000000', '0 #000000 1 1', '0 #000000 1,', ',0 #000000 1',
      '0 #000000 1</script>', '0 #000000  ', '0 #００００００ 1', '0 #\u0010\u0010\u0010\u0010\u0010\u0010 1',
    ];
    for (const p of poison) {
      let r: ColorRamp | undefined;
      expect(() => { r = ramp(p); }, String(typeof p)).not.toThrow();
      expect(r!.canonical).toBe(DEFAULT_RAMP_STOPS);
      expect(r!.rejectedStops).toBe(true);
    }
  });

  it('through the store accessor an uncoercible entry is DROPPED, so it reads as absent (default, not rejected)', () => {
    const n = makeNode('c', 'colorRamp');
    (n.data as { values: Record<string, unknown> }).values = { stops: { toString: 1 }, fac: 0.5 };
    expect(readColorRamp(getNodeValues(n)).rejectedStops).toBe(false);
  });

  it('carries no combined `rejected` flag — the two halves are worded apart, and a junk interp keeps the stops', () => {
    expect(Object.keys(ramp('garbage', 'nope')).sort()).toEqual(['canonical', 'interp', 'rejectedInterp', 'rejectedStops', 'stops']);
  });

  it('a 1025-char value is refused before any split', () => {
    const spy = vi.spyOn(String.prototype, 'split');
    let r: ColorRamp;
    const long = '1'.repeat(1025);
    let splitLong: boolean;
    try {
      r = ramp(long);
      // The only splits are of the DEFAULT canonical it falls back to — never of the oversized value.
      splitLong = spy.mock.contexts.some((ctx) => String(ctx).length > 1024);
    } finally {
      spy.mockRestore();
    }
    expect(r.rejectedStops).toBe(true);
    expect(splitLong).toBe(false);
  });

  it('an over-cap value is keyed as ONE value: two different 2 MB strings read as the SAME memo object', () => {
    // The memo key used to embed the whole string, so every read hashed megabytes before the length check ran.
    const a = ramp('1'.repeat(2_000_000));
    const b = ramp('2'.repeat(2_100_000));
    expect(a).toBe(b);
    expect(a).toMatchObject({ canonical: DEFAULT_RAMP_STOPS, rejectedStops: true });
    // At the cap a string still keys by its content.
    expect(ramp(' '.repeat(1023) + '0')).not.toBe(a);
  });

  it('a stored U+0000 cannot make two different ramps share a memo entry, in either read order', () => {
    // The key used to join the raw parts with U+0000 unescaped, so each of these crafted pairs keyed the SAME and
    // the second node read showed the first one's ramp — in the code, on the card and in the price alike.
    const pair = (stops: string) => [
      { stops: `${stops}\u0000s:q` }, // unreadable stops (a NUL), no interp
      { stops, interp: 'q\u0000t:undefined' }, // readable stops, junk interp
    ] as const;
    const [a1, b1] = pair('0 #ff0000 1');
    const ra = readColorRamp(a1);
    const rb = readColorRamp(b1);
    const [a2, b2] = pair('0 #00ff00 1');
    const rb2 = readColorRamp(b2); // the other order
    const ra2 = readColorRamp(a2);
    for (const [r, stops] of [[ra, '0 #ff0000 1'], [ra2, '0 #00ff00 1']] as const) {
      expect(r).toMatchObject({ canonical: DEFAULT_RAMP_STOPS, rejectedStops: true, rejectedInterp: false });
      expect(r.canonical).not.toBe(stops);
    }
    expect(rb).toMatchObject({ canonical: '0 #ff0000 1', rejectedStops: false, rejectedInterp: true });
    expect(rb2).toMatchObject({ canonical: '0 #00ff00 1', rejectedStops: false, rejectedInterp: true });
  });

  it('tolerated spelling is accepted and re-emitted canonical', () => {
    expect(ramp(' 0 #000000 1').canonical).toBe('0 #000000 1');
    expect(ramp('0  #000000  1').canonical).toBe('0 #000000 1');
    expect(ramp('0 #FF00AA 1,1 #00FFaa 0.50').canonical).toBe('0 #ff00aa 1,1 #00ffaa 0.5');
    expect(ramp('0.50 #000000 1').canonical).toBe('0.5 #000000 1');
    expect(ramp('2 #000000 3').canonical).toBe('1 #000000 1'); // > 1 clamps (the grammar never reads a sign)
    expect(ramp('0.12345678 #000000 1').stops[0].pos).toBe(0.1235); // the ROUNDED stop, everywhere
  });

  it('interp: the exact vocabulary, else Linear — rejected only when a key was present and wrong', () => {
    for (const m of RAMP_INTERPS) expect(ramp(undefined, m)).toMatchObject({ interp: m, rejectedInterp: false });
    for (const bad of ['__proto__', 'Linear', 'constructor', '', 1, {}, Symbol('i')]) {
      expect(ramp(undefined, bad)).toMatchObject({ interp: 'linear', rejectedInterp: true, rejectedStops: false });
    }
    // A junk interp leaves READABLE stops alone — the two halves are reported apart.
    expect(ramp('0 #ff0000 1,1 #0000ff 1', 'Linear')).toMatchObject({
      canonical: '0 #ff0000 1,1 #0000ff 1',
      rejectedStops: false,
      rejectedInterp: true,
    });
    expect(ramp('0 #zz0000 1', 'ease')).toMatchObject({ canonical: DEFAULT_RAMP_STOPS, interp: 'ease', rejectedStops: true, rejectedInterp: false });
    expect(isRampInterp('__proto__')).toBe(false);
    expect(isRampInterp('bspline')).toBe(true);
  });

  it('a stable sort on ties keeps the input order (a hard edge)', () => {
    const r = ramp('0.5 #ff0000 1,0 #000000 1,0.5 #00ff00 1');
    expect(r.stops.map((s) => s.hex)).toEqual(['#000000', '#ff0000', '#00ff00']);
  });

  it('format(parse(x)) is idempotent, and the memo returns one object per string', () => {
    for (const s of [DEFAULT_RAMP_STOPS, '0.1235 #abcdef 0.3,1 #000000 1', stopsOf(32), '0.0001 #000000 0.0001']) {
      const c = formatRampStops(parseRampStops(s)!);
      expect(formatRampStops(parseRampStops(c)!)).toBe(c);
    }
    expect(ramp('0 #123456 1')).toBe(ramp('0 #123456 1'));
    expect(Object.isFrozen(ramp('0 #123456 1').stops)).toBe(true);
  });

  it('the canonical writer only ever writes [0-9.#a-f, ] (fuzz)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let k = 0; k < 400; k++) {
      const n = 1 + Math.floor(rnd() * 32);
      const stops = Array.from({ length: n }, () => ({
        pos: rnd() * 3 - 1,
        hex: '#' + Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0').toUpperCase(),
        alpha: rnd() < 0.1 ? NaN : rnd() * 2 - 0.5,
      }));
      const c = formatRampStops(stops);
      expect(c).toMatch(/^[0-9.#a-f, ]*$/);
      expect(c.length).toBeLessThanOrEqual(703);
      expect(parseRampStops(c)).not.toBeNull();
    }
  });
});

/**
 * Blender, source/blender/blenkernel/intern/colorband.cc, BKE_colorband_evaluate (RGB colour mode), transcribed
 * here independently of utils/colorRamp.ts:
 *
 *   if (coba->tot == 1) { out = cbd1; }
 *   else if ((in <= cbd1->pos) && ELEM(ipotype, LINEAR, EASE, CONSTANT)) { out = cbd1; }   // before first stop
 *   else {
 *     for (a = 0; a < coba->tot; a++, cbd1++) if (cbd1->pos > in) break;                  // first pos > in
 *     if (a == coba->tot) { cbd2 = cbd1 - 1; right = *cbd2; right.pos = 1.0f; cbd1 = &right; }
 *     else if (a == 0) { left = *cbd1; left.pos = 0.0f; cbd2 = &left; }
 *     else { cbd2 = cbd1 - 1; }
 *     if ((a == coba->tot) && ELEM(ipotype, LINEAR, EASE, CONSTANT)) out = cbd2;           // after last stop
 *     else if (ipotype == CONSTANT) out = cbd2;
 *     else {
 *       if (cbd2->pos != cbd1->pos) fac = (in - cbd1->pos) / (cbd2->pos - cbd1->pos);
 *       else fac = (a != coba->tot) ? 0.0f : 1.0f;
 *       if (ELEM(ipotype, B_SPLINE, CARDINAL)) {
 *         cbd0 = (a >= coba->tot - 1) ? cbd1 : cbd1 + 1;
 *         cbd3 = (a < 2) ? cbd2 : cbd2 - 1;
 *         CLAMP(fac, 0.0f, 1.0f);
 *         key_curve_position_weights(fac, t, CARDINAL or BSPLINE);
 *         out = t[3]*cbd3 + t[2]*cbd2 + t[1]*cbd1 + t[0]*cbd0;  clamp_v4(out, 0, 1);
 *       } else {
 *         if (ipotype == EASE) { fac2 = fac*fac; fac = 3*fac2 - 2*fac2*fac; }
 *         mfac = 1 - fac;  out = mfac*cbd1 + fac*cbd2;
 *       }
 *     }
 *   }
 *
 * key.cc key_curve_position_weights: KEY_CARDINAL (fc = 0.71f) and KEY_BSPLINE, below.
 */
function blender(stops: { pos: number; c: number[] }[], ipo: RampInterp, x: number): number[] {
  const tot = stops.length;
  const early = ipo === 'linear' || ipo === 'ease' || ipo === 'constant';
  if (tot === 1) return stops[0].c;
  if (x <= stops[0].pos && early) return stops[0].c;
  let a = 0;
  for (; a < tot; a++) if (stops[a].pos > x) break;
  let cbd1: { pos: number; c: number[] };
  let cbd2: { pos: number; c: number[] };
  if (a === tot) {
    cbd2 = stops[a - 1];
    cbd1 = { ...cbd2, pos: 1 };
  } else if (a === 0) {
    cbd1 = stops[0];
    cbd2 = { ...cbd1, pos: 0 };
  } else {
    cbd1 = stops[a];
    cbd2 = stops[a - 1];
  }
  if (a === tot && early) return cbd2.c;
  if (ipo === 'constant') return cbd2.c;
  let fac = cbd2.pos !== cbd1.pos ? (x - cbd1.pos) / (cbd2.pos - cbd1.pos) : a !== tot ? 0 : 1;
  if (ipo === 'bspline' || ipo === 'cardinal') {
    const cbd0 = a >= tot - 1 ? cbd1 : stops[a + 1];
    const cbd3 = a < 2 ? cbd2 : stops[a - 2];
    fac = Math.min(Math.max(fac, 0), 1);
    const t2 = fac * fac;
    const t3 = t2 * fac;
    let t: number[];
    if (ipo === 'cardinal') {
      const fc = 0.71;
      t = [-fc * t3 + 2 * fc * t2 - fc * fac, (2 - fc) * t3 + (fc - 3) * t2 + 1, (fc - 2) * t3 + (3 - 2 * fc) * t2 + fc * fac, fc * t3 - fc * t2];
    } else {
      t = [
        -0.16666666 * t3 + 0.5 * t2 - 0.5 * fac + 0.16666666,
        0.5 * t3 - t2 + 0.66666666,
        -0.5 * t3 + 0.5 * t2 + 0.5 * fac + 0.16666666,
        0.16666666 * t3,
      ];
    }
    return [0, 1, 2, 3].map((k) => Math.min(Math.max(t[3] * cbd3.c[k] + t[2] * cbd2.c[k] + t[1] * cbd1.c[k] + t[0] * cbd0.c[k], 0), 1));
  }
  if (ipo === 'ease') {
    const fac2 = fac * fac;
    fac = 3 * fac2 - 2 * fac2 * fac;
  }
  const mfac = 1 - fac;
  return [0, 1, 2, 3].map((k) => mfac * cbd1.c[k] + fac * cbd2.c[k]);
}

const linearStops = (r: ColorRamp) =>
  r.stops.map((s) => ({ pos: s.pos, c: [1, 3, 5].map((o) => srgbToLinear01(parseInt(s.hex.slice(o, o + 2), 16) / 255)).concat(s.alpha) }));

describe('evaluateRamp is Blender’s BKE_colorband_evaluate', () => {
  const CORPUS = [
    '0.4 #336699 0.8', // one stop
    DEFAULT_RAMP_STOPS,
    '0.5 #ff0000 1,0.5 #00ff00 0.5', // coincident
    '0.2 #ff0000 1,0.8 #0000ff 0.25', // off 0/1
    '0 #000000 1,0.3 #ff8800 0.2,0.31 #00ff88 1,1 #ffffff 0',
    '0.1 #102030 1,0.4 #a0b0c0 0.5,0.6 #f00f0f 0.7,0.9 #0ff0f0 1',
    stopsOf(32),
    '0 #ffffff 1,0 #000000 1,1 #ff0000 1,1 #00ff00 1', // ties at both ends
  ];
  const XS = [-0.5, -1e-6, 0, 1e-4, 0.1, 0.2, 0.25, 0.3, 0.305, 0.31, 0.4, 0.5, 0.5 + 1e-9, 0.6, 0.75, 0.8, 0.9, 0.99, 1, 1.5];
  for (const interp of RAMP_INTERPS) {
    it(`${interp}: equal to the transcription over the corpus, inside and outside [0,1]`, () => {
      for (const s of CORPUS) {
        const r = ramp(s, interp);
        const ls = linearStops(r);
        for (const x of [...XS, ...Array.from({ length: 33 }, (_, i) => i / 32)]) {
          expect(evaluateRamp(r, x), `${s} @ ${x}`).toEqual(blender(ls, interp, x));
        }
      }
    });
  }

  it('hand values: default at 0.5 is linear 0.5; Ease is 0.5 at its midpoint; Constant at a stop is that stop', () => {
    expect(evaluateRamp(ramp(), 0.5)).toEqual([0.5, 0.5, 0.5, 1]);
    expect(evaluateRamp(ramp(undefined, 'ease'), 0.5)).toEqual([0.5, 0.5, 0.5, 1]);
    expect(evaluateRamp(ramp(undefined, 'ease'), 0.25)[0]).toBeCloseTo(0.15625, 12);
    const c = ramp('0 #ff0000 1,0.5 #0000ff 0.25', 'constant');
    expect(evaluateRamp(c, 0.5)).toEqual([0, 0, 1, 0.25]);
    expect(evaluateRamp(c, 0.49)).toEqual([1, 0, 0, 1]);
    // Stops blend in LINEAR light: sRGB #808080 is ~0.216 linear, the default's midpoint is 0.5 linear.
    expect(linearToHex(evaluateRamp(ramp(), 0.5))).toBe('#bcbcbc');
  });

  it('the half table, fetch and range read the GPU table', () => {
    const r = ramp('0 #ff0000 1,0.5 #0000ff 0.25', 'constant');
    const half = rampHalfTable(r);
    expect(half).toHaveLength(257 * 4);
    expect(rampHalfTable(r)).toBe(half); // memoised
    expect(rampFetch(r, 0.25)).toEqual([0, 1, 2, 3].map((ch) => fetchHalf(half, ch as 0, 0.25, true)));
    expect(rampFetch(r, 0)).toEqual([1, 0, 0, 1]);
    expect(rampFetch(r, 1)).toEqual([0, 0, 1, 0.25]);
    expect(rampFetch(r, NaN).every(Number.isNaN)).toBe(true);
    const range = rampRangeOver(r, 0.2, 0.7);
    expect(range).toEqual({ min: [0, 0, 0, 0.25], max: [1, 0, 1, 1] });
    // ClampToEdge: an unbounded Factor is the whole ramp, never the colour at 0.5.
    expect(rampRangeOver(ramp(), -Infinity, Infinity)).toEqual({ min: [0, 0, 0, 1], max: [1, 1, 1, 1] });
  });

  it('the card gradient: Constant has hard stops at the stop positions; others 33 sRGB samples', () => {
    const c = rampCss(ramp('0 #ff0000 1,0.5 #0000ff 0.25', 'constant'));
    expect(c).toBe('linear-gradient(to right, rgba(255, 0, 0, 1) 0%, rgba(255, 0, 0, 1) 50%, rgba(0, 0, 255, 0.25) 50%, rgba(0, 0, 255, 0.25) 100%)');
    const l = rampCss(ramp());
    expect(l.match(/rgba\(/g)).toHaveLength(33);
    expect(l).not.toContain('srgb-linear');
    expect(l).toContain('rgba(0, 0, 0, 1) 0%');
    expect(l).toContain('rgba(255, 255, 255, 1) 100%');
  });
});

describe('editor ops — pure, capped, canonical', () => {
  const r3 = ramp('0 #000000 1,0.5 #ff0000 0.5,1 #ffffff 1');

  it('addStopAt carries the ramp’s own colour there and refuses the 33rd stop', () => {
    const a = addStopAt(r3, 0.25)!;
    expect(a.index).toBe(1);
    expect(a.stops[1].pos).toBe(0.25);
    expect(a.stops[1].hex).toBe(linearToHex(evaluateRamp(r3, 0.25)));
    expect(a.stops[1].alpha).toBe(0.75);
    // A tie lands AFTER the stop it ties with.
    expect(addStopAt(r3, 0.5)!.index).toBe(2);
    const full = ramp(stopsOf(RAMP_MAX_STOPS));
    expect(full.stops).toHaveLength(32);
    expect(addStopAt(full, 0.5)).toBeNull();
    expect(insertStopNear(full, 3)).toBeNull();
  });

  it('insertStopNear: midway to the left neighbour, the right one for the first, towards the far end for one stop', () => {
    expect(insertStopNear(r3, 2)!.stops.map((s) => s.pos)).toEqual([0, 0.5, 0.75, 1]);
    expect(insertStopNear(r3, 0)!.stops.map((s) => s.pos)).toEqual([0, 0.25, 0.5, 1]);
    expect(insertStopNear(ramp('0.2 #000000 1'), 0)!.stops.map((s) => s.pos)).toEqual([0.2, 0.6]);
    expect(insertStopNear(ramp('0.8 #000000 1'), 0)!.stops.map((s) => s.pos)).toEqual([0.4, 0.8]);
  });

  it('insertStopNear never piles stops onto one rounded position: a too-small gap goes to the WIDEST gap', () => {
    // From the default ramp, + pressed over and over with the new stop selected each time (the editor's flow).
    let r = ramp(DEFAULT_RAMP_STOPS);
    let sel = 0;
    for (let k = 0; k < 40; k++) {
      const n = insertStopNear(r, sel);
      if (!n) break;
      r = ramp(formatRampStops(n.stops));
      sel = n.index;
    }
    expect(r.stops).toHaveLength(32);
    const positions = r.stops.map((s) => s.pos);
    expect(new Set(positions).size).toBe(positions.length);
    // The midpoint between 0 and 0.0001 rounds onto a stop: the widest gap (0.5..1 here) takes it instead.
    const tight = ramp('0 #000000 1,0.0001 #000000 1,0.5 #ffffff 1,1 #ffffff 1');
    expect(insertStopNear(tight, 1)!.stops.map((s) => s.pos)).toEqual([0, 0.0001, 0.5, 0.75, 1]);
  });

  it('indexAfterMove follows any stop through a moveStop re-sort', () => {
    const five = ramp('0 #000000 1,0.2 #110000 1,0.4 #220000 1,0.6 #330000 1,0.8 #440000 1').stops;
    for (let from = 0; from < 5; from++) {
      for (const pos of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
        const m = moveStop(five, from, pos);
        for (let i = 0; i < 5; i++) expect(m.stops[indexAfterMove(i, from, m.index)].hex).toBe(five[i].hex);
      }
    }
  });

  it('removeStop keeps one stop; moveStop may cross and returns the new index', () => {
    expect(removeStop(r3.stops, 1)!.map((s) => s.pos)).toEqual([0, 1]);
    expect(removeStop(ramp('0 #000000 1').stops, 0)).toBeNull();
    expect(removeStop(r3.stops, 7)).toBeNull();
    const m = moveStop(r3.stops, 0, 0.75);
    expect(m.index).toBe(1);
    expect(m.stops.map((s) => [s.pos, s.hex])).toEqual([[0.5, '#ff0000'], [0.75, '#000000'], [1, '#ffffff']]);
    // A tie lands after the stop it ties with.
    expect(moveStop(r3.stops, 1, -3)).toMatchObject({ index: 1, stops: [{ pos: 0, hex: '#000000' }, { pos: 0, hex: '#ff0000' }, { pos: 1 }] });
    expect(moveStop(r3.stops, 1, 0.123456).stops[1].pos).toBe(0.1235);
  });

  it('flip is an involution and mirrors a hard edge', () => {
    const hard = ramp('0 #000000 1,0.3 #ff0000 1,0.3 #00ff00 1,1 #ffffff 1').stops;
    const f = flipStops(hard);
    expect(f.map((s) => [s.pos, s.hex])).toEqual([[0, '#ffffff'], [0.7, '#00ff00'], [0.7, '#ff0000'], [1, '#000000']]);
    expect(formatRampStops(flipStops(f))).toBe(formatRampStops(hard));
  });

  it('setStopHex validates; setStopAlpha clamps and rounds', () => {
    expect(setStopHex(r3.stops, 1, '#ABCDEF')![1].hex).toBe('#abcdef');
    expect(setStopHex(r3.stops, 1, 'red')).toBeNull();
    expect(setStopHex(r3.stops, 9, '#000000')).toBeNull();
    expect(setStopAlpha(r3.stops, 1, 1.7)[1].alpha).toBe(1);
    expect(setStopAlpha(r3.stops, 1, 0.123456)[1].alpha).toBe(0.1235);
    expect(setStopAlpha(r3.stops, 1, NaN)[1].alpha).toBe(0);
  });
});
