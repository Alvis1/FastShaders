/**
 * The intro's models slide as data: two models dropped onto the 3D view in
 * turn — Rodin's Thinker, then an animated figure — each shaded by the same
 * graph: the Vertex Wave preset moving the surface and the Checker preset
 * colouring it, its dark squares in the Metals palette's Iron (owner,
 * 2026-10-18). Each model carries its own numbers (`ShaderTune`): the sphere
 * the preview starts on keeps the Checker's UV projection; the two models get
 * a solid 3D checker over their geometry's positions (x, y AND z — a flat x/y
 * projection smears into a band where the surface turns edge-on), and the
 * figure, in its own much smaller units, a finer one with a faster, lower wave.
 *
 * Pure and node-testable, like the other tours. `combinePresets` builds the
 * graph from the two real built-in presets, wired into one Output the way a
 * press wires a preset (the asset's own `outputEdges`, utils/libraryAutoWire).
 */
import type { AppEdge, AppNode } from '@/types';
import { BUILTIN_PALETTES } from '@/registry/builtinPalettes';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { sceneNodes, toAppEdges } from './sceneGraph';
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

export const MODEL_OUTPUT = 'intro-output';
export const WAVE_PRESET = 'vertex-wave';
export const COLOR_PRESET = 'checker';
/** The Vertex Wave's height on Rodin and the sphere; each model carries its own below. */
export const WAVE_AMPLITUDE = 0.03;
export const AMPLITUDE_UNIFORM = 'waveAmplitude';
export const FREQUENCY_UNIFORM = 'waveFrequency';
export const COUNT_UNIFORM = 'count';

/** One shading's numbers. Absent ones keep the preset's own. */
export interface ShaderTune {
  amplitude: number;
  frequency?: number;
  count?: number;
  /** The Checker's projection: its own UVs, or a 3D checker over positions. */
  projection: 'uv' | 'position';
}

/** The sphere the view shows before anything is dropped. */
export const SPHERE_TUNE: ShaderTune = { amplitude: WAVE_AMPLITUDE, projection: 'uv' };
/** The Checker's dark square colour, recoloured. */
export const DARK_SQUARE_UNIFORM = 'checkColorB';

/** "Iron" from the built-in Metals palette — the swatch a user would pick in
 *  the colour picker, read from the palette so the two cannot drift. */
export function paletteColor(name: string): string | null {
  for (const p of BUILTIN_PALETTES) {
    const i = p.names?.indexOf(name) ?? -1;
    if (i >= 0) return p.colors[i];
  }
  return null;
}
export const IRON = paletteColor('Iron') ?? '#c5c7c8';

/** The two models, in drop order: the file the user would drag, where the
 *  app serves the slide's copy. */
export const INTRO_MODELS = [
  {
    key: 'rodin', fileName: 'rodin.glb', path: 'models/intro/rodin.glb',
    tune: { amplitude: WAVE_AMPLITUDE, projection: 'position' } as ShaderTune,
  },
  {
    key: 'figure', fileName: 'PoseableFigure_02.glb', path: 'models/intro/PoseableFigure_02.glb',
    tune: { amplitude: 0.001, frequency: 150, count: 16, projection: 'position' } as ShaderTune,
  },
] as const;
export type IntroModelKey = (typeof INTRO_MODELS)[number]['key'];

/** A built-in library entry as `getBuiltinPresets()` returns it. */
export interface PresetAsset {
  nodes: AppNode[];
  edges: AppEdge[];
  outputEdges: AppEdge[];
}

/**
 * Both presets on one canvas, each wired into the ONE Output by its own
 * `outputEdges` (Vertex Wave → Displacement, Checker → Color), its Property
 * nodes set from `tune` and the Checker's dark squares to `dark`. For the
 * 'position' projection the Checker reads `positionGeometry` where it read
 * `uv()` — the same Split takes x and y off it — and gains its third axis:
 * z × count, floored, added to the x + y sum before the mod 2, so the pattern
 * is cubes in the geometry's own space, independent of any model's UVs.
 */
export function combinePresets(
  wave: PresetAsset,
  field: PresetAsset,
  tune: ShaderTune = { amplitude: WAVE_AMPLITUDE, projection: 'position' },
  dark = IRON,
): { nodes: AppNode[]; edges: AppEdge[] } {
  const amplitude = tune.amplitude;
  const output = {
    id: MODEL_OUTPUT,
    type: 'output',
    position: { x: 0, y: 0 },
    data: { registryType: 'output', label: 'Output', cost: 0 },
  } as unknown as AppNode;
  const nodes = [...wave.nodes, ...field.nodes].map((n) => {
    const values = (n.data as { values?: Record<string, unknown> }).values;
    if (n.data.registryType === 'property_float' && values?.name === AMPLITUDE_UNIFORM) {
      return { ...n, data: { ...n.data, values: { ...values, value: amplitude } } } as AppNode;
    }
    if (n.data.registryType === 'property_float' && values?.name === FREQUENCY_UNIFORM && tune.frequency !== undefined) {
      return { ...n, data: { ...n.data, values: { ...values, value: tune.frequency } } } as AppNode;
    }
    if (n.data.registryType === 'property_float' && values?.name === COUNT_UNIFORM && tune.count !== undefined) {
      return { ...n, data: { ...n.data, values: { ...values, value: tune.count } } } as AppNode;
    }
    if (n.data.registryType === 'property_color' && values?.name === DARK_SQUARE_UNIFORM) {
      return { ...n, data: { ...n.data, values: { ...values, hex: dark } } } as AppNode;
    }
    if (tune.projection === 'position' && n.data.registryType === 'uv' && field.nodes.includes(n)) {
      return { ...n, data: { registryType: 'positionGeometry', label: 'Position', cost: n.data.cost, values: {} } } as unknown as AppNode;
    }
    return n;
  });
  const wires = [...wave.outputEdges, ...field.outputEdges].map(
    (e) => ({ ...e, id: `${e.source}->${MODEL_OUTPUT}:${e.targetHandle}`, target: MODEL_OUTPUT }) as AppEdge,
  );
  const { nodes: zNodes, edges: fieldEdges } =
    tune.projection === 'position' ? checkerThirdAxis(field) : { nodes: [], edges: field.edges };
  return { nodes: [...nodes, ...zNodes, output], edges: [...wave.edges, ...fieldEdges, ...wires] };
}

