/**
 * Drag-connect: dragging a node ONTO another node wires them together.
 * The hovered node highlights, a tooltip names the input socket the drop
 * will plug into, and vertical movement of the dragged node changes which
 * socket that is. Direction follows the side the dragged node sits on:
 *
 * - Dragged node LEFT of the hovered node's center → the dragged node's
 *   output feeds the hovered node's input ('feed-hover').
 * - Dragged node RIGHT of center → the hovered node's output feeds the
 *   dragged node's input ('feed-dragged').
 * - If the preferred direction is impossible (missing sockets, or it would
 *   create a cycle) the opposite direction is tried before giving up.
 *
 * Vertical alignment picks the sockets: the (output, input) pair with the
 * nearest center Ys wins, so a multi-output source (Data node columns) picks
 * its column by alignment too. Occupied inputs are eligible — aligning with a
 * used socket re-wires it (inputs are single-connection, so the drop swaps its
 * edge). A hair of bias toward free inputs only breaks EXACT ties, so a loose
 * drop still fills an empty socket instead of overwriting a wired one sitting
 * at the same height.
 *
 * This module is the pure decision logic (node-env testable). NodeEditor
 * adapts React Flow internals (measured boxes, mounted handle bounds) into
 * these plain structs and renders the highlight/tooltip imperatively, the
 * same way the drop-on-edge preview does.
 */

/** A candidate drop target's absolute flow-space bounding box. */
export interface NodeBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A mounted handle, absolute flow-space center. */
export interface ConnectHandle {
  id: string;
  cx: number;
  cy: number;
  /** Inputs only: whether an edge already feeds this handle. */
  occupied?: boolean;
}

export type DragConnectMode = 'feed-hover' | 'feed-dragged';

export interface DragConnectEndpoints {
  draggedId: string;
  hoverId: string;
  draggedCenterX: number;
  hoverCenterX: number;
  draggedInputs: ConnectHandle[];
  draggedOutputs: ConnectHandle[];
  hoverInputs: ConnectHandle[];
  hoverOutputs: ConnectHandle[];
}

export interface DragConnectPlan {
  mode: DragConnectMode;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  /** The input socket picked by vertical alignment (tooltip/ring anchor). */
  chosen: ConnectHandle;
}

/**
 * The node whose bounds contain (cx, cy) — the dragged node's center. With
 * overlapping candidates the SMALLEST box wins, so a node sitting on top of a
 * large one (or inside a group's footprint) is preferred over its backdrop.
 */
export function pickDropTargetNode(cx: number, cy: number, boxes: NodeBox[]): string | null {
  let best: NodeBox | null = null;
  for (const b of boxes) {
    if (cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h) continue;
    if (!best || b.w * b.h < best.w * best.h) best = b;
  }
  return best?.id ?? null;
}

/** Handle whose center Y sits nearest refY (first wins ties — handles arrive
 *  in visual top-to-bottom order). */
export function nearestByCy(refY: number, handles: ConnectHandle[]): ConnectHandle | null {
  let best: ConnectHandle | null = null;
  let bestD = Infinity;
  for (const h of handles) {
    const d = Math.abs(h.cy - refY);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

/**
 * Would adding source→target close a cycle? True iff `target` already
 * reaches `source` through existing edges (or they are the same node).
 * graphToCode's topological sort only WARNS on cycles, so the wire-drag path
 * technically allows them — but an implicit whole-node gesture must not
 * create one by accident.
 */
export function wouldCreateCycle(
  edges: ReadonlyArray<{ source: string; target: string }>,
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const list = adj.get(e.source);
    if (list) list.push(e.target);
    else adj.set(e.source, [e.target]);
  }
  const queue = [target];
  const seen = new Set(queue);
  while (queue.length) {
    const cur = queue.pop()!;
    if (cur === source) return true;
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/** A hair of bias so an EXACT free/occupied vertical tie resolves to the FREE
 *  input — a loose drop fills an empty socket rather than silently overwriting
 *  a wired one at the same height. Smaller than any real socket spacing, so it
 *  never overrides a deliberate alignment with an occupied socket. */
const OCCUPIED_TIE_BIAS = 0.001;

function tryMode(mode: DragConnectMode, ep: DragConnectEndpoints): DragConnectPlan | null {
  const outs = mode === 'feed-hover' ? ep.draggedOutputs : ep.hoverOutputs;
  const inputs = mode === 'feed-hover' ? ep.hoverInputs : ep.draggedInputs;
  if (outs.length === 0 || inputs.length === 0) return null;
  // Best (output, input) PAIR by vertical alignment — a multi-output source
  // (Data node CSV columns) picks its column by alignment too, not always
  // column 1. With a single output this degenerates to nearestByCy. OCCUPIED
  // inputs are eligible: aligning with a used socket re-wires it (the drop
  // swaps its edge — applyConnection enforces single-input), with only a
  // tie-break bias toward free sockets.
  let out: ConnectHandle | null = null;
  let chosen: ConnectHandle | null = null;
  let bestD = Infinity;
  for (const o of outs) {
    for (const i of inputs) {
      const d = Math.abs(o.cy - i.cy) + (i.occupied ? OCCUPIED_TIE_BIAS : 0);
      if (d < bestD) {
        bestD = d;
        out = o;
        chosen = i;
      }
    }
  }
  if (!out || !chosen) return null;
  return mode === 'feed-hover'
    ? {
        mode,
        source: ep.draggedId,
        sourceHandle: out.id,
        target: ep.hoverId,
        targetHandle: chosen.id,
        chosen,
      }
    : {
        mode,
        source: ep.hoverId,
        sourceHandle: out.id,
        target: ep.draggedId,
        targetHandle: chosen.id,
        chosen,
      };
}

/**
 * Decide what dropping the dragged node on the hovered node would connect.
 * Returns null when no legal connection exists in either direction.
 */
export function planDragConnect(
  ep: DragConnectEndpoints,
  edges: ReadonlyArray<{ source: string; target: string }>,
): DragConnectPlan | null {
  const preferred: DragConnectMode =
    ep.draggedCenterX < ep.hoverCenterX ? 'feed-hover' : 'feed-dragged';
  const fallback: DragConnectMode = preferred === 'feed-hover' ? 'feed-dragged' : 'feed-hover';
  for (const mode of [preferred, fallback]) {
    const plan = tryMode(mode, ep);
    if (plan && !wouldCreateCycle(edges, plan.source, plan.target)) return plan;
  }
  return null;
}
