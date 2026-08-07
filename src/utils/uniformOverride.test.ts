import { describe, it, expect } from 'vitest';
import {
  isOverridden, sameUniformValue, overriddenUniforms,
  clearUniformValue, clearUniformValues,
  seedBounds, fallbackBounds,
  sanitizeUniformValues, sanitizeUniformBounds, MAX_UNIFORM_ENTRIES,
  extractUniforms, authoredUniformChange,
  type UniformInfo,
} from './uniformOverride';
import { planUniformDefaults } from './uniformDefaults';
import { graphToCode } from '@/engine/graphToCode';
import { makeNode, makeEdge } from '@/test-utils';

const float = (name: string, defaultValue: number): UniformInfo =>
  ({ name, kind: 'float', defaultValue });
const colour = (name: string, defaultValue: string): UniformInfo =>
  ({ name, kind: 'color', defaultValue });

describe('isOverridden — the preview disagrees with the graph', () => {
  it('is false when nothing is stored (the graph decides)', () => {
    expect(isOverridden(float('cutoff', 0.2), undefined)).toBe(false);
  });

  it('is false when the stored value equals the authored one', () => {
    expect(isOverridden(float('cutoff', 0.2), 0.2)).toBe(false);
  });

  it('is TRUE for the reported trap: node says 0.2, preview runs 0.7', () => {
    expect(isOverridden(float('cutoff', 0.2), 0.7)).toBe(true);
  });

  it('ignores a difference past the precision "Set as default" bakes at', () => {
    // A slider step is span/200, so a scrub routinely lands on values like
    // this; the bake rounds to 9 significant digits. Comparing raw would light
    // a permanent chip next to a button planUniformDefaults refuses to act on.
    const stored = 0.17500000000000002;
    expect(isOverridden(float('k', 0.175), stored)).toBe(false);

    const node = makeNode('p1', 'property_float', { name: 'k', value: 0.175 });
    const plan = planUniformDefaults(
      [node], new Map([['p1', 'k']]), [float('k', 0.175)], { k: stored },
    );
    expect(plan.size).toBe(0);
  });

  it('compares colours case-insensitively', () => {
    expect(isOverridden(colour('tint', '#ff8000'), '#FF8000')).toBe(false);
    expect(isOverridden(colour('tint', '#ff8000'), '#00ff00')).toBe(true);
  });

  it('never treats a KIND mismatch as an override', () => {
    // A '#hex' left over from a deleted colour property under a name a float
    // has since taken is skipped by the ready push, so the row already falls
    // back to the authored default — flagging it would announce nothing real.
    expect(isOverridden(float('x', 1), '#ff0000')).toBe(false);
    expect(isOverridden(colour('x', '#ff0000'), 1)).toBe(false);
  });

  it('never flags a uniform whose literal did not parse', () => {
    expect(isOverridden({ name: 'x', kind: 'float', defaultValue: 0, unparsed: true }, 5)).toBe(false);
  });

  it('rejects non-finite stored values', () => {
    expect(isOverridden(float('x', 1), NaN)).toBe(false);
    expect(isOverridden(float('x', 1), Infinity)).toBe(false);
  });

  it('sameUniformValue is symmetric on the rounding boundary', () => {
    expect(sameUniformValue('float', 0.175, 0.17500000000000002)).toBe(true);
    expect(sameUniformValue('float', 0.175, 0.176)).toBe(false);
  });
});

describe('overriddenUniforms', () => {
  it('picks only genuine overrides', () => {
    const rows = [float('a', 1), float('b', 2), colour('c', '#ff0000')];
    expect(overriddenUniforms(rows, { a: 5, b: 2, c: '#00ff00' })).toEqual({ a: 5, c: '#00ff00' });
  });

  it('ignores rows with nothing stored', () => {
    expect(overriddenUniforms([float('a', 1)], {})).toEqual({});
  });
});

describe('clearUniformValue', () => {
  it('returns the SAME object when the name is absent', () => {
    // Load-bearing: a node scrub fires ~60×/s and only the first frame has
    // anything to delete. Identity is what stops React committing (and
    // usePersistedState re-serialising the whole map to localStorage) per frame.
    const v = { a: 1 };
    expect(clearUniformValue(v, 'b')).toBe(v);
  });

  it('removes the name and leaves siblings alone', () => {
    const v = { a: 1, b: 2 };
    const out = clearUniformValue(v, 'a');
    expect(out).toEqual({ b: 2 });
    expect(v).toEqual({ a: 1, b: 2 });
  });

  it('clearUniformValues over a list, identity-preserving when nothing matches', () => {
    const v = { a: 1, b: 2, c: 3 };
    expect(clearUniformValues(v, ['a', 'c'])).toEqual({ b: 2 });
    expect(clearUniformValues(v, [])).toBe(v);
    expect(clearUniformValues(v, ['zz'])).toBe(v);
  });
});

