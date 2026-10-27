import { describe, it, expect } from 'vitest';
import type { AppNode } from '@/types';
import { makeNode } from '@/test-utils';
import { pairResyncNodes } from './resyncPairing';

/**
 * `pairResyncNodes`' `carried` exclusion (utils/panelCarry.ts): an old node
 * the connected-only panel never showed comes back whole, so it may not take
 * a parsed node's identity. The rest of the pairing is pinned in
 * activeOutput.test.ts and outputSplitResync.test.ts.
 */
describe('pairResyncNodes — carried nodes never pair', () => {
  const perlin = (id: string, label: string): AppNode => ({ ...makeNode(id, 'perlin'), data: { ...makeNode(id, 'perlin').data, label } }) as AppNode;
  // The panel showed nB only (`noise2`); nA, listed FIRST, fed nothing.
  const oldNodes = [perlin('nA', 'Perlin'), perlin('nB', 'Perlin')];
  const parsed = [perlin('p1', 'noise2')];

  it('without the exclusion the type-only pass hands the parsed node the HIDDEN node’s id', () => {
    const { paired } = pairResyncNodes(oldNodes, parsed, null);
    expect(paired.map((p) => p.match.id)).toEqual(['nA']);
  });

  it('with it, the parsed node pairs with the node the panel showed', () => {
    const { paired, unpaired } = pairResyncNodes(oldNodes, parsed, null, new Set(['nA']));
    expect(paired.map((p) => [p.node.id, p.match.id])).toEqual([['p1', 'nB']]);
    expect(unpaired).toEqual([]);
  });

  it('an exact-key match on a carried node is refused too', () => {
    const { paired, unpaired } = pairResyncNodes([perlin('nA', 'noise2')], parsed, null, new Set(['nA']));
    expect(paired).toEqual([]);
    expect(unpaired.map((n) => n.id)).toEqual(['p1']);
  });
});

describe('pairResyncNodes — pass 0 pairs by the text’s NAMES (review 2026-10-27)', () => {
  const add = (id: string, label = 'Add'): AppNode => ({ ...makeNode(id, 'add'), data: { ...makeNode(id, 'add').data, label } }) as AppNode;
  // The array lists add2 FIRST; the text declares add1 first.
  const oldNodes = [add('add2'), add('add1')];
  const parsed = [add('p1', 'add1'), add('p2', 'add2')];
  const names = new Map([['add1', 'add1'], ['add2', 'add2']]);

  it('without names the type-only pass pairs by array order — the two Adds swap', () => {
    const { paired } = pairResyncNodes(oldNodes, parsed, null);
    expect(paired.map((p) => [p.node.id, p.match.id])).toEqual([['p1', 'add2'], ['p2', 'add1']]);
  });

  it('with them, each parsed node takes the id of the node its name was', () => {
    const { paired } = pairResyncNodes(oldNodes, parsed, null, undefined, names);
    expect(paired.map((p) => [p.node.id, p.match.id])).toEqual([['p1', 'add1'], ['p2', 'add2']]);
  });

  it('only within a type, and never a carried node', () => {
    const sub = { ...makeNode('s', 'sub'), data: { ...makeNode('s', 'sub').data, label: 'add1' } } as AppNode;
    const typed = pairResyncNodes(oldNodes, [sub], null, undefined, names);
    expect(typed.paired).toEqual([]);
    const carried = pairResyncNodes(oldNodes, parsed, null, new Set(['add1']), names);
    expect(carried.paired.map((p) => [p.node.id, p.match.id])).toEqual([['p2', 'add2']]);
  });
});
