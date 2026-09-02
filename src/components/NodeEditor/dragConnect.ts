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
 * EVERY SOCKET MUST BE REACHABLE, and physical alignment alone cannot promise
 * that. The gesture is gated on the dragged node's CENTER being inside the
 * hover node's box, so the whole vertical range a drag can explore is the
 * hover box's height — while the sockets being aligned sit wherever their
 * nodes put them. Two shapes break it (measured on the shipped registry, 246
 * of 9540 dragged/hover/side combinations): a dragged node whose OUTPUT
 * socket is far from its own center (uv's `out` is 46px above it; select's is
 * 35px below) shifts the sweep off the hover node's lower or upper sockets,
 * and a dragged node TALLER than the hover node (remap, smoothstep, clamp,
 * mix, the Output node dropped onto a Float) can only bring the inputs within
 * ±half the hover height of its own center level with the hover's output.
 * Dragging the Output node onto a Float could never reach its `position`
 * row; dragging `uv` onto `add` could never reach `b`. So the planner first
 * checks, by sweeping the dragged node across the hover box, whether physical
 * alignment gives every distinct socket height a usable band (`MIN_BAND_PX`),
 * and keeps the physical rule when it does — the common case, and the one
 * where "the socket level with mine" is what people aim for. When it does
 * not, the sweep is STRETCHED: the dragged center's position within the hover
 * box, top to bottom, is mapped across the candidate sockets' span (each end
 * socket gets a full half-pitch cell), in the same direction physical
 * alignment would move — so the choice still follows the drag, only scaled
 * to fit. The output side keeps physical pairing in both modes: the output
 * nearest the chosen input wins, which is what lets a Data node pick its
 * column by alignment.
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
  /** The dragged node's visual center Y and the hover box's vertical span.
   *  The gate that produced these endpoints is "dragged center inside the
   *  hover box", so these three numbers ARE the range the gesture can sweep —
   *  which is what decides whether every socket is reachable (see the module
   *  comment). Handles are absolute, so shifting the dragged node by `dy`
   *  shifts every dragged handle by `dy`. */
  draggedCenterY: number;
  hoverTop: number;
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

/**
 * The smallest vertical band (flow px of drag travel) a socket must own for
 * physical alignment to count as reaching it. A band you cannot hold the
 * pointer in is a socket you cannot pick — `select` dragged onto `mul` gave
 * `a` a 2px band under pure alignment, which reads as unreachable. The
 * reachability sweep samples every `SWEEP_STEP` px and asks for two hits, so
 * a band of roughly this width or more passes.
 */
export const MIN_BAND_PX = 8;
const SWEEP_STEP = MIN_BAND_PX / 2;

/** Physical pairing: the (output, input) pair with the nearest center Ys,
 *  the dragged side's handles shifted by `dy` (0 = where the node is now). */
function bestPair(
  mode: DragConnectMode,
  ep: DragConnectEndpoints,
  dy: number,
): { out: ConnectHandle; chosen: ConnectHandle } | null {
  const outs = mode === 'feed-hover' ? ep.draggedOutputs : ep.hoverOutputs;
  const inputs = mode === 'feed-hover' ? ep.hoverInputs : ep.draggedInputs;
  const outShift = mode === 'feed-hover' ? dy : 0;
  const inShift = mode === 'feed-hover' ? 0 : dy;
  let out: ConnectHandle | null = null;
  let chosen: ConnectHandle | null = null;
  let bestD = Infinity;
  for (const o of outs) {
    for (const i of inputs) {
      const d = Math.abs(o.cy + outShift - (i.cy + inShift)) + (i.occupied ? OCCUPIED_TIE_BIAS : 0);
      if (d < bestD) {
        bestD = d;
        out = o;
        chosen = i;
      }
    }
  }
  return out && chosen ? { out, chosen } : null;
}

/**
 * Does physical alignment give EVERY distinct socket height a usable band as
 * the dragged center sweeps the hover box? Sockets sharing a height (the
 * phantom tile's ports all sit at the cursor) can only ever be told apart by
 * the occupied tie-break, so they count as one height. Sampled rather than
 * solved: the chosen pair is the lower envelope of |out − in| V-shapes, and a
 * few dozen pair searches per drag frame cost nothing against the closed form.
 */
function physicalReachesEverySocket(mode: DragConnectMode, ep: DragConnectEndpoints): boolean {
  const inputs = mode === 'feed-hover' ? ep.hoverInputs : ep.draggedInputs;
  const heights = new Set<number>();
  for (const i of inputs) heights.add(i.cy);
  if (heights.size <= 1) return true;
  const hits = new Map<number, number>();
  const n = Math.max(1, Math.round(ep.hoverHeight / SWEEP_STEP));
  for (let k = 0; k <= n; k++) {
    const centerY = ep.hoverTop + (ep.hoverHeight * k) / n;
    const pair = bestPair(mode, ep, centerY - ep.draggedCenterY);
    if (pair) hits.set(pair.chosen.cy, (hits.get(pair.chosen.cy) ?? 0) + 1);
  }
  for (const cy of heights) if ((hits.get(cy) ?? 0) < 2) return false;
  return true;
}

/**
 * Stretched pick: map the dragged center's position within the hover box
 * across the candidate inputs' span — top socket at one end, bottom socket at
 * the other, each end socket owning a full half-pitch cell — moving in the
 * SAME direction physical alignment would (feed-dragged reverses: moving the
 * dragged node DOWN brings its UPPER inputs level with the hover's output).
 * The candidate handles are read at their current absolute positions, and so
 * is the span, so for the dragged side both move together and the mapping is
 * consistent at any instant of the drag.
 */
function stretchedPick(
  mode: DragConnectMode,
  ep: DragConnectEndpoints,
): { out: ConnectHandle; chosen: ConnectHandle } | null {
  const outs = mode === 'feed-hover' ? ep.draggedOutputs : ep.hoverOutputs;
  const inputs = mode === 'feed-hover' ? ep.hoverInputs : ep.draggedInputs;
  const cys = [...new Set(inputs.map((i) => i.cy))].sort((a, b) => a - b);
  let lo = cys[0];
  let hi = cys[cys.length - 1];
  if (cys.length > 1) {
    lo -= (cys[1] - cys[0]) / 2;
    hi += (cys[cys.length - 1] - cys[cys.length - 2]) / 2;
  }
  const t =
    ep.hoverHeight > 0
      ? Math.min(1, Math.max(0, (ep.draggedCenterY - ep.hoverTop) / ep.hoverHeight))
      : 0.5;
  const ref = mode === 'feed-hover' ? lo + t * (hi - lo) : hi - t * (hi - lo);
  let chosen: ConnectHandle | null = null;
  let bestD = Infinity;
  for (const i of inputs) {
    const d = Math.abs(i.cy - ref) + (i.occupied ? OCCUPIED_TIE_BIAS : 0);
    if (d < bestD) {
      bestD = d;
      chosen = i;
    }
  }
  if (!chosen) return null;
  const out = nearestByCy(chosen.cy, outs);
  return out ? { out, chosen } : null;
}

function tryMode(mode: DragConnectMode, ep: DragConnectEndpoints): DragConnectPlan | null {
  const outs = mode === 'feed-hover' ? ep.draggedOutputs : ep.hoverOutputs;
  const inputs = mode === 'feed-hover' ? ep.hoverInputs : ep.draggedInputs;
  if (outs.length === 0 || inputs.length === 0) return null;
  const pair = physicalReachesEverySocket(mode, ep) ? bestPair(mode, ep, 0) : stretchedPick(mode, ep);
  if (!pair) return null;
  const { out, chosen } = pair;
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
