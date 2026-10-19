/**
 * The intro's Organize slide as data: a graph left in a heap — nine nodes
 * piled over each other, wires crossing every which way — is marquee-selected,
 * right-clicked, and Selection → Organize lays it out.
 *
 * Pure and node-testable, like the other tours. Where each node ends up is not
 * written here: `organizedPositions` asks the canvas's own Organize
 * (`organizeLayout`, which the store's `organizeSelection` applies) with each
 * card's measured box, so the slide shows exactly what the menu row does. The
 * nodes glide there over one step so the eye can follow them; the canvas moves
 * them at once.
 */
import type { AppNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { organizeLayout } from '@/engine/layoutEngine';
import { sceneNodes, toAppEdges, type SceneEdge } from './sceneGraph';
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

/** The heap's nodes, in drawing order (a later one lies over an earlier). */
export const ORGANIZE_NODES = [
  { id: 'o-output', type: 'output' },
  { id: 'o-add', type: 'add' },
  { id: 'o-noise', type: 'perlin' },
  { id: 'o-sin', type: 'sin' },
  { id: 'o-one-minus', type: 'oneMinus' },
  { id: 'o-time', type: 'time' },
  { id: 'o-mul', type: 'mul' },
  { id: 'o-fbm', type: 'fbm' },
  { id: 'o-cos', type: 'cos' },
] as const;

export const ORGANIZE_EDGES: readonly SceneEdge[] = [
  { source: 'o-time', sourceHandle: 'out', target: 'o-sin', targetHandle: 'x' },
  { source: 'o-time', sourceHandle: 'out', target: 'o-cos', targetHandle: 'x' },
  { source: 'o-noise', sourceHandle: 'out', target: 'o-mul', targetHandle: 'a' },
  { source: 'o-sin', sourceHandle: 'out', target: 'o-mul', targetHandle: 'b' },
  { source: 'o-mul', sourceHandle: 'out', target: 'o-add', targetHandle: 'a' },
  { source: 'o-cos', sourceHandle: 'out', target: 'o-add', targetHandle: 'b' },
  { source: 'o-add', sourceHandle: 'out', target: 'o-output', targetHandle: 'color' },
  { source: 'o-fbm', sourceHandle: 'out', target: 'o-one-minus', targetHandle: 'x' },
  { source: 'o-one-minus', sourceHandle: 'out', target: 'o-output', targetHandle: 'roughness' },
];

/** The heap, in flow px: every node dropped wherever it landed — overlapping,
 *  feeders right of what they feed, the Output in the middle of it all. */
export const CHAOS: Readonly<Record<string, Point>> = {
  'o-output': { x: 240, y: 40 },
  'o-add': { x: 330, y: 170 },
  'o-noise': { x: 520, y: 10 },
  'o-sin': { x: 90, y: 190 },
  'o-one-minus': { x: 20, y: 30 },
  'o-time': { x: 600, y: 180 },
  'o-mul': { x: 380, y: 215 },
  'o-fbm': { x: 430, y: 0 },
  'o-cos': { x: 150, y: 90 },
};

export const organizeDefs = () =>
  ORGANIZE_NODES.map(({ id, type }) => ({ id, def: NODE_REGISTRY.get(type)! }));

/** The heap as the canvas holds it: fresh nodes at their heap positions. */
export function organizeGraph() {
  const nodes = sceneNodes(organizeDefs()).map((n) => ({ ...n, position: { ...CHAOS[n.id] } }) as AppNode);
  return { nodes, edges: toAppEdges(ORGANIZE_EDGES) };
}

export interface Size {
  width: number;
  height: number;
}

/** Where Organize puts each node, given every card's measured box (flow px):
 *  the canvas's own `organizeLayout` over the whole heap, selected. */
export function organizedPositions(sizes: ReadonlyMap<string, Size>): Map<string, Point> | null {
  const { nodes, edges } = organizeGraph();
  const selected = nodes.map((n) => ({ ...n, selected: true, measured: sizes.get(n.id) }) as AppNode);
  return organizeLayout(selected, edges);
}

/** A React Flow Partial marquee: every node whose box the rectangle touches. */
export function marqueeHits(
  a: Point,
  b: Point,
  boxes: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number }>,
): Set<string> {
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const y2 = Math.max(a.y, b.y);
  return new Set(boxes.filter((n) => n.x < x2 && n.x + n.w > x1 && n.y < y2 && n.y + n.h > y1).map((n) => n.id));
}

