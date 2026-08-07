import { describe, it, expect } from 'vitest';
import { pickSpliceInputPort } from './edgeSplice';
import { NODE_REGISTRY, MAX_CHAIN_OPERANDS, chainPortId } from '@/registry/nodeRegistry';
import type { NodeDefinition } from '@/types';

const def = (type: string): NodeDefinition => {
  const d = NODE_REGISTRY.get(type);
  if (!d) throw new Error(`missing registry def: ${type}`);
  return d;
};

describe('pickSpliceInputPort', () => {
  it('picks the first port on a node with nothing wired', () => {
    expect(pickSpliceInputPort(def('mix'), [])).toBe('a');
  });

  it('skips a wired input and takes the next free one', () => {
    // The whole point: dragging a half-built node onto an edge must KEEP the
    // connection it already has instead of overwriting it.
    expect(pickSpliceInputPort(def('mix'), ['a'])).toBe('b');
    expect(pickSpliceInputPort(def('mix'), ['a', 'b'])).toBe('t');
  });

  it('skips a wired port even when the free one sits above it', () => {
    expect(pickSpliceInputPort(def('mix'), ['b'])).toBe('a');
  });

  it('falls back to the first port when every socket is taken (splice still splices)', () => {
    // The caller's single-input filter then replaces that port's edge, which
    // is the behaviour every splice had before free-socket selection existed.
    expect(pickSpliceInputPort(def('mix'), ['a', 'b', 't'])).toBe('a');
  });

  it('grows a variadic fold rather than declaring it full', () => {
    // Multiply declares a/b but GROWS: with both wired the trailing empty slot
    // `c` is a real, rendered socket, so the splice lands there.
    expect(pickSpliceInputPort(def('mul'), ['a', 'b'])).toBe('c');
    expect(pickSpliceInputPort(def('mul'), ['a', 'b', 'c'])).toBe('d');
  });

  it('respects a variadic node\'s maxOperands cap (append tops out at 4)', () => {
    const appendDef = def('append');
    expect(appendDef.maxOperands).toBe(4);
    expect(pickSpliceInputPort(appendDef, ['a', 'b', 'c'])).toBe('d');
    // Full at the cap → first port, replaced by the caller.
    expect(pickSpliceInputPort(appendDef, ['a', 'b', 'c', 'd'])).toBe('a');
  });

  it('stays inside MAX_CHAIN_OPERANDS for an absurd hand-edited handle set', () => {
    // A `.fastshader` can name any targetHandle; the port list must stay bounded.
    const all = Array.from({ length: MAX_CHAIN_OPERANDS }, (_, i) => chainPortId(i));
    expect(pickSpliceInputPort(def('mul'), [...all, 'arg99999999'])).toBe('a');
  });

  it('a stored inline value does not make an operand look occupied', () => {
    // Typing a number into B keeps its row but leaves the SOCKET free — a
    // splice should fill it rather than sprouting C past it.
    expect(pickSpliceInputPort(def('mul'), ['a'], ['a', 'b'])).toBe('b');
  });

  it('offers a hidden exposedPorts param (the caller exposes it on connect)', () => {
    // Image declares uv/tileX/… hidden-by-default; uv is still the primary
    // input a splice should reach for, and tryInsertOnEdge makes it visible.
    expect(pickSpliceInputPort(def('imageNode'), [])).toBe('uv');
    expect(pickSpliceInputPort(def('imageNode'), ['uv'])).toBe('tileX');
  });

  it('returns null for a def with no inputs at all', () => {
    // Noise nodes carry their params in defaultValues, so they declare none —
    // NodeEditor gates on this too, but the helper must not invent a port.
    expect(pickSpliceInputPort(def('perlin'), [])).toBeNull();
  });

  it('ignores non-port value keys when counting variadic rows', () => {
    // getNodeValues hands over every stored key; only operand-shaped ones
    // (a, b, …, argN) may influence the grown socket list.
    expect(pickSpliceInputPort(def('mul'), [], ['hex', 'name', 'speed'])).toBe('a');
  });
});
