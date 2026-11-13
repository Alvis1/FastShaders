/**
 * The intro's last scene as data: one model with many meshes, two Outputs.
 * The first Output (the surface Normal into Color) shades every mesh; the second
 * (a Color) shades nothing until its mesh list is opened and two meshes are
 * ticked — those two turn its colour on the 3D view, the rest keep the first.
 *
 * The graph is the canvas's own shape (one Output node = one material, a
 * targeted one carrying `meshTargets`), so what the view shows is
 * `graphToCode`'s `parts` emission running in the real preview document, and
 * the mesh names are the ones that document REPORTS for the model
 * (`fs:model-meshes`) — never a list written here.
 *
 * Pure and node-testable, like the other tours.
 */
import type { AppEdge, AppNode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { sceneNodes, toAppEdges, type SceneEdge } from './sceneGraph';
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

export const MESHES_MODEL = { fileName: 'PoseableFigure_02.glb', path: 'models/intro/PoseableFigure_02.glb' } as const;

export const MESHES_FIELD = 'intro-normal';
export const MESHES_COLOR = 'intro-color';
export const MESHES_OUT_ALL = 'intro-output-all';
export const MESHES_OUT_PART = 'intro-output-part';

export const MESHES_EDGES: SceneEdge[] = [
  { source: MESHES_FIELD, sourceHandle: 'out', target: MESHES_OUT_ALL, targetHandle: 'color' },
  { source: MESHES_COLOR, sourceHandle: 'out', target: MESHES_OUT_PART, targetHandle: 'color' },
];

/** The two meshes the scene ticks, in tick order: the figure's upper and
 *  lower body when the model reports them, else its first two meshes. */
export function meshPicks(names: readonly string[]): [string, string] | null {
  if (names.length < 2) return null;
  const up = names.find((n) => /body.?up/i.test(n));
  const down = names.find((n) => /body.?down/i.test(n));
  return up && down && up !== down ? [up, down] : [names[0], names[1]];
}

/** The meshes the second Output names after `ticked` ticks — in the model's
 *  own order, as the picker writes them (MeshTargetPicker's `toggle`). */
export function targetsAfter(names: readonly string[], picks: readonly string[], ticked: number): string[] {
  const on = new Set(picks.slice(0, ticked));
  return names.filter((n) => on.has(n));
}

/** The scene's graph with the second Output naming `targets` (none = an
 *  untargeted Output beside the first, which the first outranks). */
export function meshesGraph(targets: readonly string[]): { nodes: AppNode[]; edges: AppEdge[] } {
  const nodes = sceneNodes([
    { id: MESHES_FIELD, def: NODE_REGISTRY.get('normalLocal')! },
    { id: MESHES_OUT_ALL, def: NODE_REGISTRY.get('output')! },
    { id: MESHES_COLOR, def: NODE_REGISTRY.get('color')! },
    { id: MESHES_OUT_PART, def: NODE_REGISTRY.get('output')! },
  ]).map((n) =>
    n.id === MESHES_OUT_PART && targets.length
      ? ({ ...n, data: { ...n.data, meshTargets: [...targets] } } as AppNode)
      : n,
  );
  return { nodes, edges: toAppEdges(MESHES_EDGES) };
}

export interface MeshesGeometry {
  /** The second Output's mesh picker, the two rows ticked, and a spot of
   *  empty canvas whose click closes the list. */
  picker: Point;
  rows: [Point, Point];
  away: Point;
}

export interface MeshesState {
  /** The mesh list is open. */
  open: boolean;
  /** How many of the two picks are ticked. */
  ticked: 0 | 1 | 2;
  pressed: boolean;
}

export interface MeshesTour {
  geo: MeshesGeometry;
  tl: Timeline<MeshesState>;
  /** Stills: nothing ticked, and both ticked with the list closed. */
  before: number;
  after: number;
}

const REST: Point = { x: 40, y: 260 };

export function buildMeshesTour(geo: MeshesGeometry): MeshesTour {
  const at = (p: Point): Key => ({ x: p.x, y: p.y });
  let cur: MeshesState = { open: false, ticked: 0, pressed: false };
  const steps: Step<MeshesState>[] = [];
  const go = (ms: number, to: Point, patch: Partial<MeshesState> = {}) => {
    cur = { ...cur, pressed: false, ...patch };
    steps.push({ ms, to: at(to), state: cur });
    return steps.length - 1;
  };
  const before = go(2600, REST);
  go(900, geo.picker);
  go(220, geo.picker, { pressed: true });
  go(500, geo.picker, { open: true });
  go(650, geo.rows[0]);
  go(220, geo.rows[0], { ticked: 1, pressed: true });
  go(1600, geo.rows[0]);
  go(500, geo.rows[1]);
  go(220, geo.rows[1], { ticked: 2, pressed: true });
  go(1200, geo.rows[1]);
  go(800, geo.away);
  go(220, geo.away, { open: false, pressed: true });
  const after = go(4200, geo.away);
  go(800, REST);
  const tl = timeline(at(REST), steps);
  return { geo, tl, before: stepMiddle(tl, before), after: stepMiddle(tl, after) };
}

export function meshesFrame(tour: MeshesTour, t: number): { cursor: Point; state: MeshesState; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, state, opacity };
}
