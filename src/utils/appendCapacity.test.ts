/**
 * Socket-side channel budget for the vector-CONCATENATING variadic node
 * (`append`).
 *
 * The regression this whole module exists for: `maxOperands: 4` bounds the
 * socket COUNT, which is the right ceiling only while every operand is a
 * scalar. Wire a vec3 into `a` and the node still offered `b`, `c` and `d`
 * while `buildAppendConstructor` trimmed the argument list back to four
 * channels — so a wire landed on a live-looking socket, drew a real edge, and
 * never reached the shader. These pins are therefore about the ARITHMETIC of
 * that cap (channels, not sockets) and about the gate that keeps it away from
 * the arithmetic folds, which have no vector ceiling at all and must keep
 * growing to `MAX_CHAIN_OPERANDS` exactly as before.
 */
import { describe, it, expect } from 'vitest';
import {
  VECTOR_CHANNEL_LIMIT,
  concatenatesOperands,
  appendChannelsUsed,
  appendGrowthExhausted,
  type ChannelOf,
} from './appendCapacity';
import { NODE_REGISTRY, effectiveInputs } from '@/registry/nodeRegistry';

const def = (type: string) => NODE_REGISTRY.get(type)!;
const APPEND = def('append');

/**
 * Channel widths by port id. A Map, not a plain object, so a port id like
 * `constructor` resolves to "unwired" rather than to something off the
 * prototype chain — the same reason the registry's own lookup tables are Maps.
 */
const widths = (entries: Record<string, number>): ChannelOf => {
  const m = new Map(Object.entries(entries));
  return (id) => m.get(id);
};

/** Nothing is wired anywhere. */
const noWidths: ChannelOf = () => undefined;

describe('concatenatesOperands', () => {
  it('is true for append', () => {
    expect(concatenatesOperands(APPEND)).toBe(true);
  });

  it('is false for the arithmetic folds', () => {
    // A fold CONSUMES its operands — `mul(a, b, c, d, e)` is one more
    // multiplication, not one more channel — so it must never inherit a
    // vec4-shaped ceiling.
    for (const type of ['add', 'sub', 'mul', 'div']) {
      expect(concatenatesOperands(def(type)), type).toBe(false);
    }
  });

  it('is false for a node that does not grow operands at all', () => {
    expect(concatenatesOperands(def('clamp'))).toBe(false);
  });

  it('is false for a missing definition', () => {
    // Callers hand it a raw registry lookup, which is undefined for a node
    // type out of a hand-edited `.fastshader`.
    expect(concatenatesOperands(undefined)).toBe(false);
  });

  it('is keyed on the FLAG PAIR, not on the type name', () => {
    // The point of keying on flags is that a second constructor-style variadic
    // node inherits the cap instead of quietly reintroducing the dropped-wire
    // bug — and that a node which folds is excluded however it is named.
    expect(concatenatesOperands({ ...APPEND, type: 'append2' })).toBe(true);
    expect(concatenatesOperands({ ...APPEND, chainable: true })).toBe(false);
  });
});

describe('appendChannelsUsed', () => {
  it('sums the operand widths', () => {
    expect(appendChannelsUsed(['a', 'b'], widths({ a: 3, b: 1 }))).toBe(4);
    expect(appendChannelsUsed(['a', 'b'], widths({ a: 2, b: 2 }))).toBe(4);
    expect(appendChannelsUsed(['a', 'b', 'c'], widths({ a: 1, b: 1, c: 1 }))).toBe(3);
  });

  it('counts an unwired operand as one channel', () => {
    // An empty operand socket is not free: append has no chainIdentity and no
    // defaultValues, so codegen emits a bare `0` for it, and that `0` occupies
    // a slot in the constructor.
    expect(appendChannelsUsed(['a', 'b'], noWidths)).toBe(2);
    expect(appendChannelsUsed(['a', 'b'], widths({ a: 3 }))).toBe(4);
  });

  it('degrades a nonsensical width to one channel instead of poisoning the sum', () => {
    // `channelCount` runs a full upstream CPU evaluation and returns null for
    // anything unevaluable; the widths also ride through untrusted graph data.
    // A single NaN must not make the whole node's budget NaN — which compares
    // false against the limit and would re-open the affordance permanently.
    for (const junk of [NaN, Infinity, -Infinity, 0, -3, 0.5]) {
      expect(appendChannelsUsed(['a'], () => junk), String(junk)).toBe(1);
    }
    expect(appendChannelsUsed(['a', 'b'], widths({ a: NaN, b: 3 }))).toBe(4);
    // Fractional widths floor rather than accumulating a fraction of a socket.
    expect(appendChannelsUsed(['a'], () => 2.7)).toBe(2);
  });

  it('counts nothing for an empty operand list', () => {
    expect(appendChannelsUsed([], noWidths)).toBe(0);
  });

  it('takes any iterable of port ids', () => {
    // The caller maps over `effectiveInputs`, but the connected/valued handle
    // sets elsewhere in the editor are Sets.
    expect(appendChannelsUsed(new Set(['a', 'b']), widths({ a: 2, b: 1 }))).toBe(3);
  });
});

