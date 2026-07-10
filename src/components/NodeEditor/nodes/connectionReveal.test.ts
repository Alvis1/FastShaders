import { describe, it, expect } from 'vitest';
import type { ReactFlowState } from '@xyflow/react';
import { makeConnectionRevealSelector, CONNECTION_REVEAL_RADIUS } from './connectionReveal';

// Node box in FLOW coords: (100,100) sized 60×40. The selector receives the
// connection endpoint in SCREEN/pane pixels and must convert it to flow via the
// viewport transform before measuring proximity — the coordinate-space bug that
// made the reveal never fire (screen point compared to a flow box).
const NODE = { x: 100, y: 100, w: 60, h: 40 };
const R = CONNECTION_REVEAL_RADIUS;

/** Screen point that lands on flow point (fx, fy) under transform [vx,vy,scale]. */
function screenFor(fx: number, fy: number, [vx, vy, scale]: [number, number, number]) {
  return { x: fx * scale + vx, y: fy * scale + vy };
}

function state(opts: {
  to?: { x: number; y: number } | null;
  transform?: [number, number, number];
  fromType?: 'source' | 'target';
  fromNodeId?: string;
  hasNode?: boolean;
}): ReactFlowState {
  const { to = null, transform = [0, 0, 1], fromType = 'source', fromNodeId = 'src', hasNode = true } = opts;
  const connection = to
    ? { inProgress: true, fromHandle: { type: fromType }, fromNode: { id: fromNodeId }, to }
    : { inProgress: false };
  const nodeLookup = new Map(
    hasNode
      ? [['n1', { internals: { positionAbsolute: { x: NODE.x, y: NODE.y } }, measured: { width: NODE.w, height: NODE.h } }]]
      : [],
  );
  return { connection, transform, nodeLookup } as unknown as ReactFlowState;
}

describe('makeConnectionRevealSelector', () => {
  const sel = makeConnectionRevealSelector('n1', true);

  it('is false when disabled', () => {
    expect(makeConnectionRevealSelector('n1', false)(state({ to: { x: 110, y: 110 } }))).toBe(false);
  });

  it('is false when no connection is in progress', () => {
    expect(sel(state({ to: null }))).toBe(false);
  });

  it('is false when dragging from a target handle (not an output)', () => {
    expect(sel(state({ to: { x: 110, y: 110 }, fromType: 'target' }))).toBe(false);
  });

  it('is false on the node the drag started from (no self-wiring)', () => {
    expect(sel(state({ to: { x: 110, y: 110 }, fromNodeId: 'n1' }))).toBe(false);
  });

  it('is false when the node has not been measured/registered', () => {
    expect(sel(state({ to: { x: 110, y: 110 }, hasNode: false }))).toBe(false);
  });

  it('reveals when the endpoint is inside the box (identity transform)', () => {
    expect(sel(state({ to: { x: 120, y: 115 } }))).toBe(true); // inside 100..160 / 100..140
  });

  it('reveals just within the radius and hides just beyond it', () => {
    // right edge is x=160; just inside the radius reveals, just beyond hides.
    expect(sel(state({ to: { x: 160 + R - 5, y: 120 } }))).toBe(true);
    expect(sel(state({ to: { x: 160 + R + 5, y: 120 } }))).toBe(false);
  });

  it('converts the screen endpoint through pan+zoom before measuring (the fix)', () => {
    const t: [number, number, number] = [50, 20, 2];
    // A screen point that maps to flow (120,115) — inside the box.
    const inside = screenFor(120, 115, t);
    expect(sel(state({ to: inside, transform: t }))).toBe(true);
    // WITHOUT converting, that same raw screen point would read as far away:
    expect(sel(state({ to: inside, transform: [0, 0, 1] }))).toBe(false);
  });
});
