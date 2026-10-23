/**
 * Intro scene — click a wire and the chip on it says what the wire carries:
 * a number, a range, one line per channel, and live values when Time drives
 * it. Pure: the graph, the order the wires are clicked in, and the timeline.
 * The values themselves are the canvas's own (`evaluateEdgeRange` through
 * EdgeInfoCard's `edgeChipChannels`), worked out by the scene.
 */
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import type { AppEdge, AppNode } from '@/types';
import { sceneNodes, toAppEdges, type SceneEdge } from './sceneGraph';
import { momentAt, stepMiddle, timeline, type Key, type Point, type Step, type Timeline } from './timeline';

/** The Output's channels the scene wires, top to bottom as the card lists them. */
export const VALUES_OUTPUT_PORTS = ['color', 'emissive', 'roughness', 'metalness'] as const;

/** What Float holds — the wire carries exactly this number. */
export const VALUES_FLOAT = 0.5;

/**
 * The graph: Position (three channels, each a range) into Color, UV (two)
 * into Emissive, a Float (one number) into Roughness, and Time → Sine (one
 * live value) into Metalness.
 */
export function valuesGraph(): { nodes: AppNode[]; edges: AppEdge[] } {
  const reg = (type: string) => NODE_REGISTRY.get(type)!;
  const nodes = sceneNodes([
    { id: 'uv', def: reg('uv') },
    { id: 'position', def: reg('positionGeometry') },
    { id: 'float', def: reg('float') },
    { id: 'time', def: reg('time') },
    { id: 'sine', def: reg('sin') },
    { id: 'output', def: reg('output') },
  ]).map((n) => {
    if (n.id === 'float') return { ...n, data: { ...n.data, values: { value: VALUES_FLOAT } } } as AppNode;
    if (n.id === 'output') return { ...n, data: { ...n.data, exposedPorts: [...VALUES_OUTPUT_PORTS] } } as AppNode;
    return n;
  });
  const edges: SceneEdge[] = [
    { source: 'position', sourceHandle: 'out', target: 'output', targetHandle: 'color' },
    { source: 'uv', sourceHandle: 'out', target: 'output', targetHandle: 'emissive' },
    { source: 'float', sourceHandle: 'out', target: 'output', targetHandle: 'roughness' },
    { source: 'time', sourceHandle: 'out', target: 'sine', targetHandle: 'x' },
    { source: 'sine', sourceHandle: 'out', target: 'output', targetHandle: 'metalness' },
  ];
  return { nodes, edges: toAppEdges(edges) };
}

/** The wires shown, one at a time and in this order — a number, a range on
 *  two channels, three channels, then the live one — by the source node
 *  they leave. */
export const VALUES_CLICKS = ['float', 'uv', 'position', 'sine'] as const;
export type ValuesWire = (typeof VALUES_CLICKS)[number];

/** The nodes each phase shows: the wire's source (Sine with its Time) and
 *  the Output. */
export const PHASE_NODES: Record<ValuesWire, readonly string[]> = {
  float: ['float', 'output'],
  uv: ['uv', 'output'],
  position: ['position', 'output'],
  sine: ['time', 'sine', 'output'],
};

export interface ValuesState {
  /** The wire on show. */
  phase: ValuesWire;
  /** It has been clicked: thickened, its chip up. */
  selected: boolean;
  pressed: boolean;
}

export interface ValuesTour {
  tl: Timeline<ValuesState>;
  /** A still with each wire's chip up, by wire. */
  stills: Record<ValuesWire, number>;
}

/** The pointer's places: where each wire is clicked (off its middle, so the
 *  chip that opens there does not sit under the arrow), and where it waits. */
export interface ValuesGeometry {
  clicks: Record<ValuesWire, Point>;
  rest: Point;
}

/** How far the pointer backs off a wire it has clicked, so the chip reads. */
const BACK_OFF: Point = { x: -14, y: 26 };
const FADE_MS = 350;

/**
 * Each phase fades its pair in, clicks the wire, holds the chip (the live one
 * longest — its numbers keep moving) and fades out. `fade` is the phase's
 * opacity; the pointer drifts back to `rest` while a phase changes.
 */
export function buildValuesTour(geo: ValuesGeometry): ValuesTour {
  const at = (p: Point, fade: number): Key => ({ x: p.x, y: p.y, fade });
  const s = (phase: ValuesWire, selected = false, pressed = false): ValuesState => ({ phase, selected, pressed });
  const steps: Step<ValuesState>[] = [];
  const holdAt: Partial<Record<ValuesWire, number>> = {};
  for (const wire of VALUES_CLICKS) {
    const p = geo.clicks[wire];
    const off = { x: p.x + BACK_OFF.x, y: p.y + BACK_OFF.y };
    steps.push(
      { ms: FADE_MS, to: at(geo.rest, 1), state: s(wire) },
      { ms: 800, to: at(p, 1), state: s(wire) },
      { ms: 200, to: at(p, 1), state: s(wire, true, true) },
    );
    holdAt[wire] = steps.length;
    steps.push(
      { ms: wire === 'sine' ? 3600 : 2000, to: at(off, 1), state: s(wire, true) },
      { ms: FADE_MS, to: at(off, 0), state: s(wire, true) },
    );
  }
  const tl = timeline(at(geo.rest, 0), steps);
  const stills = Object.fromEntries(VALUES_CLICKS.map((w) => [w, stepMiddle(tl, holdAt[w]!)])) as Record<ValuesWire, number>;
  return { tl, stills };
}

export function valuesFrame(tour: ValuesTour, t: number): { cursor: Point; fade: number; state: ValuesState; opacity: number } {
  const { key, state, opacity } = momentAt(tour.tl, t);
  return { cursor: { x: key.x, y: key.y }, fade: key.fade, state, opacity };
}
