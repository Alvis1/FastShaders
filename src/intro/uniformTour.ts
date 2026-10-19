/**
 * The intro's uniforms slide as data: a Property node is a UNIFORM — the 3D
 * view lists it with a slider, dragging it changes the running shader at once
 * (no recompile, the node keeps its number), and "Set as default" writes the
 * tuned value back into the node.
 *
 * Pure and node-testable, like the other tours.
 */
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

/** The Property node's name and its number in the graph. */
export const UNIFORM_NAME = 'scale';
export const UNIFORM_START = 5;
/** Where the drag goes: down to coarse, then up to fine, in slider steps. */
export const UNIFORM_LOW = 1;
export const UNIFORM_HIGH = 9;
const STEP = 0.5;
const STEP_MS = 110;

export interface UniformGeometry {
  /** The slider track's ends (stage px) and the numbers they stand for. */
  track: { x0: number; x1: number; y: number };
  bounds: { min: number; max: number };
  /** "Set as default". */
  setDefault: Point;
}

export interface UniformState {
  /** The value the preview runs. */
  value: number;
  /** "Set as default" has written it into the node. */
  baked: boolean;
  pressed: boolean;
}

export interface UniformTour {
  geo: UniformGeometry;
  tl: Timeline<UniformState>;
  /** Stills: tuned (an override), baked. */
  tuned: number;
  baked: number;
}

/** Where the slider's thumb sits for `v`. */
export function thumbAt(geo: UniformGeometry, v: number): Point {
  const { x0, x1, y } = geo.track;
  const { min, max } = geo.bounds;
  const u = max > min ? (v - min) / (max - min) : 0;
  return { x: x0 + (x1 - x0) * Math.max(0, Math.min(1, u)), y };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export function buildUniformTour(geo: UniformGeometry): UniformTour {
  const at = (p: Point): Key => ({ x: p.x, y: p.y });
  let cur: UniformState = { value: UNIFORM_START, baked: false, pressed: false };
  const steps: Step<UniformState>[] = [];
  const go = (ms: number, to: Point, patch: Partial<UniformState> = {}) => {
    cur = { ...cur, pressed: false, ...patch };
    steps.push({ ms, to: at(to), state: cur });
    return steps.length - 1;
  };
  const rest = { x: geo.track.x0 - 90, y: geo.track.y + 120 };

  go(1400, rest);
  go(900, thumbAt(geo, UNIFORM_START));
  go(200, thumbAt(geo, UNIFORM_START), { pressed: true });
  // Down to coarse…
  for (let v = UNIFORM_START - STEP; v >= UNIFORM_LOW - 1e-9; v -= STEP) {
    go(STEP_MS, thumbAt(geo, v), { pressed: true, value: round(v) });
  }
  go(500, thumbAt(geo, UNIFORM_LOW), { pressed: true });
  // …and up to fine.
  for (let v = UNIFORM_LOW + STEP; v <= UNIFORM_HIGH + 1e-9; v += STEP) {
    go(STEP_MS, thumbAt(geo, v), { pressed: true, value: round(v) });
  }
  const tunedAt = go(1600, thumbAt(geo, UNIFORM_HIGH));
  go(800, geo.setDefault);
  go(220, geo.setDefault, { pressed: true });
  const bakedAt = go(3000, geo.setDefault, { baked: true });
  go(700, { x: geo.setDefault.x - 70, y: geo.setDefault.y + 120 });

  const tl = timeline(at(rest), steps);
  return { geo, tl, tuned: stepMiddle(tl, tunedAt), baked: stepMiddle(tl, bakedAt) };
}

export function uniformFrame(tour: UniformTour, t: number): { cursor: Point; state: UniformState; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, state, opacity };
}