/** The Checker's z term: Split.z × count → floor → added to the x + y sum,
 *  which then feeds the mod in its place. The preset unchanged when its shape
 *  is not the one this expects. */
function checkerThirdAxis(field: PresetAsset): { nodes: AppNode[]; edges: AppEdge[] } {
  const type = (id: string) => field.nodes.find((n) => n.id === id)?.data.registryType;
  const split = field.nodes.find((n) => n.data.registryType === 'split');
  const count = field.nodes.find(
    (n) => n.data.registryType === 'property_float' && (n.data as { values?: { name?: unknown } }).values?.name === 'count',
  );
  const sumToMod = field.edges.find((e) => type(e.source) === 'add' && type(e.target) === 'mod');
  if (!split || !count || !sumToMod) return { nodes: [], edges: field.edges };
  const MUL = 'intro-checker-z-mul';
  const FLOOR = 'intro-checker-z-floor';
  const SUM = 'intro-checker-z-add';
  const nodes = sceneNodes([
    { id: MUL, def: NODE_REGISTRY.get('mul')! },
    { id: FLOOR, def: NODE_REGISTRY.get('floor')! },
    { id: SUM, def: NODE_REGISTRY.get('add')! },
  ]);
  const added = toAppEdges([
    { source: split.id, sourceHandle: 'z', target: MUL, targetHandle: 'a' },
    { source: count.id, sourceHandle: 'out', target: MUL, targetHandle: 'b' },
    { source: MUL, sourceHandle: 'out', target: FLOOR, targetHandle: 'x' },
    { source: sumToMod.source, sourceHandle: sumToMod.sourceHandle ?? 'out', target: SUM, targetHandle: 'a' },
    { source: FLOOR, sourceHandle: 'out', target: SUM, targetHandle: 'b' },
    { source: SUM, sourceHandle: 'out', target: sumToMod.target, targetHandle: sumToMod.targetHandle ?? 'x' },
  ]);
  return { nodes, edges: [...field.edges.filter((e) => e !== sumToMod), ...added] };
}

export interface ModelGeometry {
  /** Where each drag enters (beyond the stage's edge) and lands (the view). */
  enter: Point;
  drop: Point;
  /** "Only Mesh" in each model's question, or null when the real plan does
   *  not ask (the model then goes straight in, as a drop does). */
  onlyMesh: Record<IntroModelKey, Point | null>;
}

export interface ModelState {
  /** What the view shows: the preview's own sphere, then each model. */
  shown: 'sphere' | IntroModelKey;
  dragging: IntroModelKey | null;
  /** The model whose import question is open. */
  ask: IntroModelKey | null;
  pressed: boolean;
}

export interface ModelTour {
  geo: ModelGeometry;
  tl: Timeline<ModelState>;
  /** Stills: each model on the view. */
  rodin: number;
  figure: number;
}

export function buildModelTour(geo: ModelGeometry): ModelTour {
  const at = (p: Point): Key => ({ x: p.x, y: p.y });
  let cur: ModelState = { shown: 'sphere', dragging: null, ask: null, pressed: false };
  const steps: Step<ModelState>[] = [];
  const go = (ms: number, to: Point, patch: Partial<ModelState> = {}) => {
    cur = { ...cur, pressed: false, ...patch };
    steps.push({ ms, to: at(to), state: cur });
    return steps.length - 1;
  };
  const stills: Partial<Record<IntroModelKey, number>> = {};

  go(1800, geo.enter);
  for (const { key } of INTRO_MODELS) {
    go(450, geo.enter, { dragging: key, pressed: true });
    go(1400, geo.drop, { dragging: key, pressed: true });
    const btn = geo.onlyMesh[key];
    let last = geo.drop;
    if (btn) {
      go(900, geo.drop, { dragging: null, ask: key });
      go(700, btn, { ask: key });
      go(220, btn, { ask: key, pressed: true });
      last = btn;
    }
    stills[key] = go(key === 'figure' ? 7000 : 5200, last, { dragging: null, ask: null, shown: key });
    go(800, geo.enter);
  }

  const tl = timeline(at(geo.enter), steps);
  return { geo, tl, rodin: stepMiddle(tl, stills.rodin!), figure: stepMiddle(tl, stills.figure!) };
}

export function modelFrame(tour: ModelTour, t: number): { cursor: Point; state: ModelState; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, state, opacity };
}
