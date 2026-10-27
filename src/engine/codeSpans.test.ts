import { describe, it, expect } from 'vitest';
import { assembleNodeSpans, joinedOffsets, positionIndex, refOccurrences, type SpanAssembly } from './codeSpans';

/**
 * The pure half of graphToCode's `nodeSpans` (engine/codeSpans.ts). The
 * whole-pass behaviour is nodeSpans.test.ts; these pin the pieces.
 */

describe('joinedOffsets', () => {
  it('is each element’s start in the joined text', () => {
    const lines = ['ab', '', 'cde', 'f'];
    const code = lines.join('\n');
    const off = joinedOffsets(lines);
    expect(off).toEqual([0, 3, 4, 8]);
    lines.forEach((l, i) => expect(code.slice(off[i], off[i] + l.length)).toBe(l));
  });
});

describe('positionIndex — Monaco’s line rule', () => {
  it('counts \\n, \\r\\n and a lone \\r as ONE break each', () => {
    const code = 'a\nbb\r\nccc\rd';
    const pos = positionIndex(code);
    expect(pos(0)).toEqual({ lineNumber: 1, column: 1 });
    expect(pos(2)).toEqual({ lineNumber: 2, column: 1 });
    expect(pos(4)).toEqual({ lineNumber: 2, column: 3 }); // the end of `bb`
    expect(pos(6)).toEqual({ lineNumber: 3, column: 1 });
    expect(pos(10)).toEqual({ lineNumber: 4, column: 1 });
    expect(pos(code.length)).toEqual({ lineNumber: 4, column: 2 });
  });

  it('an offset inside a \\r\\n pair reads as the end of its line, never past it', () => {
    const pos = positionIndex('ab\r\ncd');
    expect(pos(3)).toEqual({ lineNumber: 1, column: 3 });
  });
});

describe('refOccurrences', () => {
  const code = 'float1 float10 _float1 a.float1 (float1) float1';
  it('finds a reference only as a whole reference', () => {
    expect(refOccurrences(code, 'float1', 0, code.length)).toEqual([0, 33, 41]);
  });
  it('stays inside [from, to)', () => {
    expect(refOccurrences(code, 'float1', 1, 40)).toEqual([33]);
    expect(refOccurrences(code, 'float1', 0, 46)).toEqual([0, 33]);
  });
  it('a swizzle is not the start of a longer one', () => {
    expect(refOccurrences('x.xy x.x', 'x.x', 0, 8)).toEqual([5]);
  });
  it('an empty reference has none', () => {
    expect(refOccurrences(code, '', 0, code.length)).toEqual([]);
  });
});

describe('assembleNodeSpans', () => {
  const base = (out: string[], over: Partial<SpanAssembly> = {}): SpanAssembly => ({
    out,
    setupBase: 0,
    bases: new Map(),
    marks: [],
    sink: null,
    discard: null,
    ret: { index: out.length - 1, whole: null, cols: [] },
    splitReads: [],
    ...over,
  });

  it('a mark on an array with NO base gives no span (a scope Fn that was never emitted)', () => {
    const scope = ['  const a = 1;'];
    const out = ['const shader = Fn(() => {', '  return a;'];
    const spans = assembleNodeSpans(out.join('\n'), base(out, {
      marks: [{ nodeId: 'a', target: scope, from: 0, to: 1, setupFrom: 0, setupTo: 0 }],
    }));
    expect(spans.has('a')).toBe(false);
  });

  it('a mark on an array placed twice gets a span at each place', () => {
    const scope = ['const a = 1;'];
    const out = ['x', '  const a = 1;', 'y', '  const a = 1;', 'return'];
    const spans = assembleNodeSpans(out.join('\n'), base(out, {
      bases: new Map([[scope, [1, 3]]]),
      marks: [{ nodeId: 'a', target: scope, from: 0, to: 1, setupFrom: 0, setupTo: 0 }],
    }));
    expect(spans.get('a')!.map((s) => s.startLineNumber)).toEqual([2, 4]);
  });

  it('the sink owns its program minus the chains copied into it', () => {
    const out = ['h', 'sink-a', 'chain-1', 'chain-2', 'sink-b', 'sink-c', 'ret'];
    const spans = assembleNodeSpans(out.join('\n'), base(out, {
      sink: { id: 's', from: 1, to: 6, chains: [[2, 4]] },
      ret: { index: 6, whole: 's', cols: [] },
    }));
    expect(spans.get('s')!.map((s) => [s.startLineNumber, s.endLineNumber])).toEqual([[2, 2], [5, 6], [7, 7]]);
  });

  it('empty marks give nothing, and the return can be owned by columns', () => {
    const main: string[] = [];
    const out = ['const shader = Fn(() => {', '  return { color: c1, parts: { "A": { color: c2 } } };'];
    const spans = assembleNodeSpans(out.join('\n'), base(out, {
      bases: new Map([[main, [1]]]),
      marks: [{ nodeId: 'n', target: main, from: 0, to: 0, setupFrom: 0, setupTo: 0 }],
      ret: { index: 1, whole: null, cols: [{ nodeId: 'o', from: 11, to: 20 }] },
    }));
    expect(spans.has('n')).toBe(false);
    expect(spans.get('o')).toEqual([{ startLineNumber: 2, startColumn: 12, endLineNumber: 2, endColumn: 21, kind: 'own', inline: true }]);
  });

  it('a Split read is a use span inside its consumer’s own text, once per place', () => {
    const main = ['  const iso = isolines(pos.x, pos.x);'];
    const out = ['const shader = Fn(() => {', ...main, '  return pos.x;'];
    const spans = assembleNodeSpans(out.join('\n'), base(out, {
      bases: new Map([[main, [1]]]),
      marks: [{ nodeId: 'iso', target: main, from: 0, to: 1, setupFrom: 0, setupTo: 0 }],
      splitReads: [
        { splitId: 's', consumerId: 'iso', ref: 'pos.x' },
        { splitId: 's', consumerId: 'iso', ref: 'pos.x' },
      ],
    }));
    const reads = spans.get('s')!;
    expect(reads.map((s) => [s.startLineNumber, s.startColumn, s.kind, s.inline])).toEqual([
      [2, 24, 'use', true],
      [2, 31, 'use', true],
    ]);
  });
});
