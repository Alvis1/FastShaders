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
 * The input STARTS on the node's MAIN input (utils/primaryInput.ts — the Factor
 * of a Mix, the X of a Smoothstep, otherwise the top input) wherever the hover
 * begins, and vertical TRAVEL from there steps through the inputs (owner,
 * 2026-11-13: "it does not cycle through inputs anymore when dragged
 * vertically"). The two halves are separate on purpose. Where the node sits must
 * not pick the socket — absolute alignment put a node dropped dead-centre on a
 * three-input node onto its MIDDLE socket (owner, 2026-11-10) — but how far it
 * has MOVED since the hover began may: `stepInput` keeps a virtual point in the
 * input sockets' frame, anchored on the main input at the first frame, moved
 * one socket pitch per pitch of vertical travel (in the physical direction:
 * moving down rings a lower socket of the hovered node, and an UPPER one of the
 * dragged node's own inputs, as alignment would), and CLAMPED to the outermost
 * sockets with the anchor sliding along — so overshooting an end and reversing
 * steps back at once, and every socket is reachable from either edge of the
 * hover box. The dragged centre can only travel the hover node's height before
 * the hover ends, so when the input span would need more than `REACH_FRAC` of
 * it (a tall Output dragged onto a small Float) the travel is amplified rather
 * than leaving the far sockets unreachable. `STEP_HYSTERESIS` keeps a pointer
 * resting between two sockets from flickering the ring. The state rides the
 * PLAN (`step`), and the caller hands the previous frame's plan back in; a
 * hover that ends (no plan), another node or the other side starts over on the
 * main input.
 *
 * A fed main input is REPLACED (inputs are single-connection) — except on an
 * operand node (Add, Multiply, Append: `spare` handles), whose A, B, C… are
 * interchangeable slots, where the hover starts on the next free one so two
 * drops build `a + b` instead of the second overwriting the first. Stepping
 * visits occupied sockets too (the ring shows what a drop would replace). The
 * channels of an Output are not interchangeable (Position is vertex
 * displacement), so a fed Color is replaced, never silently bypassed. The
 * gesture counterpart's own existing edge doesn't count as occupying
 * (NodeEditor's `mountedHandles`), so re-docking a feeder re-recognizes its
 * connection.
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

/** Flow px, in the input sockets' frame: a socket must be this much nearer the
 *  virtual point than the ringed one before the ring moves to it, so a pointer
 *  resting on the midpoint between two sockets does not flicker between them.
 *  Never more than a quarter of the tightest gap between two socket rows, or
 *  sockets packed closer than twice it could never be reached. */
export const STEP_HYSTERESIS = 4;

/** The share of the hover node's height the whole input span may need: past
 *  it, vertical travel is amplified so every input stays reachable before the
 *  dragged centre leaves the hover box. */
export const REACH_FRAC = 0.7;

/** The vertical-step state of one hover, carried frame to frame on the plan. */
export interface InputStep {
  /** dragged id, hover id and mode: a different key starts over on the main input. */
  key: string;
  /** The virtual point is `gain · travel + offset`, in the inputs' frame. */
  offset: number;
}

export interface DragConnectEndpoints {
  draggedId: string;
  hoverId: string;
  draggedCenterX: number;
  hoverCenterX: number;
  /** The dragged node's centre Y and the hovered box's centre and height:
   *  vertical travel steps the input (see the module header). */
  draggedCenterY: number;
  hoverCenterY: number;
  hoverHeight: number;
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
  /** Hand the plan back to the next frame's `planDragConnect` to keep stepping. */
  step: InputStep;
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
 * The input a hover STARTS on (vertical travel then steps from it — `stepInput`):
 * the main input — and when it is fed, the next free OPERAND slot (`spare`,
 * visual order) if there is one, else the main input again, replacing its wire.
 * Null for no inputs.
 */
export function pickMainInput(inputs: ConnectHandle[]): ConnectHandle | null {
  if (inputs.length === 0) return null;
  const main = inputs.find((i) => i.primary) ?? inputs[0];
  if (!main.occupied) return main;
  return inputs.find((i) => i.spare && !i.occupied) ?? main;
}

/**
 * The input a hover rings this frame: the main input on its first frame (or a
 * new key), afterwards wherever vertical travel has stepped it — see the module
 * header. Null for no inputs.
 */
export function stepInput(
  mode: DragConnectMode,
  ep: DragConnectEndpoints,
  inputs: ConnectHandle[],
  prev: DragConnectPlan | null | undefined,
): { chosen: ConnectHandle; step: InputStep } | null {
  const anchor = pickMainInput(inputs);
  if (!anchor) return null;
  const key = `${ep.draggedId}\u0000${ep.hoverId}\u0000${mode}`;
  // The inputs' own frame: the hovered node's centre for its inputs, the
  // dragged node's for the dragged node's (they travel with it).
  const frameY = mode === 'feed-hover' ? ep.hoverCenterY : ep.draggedCenterY;
  const dy = ep.draggedCenterY - ep.hoverCenterY;
  // Physical direction: the dragged node moving DOWN brings a lower socket of
  // the hovered node level with it, and an upper one of its own.
  const travel = mode === 'feed-hover' ? dy : -dy;
  const rows = inputs.map((i) => i.cy - frameY).sort((p, q) => p - q);
  const lo = rows[0];
  const hi = rows[rows.length - 1];
  let gap = Infinity;
  for (let k = 1; k < rows.length; k++) if (rows[k] > rows[k - 1]) gap = Math.min(gap, rows[k] - rows[k - 1]);
  const hysteresis = Math.min(STEP_HYSTERESIS, gap / 4);
  const room = Math.max(ep.hoverHeight, 1) * REACH_FRAC;
  const gain = Math.max(1, (hi - lo) / room);
  const current = prev?.step.key === key ? inputs.find((i) => i.id === prev.chosen.id) : undefined;
  let offset = current && prev ? prev.step.offset : anchor.cy - frameY - gain * travel;
  let v = gain * travel + offset;
  // Clamp to the outermost sockets and let the anchor slide with the overshoot:
  // reversing then steps back at once instead of first undoing the overshoot.
  if (v < lo) {
    offset += lo - v;
    v = lo;
  } else if (v > hi) {
    offset -= v - hi;
    v = hi;
  }
  const held = current ?? anchor;
  const nearest = nearestByCy(v + frameY, inputs) ?? held;
  const chosen =
    Math.abs(nearest.cy - frameY - v) + hysteresis < Math.abs(held.cy - frameY - v) ? nearest : held;
  return { chosen, step: { key, offset } };
}

function tryMode(
  mode: DragConnectMode,
  ep: DragConnectEndpoints,
  prev: DragConnectPlan | null | undefined,
): DragConnectPlan | null {
  const outs = mode === 'feed-hover' ? ep.draggedOutputs : ep.hoverOutputs;
  const inputs = mode === 'feed-hover' ? ep.hoverInputs : ep.draggedInputs;
  const picked = stepInput(mode, ep, inputs, prev);
  // The output level with the chosen input (first wins a tie — the phantom
  // tile's ports all sit at one Y, and its `out` comes first).
  const out = picked ? nearestByCy(picked.chosen.cy, outs) : null;
  if (!picked || !out) return null;
  const { chosen, step } = picked;
  return mode === 'feed-hover'
    ? {
        mode,
        source: ep.draggedId,
        sourceHandle: out.id,
        target: ep.hoverId,
        targetHandle: chosen.id,
        chosen,
        step,
      }
    : {
        mode,
        source: ep.hoverId,
        sourceHandle: out.id,
        target: ep.draggedId,
        targetHandle: chosen.id,
        chosen,
        step,
      };
}

/**
 * Decide what dropping the dragged node on the hovered node would connect.
 * Returns null when no legal connection exists in either direction. `prev` is
 * the plan this gesture showed on its previous frame (null when it showed
 * none): it carries the vertical step, so passing it is what makes vertical
 * travel move the chosen input.
 */
export function planDragConnect(
  ep: DragConnectEndpoints,
  edges: ReadonlyArray<{ source: string; target: string }>,
  prev?: DragConnectPlan | null,
): DragConnectPlan | null {
  const preferred: DragConnectMode =
    ep.draggedCenterX < ep.hoverCenterX ? 'feed-hover' : 'feed-dragged';
  const fallback: DragConnectMode = preferred === 'feed-hover' ? 'feed-dragged' : 'feed-hover';
  for (const mode of [preferred, fallback]) {
    const plan = tryMode(mode, ep, prev);
    if (plan && !wouldCreateCycle(edges, plan.source, plan.target)) return plan;
  }
  return null;
}
