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

// ─── (b) the registry default and the evaluator fallback AGREE ─────────────
//
// This section used to assert the OPPOSITE — it catalogued "deliberate
// divergences" where a port had no registry entry and the evaluator quietly
// used a non-zero number instead. That framing hid a whole bug class: codegen
// cannot see the evaluator's fallback, so it emitted the bare `0` while the
// node's own card showed the evaluator's number. `clamp(x, 0, 0)` rendered a
// constant 0, `remap(x, 0, 0, 0, 0)` divided by zero, `hsl(0, 0, 0)` was black
// beside a card showing red, `smoothstep(0, 0, x)` is a hard WGSL compile
// error, and `log2(0)` is -Infinity — every one of them a port this section
// was pinning as working-as-intended.
//
// The evaluator's numbers were right; the registry simply never declared them.
// Each case now asserts BOTH sides in one test: what the registry DECLARES and
// what the evaluator COMPUTES. That turns the old prose comment into an
// enforced invariant, so the next drift fails loudly instead of silently.

describe('registry defaults and evaluator fallbacks agree', () => {
  const declares = (type: string, port: string, value: number) => {
    expect(NODE_REGISTRY.get(type)?.defaultValues?.[port], `${type}.${port}`).toBe(value);
  };

  it('log2 declares x = 1 -> log2(1) = 0 (a 0 fallback is -Infinity, and WGSL rejects it)', () => {
    declares('log2', 'x', 1);
    expect(evalBare('log2')).toEqual([0]);
  });

  it('mix declares a = 0, b = 1, t = 0.5', () => {
    declares('mix', 'a', 0);
    declares('mix', 'b', 1);
    declares('mix', 't', 0.5);
    expect(evalBare('mix', { t: 1 })).toEqual([1]);
    expect(evalBare('mix', { a: 0, b: 1 })).toEqual([0.5]);
    expect(evalBare('mix')).toEqual([0.5]);
  });

  it('smoothstep declares edge0 = 0, edge1 = 1 and leaves x at 0 on BOTH sides', () => {
    declares('smoothstep', 'edge0', 0);
    declares('smoothstep', 'edge1', 1);
    // `x` deliberately has no registry entry (clamp's rule: the signal port is
    // the one you always wire), so the evaluator must fall back to 0 as well —
    // the bare value codegen emits for an undeclared port.
    expect(NODE_REGISTRY.get('smoothstep')?.defaultValues?.x).toBeUndefined();
    expect(evalBare('smoothstep')).toEqual([0]);
    expect(evalBare('smoothstep', { edge0: -1 })).toEqual([0.5]);
  });

  it('clamp declares min = 0, max = 1 (x = 2 clamps down to 1, not to 0)', () => {
    declares('clamp', 'min', 0);
    declares('clamp', 'max', 1);
    expect(evalBare('clamp', { x: 2 })).toEqual([1]);
  });

  it('remap declares the 0..1 -> 0..1 identity (0.6 maps to itself)', () => {
    declares('remap', 'inLow', 0);
    declares('remap', 'inHigh', 1);
    declares('remap', 'outLow', 0);
    declares('remap', 'outHigh', 1);
    expect(evalBare('remap', { x: 0.6 })).toEqual([0.6]);
  });

  it('hsl declares s = 1, l = 0.5 (a bare node is pure red, not black)', () => {
    declares('hsl', 's', 1);
    declares('hsl', 'l', 0.5);
    const res = evalBare('hsl');
    expect(res).not.toBeNull();
    expect(res![0]).toBeCloseTo(1, 12);
    expect(res![1]).toBeCloseTo(0, 12);
    expect(res![2]).toBeCloseTo(0, 12);
  });

  it('the already-correct ones stay correct', () => {
    declares('pow', 'base', 1);
    declares('pow', 'exp', 1);
    declares('mod', 'y', 1);
    declares('min', 'a', 1);
    declares('min', 'b', 1);
    declares('max', 'b', 0);
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
