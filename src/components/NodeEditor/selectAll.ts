/**
 * A selects every node — Blender's key, the sibling of Shift+A (add) and F
 * (frame the selection) that the canvas already borrows. Pure: computes the
 * React Flow `select` changes the key should dispatch, so the binding in
 * NodeEditor is one line and the rule is node-env testable.
 *
 * "Every node" means every node the user can SEE: a member hidden inside a
 * collapsed group (the `fs-collapsed-member` className — the Groups
 * convention, not React Flow's `hidden`) is represented on screen by the
 * pill, and selecting the pill is what selecting the group means. Selecting
 * the invisible members too would let Delete remove nodes nobody could see
 * were selected. Group frames and notes ARE nodes and are included: React
 * Flow skips a child whose parent is also dragged, so a frame plus its
 * members drag once, and Delete on the set removes the frames with the
 * members rather than leaving empty frames behind.
 *
 * When every visible node is ALREADY selected the key DESELECTS all — the
 * classic toggle, and the only modifier-free way back out (Cmd+A stays the
 * browser's select-all and never reaches here).
 */
import type { NodeChange } from '@xyflow/react';
import type { AppNode } from '@/types';

export type SelectChange = Extract<NodeChange<AppNode>, { type: 'select' }>;

/** Whether the node is on screen and therefore part of "all". */
export function isSelectableNode(node: AppNode): boolean {
  return !(node.className ?? '').includes('fs-collapsed-member');
}

/**
 * The `select` changes for one press of A: select every visible node, or —
 * when they are all selected already — deselect every node (hidden members
 * included, so a stale hidden selection cannot survive the toggle). Returns
 * only the nodes whose state changes; an empty list means nothing to do.
 */
export function selectAllChanges(nodes: readonly AppNode[]): SelectChange[] {
  const visible = nodes.filter(isSelectableNode);
  const allSelected = visible.length > 0 && visible.every((n) => n.selected);
  if (allSelected) {
    return nodes.filter((n) => n.selected).map((n) => ({ type: 'select', id: n.id, selected: false }));
  }
  return visible.filter((n) => !n.selected).map((n) => ({ type: 'select', id: n.id, selected: true }));
}
