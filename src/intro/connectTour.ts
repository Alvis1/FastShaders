/**
 * The intro's first scene as data: a node is dragged onto an Output, passes
 * over Roughness and Emissive, and is dropped on Color, which wires it.
 *
 * Nothing here is scripted per socket. The socket a frame rings is whatever
 * the canvas's own drag-connect planner (`planDragConnect`) picks for the
 * dragged node's position, run on geometry measured from the real node cards;
 * the positions the drag pauses at are found by sweeping that same planner, and
 * the drop lands where the canvas's snap puts a connected node. So when a node
 * is redesigned, or the planner changes its mind, the intro follows — the only
 * authored things are the ROUTE (which sockets to visit) and the timing.
 *
 * Pure and node-testable: ConnectScene measures and paints, this plans.
 */
import {
  CONNECT_SNAP_GAP,
  pickDropTargetNode,
  planDragConnect,
  type ConnectHandle,
  type DragConnectPlan,
  type NodeBox,
} from '@/components/NodeEditor/dragConnect';
import { momentAt, stepMiddle, stepStart, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

export type { Point };

/** What the scene measures, in stage px, with the dragged node at its START. */
export interface TourGeometry {
  /** The node dropped onto: its box and its input sockets (centres). */
  target: NodeBox;
  targetInputs: ConnectHandle[];
  /** Half a target socket's width — the snap anchors on socket EDGES. */
  targetSocketHalf: number;
  /** The dragged node's VISUAL box (cost scale included) and its output socket. */
  dragged: NodeBox;
  draggedOutput: ConnectHandle;
  draggedSocketHalf: number;
  /** Where the pointer takes hold of the dragged node — its header. */
  grab: Point;
}

/** One painted instant of the tour. */
export interface TourFrame {
  /** The dragged node's offset from its start. */
  dx: number;
  dy: number;
  cursor: Point;
  /** Pointer button down. */
  pressed: boolean;
  /** The dragged node is selected (a press selects it, and it stays so). */
  selected: boolean;
  /** The drag-connect preview: the socket a drop would wire right now. */
  plan: DragConnectPlan | null;
  /** The wire exists. */
  connected: boolean;
  /** Scene fade at the loop's two ends, 0–1. */
  opacity: number;
}

interface TourState {
  pressed: boolean;
  selected: boolean;
  /** Run the planner on this step's frames. */
  dragging: boolean;
  connected: boolean;
}

export interface Tour {
  geo: TourGeometry;
  tl: Timeline<TourState>;
  /** When the press ends and the drag begins. */
  dragFrom: number;
  /** The middle of each pause over a route socket, in route order — what the
   *  tests sample, and where a viewer reads the ringed socket's label. */
  holds: Array<{ t: number; socket: string }>;
  /** An instant of the connected hold — the still a reduced-motion viewer gets. */
  still: number;
}

/** Where inside the target, across its width, the dragged centre travels: left
 *  of centre, so the drop FEEDS the target (planDragConnect's 'feed-hover'),
 *  and only just past the edge — the target is lifted over the dragged node
 *  while it previews, so going deeper hides the very card being dragged. */
const INSIDE_FRAC = 0.1;
/** The pointer's idle spot relative to the grab point, before and after. */
const REST: Point = { x: -36, y: 84 };
const LEAVE: Point = { x: 56, y: 72 };

/** The planner's answer for the dragged node offset by (dx, dy) — null while
 *  its centre is outside the target, exactly as the canvas gates it. */
export function planAt(geo: TourGeometry, dx: number, dy: number): DragConnectPlan | null {
  const cx = geo.dragged.x + geo.dragged.w / 2 + dx;
  const cy = geo.dragged.y + geo.dragged.h / 2 + dy;
  if (pickDropTargetNode(cx, cy, [geo.target]) === null) return null;
  return planDragConnect(
    {
      draggedId: geo.dragged.id,
      hoverId: geo.target.id,
      draggedCenterX: cx,
      hoverCenterX: geo.target.x + geo.target.w / 2,
      draggedCenterY: cy,
      hoverTop: geo.target.y,
      hoverHeight: geo.target.h,
      draggedInputs: [],
      draggedOutputs: [{ ...geo.draggedOutput, cx: geo.draggedOutput.cx + dx, cy: geo.draggedOutput.cy + dy }],
      hoverInputs: geo.targetInputs,
      hoverOutputs: [],
    },
    [],
  );
}

/** The vertical offset at the middle of the longest band of drag positions
 *  over which the planner picks `socket` (null when no position does). */
function bandMiddle(geo: TourGeometry, dx: number, socket: string): number | null {
  const c0 = geo.dragged.y + geo.dragged.h / 2;
  let best: [number, number] | null = null;
  let runStart: number | null = null;
  const top = Math.ceil(geo.target.y);
  const bottom = Math.floor(geo.target.y + geo.target.h);
  for (let y = top; y <= bottom + 1; y++) {
    const hit = y <= bottom && planAt(geo, dx, y - c0)?.targetHandle === socket;
    if (hit && runStart === null) runStart = y;
    if (!hit && runStart !== null) {
      if (!best || y - 1 - runStart > best[1] - best[0]) best = [runStart, y - 1];
      runStart = null;
    }
  }
  return best ? (best[0] + best[1]) / 2 - c0 : null;
}

/** Plan the tour over `route`, or null when the planner never picks one of
 *  its sockets from inside the target (the scene then shows nothing moving). */
export function buildTour(geo: TourGeometry, route: readonly string[]): Tour | null {
  if (route.length === 0) return null;
  const c0x = geo.dragged.x + geo.dragged.w / 2;
  const dxIn = geo.target.x + geo.target.w * INSIDE_FRAC - c0x;
  // One pixel past the target's left edge: the preview appears on arrival.
  const dxEntry = geo.target.x + 1 - c0x;
  const dys: number[] = [];
  for (const socket of route) {
    const dy = bandMiddle(geo, dxIn, socket);
    if (dy === null) return null;
    dys.push(dy);
  }
  const last = route[route.length - 1];
  const landing = geo.targetInputs.find((h) => h.id === last);
  if (!landing) return null;

  const held = (dx: number, dy: number): Key => ({ dx, dy, x: geo.grab.x + dx, y: geo.grab.y + dy });
  const start: Key = { dx: 0, dy: 0, x: geo.grab.x + REST.x, y: geo.grab.y + REST.y };
  const release = held(dxIn, dys[dys.length - 1]);
  // NodeEditor's connectSnapOffset: the dragged node's output EDGE lands a
  // wire's length left of the input EDGE, level with it.
  const snap: Key = {
    dx: landing.cx - geo.targetSocketHalf - CONNECT_SNAP_GAP - (geo.draggedOutput.cx + geo.draggedSocketHalf),
    dy: landing.cy - geo.draggedOutput.cy,
    x: release.x,
    y: release.y,
  };

  const idle: TourState = { pressed: false, selected: false, dragging: false, connected: false };
  const press: TourState = { pressed: true, selected: true, dragging: false, connected: false };
  const drag: TourState = { pressed: true, selected: true, dragging: true, connected: false };
  const wired: TourState = { pressed: false, selected: true, dragging: false, connected: true };
  const steps: Step<TourState>[] = [
    { ms: 500, to: start, state: idle },
    { ms: 800, to: held(0, 0), state: idle },
    { ms: 220, to: held(0, 0), state: press },
    { ms: 1100, to: held(dxEntry, dys[0]), state: drag },
    { ms: 450, to: held(dxIn, dys[0]), state: drag },
  ];
  const holdAt: number[] = [];
  route.forEach((_, i) => {
    if (i > 0) steps.push({ ms: 650, to: held(dxIn, dys[i]), state: drag });
    holdAt.push(steps.length);
    steps.push({ ms: i === route.length - 1 ? 1000 : 750, to: held(dxIn, dys[i]), state: drag });
  });
  steps.push({ ms: 220, to: snap, state: wired });
  const stillAt = steps.length;
  steps.push({ ms: 2400, to: snap, state: wired });
  steps.push({ ms: 700, to: { ...snap, x: release.x + LEAVE.x, y: release.y + LEAVE.y }, state: wired });

  const tl = timeline(start, steps);
  return {
    geo,
    tl,
    dragFrom: stepStart(tl, 3),
    holds: holdAt.map((index, i) => ({ t: stepMiddle(tl, index), socket: route[i] })),
    still: stepMiddle(tl, stillAt),
  };
}

/** The tour at `t` ms (wrapped into the loop). */
export function tourFrame(tour: Tour, t: number): TourFrame {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return {
    dx: key.dx,
    dy: key.dy,
    cursor: { x: key.x, y: key.y },
    pressed: state.pressed,
    selected: state.selected,
    plan: state.dragging ? planAt(tour.geo, key.dx, key.dy) : null,
    connected: state.connected,
    opacity,
  };
}
