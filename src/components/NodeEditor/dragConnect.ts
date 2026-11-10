/**
 * Drag-connect: dragging a node ONTO another node wires them together.
 * The hovered node highlights and a tooltip names the input socket the drop
 * will plug into. Direction follows the side the dragged node sits on:
 *
 * - Dragged node LEFT of the hovered node's center → the dragged node's
 *   output feeds the hovered node's input ('feed-hover').
 * - Dragged node RIGHT of center → the hovered node's output feeds the
 *   dragged node's input ('feed-dragged').
 * - If the preferred direction is impossible (missing sockets, or it would
 *   create a cycle) the opposite direction is tried before giving up.
 *
 * The INPUT is always the node's MAIN input (utils/primaryInput.ts — the Factor
 * of a Mix, the X of a Smoothstep, otherwise the top input), never chosen by
 * where the dragged node sits vertically. Vertical alignment used to pick it,
 * which put a node dropped dead-centre on a three-input node onto its MIDDLE
 * socket. A fed main input is REPLACED (inputs are single-connection) — except
 * on an operand node (Add, Multiply, Append: `spare` handles), whose A, B, C…
 * are interchangeable slots, where the drop takes the next free one so two
 * drops build `a + b` instead of the second overwriting the first. The channels
 * of an Output are not interchangeable (Position is vertex displacement), so a
 * fed Color is replaced, never silently bypassed. The gesture counterpart's own
 * existing edge doesn't count as occupying (NodeEditor's `mountedHandles`), so
 * re-docking a feeder re-recognizes its connection.
 *
 * The OUTPUT of a multi-output source (Data node columns, Split) is still
 * chosen by alignment: the output level with the chosen input wins.
 *
 * This module is the pure decision logic (node-env testable). NodeEditor
 * adapts React Flow internals (measured boxes, mounted handle bounds) into
 * these plain structs and renders the highlight/tooltip imperatively, the
 * same way the drop-on-edge preview does.
 */

/** Flow-px gap between the two handle anchors when the dropped node snaps
 *  into place beside the node it just connected to (NodeEditor's
 *  `connectSnapOffset`; the intro's tour lands the same way). */
export const CONNECT_SNAP_GAP = 48;

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
  /** Inputs only: this is the node's MAIN input (utils/primaryInput.ts). With
   *  no handle flagged, the first input in the array is the main one. */
  primary?: boolean;
  /** Inputs only: an interchangeable operand slot (Add's A/B/C…) — it may take
   *  the drop when the main input is already fed. */
  spare?: boolean;
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
  /** The input socket picked (tooltip/ring anchor). */
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

/**
 * The input a drop lands on: the main input — and when it is fed, the next free
 * OPERAND slot (`spare`, visual order) if there is one, else the main input
 * again, replacing its wire. Null for no inputs.
 */
export function pickMainInput(inputs: ConnectHandle[]): ConnectHandle | null {
  if (inputs.length === 0) return null;
  const main = inputs.find((i) => i.primary) ?? inputs[0];
  if (!main.occupied) return main;
  return inputs.find((i) => i.spare && !i.occupied) ?? main;
}

function tryMode(mode: DragConnectMode, ep: DragConnectEndpoints): DragConnectPlan | null {
  const outs = mode === 'feed-hover' ? ep.draggedOutputs : ep.hoverOutputs;
  const inputs = mode === 'feed-hover' ? ep.hoverInputs : ep.draggedInputs;
  const chosen = pickMainInput(inputs);
  // The output level with the chosen input (first wins a tie — the phantom
  // tile's ports all sit at one Y, and its `out` comes first).
  const out = chosen ? nearestByCy(chosen.cy, outs) : null;
  if (!chosen || !out) return null;
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
