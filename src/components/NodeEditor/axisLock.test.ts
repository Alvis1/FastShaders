import { describe, it, expect } from 'vitest';
import type { NodeChange } from '@xyflow/react';
import type { AppNode } from '@/types';
import { makeNode } from '@/test-utils';
import { axisLockChanges, type DragStarts } from './axisLock';

const at = (id: string, x: number, y: number): AppNode => ({ ...makeNode(id, 'float'), position: { x, y } });
const move = (id: string, x: number, y: number, dragging = true): NodeChange<AppNode> =>
  ({ type: 'position', id, position: { x, y }, dragging });
const pos = (c: NodeChange<AppNode>) => (c.type === 'position' ? c.position : undefined);

describe('Shift-drag pins a node drag to one axis', () => {
  it('pins to the axis the gesture travelled further along, from the drag START', () => {
    const nodes = [at('a', 100, 100)];
    const starts: DragStarts = new Map();
    // Mostly horizontal → y stays at the start.
    expect(pos(axisLockChanges([move('a', 140, 110)], nodes, starts, true)[0])).toEqual({ x: 140, y: 100 });
    // Later the store holds the pinned position; the START is still the origin,
    // and a mostly vertical stretch now frees y instead.
    const later = [at('a', 140, 100)];
    expect(pos(axisLockChanges([move('a', 120, 200)], later, starts, true)[0])).toEqual({ x: 100, y: 200 });
  });

  it('records the start even without Shift, so pressing it mid-drag locks against the true origin', () => {
    const starts: DragStarts = new Map();
    const free = axisLockChanges([move('a', 130, 105)], [at('a', 100, 100)], starts, false);
    expect(pos(free[0])).toEqual({ x: 130, y: 105 });
    expect(pos(axisLockChanges([move('a', 160, 120)], [at('a', 130, 105)], starts, true)[0]))
      .toEqual({ x: 160, y: 100 });
  });

  it('a multi-node drag moves every node along the SAME axis, each from its own start', () => {
    const starts: DragStarts = new Map();
    const out = axisLockChanges(
      [move('a', 150, 110), move('b', 350, 310)],
      [at('a', 100, 100), at('b', 300, 300)],
      starts,
      true,
    );
    expect(out.map(pos)).toEqual([{ x: 150, y: 100 }, { x: 350, y: 300 }]);
  });

  it('pins the final drop and then forgets the drag', () => {
    const starts: DragStarts = new Map();
    axisLockChanges([move('a', 120, 104)], [at('a', 100, 100)], starts, true);
    const end = axisLockChanges([move('a', 180, 130, false)], [at('a', 120, 100)], starts, true);
    expect(pos(end[0])).toEqual({ x: 180, y: 100 });
    expect(starts.size).toBe(0);
  });

  it('leaves non-drag changes alone and returns the same array when nothing is pinned', () => {
    const starts: DragStarts = new Map();
    const changes: NodeChange<AppNode>[] = [{ type: 'select', id: 'a', selected: true }];
    expect(axisLockChanges(changes, [at('a', 0, 0)], starts, true)).toBe(changes);
    const unlocked = [move('a', 5, 5)];
    expect(axisLockChanges(unlocked, [at('a', 0, 0)], starts, false)).toBe(unlocked);
  });
});
