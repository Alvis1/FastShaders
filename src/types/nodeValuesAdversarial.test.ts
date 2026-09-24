/**
 * A TAMPERED `values` ENTRY MUST NOT BLANK THE APP (2026-09-19).
 *
 * `values` is typed `Record<string, string | number>` and that type is a
 * runtime LIE: the map arrives verbatim from a `.fastshader`, `fs:graph` or
 * `fs:savedGroups`, all three adversarial by the project's own rule.
 * `String(v)` and `Number(v)` run ToPrimitive, which THROWS when neither
 * `valueOf` nor `toString` yields a primitive — and there are ~40 such
 * coercions across codegen, the CPU evaluator, the export paths and the node
 * components.
 *
 * MEASURED before the fix: 38 single-key poisoned graphs across 17 node types,
 * every one of them fatal. There is no error boundary in this app, so the
 * throw unmounts the root and the screen goes blank; the 300 ms autosave is a
 * store SUBSCRIPTION outside React, so it writes the poisoned graph back and
 * the app blanks again on every reload. Guarding the call sites one at a time
 * did NOT converge — every node family has its own reads — so it is closed in
 * `rawNodeValues`, where every reader already comes through.
 *
 * This suite pins the two halves that make that safe:
 *   1. an uncoercible entry never reaches a caller;
 *   2. everything else is returned BY IDENTITY, so no memo is invalidated and
 *      no coercion anywhere changes its answer.
 */
import { describe, it, expect } from 'vitest';
import { getNodeValues, setNodeValues, outputNodeValues } from '@/types';
import type { AppNode } from '@/types';
import { makeNode } from '@/test-utils';

/** Entries whose coercion THROWS — the reason the guard exists. */
const POISON: Record<string, unknown> = {
  noToString: { toString: 1 },
  nullToString: { toString: null },
  neitherPrimitive: { valueOf: {}, toString: {} },
  nullProto: Object.create(null) as object,
  sym: Symbol('x'),
  throwingPrimitive: { [Symbol.toPrimitive]: 1 },
};

/** Entries that coerce fine and must survive UNCHANGED, value for value. */
const KEPT: Record<string, unknown> = {
  s: 'text', empty: '', n: 12, zero: 0, neg: -1, frac: 0.5, nan: NaN, inf: Infinity,
  t: true, f: false, nul: null, und: undefined, arr: [1, 2], obj: {}, date: new Date(0),
};

const withValues = (values: Record<string, unknown>): AppNode => {
  const n = makeNode('n1', 'mul');
  (n.data as { values: unknown }).values = values;
  return n;
};

describe('an uncoercible entry never reaches a caller', () => {
  it('is dropped, key by key', () => {
    for (const [key, v] of Object.entries(POISON)) {
      const out = getNodeValues(withValues({ [key]: v, keep: 'yes' }));
      expect(key in out, key).toBe(false);
      expect(out.keep, key).toBe('yes');
    }
  });

  it('so every coercion a caller performs is safe', () => {
    const out = getNodeValues(withValues({ ...POISON, good: 5 }));
    for (const key of Object.keys(POISON)) {
      expect(() => String(out[key]), key).not.toThrow();
      expect(() => Number(out[key]), key).not.toThrow();
      expect(() => `${out[key]}`, key).not.toThrow();
    }
    expect(out.good).toBe(5);
  });

  it('a values map that is ENTIRELY poison degrades to an empty map', () => {
    expect(Object.keys(getNodeValues(withValues({ ...POISON })))).toEqual([]);
  });

  it('and the same holds through the Output node accessor’s own path', () => {
    // `outputNodeValues` takes DATA, not a node, and guards the object; the
    // per-entry guard belongs to the node accessor, so this pins only that the
    // object guard still holds and nothing here throws.
    for (const bad of [5, 'x', null, undefined, [], true]) {
      expect(() => outputNodeValues({ values: bad })).not.toThrow();
      expect(outputNodeValues({ values: bad })).toEqual({});
    }
  });
});

describe('nothing else changes — the guard must not be a regression', () => {
  it('returns the SAME object when every entry is coercible', () => {
    // Identity is the documented contract: a new object on every call would
    // invalidate every downstream memo, on every graph notify.
    const values: Record<string, unknown> = { ...KEPT };
    const node = withValues(values);
    expect(getNodeValues(node)).toBe(values);
    expect(getNodeValues(node)).toBe(getNodeValues(node));
  });

  it('keeps every coercible value EXACTLY, junk included', () => {
    const out = getNodeValues(withValues({ ...KEPT })) as Record<string, unknown>;
    for (const [k, v] of Object.entries(KEPT)) {
      if (typeof v === 'number' && Number.isNaN(v)) expect(out[k], k).toBeNaN();
      else expect(out[k], k).toBe(v);
    }
  });

  it('keeps the coercions other modules PIN', () => {
    // imageTextureSpec reads `repeat` as CLAMP for false / null / '' — i.e.
    // the `Number()` zero. Dropping booleans here would flip every Image node
    // storing `repeat: false` from clamp to repeat.
    const out = getNodeValues(withValues({ repeat: false, other: null, blank: '' }));
    expect(Number(out.repeat)).toBe(0);
    expect(Number(out.other)).toBe(0);
    expect(Number(out.blank)).toBe(0);
  });

  it('works on a null-prototype values map', () => {
    const values = Object.create(null) as Record<string, unknown>;
    values.a = 1;
    values.bad = { toString: 1 };
    const out = getNodeValues(withValues(values));
    expect(out.a).toBe(1);
    expect('bad' in out).toBe(false);
  });

  it('a non-object values field still reads as empty', () => {
    for (const bad of [5, 'x', null, undefined, [1, 2], true]) {
      expect(getNodeValues(withValues(bad as unknown as Record<string, unknown>))).toEqual({});
    }
  });

  it('setNodeValues still merges onto the RAW map, poison and all', () => {
    // The writer reads the raw field by design; the guard is a READ-side
    // concern. What matters is that a write does not throw and lands.
    const node = withValues({ bad: { toString: 1 }, keep: 1 });
    expect(() => setNodeValues(node, { added: 2 })).not.toThrow();
    const out = getNodeValues(node);
    expect(out.added).toBe(2);
    expect(out.keep).toBe(1);
    expect('bad' in out).toBe(false);
  });
});