export interface OrganizeGeometry {
  /** The marquee's two corners (stage px), bare canvas at both ends. */
  marqueeFrom: Point;
  marqueeTo: Point;
  /** Where the selection is right-clicked, and the menu's Organize row. */
  menuClick: Point;
  organizeRow: Point;
  /** Each node's place in the heap and once organized (flow px). */
  chaos: ReadonlyMap<string, Point>;
  organized: ReadonlyMap<string, Point>;
}

export interface OrganizeState {
  /** The marquee is being dragged (from `marqueeFrom` to the pointer). */
  marquee: boolean;
  /** The nodes are selected (the marquee was released). */
  selected: boolean;
  /** The canvas menu is open — its first row, Organize, focused as the
   *  menu opens it (AddNodeMenu's focus starts on row 0). */
  menu: boolean;
  /** Organize was pressed: the nodes are on their way, or there. */
  organized: boolean;
  rightClick: boolean;
  pressed: boolean;
}

export interface OrganizeTour {
  geo: OrganizeGeometry;
  tl: Timeline<OrganizeState>;
  /** Stills: the heap selected with the menu open; the organized graph. */
  menu: number;
  organized: number;
}

const REST: Point = { x: 500, y: 280 };
export const GLIDE_MS = 900;

export const nodeKey = (id: string, axis: 'x' | 'y') => `${axis}:${id}`;

/** A node's place at a moment of the tour (flow px). */
export function nodeAt(key: Readonly<Record<string, number>>, id: string): Point {
  return { x: key[nodeKey(id, 'x')], y: key[nodeKey(id, 'y')] };
}

export function buildOrganizeTour(geo: OrganizeGeometry): OrganizeTour {
  const place = (at: ReadonlyMap<string, Point>) => {
    const k: Record<string, number> = {};
    for (const [id, p] of at) {
      k[nodeKey(id, 'x')] = p.x;
      k[nodeKey(id, 'y')] = p.y;
    }
    return k;
  };
  let nodes = place(geo.chaos);
  let cur: OrganizeState = {
    marquee: false, selected: false, menu: false, organized: false, rightClick: false, pressed: false,
  };
  const steps: Step<OrganizeState>[] = [];
  const go = (ms: number, to: Point, patch: Partial<OrganizeState> = {}) => {
    cur = { ...cur, pressed: false, rightClick: false, ...patch };
    steps.push({ ms, to: { x: to.x, y: to.y, ...nodes }, state: cur });
    return steps.length - 1;
  };

  go(1800, REST);
  go(800, geo.marqueeFrom);
  go(200, geo.marqueeFrom, { pressed: true, marquee: true });
  go(1300, geo.marqueeTo, { pressed: true, marquee: true });
  go(400, geo.marqueeTo, { marquee: false, selected: true });
  go(700, geo.menuClick);
  go(260, geo.menuClick, { rightClick: true });
  const menuAt = go(700, geo.menuClick, { menu: true });
  go(650, geo.organizeRow, { menu: true });
  go(300, geo.organizeRow, { menu: true });
  go(220, geo.organizeRow, { menu: true, pressed: true });
  nodes = place(geo.organized);
  go(GLIDE_MS, geo.organizeRow, { menu: false, organized: true });
  const organizedAt = go(3400, geo.organizeRow);
  go(700, REST);

  const tl = timeline({ x: REST.x, y: REST.y, ...place(geo.chaos) } as Key, steps);
  return { geo, tl, menu: stepMiddle(tl, menuAt), organized: stepMiddle(tl, organizedAt) };
}

export function organizeFrame(
  tour: OrganizeTour,
  t: number,
): { cursor: Point; state: OrganizeState; key: Record<string, number>; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, state, key, opacity };
}