describe('bounds', () => {
  it('seedBounds always contains its own value', () => {
    for (const v of [0, -0, 0.2, -0.2, 0.9, 1, 5, 20, 1e9, -1e9, 1e-7, 0.123]) {
      const b = seedBounds(v);
      expect(v).toBeGreaterThanOrEqual(b.min);
      expect(v).toBeLessThanOrEqual(b.max);
    }
  });

  it('keeps frozen bounds that still contain the value', () => {
    const prev = { min: 0, max: 40 };
    expect(fallbackBounds(prev, 20)).toBe(prev);
  });

  it('re-seeds when the value escapes the frozen range', () => {
    // The revert case: a preset's frequency = 20 displayed against a 0..1
    // track seeded while the row was tuned to 0.5 — one touch from being
    // clamped to 1 and stored.
    expect(fallbackBounds({ min: 0, max: 1 }, 20)).toEqual({ min: 0, max: 40 });
  });

  it('discards hostile frozen bounds', () => {
    expect(fallbackBounds({ min: NaN, max: 1 }, 0.5)).toEqual(seedBounds(0.5));
    expect(fallbackBounds(undefined, 0.5)).toEqual(seedBounds(0.5));
  });

  it('one re-seed always suffices — the result contains the value', () => {
    const b = fallbackBounds({ min: 0, max: 1 }, 20);
    expect(fallbackBounds(b, 20)).toBe(b);
  });
});

describe('sanitizers — both maps arrive from an imported project block', () => {
  it('keeps finite numbers and 6-digit hex only', () => {
    expect(sanitizeUniformValues({
      a: 1, b: '#ff8000', c: NaN, d: Infinity, e: '#ff8000ff', f: {}, g: null, h: '12',
    })).toEqual({ a: 1, b: '#ff8000' });
  });

  it('non-object roots yield an empty map', () => {
    expect(sanitizeUniformValues(null)).toEqual({});
    expect(sanitizeUniformValues('x')).toEqual({});
    expect(sanitizeUniformBounds(42)).toEqual({});
  });

  it('bounds must be finite and ordered', () => {
    expect(sanitizeUniformBounds({
      a: { min: 0, max: 1 },
      b: { min: 'abc', max: 1 },
      c: { min: 5, max: 0 },
      d: { min: 0, max: 0 },
      e: { min: -Infinity, max: 1 },
      f: null,
    })).toEqual({ a: { min: 0, max: 1 } });
  });

  it('both cap the entry count', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < MAX_UNIFORM_ENTRIES + 50; i++) big[`u${i}`] = i;
    expect(Object.keys(sanitizeUniformValues(big))).toHaveLength(MAX_UNIFORM_ENTRIES);
    const bigB: Record<string, { min: number; max: number }> = {};
    for (let i = 0; i < MAX_UNIFORM_ENTRIES + 50; i++) bigB[`u${i}`] = { min: 0, max: 1 };
    expect(Object.keys(sanitizeUniformBounds(bigB))).toHaveLength(MAX_UNIFORM_ENTRIES);
  });
});

describe('extractUniforms', () => {
  it('claims colour names before the numeric pass sees them', () => {
    const rows = extractUniforms('const tint = uniform(color(0xFF8000));');
    expect(rows).toEqual([{ name: 'tint', kind: 'color', defaultValue: '#ff8000' }]);
  });

  it('flags an unparseable literal instead of laundering it into 0', () => {
    expect(extractUniforms('const x = uniform(abc);')).toEqual([
      { name: 'x', kind: 'float', defaultValue: 0, unparsed: true },
    ]);
  });

  it('first declaration wins for a duplicated name', () => {
    const rows = extractUniforms('const a = uniform(1);\nconst a = uniform(2);');
    expect(rows).toEqual([{ name: 'a', kind: 'float', defaultValue: 1 }]);
  });
});

describe('authoredUniformChange — the one act that outranks a tuned value', () => {
  const varNames = { p1: 'cutoff' };
  const prop = (values: Record<string, string | number>, id = 'p1') =>
    makeNode(id, 'property_float', values);

  it('reports a float value edit under its EMITTED name', () => {
    expect(authoredUniformChange(
      prop({ name: 'cutoff', value: 0.2 }),
      prop({ name: 'cutoff', value: 0.9 }),
      varNames,
    )).toEqual({ name: 'cutoff', value: 0.9 });
  });

  it('reports a colour edit as a hex string', () => {
    expect(authoredUniformChange(
      makeNode('c1', 'property_color', { name: 'tint', hex: '#ff0000' }),
      makeNode('c1', 'property_color', { name: 'tint', hex: '#00ff00' }),
      { c1: 'tint' },
    )).toEqual({ name: 'tint', value: '#00ff00' });
  });

  it('is silent on a RENAME — a new name has no stored entry to outrank', () => {
    expect(authoredUniformChange(
      prop({ name: 'cutoff', value: 0.2 }),
      prop({ name: 'threshold', value: 0.2 }),
      varNames,
    )).toBeNull();
  });

  it('is silent for identical before/after', () => {
    expect(authoredUniformChange(
      prop({ name: 'cutoff', value: 0.2 }),
      prop({ name: 'cutoff', value: 0.2 }),
      varNames,
    )).toBeNull();
  });

  it('is silent for non-property nodes', () => {
    for (const type of ['float', 'time', 'micNode', 'slider']) {
      expect(authoredUniformChange(
        makeNode('n', type, { value: 1 }),
        makeNode('n', type, { value: 2 }),
        { n: 'x' },
      )).toBeNull();
    }
  });

  it('is silent for a half-typed number — it must not clear a tuning', () => {
    expect(authoredUniformChange(
      prop({ name: 'cutoff', value: 0.2 }),
      prop({ name: 'cutoff', value: 'abc' }),
      varNames,
    )).toBeNull();
  });

  it('honours the collision suffix in the emitted name', () => {
    expect(authoredUniformChange(
      prop({ name: 'speed', value: 1 }, 'b'),
      prop({ name: 'speed', value: 2 }, 'b'),
      { b: 'speed2' },
    )).toEqual({ name: 'speed2', value: 2 });
  });

  it('falls back to the stored name when varNames is stale (post-Apply)', () => {
    // codeToGraph mints fresh ids AND writes values.name from the code
    // identifier for both property kinds, so the fallback is exact.
    expect(authoredUniformChange(
      prop({ name: 'my speed', value: 1 }),
      prop({ name: 'my speed', value: 2 }),
      {},
    )).toEqual({ name: 'my_speed', value: 2 });
    expect(authoredUniformChange(
      prop({ value: 1 }),
      prop({ value: 2 }),
      {},
    )).toBeNull();
  });
});

