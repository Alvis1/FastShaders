import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONNECT_SNAP_GAP } from '@/components/NodeEditor/dragConnect';
import { buildTour, planAt, tourFrame, type Tour, type TourGeometry } from './connectTour';

/** An Output-shaped target (Color, Emissive, Roughness, then Displacement in
 *  its own section) and a Noise-shaped dragged node to its left, roughly as
 *  the real cards measure. */
function geometry(rowPitch = 22): TourGeometry {
  const top = 92;
  return {
    target: { id: 'out', x: 330, y: 44, w: 150, h: 190 },
    targetInputs: [
      { id: 'color', cx: 330, cy: top, occupied: false },
      { id: 'emissive', cx: 330, cy: top + rowPitch, occupied: false },
      { id: 'roughness', cx: 330, cy: top + 2 * rowPitch, occupied: false },
      { id: 'position', cx: 330, cy: 210, occupied: false },
    ],
    targetSocketHalf: 5,
    dragged: { id: 'noise', x: 44, y: 118, w: 120, h: 140 },
    draggedOutput: { id: 'out', cx: 164, cy: 188 },
    draggedSocketHalf: 5,
    grab: { x: 104, y: 128 },
  };
}

const ROUTE = ['roughness', 'emissive', 'color'];

function tour(geo = geometry()): Tour {
  const built = buildTour(geo, ROUTE);
  if (!built) throw new Error('tour not built');
  return built;
}

/** The distinct sockets the preview rings over one loop, in order. */
function ringedSequence(t: Tour): string[] {
  const seen: string[] = [];
  for (let ms = 0; ms < t.tl.total; ms += 5) {
    const socket = tourFrame(t, ms).plan?.targetHandle;
    if (socket && seen[seen.length - 1] !== socket) seen.push(socket);
  }
  return seen;
}

describe('intro scene 1: the drag-connect tour', () => {
  it('pauses over Roughness, then Emissive, then Color — as the canvas planner picks them', () => {
    const t = tour();
    expect(t.holds.map((h) => h.socket)).toEqual(ROUTE);
    for (const hold of t.holds) {
      const plan = tourFrame(t, hold.t).plan;
      expect(plan?.targetHandle, hold.socket).toBe(hold.socket);
      // Dragged from the LEFT, so the dragged node feeds the Output.
      expect(plan?.mode).toBe('feed-hover');
      expect(plan?.source).toBe('noise');
      expect(plan?.target).toBe('out');
    }
  });

  it('rings exactly the route over a whole loop — no flicker onto another socket', () => {
    expect(ringedSequence(tour())).toEqual(ROUTE);
  });

  it('shows no preview until the dragged centre is inside the Output, as on the canvas', () => {
    const t = tour();
    const f = tourFrame(t, t.dragFrom + 10);
    expect(f.pressed).toBe(true);
    expect(f.plan).toBeNull();
  });

  it('follows the design: re-spaced sockets are still found, because the stops are planned, not authored', () => {
    expect(ringedSequence(tour(geometry(34)))).toEqual(ROUTE);
    expect(ringedSequence(tour(geometry(16)))).toEqual(ROUTE);
  });

  it('drops where the canvas snaps a connected node: a wire length left of Color, level with it', () => {
    const t = tour();
    const f = tourFrame(t, t.still);
    expect(f.connected).toBe(true);
    expect(f.pressed).toBe(false);
    expect(f.plan).toBeNull();
    const geo = t.geo;
    const color = geo.targetInputs.find((h) => h.id === 'color')!;
    const outRight = geo.draggedOutput.cx + geo.draggedSocketHalf + f.dx;
    expect(color.cx - geo.targetSocketHalf - outRight).toBeCloseTo(CONNECT_SNAP_GAP, 6);
    expect(geo.draggedOutput.cy + f.dy).toBeCloseTo(color.cy, 6);
  });

  it('fades in and out at the loop seam and is fully shown in between', () => {
    const t = tour();
    expect(tourFrame(t, 0).opacity).toBe(0);
    expect(tourFrame(t, t.holds[0].t).opacity).toBe(1);
    expect(tourFrame(t, t.tl.total - 1).opacity).toBeLessThan(0.01);
  });

  it('builds nothing for a socket the planner can never pick', () => {
    expect(buildTour(geometry(), ['roughness', 'metalness'])).toBeNull();
    expect(buildTour(geometry(), [])).toBeNull();
  });

  it('planAt is the canvas gate: outside the Output there is no plan', () => {
    expect(planAt(geometry(), 0, 0)).toBeNull();
  });
});

describe('intro scene 1 never touches the graph', () => {
  // GraphModal shows a graph by writing it INTO the store — safe only on
  // node-editor.html, whose autosave is off. In the app, the 300 ms autosave
  // would write the intro's two nodes over the user's work.
  it('ConnectScene reads preferences only', () => {
    const src = readFileSync(path.join(__dirname, 'ConnectScene.tsx'), 'utf8');
    for (const banned of ['setNodes', 'setEdges', 'getState()', 'pushHistory', 'addNode']) {
      expect(src, banned).not.toContain(banned);
    }
  });
});
