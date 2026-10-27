import { describe, it, expect } from 'vitest';
import {
  fmtEdgeNum,
  tinyNum,
  edgeRangeText,
  rangeSpan,
  liveEdgeText,
  liveEdgeRangeText,
} from './edgeValueText';
import { evaluateEdgeRange } from '@/engine/cpuEvaluator';
import { makeNode, makeEdge } from '../test-utils';

describe('fmtEdgeNum', () => {
  it('keeps up to 2 decimals and trims trailing zeros', () => {
    expect(fmtEdgeNum(3.687)).toBe('3.69');
    expect(fmtEdgeNum(5)).toBe('5');
    expect(fmtEdgeNum(-0.7)).toBe('-0.7');
    expect(fmtEdgeNum(Number.NaN)).toBe('0');
    expect(fmtEdgeNum(Infinity)).toBe('0');
  });

  it('keeps ONE significant digit below 0.01 — a tiny constant never prints "0"', () => {
    expect(fmtEdgeNum(0.003)).toBe('0.003');
    expect(fmtEdgeNum(0.00034)).toBe('0.0003');
    expect(fmtEdgeNum(-0.004)).toBe('-0.004');
    expect(fmtEdgeNum(0.0099)).toBe('0.01');
    // Very small values may print in exponent form; never as zero.
    expect(Number(fmtEdgeNum(3e-7))).toBe(3e-7);
  });

  it('never prints "-0"', () => {
    expect(fmtEdgeNum(-0)).toBe('0');
    for (const n of [-0, -1e-12, -0.001, -0.0049, -0.005, -0.009]) {
      expect(fmtEdgeNum(n)).not.toBe('-0');
      expect(fmtEdgeNum(n)).not.toMatch(/^-0(\.0*)?$/);
    }
  });
});

describe('tinyNum', () => {
  it('answers only for 0 < |n| < 0.01', () => {
    expect(tinyNum(0)).toBeNull();
    expect(tinyNum(-0)).toBeNull();
    expect(tinyNum(0.01)).toBeNull();
    expect(tinyNum(-0.5)).toBeNull();
    expect(tinyNum(0.003)).toBe('0.003');
    expect(tinyNum(-0.0003)).toBe('-0.0003');
  });
});

describe('edgeRangeText — full form', () => {
  it.each([
    [0, 0.3, '0…0.3'],
    [-0.5, 0.5, '-0.5…0.5'],
    [0.6, 1.4, '0.6…1.4'],
    [-0.8, 0.8, '-0.8…0.8'],
    [0, 1, '0…1'],
    [-1.5, 1.5, '-1.5…1.5'],
    [0, 10.4, '0…11'],
    [0, 0.04, '0…0.04'],
    [-0.1, 0.1, '-0.1…0.1'],
    [0.0008, 1.52, '0…1.6'],
    [-250, -249, '-250…-249'],
    // The old whole-number rule printed every one of these wrong:
    // "0", "0", "0…1", "1", "-1…2", "0…10".
    [-0.4, 0.4, '-0.4…0.4'],
    [0.9, 1.1, '0.9…1.1'],
  ])('(%s, %s) → %s', (lo, hi, text) => {
    expect(edgeRangeText(lo, hi)).toBe(text);
  });

  it('snaps float noise before rounding outward (0.1 × 3 prints 0.3, not 0.4)', () => {
    expect(edgeRangeText(0, 0.1 * 3)).toBe('0…0.3');
    expect(edgeRangeText(0.1 * 3, 1)).toBe('0.3…1');
    expect(edgeRangeText(-0.1 * 3, 0)).toBe('-0.3…0');
  });

  it('always prints two ends for a true range, never collapsing it to one number', () => {
    expect(edgeRangeText(-0.4, 0.4)).toContain('…');
    expect(edgeRangeText(0.6, 1.4)).toContain('…');
    expect(edgeRangeText(0, 0.004)).toBe('0…0.01');
  });
});

describe('edgeRangeText — compact (a fixed-width cell)', () => {
  it.each([
    [0, 0.3, '0…1'],
    [-0.4, 0.4, '-1…1'],
    [0.6, 1.4, '0…2'],
    [0, 10.4, '0…11'],
    [0, 1, '0…1'],
    // ceil(-0.4) is -0, printed "0".
    [-1.4, -0.4, '-2…0'],
  ])('(%s, %s) → %s', (lo, hi, text) => {
    expect(edgeRangeText(lo, hi, true)).toBe(text);
  });

  it('snaps float noise too', () => {
    expect(edgeRangeText(0, 0.1 * 30, true)).toBe('0…3');
  });
});

