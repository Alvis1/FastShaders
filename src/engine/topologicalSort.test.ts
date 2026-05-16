import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { topologicalSort } from './topologicalSort';
import type { AppNode, AppEdge } from '@/types';

function node(id: string): AppNode {
  return {
    id,
    type: 'shader',
    position: { x: 0, y: 0 },
    data: { registryType: 'add', label: id, cost: 0, values: {} },
  } as unknown as AppNode;
}

function edge(source: string, target: string): AppEdge {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    sourceHandle: 'out',
    targetHandle: 'a',
  } as unknown as AppEdge;
}

describe('topologicalSort', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns an empty array for an empty graph', () => {
    expect(topologicalSort([], [])).toEqual([]);
  });

  it('returns the single node for a singleton graph', () => {
    const a = node('a');
    expect(topologicalSort([a], [])).toEqual([a]);
  });

  it('orders a linear chain by ancestry', () => {
    const nodes = ['a', 'b', 'c'].map(node);
    const edges = [edge('a', 'b'), edge('b', 'c')];
    const result = topologicalSort(nodes, edges).map((n) => n.id);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('produces a valid order for a diamond DAG', () => {
    // a -> b, a -> c, b -> d, c -> d
    const nodes = ['a', 'b', 'c', 'd'].map(node);
    const edges = [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')];
    const order = topologicalSort(nodes, edges).map((n) => n.id);
    expect(order).toHaveLength(4);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('handles disjoint components', () => {
    const nodes = ['a', 'b', 'x', 'y'].map(node);
    const edges = [edge('a', 'b'), edge('x', 'y')];
    const result = topologicalSort(nodes, edges).map((n) => n.id);
    expect(result).toHaveLength(4);
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('b'));
    expect(result.indexOf('x')).toBeLessThan(result.indexOf('y'));
  });

  it('omits cyclic nodes and warns', () => {
    const nodes = ['a', 'b', 'c'].map(node);
    // a -> b -> c -> a is a 3-cycle; nothing has in-degree 0
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    const result = topologicalSort(nodes, edges);
    expect(result.length).toBeLessThan(nodes.length);
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Cycle detected');
  });

  it('omits a self-loop node and still emits the rest', () => {
    const nodes = ['root', 'loop', 'leaf'].map(node);
    const edges = [edge('root', 'leaf'), edge('loop', 'loop')];
    const result = topologicalSort(nodes, edges).map((n) => n.id);
    expect(result).toContain('root');
    expect(result).toContain('leaf');
    expect(result).not.toContain('loop');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('does not warn when the graph is acyclic', () => {
    const nodes = ['a', 'b'].map(node);
    topologicalSort(nodes, [edge('a', 'b')]);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
