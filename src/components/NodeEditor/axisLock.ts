import type { NodeChange } from '@xyflow/react';
import type { AppNode } from '@/types';

/** Each dragged node's position when its drag began, keyed by node id. */
export type DragStarts = Map<string, { x: number; y: number }>;

/**
 * Shift held during a node drag pins the drag to ONE axis — horizontal or
 * vertical, whichever the gesture has travelled further along so far, decided
 * afresh every frame — measured from where each node started.
 *
 * Applied to React Flow's position CHANGES on their way into the store, which
 * is the only place it can go: React Flow keeps no state of ours across a
 * drag, recomputing each frame's position from the pointer, so a pinned frame
 * never accumulates into the next, and letting go of Shift mid-drag simply
 * frees the node back onto the pointer. Every drag records its nodes' starts
 * (`starts`, mutated) on its first frame — the store still holds the
 * pre-drag position then — whether or not Shift is down yet, so pressing it
 * mid-drag locks against the true origin. The final `dragging: false` change
 * is pinned too (it would otherwise drop the node where the pointer is) and
 * then clears `starts`.
 *
 * Returns `changes` itself when nothing was pinned.
 */
export function axisLockChanges(
  changes: NodeChange<AppNode>[],
  nodes: readonly AppNode[],
  starts: DragStarts,
  locked: boolean,
): NodeChange<AppNode>[] {
  let ended = false;
  let axis: 'x' | 'y' | null = null; // the axis that stays FREE
  for (const c of changes) {
    if (c.type !== 'position') continue;
    if (c.dragging === true && !starts.has(c.id)) {
      const n = nodes.find((m) => m.id === c.id);
      if (n) starts.set(c.id, { x: n.position.x, y: n.position.y });
    }
    if (c.dragging === false) ended = true;
    const s = starts.get(c.id);
    if (axis === null && s && c.position) {
      const dx = Math.abs(c.position.x - s.x);
      const dy = Math.abs(c.position.y - s.y);
      if (dx > 0 || dy > 0) axis = dx >= dy ? 'x' : 'y';
    }
  }
  let out = changes;
  if (locked && axis !== null) {
    out = changes.map((c) => {
      if (c.type !== 'position' || !c.position) return c;
      const s = starts.get(c.id);
      if (!s) return c;
      const position = axis === 'x' ? { x: c.position.x, y: s.y } : { x: s.x, y: c.position.y };
      return { ...c, position };
    });
  }
  if (ended) starts.clear();
  return out;
}
