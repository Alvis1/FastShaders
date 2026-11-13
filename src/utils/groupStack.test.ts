import { describe, it, expect } from 'vitest';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';
import { raisedGroupStack } from './groupFrame';

const group = (id: string, parentId?: string, zIndex?: unknown): AppNode =>
  ({ id, type: 'group', position: { x: 0, y: 0 }, data: { label: id }, ...(parentId ? { parentId } : {}), ...(zIndex !== undefined ? { zIndex } : {}) }) as unknown as AppNode;
const inGroup = (n: AppNode, parentId: string) => ({ ...n, parentId }) as AppNode;
const z = (nodes: AppNode[] | null, id: string) => (nodes?.find((n) => n.id === id) as { zIndex?: unknown } | undefined)?.zIndex;

describe('raisedGroupStack — the last touched group stays on top', () => {
  const base = () => [group('A'), inGroup(makeNode('a', 'mul'), 'A'), group('B'), inGroup(makeNode('b', 'mul'), 'B'), makeNode('free', 'mul')];

  it('raising a group ranks it on top; the ranks persist and compact', () => {
    const one = raisedGroupStack(base(), ['A'])!;
    expect(z(one, 'A')).toBe(1);
    expect(z(one, 'B')).toBeUndefined(); // untouched: no rank, below every raised one
    const two = raisedGroupStack(one, ['B'])!;
    expect([z(two, 'A'), z(two, 'B')]).toEqual([1, 2]);
    const three = raisedGroupStack(two, ['A'])!;
    expect([z(three, 'A'), z(three, 'B')]).toEqual([2, 1]);
  });

  it('touching a MEMBER raises its group; a free node raises nothing', () => {
    expect(z(raisedGroupStack(base(), ['b']), 'B')).toBe(1);
    expect(raisedGroupStack(base(), ['free'])).toBeNull();
  });

  it('a nested frame raises its OUTERMOST group, and only outermost groups carry a rank', () => {
    const nodes = [group('O'), group('I', 'O'), inGroup(makeNode('m', 'mul'), 'I'), group('P')];
    const out = raisedGroupStack(nodes, ['m'])!;
    expect(z(out, 'O')).toBe(1);
    expect(z(out, 'I')).toBeUndefined();
  });

  it('already on top → null (no store write on every drag tick); never reorders the array or touches members', () => {
    const one = raisedGroupStack(base(), ['A'])!;
    expect(raisedGroupStack(one, ['A', 'a'])).toBeNull();
    expect(one.map((n) => n.id)).toEqual(base().map((n) => n.id));
    expect(one[1]).toBe(one[1]);
    expect(z(one, 'a')).toBeUndefined();
  });

  it('a junk stored zIndex is read as no rank, never coerced', () => {
    const poisoned = [group('A', undefined, { toString: 1 }), group('B', undefined, 'x'), group('C', undefined, Infinity)];
    const out = raisedGroupStack(poisoned, ['C'])!;
    expect(z(out, 'C')).toBe(1);
  });

  it('a parentId cycle ends the walk', () => {
    const loop = [{ ...group('A'), parentId: 'B' }, { ...group('B'), parentId: 'A' }] as AppNode[];
    expect(() => raisedGroupStack(loop, ['A'])).not.toThrow();
  });
});
