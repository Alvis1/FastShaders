/**
 * Where pasted / duplicated nodes land.
 *
 * Ctrl/Cmd+V lands the pasted set CENTRED in the view (`target` = the view's
 * centre in flow coords), so a paste after panning away from the originals is
 * on screen rather than 30 px off something the user can no longer see.
 * Ctrl/Cmd+D (`target` null) keeps the classic +30 offset beside the source.
 *
 * Positions are read in ABSOLUTE flow space (`node.position` is
 * parent-relative): a node whose parent is pasted WITH it keeps its relative
 * position and rides its parent's clone; any other node is a ROOT of the set.
 * Centring a root that lives in a group the paste does not copy DETACHES it —
 * a node in the middle of the view that still belongs to a frame elsewhere
 * would draw outside that frame. The +30 duplicate keeps its parent.
 */
import type { AppNode, GroupNodeData } from '@/types';
import { absoluteNodePosition, groupFrameSize, measuredNodeSize } from '@/utils/groupFrame';

/** The +30 cascade of a duplicate, and the step between repeated pastes. */
export const PASTE_STEP = 30;

export interface PastedSpot {
  position: { x: number; y: number };
  /** The SOURCE parent id (remap it to its clone), or undefined for a root. */
  parentId: string | undefined;
}

function boxSize(n: AppNode): { w: number; h: number } {
  return n.type === 'group' && !(n.data as GroupNodeData).collapsed
    ? groupFrameSize(n)
    : measuredNodeSize(n);
}

export function pastedSpots(
  sources: readonly AppNode[],
  liveNodes: readonly AppNode[],
  target: { x: number; y: number } | null,
): Map<string, PastedSpot> {
  const ids = new Set(sources.map((n) => n.id));
  const byId = new Map(liveNodes.map((n) => [n.id, n] as const));
  const spots = new Map<string, PastedSpot>();
  const roots: { node: AppNode; abs: { x: number; y: number } }[] = [];

  for (const node of sources) {
    if (node.parentId !== undefined && ids.has(node.parentId)) {
      spots.set(node.id, { position: { ...node.position }, parentId: node.parentId });
      continue;
    }
    // The clipboard copy's position is relative to ITS OWN parent; the parent
    // chain above that is read live. A parent gone since the copy leaves the
    // position as it was, read as absolute.
    const parent = node.parentId !== undefined ? byId.get(node.parentId) : undefined;
    const base = parent ? absoluteNodePosition(parent, byId) : { x: 0, y: 0 };
    roots.push({ node, abs: { x: base.x + node.position.x, y: base.y + node.position.y } });
  }

  if (!target || roots.length === 0) {
    for (const { node } of roots) {
      spots.set(node.id, {
        position: { x: node.position.x + PASTE_STEP, y: node.position.y + PASTE_STEP },
        parentId: node.parentId,
      });
    }
    return spots;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { node, abs } of roots) {
    const { w, h } = boxSize(node);
    minX = Math.min(minX, abs.x);
    minY = Math.min(minY, abs.y);
    maxX = Math.max(maxX, abs.x + w);
    maxY = Math.max(maxY, abs.y + h);
  }
  const dx = target.x - (minX + maxX) / 2;
  const dy = target.y - (minY + maxY) / 2;
  for (const { node, abs } of roots) {
    spots.set(node.id, { position: { x: abs.x + dx, y: abs.y + dy }, parentId: undefined });
  }
  return spots;
}