describe('edgeRangeText — what is never printed', () => {
  it('collapses ends that FORMAT alike to that one number, in either mode', () => {
    expect(edgeRangeText(3.687, 3.694)).toBe('3.69');
    expect(edgeRangeText(3.687, 3.694, true)).toBe('3.69');
    expect(edgeRangeText(5, 5.004)).toBe('5');
    expect(edgeRangeText(0.0031, 0.0034)).toBe('0.003');
    expect(edgeRangeText(-2, -2)).toBe('-2');
  });

  it('an inverted or non-finite interval reads "…", never an invented one', () => {
    for (const compact of [false, true]) {
      expect(edgeRangeText(1, 0, compact)).toBe('…');
      expect(edgeRangeText(0.5, 0.4999, compact)).toBe('…');
      expect(edgeRangeText(Number.NaN, 1, compact)).toBe('…');
      expect(edgeRangeText(0, Infinity, compact)).toBe('…');
      expect(edgeRangeText(-Infinity, 0, compact)).toBe('…');
    }
  });

  it('float noise straddling one printable step prints that one number, not "0…0"', () => {
    expect(edgeRangeText(-1e-12, 1e-12)).toBe('0');
    expect(edgeRangeText(-1e-12, 1e-12, true)).toBe('0');
    expect(edgeRangeText(1 - 1e-12, 1 + 1e-12)).toBe('1');
  });

  it('never prints "-0" as an end', () => {
    expect(edgeRangeText(-0.4, -0, true)).toBe('-1…0');
    expect(edgeRangeText(-0.04, -0)).toBe('-0.04…0');
    expect(edgeRangeText(-0.3, 0.3, true)).not.toMatch(/(^|…)-0(…|$)/);
  });

  it('the printed interval always CONTAINS the true one (rounded outward)', () => {
    // A deterministic sweep: intervals across magnitudes, spans and signs.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 4000; i++) {
      const scale = 10 ** Math.floor(rnd() * 7 - 3); // 0.001 … 1000
      const a = (rnd() * 2 - 1) * scale;
      const b = a + rnd() * scale * (rnd() < 0.5 ? 0.05 : 3);
      for (const compact of [false, true]) {
        const text = edgeRangeText(a, b, compact);
        const parts = text.split('…');
        if (parts.length !== 2) continue; // collapsed: below display precision
        const [lo, hi] = parts.map(Number);
        expect(lo, `${a}…${b} → ${text}`).toBeLessThanOrEqual(a + 1e-9 * Math.max(1, Math.abs(a)));
        expect(hi, `${a}…${b} → ${text}`).toBeGreaterThanOrEqual(b - 1e-9 * Math.max(1, Math.abs(b)));
        expect(lo).toBeLessThan(hi);
      }
    }
  });
});

describe('rangeSpan', () => {
  it('spans every channel', () => {
    expect(rangeSpan({ min: [0, -1, 2], max: [1, 0.5, 3] })).toEqual([-1, 3]);
    expect(rangeSpan({ min: [0.5], max: [0.5] })).toEqual([0.5, 0.5]);
  });

  it('is null when there is nothing honest to print', () => {
    expect(rangeSpan(null)).toBeNull();
    expect(rangeSpan(undefined)).toBeNull();
    expect(rangeSpan({ min: [], max: [] })).toBeNull();
    expect(rangeSpan({ min: [0, -Infinity], max: [1, 1] })).toBeNull();
    expect(rangeSpan({ min: [0, Number.NaN], max: [1, 1] })).toBeNull();
    // An inverted channel would make the union an INVENTED interval.
    expect(rangeSpan({ min: [0, 5], max: [1, 1] })).toBeNull();
    // A channel with no max is not a bound.
    expect(rangeSpan({ min: [0, 0], max: [1] })).toBeNull();
  });
});

describe('liveEdgeText', () => {
  it('evaluates a time-driven chain at the given t (the frozen-t=0 bug case)', () => {
    // time → sin: at t = 0 this is the "dead wire 0" the on-node labels used
    // to freeze on; at a real t it is the live value.
    const nodes = [
      makeNode('t1', 'time', { speed: 1 }),
      makeNode('s1', 'sin', {}),
    ];
    const edges = [makeEdge('t1', 'out', 's1', 'x')];
    expect(liveEdgeText('s1', nodes, edges, 0)).toBe('0');
    expect(liveEdgeText('s1', nodes, edges, Math.PI / 2)).toBe('1');
    expect(liveEdgeText('t1', nodes, edges, 3.66)).toBe('3.66');
  });

  it('prints a multi-channel point as min…max, compact on request', () => {
    const nodes = [makeNode('v', 'vec3', { x: 0.2, y: 0.5, z: 0.9 })];
    expect(liveEdgeText('v', nodes, [], 0)).toBe('0.2…0.9');
    expect(liveEdgeText('v', nodes, [], 0, null, true)).toBe('0…1');
  });

  it('is null for a source the evaluator cannot reach', () => {
    expect(liveEdgeText('missing', [], [], 1)).toBeNull();
  });
});

describe('liveEdgeRangeText — a field ticks its INTERVAL', () => {
  // UV + Time: the truth is [t, t + 1] on both channels. The assertions are
  // RELATIVE to evaluateEdgeRange, so they hold whatever the evaluator's
  // interval rules become: this pins the display layer, not the arithmetic.
  const nodes = [makeNode('uv1', 'uv'), makeNode('t1', 'time', { speed: 1 }), makeNode('a', 'add')];
  const edges = [makeEdge('uv1', 'out', 'a', 'a'), makeEdge('t1', 'out', 'a', 'b')];
  const expected = (t: number, compact = false) => {
    const span = rangeSpan(evaluateEdgeRange({ source: 'a', sourceHandle: 'out' }, nodes, edges, t));
    return span ? edgeRangeText(span[0], span[1], compact) : null;
  };

  it('prints the interval the evaluator infers AT t, in both formats', () => {
    for (const t of [0, 0.25, 5, 61.7]) {
      expect(liveEdgeRangeText('a', nodes, edges, t, 'out')).toBe(expected(t));
      expect(liveEdgeRangeText('a', nodes, edges, t, 'out', true)).toBe(expected(t, true));
    }
    expect(expected(5)).not.toBeNull();
  });

  it('moves with the clock — t = 5 is not the t = 0 "0…1" forever', () => {
    expect(liveEdgeRangeText('a', nodes, edges, 5, 'out')).not.toBe(liveEdgeRangeText('a', nodes, edges, 0, 'out'));
  });

  it('is null (the caller prints "…") when there is no interval', () => {
    expect(liveEdgeRangeText('missing', nodes, edges, 5)).toBeNull();
  });
});
