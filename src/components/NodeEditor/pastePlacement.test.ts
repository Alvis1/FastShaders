import { describe, it, expect } from 'vitest';
import type { AppNode } from '@/types';
import { makeNode } from '@/test-utils';
import { pastedSpots, PASTE_STEP } from './pastePlacement';

function at(id: string, x: number, y: number, w = 100, h = 50, parentId?: string): AppNode {
  const n = makeNode(id, 'add');
  n.position = { x, y };
  (n as AppNode & { measured: { width: number; height: number } }).measured = { width: w, height: h };
  if (parentId) n.parentId = parentId;
  return n;
}

function group(id: string, x: number, y: number, w: number, h: number): AppNode {
  return {
    id, type: 'group', position: { x, y }, width: w, height: h,
    data: { label: id, collapsed: false },
  } as unknown as AppNode;
}

describe('pastedSpots', () => {
  it('centres the pasted set on the view target', () => {
    const a = at('a', 0, 0);
    const b = at('b', 200, 100);
    const spots = pastedSpots([a, b], [a, b], { x: 1000, y: 500 });
    // bbox (0,0)–(300,150), centre (150,75) → shifted by (850,425)
    expect(spots.get('a')).toEqual({ position: { x: 850, y: 425 }, parentId: undefined });
    expect(spots.get('b')).toEqual({ position: { x: 1050, y: 525 }, parentId: undefined });
  });

  it('a duplicate (no target) lands +PASTE_STEP beside the source and keeps its parent', () => {
    const g = group('g', 500, 500, 400, 300);
    const a = at('a', 10, 20, 100, 50, 'g');
    const spots = pastedSpots([a], [g, a], null);
    expect(spots.get('a')).toEqual({ position: { x: 10 + PASTE_STEP, y: 20 + PASTE_STEP }, parentId: 'g' });
  });

  it('centring a member whose group is not pasted detaches it at its absolute spot', () => {
    const g = group('g', 500, 500, 400, 300);
    const a = at('a', 10, 20, 100, 50, 'g');
    const spots = pastedSpots([a], [g, a], { x: 0, y: 0 });
    expect(spots.get('a')).toEqual({ position: { x: -50, y: -25 }, parentId: undefined });
  });

  it('members pasted WITH their group ride it: relative position kept, parent named', () => {
    const g = group('g', 500, 500, 400, 300);
    const a = at('a', 10, 20, 100, 50, 'g');
    const spots = pastedSpots([g, a], [g, a], { x: 0, y: 0 });
    expect(spots.get('g')).toEqual({ position: { x: -200, y: -150 }, parentId: undefined });
    expect(spots.get('a')).toEqual({ position: { x: 10, y: 20 }, parentId: 'g' });
  });
});
