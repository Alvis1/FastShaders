import { describe, it, expect } from 'vitest';
import { connectedUniformNamesKey, ALL_UNIFORMS } from './connectedUniforms';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';

const prop = (id: string, type: 'property_float' | 'property_color', name: string): AppNode =>
  makeNode(id, type, type === 'property_color' ? { name, hex: '#ff0000' } : { name, value: 1 });

const out = () => makeNode('out', 'output');

describe('connectedUniformNamesKey', () => {
  it('lists a connected property', () => {
    const nodes = [prop('a', 'property_float', 'glow'), out()];
    const edges = [makeEdge('a', 'out', 'out', 'opacity')];
    expect(connectedUniformNamesKey(nodes, edges, { a: 'glow' })).toBe('glow');
  });

  it('omits a property with no outgoing edge — scrubbing it would do nothing', () => {
    const nodes = [prop('a', 'property_float', 'glow'), prop('b', 'property_float', 'unused'), out()];
    const edges = [makeEdge('a', 'out', 'out', 'opacity')];
    expect(connectedUniformNamesKey(nodes, edges, { a: 'glow', b: 'unused' })).toBe('glow');
  });

  it('omits a property wired into a DEAD END that never reaches the Output', () => {
    // The whole point: `dead` has an outgoing edge, so a "is it wired?" test
    // calls it connected — but the multiply it feeds goes nowhere, so the
    // slider moves nothing on screen.
    const nodes = [
      prop('a', 'property_float', 'glow'),
      prop('d', 'property_float', 'dead'),
      makeNode('m', 'mul'),
      out(),
    ];
    const edges = [makeEdge('a', 'out', 'out', 'opacity'), makeEdge('d', 'out', 'm', 'a')];
    expect(connectedUniformNamesKey(nodes, edges, { a: 'glow', d: 'dead' })).toBe('glow');
  });

  it('keeps a property that reaches the Output through a chain', () => {
    const nodes = [prop('a', 'property_float', 'glow'), makeNode('m', 'mul'), out()];
    const edges = [makeEdge('a', 'out', 'm', 'a'), makeEdge('m', 'out', 'out', 'color')];
    expect(connectedUniformNamesKey(nodes, edges, { a: 'glow' })).toBe('glow');
  });

  it('survives a cycle in the dead branch without hanging', () => {
    const nodes = [prop('a', 'property_float', 'glow'), makeNode('x', 'mul'), makeNode('y', 'mul'), out()];
    const edges = [
      makeEdge('a', 'out', 'out', 'opacity'),
      makeEdge('x', 'out', 'y', 'a'),
      makeEdge('y', 'out', 'x', 'a'),
    ];
    expect(connectedUniformNamesKey(nodes, edges, { a: 'glow' })).toBe('glow');
  });

  it('falls back to "is wired" when there is no Output node to reach', () => {
    const nodes = [prop('a', 'property_float', 'glow'), makeNode('m', 'mul')];
    const edges = [makeEdge('a', 'out', 'm', 'a')];
    expect(connectedUniformNamesKey(nodes, edges, { a: 'glow' })).toBe('glow');
  });

  it('uses the EMITTED name so a codegen-renamed duplicate still shows', () => {
    // Two presets both shipping `colorA`: codegen keeps the first and renames
    // the second to colorA2. Matching on the STORED name found no colorA2
    // among the extracted uniforms and dropped a live slider from the overlay.
    const nodes = [
      prop('a', 'property_color', 'colorA'),
      prop('b', 'property_color', 'colorA'),
      out(),
    ];
    const edges = [makeEdge('a', 'out', 'out', 'color'), makeEdge('b', 'out', 'out', 'emissive')];
    const key = connectedUniformNamesKey(nodes, edges, { a: 'colorA', b: 'colorA2' });
    expect(key.split(' ')).toEqual(['colorA', 'colorA2']);
  });

  it('falls back to the stored name when varNames has no entry (code-panel Apply)', () => {
    // codeToGraph mints fresh ids, so every varNames lookup misses; the parsed
    // name IS the name in the code, so it is the right fallback.
    const nodes = [prop('fresh-id', 'property_float', 'glow'), out()];
    const edges = [makeEdge('fresh-id', 'out', 'out', 'opacity')];
    expect(connectedUniformNamesKey(nodes, edges, {})).toBe('glow');
  });

  it('sanitizes a fallback name the way codegen does', () => {
    const nodes = [prop('a', 'property_float', 'my glow'), out()];
    const edges = [makeEdge('a', 'out', 'out', 'opacity')];
    // sanitizeIdentifier maps every non-identifier char to '_'.
    expect(connectedUniformNamesKey(nodes, edges, {})).toBe('my_glow');
  });

  it('returns the sentinel when the graph has no property nodes at all', () => {
    const nodes = [makeNode('c', 'color', { hex: '#ff0000' }), out()];
    expect(connectedUniformNamesKey(nodes, [makeEdge('c', 'out', 'out', 'color')], {}))
      .toBe(ALL_UNIFORMS);
  });

  it('a property literally named "*" cannot fake the sentinel', () => {
    const nodes = [prop('a', 'property_float', '*'), out()];
    const edges = [makeEdge('a', 'out', 'out', 'opacity')];
    const key = connectedUniformNamesKey(nodes, edges, {});
    expect(key).not.toBe(ALL_UNIFORMS);
  });

  it('is order-stable so the selector key does not thrash', () => {
    const nodes = [prop('a', 'property_float', 'zed'), prop('b', 'property_float', 'alpha'), out()];
    const edges = [makeEdge('a', 'out', 'out', 'opacity'), makeEdge('b', 'out', 'out', 'roughness')];
    const k1 = connectedUniformNamesKey(nodes, edges, { a: 'zed', b: 'alpha' });
    const k2 = connectedUniformNamesKey([...nodes].reverse(), edges, { a: 'zed', b: 'alpha' });
    expect(k1).toBe(k2);
  });
});
