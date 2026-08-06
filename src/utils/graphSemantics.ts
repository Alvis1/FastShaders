import type { AppNode, AppEdge } from '@/types';

/**
 * O(N+E) reference-scan predicates for classifying a store update by what it
 * can possibly affect. Every drag pointermove, marquee select, and dimension
 * pass replaces the nodes/edges ARRAYS (applyNodeChanges), so consumers keyed
 * on array identity re-run at pointer rate even though nothing they read
 * changed. These predicates detect that cheaply.
 *
 * Why reference compares are sufficient: `applyNodeChanges` spreads a node for
 * position/select/dimensions changes but REUSES its `data` object, while every
 * semantic mutation path (updateNodeData, setNodes, code→graph resync, and
 * undo/redo's structuredClone) mints fresh `data` references. So "same id at
 * the same index with the same `data` ref" proves the node is semantically
 * untouched without a deep walk.
 */

/**
 * True when the update CANNOT change compiled output or CPU-evaluated values:
 * same nodes (id + `data` ref, in order) and same edges by endpoint tuple.
 * Edge `data` is deliberately ignored — it carries only visual payload
 * (dataType tint, routing waypoints), which graphToCode/cpuEvaluator never
 * read, so a waypoint drag stays inert here.
 *
 * NOT for persistence decisions: positions and waypoints DO persist — use
 * `selectionOnlyGraphChange` for the autosave path instead.
 */
export function sameGraphSemantics(
  prevNodes: AppNode[],
  nodes: AppNode[],
  prevEdges: AppEdge[],
  edges: AppEdge[],
): boolean {
  if (prevNodes !== nodes) {
    if (prevNodes.length !== nodes.length) return false;
    for (let i = 0; i < nodes.length; i++) {
      const a = prevNodes[i];
      const b = nodes[i];
      if (a === b) continue;
      if (a.id !== b.id) return false;
      // Note nodes are pure annotations — no registry def, no edges, ignored
      // by graphToCode/cpuEvaluator — so typing in one is inert too. Group
      // data is NOT excepted: its collapse state rewrites boundary edges.
      if (a.data !== b.data && b.type !== 'note') return false;
    }
  }
  if (prevEdges !== edges) {
    if (prevEdges.length !== edges.length) return false;
    for (let i = 0; i < edges.length; i++) {
      const a = prevEdges[i];
      const b = edges[i];
      if (a === b) continue;
      if (
        a.source !== b.source ||
        a.target !== b.target ||
        a.sourceHandle !== b.sourceHandle ||
        a.targetHandle !== b.targetHandle
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * True when the only thing that changed is ephemeral per-element UI state the
 * persisted payload doesn't care about: selection flags, `dragging`,
 * `resizing`, and the `measured` sizes React Flow re-derives on mount.
 * Anything that persists — positions, EXPLICIT width/height (the note/group
 * corner-resize writes those, and loadGraph restores them), `data` (values,
 * waypoints), group membership, edge topology — returns false so the autosave
 * still arms.
 */
export function selectionOnlyGraphChange(
  prevNodes: AppNode[],
  nodes: AppNode[],
  prevEdges: AppEdge[],
  edges: AppEdge[],
): boolean {
  if (prevNodes !== nodes) {
    if (prevNodes.length !== nodes.length) return false;
    for (let i = 0; i < nodes.length; i++) {
      const a = prevNodes[i];
      const b = nodes[i];
      if (a === b) continue;
      if (
        a.id !== b.id ||
        a.data !== b.data ||
        a.position !== b.position ||
        a.parentId !== b.parentId ||
        a.width !== b.width ||
        a.height !== b.height
      ) {
        return false;
      }
    }
  }
  if (prevEdges !== edges) {
    if (prevEdges.length !== edges.length) return false;
    for (let i = 0; i < edges.length; i++) {
      const a = prevEdges[i];
      const b = edges[i];
      if (a === b) continue;
      if (
        a.id !== b.id ||
        a.data !== b.data ||
        a.source !== b.source ||
        a.target !== b.target ||
        a.sourceHandle !== b.sourceHandle ||
        a.targetHandle !== b.targetHandle
      ) {
        return false;
      }
    }
  }
  return true;
}
