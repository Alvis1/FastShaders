/**
 * The intro's second scene as data: right-click a wire, Insert node, search
 * "round", pick Round — it lands on the wire — then select it and press Delete:
 * the node goes and the wire it sat on comes back.
 *
 * The WIRING is not scripted: which socket of the inserted node the wire lands
 * on is the canvas's own `pickSpliceInputPort`, and what a delete leaves is the
 * canvas's own `bridgeEdgesAcrossDeletedNodes` — so if either rule changes,
 * the scene shows the new behaviour (and `insertTour.test.ts` says so).
 *
 * Pure and node-testable, like connectTour.ts.
 */
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { pickSpliceInputPort } from '@/components/NodeEditor/edgeSplice';
import { bridgeEdgesAcrossDeletedNodes } from '@/utils/edgeUtils';
import type { NodeDefinition } from '@/types';
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';
import { toAppEdges, type SceneEdge } from './sceneGraph';

export const INSERT_SOURCE = 'intro-noise';
export const INSERT_TARGET = 'intro-output';
export const INSERTED = 'intro-round';
/** What the scene types into the node search. */
export const INSERT_QUERY = 'round';
export const insertedDef: NodeDefinition = NODE_REGISTRY.get('round')!;

/** The wire the scene starts with and right-clicks. */
export const ORIGINAL_EDGE: SceneEdge = {
  source: INSERT_SOURCE,
  sourceHandle: 'out',
  target: INSERT_TARGET,
  targetHandle: 'color',
};

export interface InsertWiring {
  before: SceneEdge[];
  spliced: SceneEdge[];
  afterDelete: SceneEdge[];
}

/** The three wirings the scene shows, each decided by the canvas's own rule. */
export function insertWiring(): InsertWiring {
  const port = pickSpliceInputPort(insertedDef, [], []) ?? insertedDef.inputs[0].id;
  const spliced: SceneEdge[] = [
    { source: ORIGINAL_EDGE.source, sourceHandle: ORIGINAL_EDGE.sourceHandle, target: INSERTED, targetHandle: port },
    { source: INSERTED, sourceHandle: insertedDef.outputs[0].id, target: ORIGINAL_EDGE.target, targetHandle: ORIGINAL_EDGE.targetHandle },
  ];
  const afterDelete = bridgeEdgesAcrossDeletedNodes(toAppEdges(spliced), new Set([INSERTED])).map((e) => ({
    source: e.source,
    sourceHandle: e.sourceHandle ?? 'out',
    target: e.target,
    targetHandle: e.targetHandle ?? 'in',
  }));
  return { before: [ORIGINAL_EDGE], spliced, afterDelete };
}

/** What the scene measures, in stage px. */
export interface InsertGeometry {
  /** Where the wire is right-clicked (its midpoint). */
  click: Point;
  /** The edge menu's "Insert node" row, and the search list's Round row. */
  insertRow: Point;
  roundRow: Point;
  /** The inserted node's header, where it is clicked to select it. */
  roundGrab: Point;
}

export type InsertNodeState = 'absent' | 'present' | 'selected' | 'deleted';

export interface InsertState {
  menu: 'none' | 'edge' | 'add';
  /** Characters of INSERT_QUERY typed so far. */
  typed: number;
  /** The menu row shown focused: the hovered one, or the search's first. */
  focus: 'insert' | 'first' | 'round' | null;
  node: InsertNodeState;
  rightClick: boolean;
  pressed: boolean;
  /** The Delete key is down. */
  key: boolean;
  /** The pointer rests on the wire (TypedEdge thickens a hovered wire). */
  wireHover: boolean;
}

export interface InsertTour {
  geo: InsertGeometry;
  tl: Timeline<InsertState>;
  /** Stills: the node on the wire, and the wire after the delete. */
  spliced: number;
  deleted: number;
}

const REST: Point = { x: 70, y: 90 };
const LEAVE: Point = { x: 60, y: 70 };
const TYPE_MS = 120;

export function buildInsertTour(geo: InsertGeometry): InsertTour {
  const at = (p: Point): Key => ({ x: p.x, y: p.y });
  const base: InsertState = {
    menu: 'none', typed: 0, focus: null, node: 'absent', rightClick: false, pressed: false, key: false, wireHover: false,
  };
  const s = (patch: Partial<InsertState>): InsertState => ({ ...base, ...patch });
  const rest = at({ x: geo.click.x + REST.x, y: geo.click.y + REST.y });
  const steps: Step<InsertState>[] = [
    { ms: 500, to: rest, state: s({}) },
    { ms: 900, to: at(geo.click), state: s({}) },
    { ms: 260, to: at(geo.click), state: s({ wireHover: true, rightClick: true }) },
    { ms: 380, to: at(geo.click), state: s({ wireHover: true, menu: 'edge' }) },
    { ms: 500, to: at(geo.insertRow), state: s({ wireHover: true, menu: 'edge' }) },
    { ms: 320, to: at(geo.insertRow), state: s({ wireHover: true, menu: 'edge', focus: 'insert', pressed: true }) },
    { ms: 260, to: at(geo.insertRow), state: s({ wireHover: true, menu: 'add' }) },
  ];
  for (let n = 1; n <= INSERT_QUERY.length; n++) {
    steps.push({ ms: TYPE_MS, to: at(geo.insertRow), state: s({ wireHover: true, menu: 'add', typed: n, focus: 'first' }) });
  }
  const typed = { menu: 'add' as const, typed: INSERT_QUERY.length, wireHover: true };
  steps.push(
    { ms: 450, to: at(geo.insertRow), state: s({ ...typed, focus: 'first' }) },
    { ms: 500, to: at(geo.roundRow), state: s({ ...typed, focus: 'first' }) },
    { ms: 320, to: at(geo.roundRow), state: s({ ...typed, focus: 'round', pressed: true }) },
  );
  const splicedAt = steps.length;
  steps.push(
    { ms: 1600, to: at(geo.roundRow), state: s({ node: 'present' }) },
    { ms: 700, to: at(geo.roundGrab), state: s({ node: 'present' }) },
    { ms: 220, to: at(geo.roundGrab), state: s({ node: 'selected', pressed: true }) },
    { ms: 500, to: at(geo.roundGrab), state: s({ node: 'selected' }) },
    { ms: 450, to: at(geo.roundGrab), state: s({ node: 'selected', key: true }) },
    { ms: 350, to: at(geo.roundGrab), state: s({ node: 'deleted', key: true }) },
  );
  const deletedAt = steps.length;
  steps.push(
    { ms: 2000, to: at(geo.roundGrab), state: s({ node: 'deleted' }) },
    { ms: 700, to: at({ x: geo.roundGrab.x + LEAVE.x, y: geo.roundGrab.y + LEAVE.y }), state: s({ node: 'deleted' }) },
  );
  const tl = timeline(rest, steps);
  return { geo, tl, spliced: stepMiddle(tl, splicedAt), deleted: stepMiddle(tl, deletedAt) };
}

export function insertFrame(tour: InsertTour, t: number): { cursor: Point; state: InsertState; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, state, opacity };
}

/** The wiring a state shows. */
export function wiringFor(node: InsertNodeState, wiring: InsertWiring): SceneEdge[] {
  if (node === 'absent') return wiring.before;
  if (node === 'deleted') return wiring.afterDelete;
  return wiring.spliced;
}
