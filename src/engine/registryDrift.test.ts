/**
 * Registry ↔ cpuEvaluator drift guard.
 *
 * The evaluator hardcodes per-node semantics (chain identities, per-port
 * fallbacks, noise channel counts) that must stay in lockstep with the
 * registry definitions. Rather than folding the two into a shared template
 * (rejected — the divergences below are deliberate), this suite pins every
 * point of coupling so a future "unification" that would silently change
 * emitted values fails loudly instead.
 *
 * Everything goes through the public evaluateNodeOutput API on minimal graphs.
 */
import { describe, it, expect } from 'vitest';
import { evaluateNodeOutput } from './cpuEvaluator';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { makeNode, makeEdge } from '@/test-utils';
import type { TSLDataType } from '@/types';

/** Evaluate a single node with the given inline values and no incoming edges. */
function evalBare(registryType: string, values: Record<string, string | number> = {}) {
  const n = makeNode('n', registryType, values);
  return evaluateNodeOutput('n', [n], [], 0);
}

// ─── (a) chainIdentity: registry value vs evaluator missing-operand fold ────

// JS mirrors of the chainable ops (matching the evaluator's div-by-zero guard).
const CHAIN_OPS: Record<string, (a: number, b: number) => number> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => (b !== 0 ? a / b : 0),
};

describe('registry drift — chainIdentity vs cpuEvaluator operand fallback', () => {
  const chainDefs = [...NODE_REGISTRY.values()].filter((d) => d.chainable);

  it('CHAIN_OPS covers exactly the chainable defs (extend it when adding one)', () => {
    expect(chainDefs.map((d) => d.type).sort()).toEqual(Object.keys(CHAIN_OPS).sort());
    for (const d of chainDefs) expect(d.chainIdentity).toBeDefined();
  });

  for (const [type, fn] of Object.entries(CHAIN_OPS)) {
    it(`${type}: an absent operand contributes exactly the registry chainIdentity`, () => {
      const identity = NODE_REGISTRY.get(type)!.chainIdentity!;
      const x = 0.7;
      const src = makeNode('src', 'float', { value: x });
      const op = makeNode('op', type);
      // b absent → fold must be fn(x, identity)
      const bAbsent = evaluateNodeOutput('op', [src, op], [makeEdge('src', 'out', 'op', 'a')], 0);
      expect(bAbsent).not.toBeNull();
      expect(bAbsent![0]).toBeCloseTo(fn(x, identity), 12);
      // a absent → fold must be fn(identity, x)
      const aAbsent = evaluateNodeOutput('op', [src, op], [makeEdge('src', 'out', 'op', 'b')], 0);
      expect(aAbsent).not.toBeNull();
      expect(aAbsent![0]).toBeCloseTo(fn(identity, x), 12);
    });
  }
});

// ─── (b) per-port fallbacks that DELIBERATELY differ from registry defaults ─
//
// Audit of the evaluate() switch (2026-07-11): where the registry declares
// defaultValues, the evaluator fallbacks MATCH them (pow base/exp:1, mod y:1,
// min a/b:1, max b:0, uv tiling:1, noise scale:1). The ports below have NO
// registry defaultValues entry, and the evaluator deliberately falls back to a
// non-zero value — so a naive unification to `def.defaultValues?.[port] ?? 0`
// would silently change every result pinned here.

describe('registry drift — deliberate per-port fallback divergences', () => {
  it('log2 falls back to x = 1 → log2(1) = 0 (a 0 fallback would give ≈ -33)', () => {
    expect(evalBare('log2')).toEqual([0]);
  });

  it('mix falls back to b = 1 (t = 1 inline isolates the b port)', () => {
    expect(evalBare('mix', { t: 1 })).toEqual([1]);
  });

  it('mix falls back to t = 0.5 (a = 0, b = 1 inline isolate the t port)', () => {
    expect(evalBare('mix', { a: 0, b: 1 })).toEqual([0.5]);
  });

  it('smoothstep falls back to x = 0.5 → midpoint 0.5 (a 0 fallback would give 0)', () => {
    expect(evalBare('smoothstep')).toEqual([0.5]);
  });

  it('smoothstep falls back to edge1 = 1 (edge0 = -1 inline isolates edge1)', () => {
    // t = (0.5 - (-1)) / (1 - (-1)) = 0.75 → 0.75² · (3 - 1.5) = 0.84375
    expect(evalBare('smoothstep', { edge0: -1 })).toEqual([0.84375]);
  });

  it('clamp falls back to max = 1 (x = 2 clamps down to 1, not to 0)', () => {
    expect(evalBare('clamp', { x: 2 })).toEqual([1]);
  });

  it('remap falls back to inHigh = 1 and outHigh = 1 (0.6 maps to itself)', () => {
    expect(evalBare('remap', { x: 0.6 })).toEqual([0.6]);
  });

  it('hsl falls back to s = 1, l = 0.5 (bare node is pure red, not mid-grey)', () => {
    const res = evalBare('hsl');
    expect(res).not.toBeNull();
    expect(res![0]).toBeCloseTo(1, 12);
    expect(res![1]).toBeCloseTo(0, 12);
    expect(res![2]).toBeCloseTo(0, 12);
  });
});

// ─── (c) noise output dataType vs evaluate() channel count ──────────────────

describe('registry drift — noise output shape vs evaluated channel count', () => {
  // Local mirror of shapeOfDataType for the concrete types noise may declare.
  const CHANNELS: Partial<Record<TSLDataType, number>> = {
    float: 1,
    int: 1,
    vec2: 2,
    vec3: 3,
    vec4: 4,
    color: 3,
  };
  const noiseDefs = [...NODE_REGISTRY.values()].filter((d) => d.category === 'noise');

  it('covers the 8 MaterialX noise defs', () => {
    expect(noiseDefs).toHaveLength(8);
  });

  for (const def of noiseDefs) {
    it(`${def.type}: evaluate() emits ${def.outputs[0].dataType}-shaped channels`, () => {
      // Noise outputs must stay concrete — 'any' has no defined channel count.
      const expected = CHANNELS[def.outputs[0].dataType];
      expect(expected).toBeDefined();
      const res = evalBare(def.type, def.defaultValues ?? {});
      expect(res).not.toBeNull();
      expect(res!.length).toBe(expected);
    });
  }
});