describe('end to end against real graphToCode', () => {
  it('reproduces the trap and shows the authoring edit clearing it', () => {
    const nodes = [
      makeNode('p1', 'property_float', { name: 'cutoff', value: 0.2 }),
      makeNode('out', 'output'),
    ];
    const { code, varNames } = graphToCode(nodes, [makeEdge('p1', 'out', 'out', 'discard')]);
    expect(code).toContain('const cutoff = uniform(0.2);');

    const rows = extractUniforms(code);
    expect(rows).toEqual([{ name: 'cutoff', kind: 'float', defaultValue: 0.2 }]);

    // The user tuned it to 0.7 once; the preview ran 0.7 forever after.
    let stored: Record<string, number | string> = { cutoff: 0.7 };
    expect(isOverridden(rows[0], stored.cutoff)).toBe(true);

    // Editing the node's number now clears it.
    const change = authoredUniformChange(
      nodes[0],
      makeNode('p1', 'property_float', { name: 'cutoff', value: 0.9 }),
      Object.fromEntries(varNames),
    )!;
    expect(change).toEqual({ name: 'cutoff', value: 0.9 });
    stored = clearUniformValue(stored, change.name);
    expect(isOverridden(rows[0], stored.cutoff)).toBe(false);
  });

  it('emitted float literals survive extraction bit-exactly (no epsilon needed)', () => {
    for (const v of [0.2, 0.9, 0.305, 0.30500000000000005, 1e-7, 1e21, 0.1 + 0.2, 1 / 3]) {
      const { code } = graphToCode(
        [makeNode('p1', 'property_float', { name: 'k', value: v }), makeNode('out', 'output')],
        [makeEdge('p1', 'out', 'out', 'opacity')],
      );
      const [row] = extractUniforms(code);
      expect(row.defaultValue, `value ${v}`).toBe(v);
      expect(isOverridden(row, v)).toBe(false);
    }
  });

  it('a nodes-array reorder cannot clear tuning', () => {
    // Two properties named `speed`: which owns the bare identifier follows the
    // array order, so a name-keyed baseline would read a reorder as an edit.
    // Keying on the node id + a changed value cannot.
    const a = makeNode('a', 'property_float', { name: 'speed', value: 1 });
    const b = makeNode('b', 'property_float', { name: 'speed', value: 2 });
    const out = makeNode('out', 'output');
    const edges = [makeEdge('a', 'out', 'out', 'opacity'), makeEdge('b', 'out', 'out', 'roughness')];
    const first = graphToCode([a, b, out], edges).varNames;
    const flipped = graphToCode([b, a, out], edges).varNames;
    expect(first.get('a')).not.toBe(flipped.get('a'));
    // …and neither ordering is an authoring change.
    expect(authoredUniformChange(a, a, Object.fromEntries(flipped))).toBeNull();
    expect(authoredUniformChange(b, b, Object.fromEntries(flipped))).toBeNull();
  });

  it('a DISCONNECTED property still emits a uniform — badges must not be connection-filtered', () => {
    const { code } = graphToCode(
      [makeNode('p1', 'property_float', { name: 'cutoff', value: 0.42 }), makeNode('out', 'output')],
      [],
    );
    expect(code).toContain('const cutoff = uniform(0.42);');
    expect(extractUniforms(code)[0].defaultValue).toBe(0.42);
  });

  it('a colour property extracts as its authored hex', () => {
    const { code } = graphToCode(
      [makeNode('c1', 'property_color', { name: 'tint', hex: '#ff8800' }), makeNode('out', 'output')],
      [makeEdge('c1', 'out', 'out', 'color')],
    );
    expect(extractUniforms(code)).toEqual([{ name: 'tint', kind: 'color', defaultValue: '#ff8800' }]);
  });
});