describe('appendGrowthExhausted', () => {
  it('never exhausts an arithmetic fold', () => {
    // The whole reason the helper is gated: a fold has no vector ceiling, so
    // widths are irrelevant and it keeps growing sockets as before. Wired here
    // with four-channel operands past append's own maxOperands.
    for (const type of ['add', 'mul']) {
      expect(
        appendGrowthExhausted(def(type), ['a', 'b', 'c', 'd', 'e'], [], () => 4),
        type,
      ).toBe(false);
    }
  });

  it('offers another socket while channels remain', () => {
    // a + b = 2 of 4 — c is still reachable.
    expect(appendGrowthExhausted(APPEND, ['a', 'b'], [], widths({ a: 1, b: 1 }))).toBe(false);
    // 3 of 4 — d is still reachable.
    expect(appendGrowthExhausted(APPEND, ['a', 'b'], [], widths({ a: 2, b: 1 }))).toBe(false);
  });

  it('withholds the socket once the vec4 is full', () => {
    // The headline case: ONE wired vec3 plus the unwired `b` already spends
    // every channel, so the emitter would drop anything landing on `c`.
    expect(appendGrowthExhausted(APPEND, ['a', 'b'], [], widths({ a: 3, b: 1 }))).toBe(true);
    expect(appendGrowthExhausted(APPEND, ['a'], [], widths({ a: 3 }))).toBe(true);
    // Two vec2s fill a vec4 exactly as four floats do — the cap is channels.
    expect(appendGrowthExhausted(APPEND, ['a', 'b'], [], widths({ a: 2, b: 2 }))).toBe(true);
    // Four scalars: full on channels AND at maxOperands.
    expect(
      appendGrowthExhausted(APPEND, ['a', 'b', 'c', 'd'], [], widths({ a: 1, b: 1, c: 1, d: 1 })),
    ).toBe(true);
  });

  it('leaves a freshly dropped node growable', () => {
    // Nothing connected: the two registry operands stand at 2 channels, so a
    // brand-new Append must still offer `c`.
    expect(appendGrowthExhausted(APPEND, [], [], noWidths)).toBe(false);
  });

  it('does not count the trailing empty grow slot against the budget', () => {
    // Three wired scalars leave one channel, so the fourth socket must still
    // be offered. This only holds because the check measures the EMITTED
    // operands (`includeTrailingEmpty: false`); counting the grow slot itself
    // would make the node refuse to open the very socket it can still fill.
    const connected = ['a', 'b', 'c'];
    const ch = widths({ a: 1, b: 1, c: 1 });
    expect(appendGrowthExhausted(APPEND, connected, [], ch)).toBe(false);
    // The counterfactual, stated as fact: with the grow slot included the
    // operand list is already four long.
    expect(effectiveInputs(APPEND, connected, false, []).length).toBe(3);
    expect(effectiveInputs(APPEND, connected, true, []).length).toBe(4);
  });

  it('counts an unwired extension operand that carries a stored value', () => {
    // codeToGraph stores numeric literal arguments as values, so a parsed
    // `append(x, 2, 3)` has extension operands with no edge that are still
    // emitted — and still spend channels.
    expect(appendGrowthExhausted(APPEND, ['a'], ['c'], widths({ a: 3 }))).toBe(true);
    expect(appendGrowthExhausted(APPEND, [], ['c'], noWidths)).toBe(false);
    expect(appendGrowthExhausted(APPEND, [], ['d'], noWidths)).toBe(true);
  });
});

describe('VECTOR_CHANNEL_LIMIT', () => {
  it('is the width of the widest GPU vector', () => {
    // There is no vec5, which is also why append's socket cap is 4: the two
    // numbers coincide only because an operand is at least one channel wide,
    // so the socket count can never bound the channel budget on its own.
    expect(VECTOR_CHANNEL_LIMIT).toBe(4);
    expect(APPEND.maxOperands).toBe(VECTOR_CHANNEL_LIMIT);
  });
});
