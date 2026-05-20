import { describe, it, expect } from 'vitest';
import { hasTimeUpstream } from './graphTraversal';
import { makeNode } from '@/test-utils';

const node = makeNode;

describe('hasTimeUpstream', () => {
  it('returns false on an isolated non-time node', () => {
    const nodes = [node('a', 'add')];
    expect(hasTimeUpstream('a', nodes, [])).toBe(false);
  });

  it('returns true when the node itself is a time node', () => {
    const nodes = [node('t', 'time')];
    expect(hasTimeUpstream('t', nodes, [])).toBe(true);
  });

  it('finds a direct time ancestor through one edge', () => {
    const nodes = [node('t', 'time'), node('a', 'add')];
    const edges = [{ source: 't', target: 'a' }];
    expect(hasTimeUpstream('a', nodes, edges)).toBe(true);
  });

  it('finds a multi-hop time ancestor', () => {
    const nodes = [node('t', 'time'), node('m', 'mul'), node('o', 'output')];
    const edges = [
      { source: 't', target: 'm' },
      { source: 'm', target: 'o' },
    ];
    expect(hasTimeUpstream('o', nodes, edges)).toBe(true);
  });

  it('returns false when no time ancestor exists', () => {
    const nodes = [node('uv', 'uv'), node('m', 'mul'), node('o', 'output')];
    const edges = [
      { source: 'uv', target: 'm' },
      { source: 'm', target: 'o' },
    ];
    expect(hasTimeUpstream('o', nodes, edges)).toBe(false);
  });

  it('only walks upstream (a downstream time node does not count)', () => {
    const nodes = [node('a', 'add'), node('t', 'time')];
    const edges = [{ source: 'a', target: 't' }];
    expect(hasTimeUpstream('a', nodes, edges)).toBe(false);
  });

  it('terminates on a cycle without recursing forever', () => {
    const nodes = [node('a', 'add'), node('b', 'mul')];
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ];
    expect(hasTimeUpstream('a', nodes, edges)).toBe(false);
  });

  it('returns false for an unknown node id', () => {
    expect(hasTimeUpstream('missing', [], [])).toBe(false);
  });
});
