/**
 * The intro's third scene as data: the right end of the Gas Giant texture
 * group beside an empty Output, under the cost bar. A wire dragged from the
 * group's LAST node into Color brings the whole chain into the point total,
 * which passes the device's budget.
 *
 * Nothing the app decides is scripted: the asset is the real built-in (loaded
 * on demand — building it needs the Babel chunk), its last node is the one its
 * own `return` names (`outputEdges`), and both totals are
 * `computeReachableCost` — the number the bar prints — on the graph before and
 * after that wire. If the texture is ever made cheaper than the budget, the
 * scene shows that and `budgetTour.test.ts` says so.
 *
 * Pure and node-testable, like connectTour.ts.
 */
import type { AppEdge, AppNode } from '@/types';
import { computeReachableCost } from '@/utils/nodeCost';
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';
import type { SceneEdge } from './sceneGraph';

export const BUDGET_TEXTURE = 'gas-giant';
export const BUDGET_OUTPUT = 'intro-output';

/** A built-in library entry as `getBuiltinTextures()` returns it. */
export interface BudgetAsset {
  nodes: AppNode[];
  edges: AppEdge[];
  outputEdges: AppEdge[];
}

export interface BudgetGraph {
  /** The group container, then its members (positions parent-relative). */
  frame: AppNode;
  members: AppNode[];
  /** The group's own wires. */
  edges: AppEdge[];
  /** The wire the scene draws: the last node into the Output's Color. */
  wire: SceneEdge;
  /** The whole graph once that wire exists (the Output included) — what the
   *  wired values and the channel counts are read from. */
  nodesAfter: AppNode[];
  edgesAfter: AppEdge[];
  /** The point total with the group unwired, and with the wire. */
  before: number;
  after: number;
}

/** The Output a fresh drop builds. */
function freshOutput(): AppNode {
  return {
    id: BUDGET_OUTPUT,
    type: 'output',
    position: { x: 0, y: 0 },
    data: { registryType: 'output', label: 'Output', cost: 0 },
  } as unknown as AppNode;
}

export function budgetGraph(asset: BudgetAsset): BudgetGraph | null {
  const [frame, ...members] = asset.nodes;
  const into = asset.outputEdges.find((e) => e.targetHandle === 'color');
  if (!frame || frame.type !== 'group' || !into) return null;
  const wire: SceneEdge = {
    source: into.source,
    sourceHandle: into.sourceHandle ?? 'out',
    target: BUDGET_OUTPUT,
    targetHandle: 'color',
  };
  const nodes = [...asset.nodes, freshOutput()];
  const wired = {
    ...into,
    id: `${wire.source}->${BUDGET_OUTPUT}`,
    target: BUDGET_OUTPUT,
    targetHandle: 'color',
  } as AppEdge;
  const edgesAfter = [...asset.edges, wired];
  return {
    frame,
    members,
    edges: asset.edges,
    wire,
    nodesAfter: nodes,
    edgesAfter,
    before: computeReachableCost(nodes, asset.edges),
    after: computeReachableCost(nodes, edgesAfter),
  };
}

/** Wider than any member card: a member whose top-left lies this far left of
 *  the stage may still reach into it. */
const MEMBER_REACH = 240;

/**
 * The members the stage draws, with the frame's top-left at `frameAt`: every
 * one that can reach into the `w × h` stage, plus the sources of the wires
 * arriving at those (their sockets anchor the wires that enter from the left
 * edge). The rest of the group is off stage and never mounted.
 */
export function drawnMembers(graph: BudgetGraph, frameAt: Point, w: number, h: number): AppNode[] {
  const reaches = (n: AppNode) => {
    const x = frameAt.x + n.position.x;
    const y = frameAt.y + n.position.y;
    return x > -MEMBER_REACH && x < w && y > -MEMBER_REACH && y < h;
  };
  const shown = new Set(graph.members.filter(reaches).map((n) => n.id));
  for (const e of graph.edges) if (shown.has(e.target)) shown.add(e.source);
  return graph.members.filter((n) => shown.has(n.id));
}

/** What the scene measures, in stage px. */
export interface BudgetGeometry {
  /** The last node's output socket (its outer edge) and the Output's Color
   *  socket (its inner edge) — where the drag starts and lands. */
  from: Point;
  to: Point;
  /** The cost bar's total, where the pointer goes to show it. */
  total: Point;
}

export interface BudgetState {
  /** A connection is being dragged: the line follows the pointer. */
  dragging: boolean;
  /** The wire exists: the total counts the group. */
  connected: boolean;
  pressed: boolean;
}

export interface BudgetTour {
  geo: BudgetGeometry;
  tl: Timeline<BudgetState>;
  /** A still: wired, the pointer on the over-budget total. */
  still: number;
}

const REST: Point = { x: -90, y: 70 };
const LEAVE: Point = { x: -50, y: 60 };

export function buildBudgetTour(geo: BudgetGeometry): BudgetTour {
  const at = (p: Point): Key => ({ x: p.x, y: p.y });
  const s = (patch: Partial<BudgetState>): BudgetState => ({ dragging: false, connected: false, pressed: false, ...patch });
  const rest = at({ x: geo.from.x + REST.x, y: geo.from.y + REST.y });
  const steps: Step<BudgetState>[] = [
    { ms: 600, to: rest, state: s({}) },
    { ms: 900, to: at(geo.from), state: s({}) },
    { ms: 250, to: at(geo.from), state: s({ pressed: true }) },
    { ms: 1200, to: at(geo.to), state: s({ pressed: true, dragging: true }) },
    { ms: 250, to: at(geo.to), state: s({ pressed: true, dragging: true }) },
    { ms: 900, to: at(geo.to), state: s({ connected: true }) },
    { ms: 900, to: at(geo.total), state: s({ connected: true }) },
  ];
  const stillAt = steps.length;
  steps.push(
    { ms: 2600, to: at(geo.total), state: s({ connected: true }) },
    { ms: 700, to: at({ x: geo.total.x + LEAVE.x, y: geo.total.y + LEAVE.y }), state: s({ connected: true }) },
  );
  const tl = timeline(rest, steps);
  return { geo, tl, still: stepMiddle(tl, stillAt) };
}

export function budgetFrame(tour: BudgetTour, t: number): { cursor: Point; state: BudgetState; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, state, opacity };
}
