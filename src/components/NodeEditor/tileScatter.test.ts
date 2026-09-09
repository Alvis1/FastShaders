import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  nextTileScatter,
  resetTileScatter,
  SCATTER_MIN_PX,
  SCATTER_MAX_PX,
} from './tileDrag';

const SRC = readFileSync(new URL('./tileDrag.ts', import.meta.url), 'utf8');

const len = (p: { dx: number; dy: number }) => Math.hypot(p.dx, p.dy);
const gap = (a: { dx: number; dy: number }, b: { dx: number; dy: number }) =>
  Math.hypot(a.dx - b.dx, a.dy - b.dy);

/** Deterministic stand-in for Math.random — cycles the given values. */
const seeded = (...vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

// The angle is MODULE state (one visual sequence for the app), and the suite
// runs with `isolate: false`, so a leftover angle from an earlier test would
// decide this one's first step.
beforeEach(() => resetTileScatter());

describe('nextTileScatter', () => {
  it('always lands in the ring, never on the centre', () => {
    // The defect this exists to fix is a node dropped EXACTLY where the last
    // one went, so the inner radius is the load-bearing half of the range.
    for (let i = 0; i < 500; i++) {
      const r = len(nextTileScatter());
      expect(r).toBeGreaterThanOrEqual(SCATTER_MIN_PX - 1e-9);
      expect(r).toBeLessThanOrEqual(SCATTER_MAX_PX + 1e-9);
    }
  });

  it('never puts two CONSECUTIVE adds within √2·min of each other', () => {
    // THE property. The golden-angle step (plus bounded jitter) always lands
    // between a quarter and three quarters of a turn from the previous angle,
    // so cos(Δ) <= 0 and the separation is at least sqrt(r1² + r2²) — i.e.
    // ~34px on screen at any zoom. A plain random angle has no such floor.
    const floor = Math.SQRT2 * SCATTER_MIN_PX;
    let prev = nextTileScatter();
    for (let i = 0; i < 2000; i++) {
      const next = nextTileScatter();
      expect(gap(prev, next)).toBeGreaterThanOrEqual(floor - 1e-9);
      prev = next;
    }
  });

  it('holds that floor at BOTH extremes of the jitter', () => {
    // rand() drives the jitter AND the radius, so 0 and 1 are the two corners
    // where a widened SCATTER_JITTER_TURN would first break the quarter-turn
    // bound — the assertion above could pass by luck without them.
    for (const r of [seeded(0), seeded(1), seeded(0, 1), seeded(1, 0)]) {
      resetTileScatter();
      let prev = nextTileScatter(r);
      for (let i = 0; i < 20; i++) {
        const next = nextTileScatter(r);
        expect(gap(prev, next)).toBeGreaterThanOrEqual(Math.SQRT2 * SCATTER_MIN_PX - 1e-9);
        prev = next;
      }
    }
  });

  it('spreads over the whole ring rather than orbiting one side', () => {
    // The reason for the golden angle rather than "the opposite side of the
    // last one": a fixed half-turn step alternates between two points, which
    // stacks every OTHER add.
    const quadrants = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = nextTileScatter();
      quadrants.add(`${p.dx > 0}${p.dy > 0}`);
    }
    expect(quadrants.size).toBe(4);
  });

  it('is driven entirely by the injected rand (no hidden entropy)', () => {
    resetTileScatter();
    const a = [0, 0, 0].map(() => nextTileScatter(seeded(0.25, 0.5)));
    resetTileScatter();
    const b = [0, 0, 0].map(() => nextTileScatter(seeded(0.25, 0.5)));
    expect(a).toEqual(b);
  });
});

describe('where the scatter is applied', () => {
  it('offsets the click/Enter add from the canvas centre', () => {
    // The vitest env is `node`, so dropTileAtCanvasCenter (which reads the
    // canvas rect) cannot be driven here — source-pinned instead, the
    // scrollArrows.test.ts precedent.
    expect(SRC).toMatch(/clientX: r\.left \+ r\.width \/ 2 \+ dx/);
    expect(SRC).toMatch(/clientY: r\.top \+ r\.height \/ 2 \+ dy/);
  });

  it('does NOT scatter a DRAG', () => {
    // A drag lands where the pointer was released — that position is the
    // user's, and nudging it would be the app arguing with an aim. Exactly one
    // call site, and it is the activation path.
    const calls = SRC.match(/nextTileScatter\(/g) ?? [];
    expect(calls.length).toBe(2); // the declaration + the one call
    expect(SRC).toMatch(/dropTileAtCanvasCenter[\s\S]{0,400}nextTileScatter\(\)/);
  });
});
