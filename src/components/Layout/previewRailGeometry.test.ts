/**
 * The preview rail's pure geometry.
 *
 * Both rails and PreviewLink's endpoint resolution ask these functions, so a
 * wire's far end and the socket the preview draws for it cannot land at two
 * different heights — which is the only thing making the pair read as one
 * connection across the seam.
 */
import { describe, it, expect } from 'vitest';
import {
  RAIL_MIN_STEP,
  RAIL_SPAN,
  railFraction,
  railFractions,
  railY,
} from './previewRailGeometry';

describe('railFraction', () => {
  it('puts a lone socket at the middle — the one-Output shader does not move', () => {
    expect(railFraction(0, 1)).toBe(0.5);
    expect(railFraction(0, 0)).toBe(0.5);
  });

  it('is symmetric about the middle for any count', () => {
    for (const n of [2, 3, 5, 16, 40]) {
      const f = railFractions(n);
      for (let i = 0; i < n; i++) {
        expect(f[i] + f[n - 1 - i]).toBeCloseTo(1, 10);
      }
    }
  });

  it('is strictly increasing and inside the pane', () => {
    for (const n of [2, 3, 17, 90]) {
      const f = railFractions(n);
      for (let i = 1; i < n; i++) expect(f[i]).toBeGreaterThan(f[i - 1]);
      expect(f[0]).toBeGreaterThan(0);
      expect(f[n - 1]).toBeLessThan(1);
    }
  });

  it('never spreads past RAIL_SPAN, however many Outputs there are', () => {
    // 90 is the module's own `parts` ceiling, so this is the real worst case.
    const f = railFractions(90);
    expect(f[89] - f[0]).toBeLessThanOrEqual(RAIL_SPAN + 1e-12);
  });

  it('keeps sockets RAIL_MIN_STEP apart until the span runs out', () => {
    const few = railFractions(4);
    expect(few[1] - few[0]).toBeCloseTo(RAIL_MIN_STEP, 10);
    // Past the point where the span binds, the step shrinks rather than the
    // rail growing — a tight column beats one whose ends leave the pane.
    const many = railFractions(40);
    expect(many[1] - many[0]).toBeLessThan(RAIL_MIN_STEP);
  });
});

describe('railY', () => {
  it('maps into a pane box and rounds to whole pixels', () => {
    // A half-pixel socket blurs its own rim.
    expect(railY(100, 600, 0, 1)).toBe(400);
    expect(Number.isInteger(railY(0, 601, 1, 3))).toBe(true);
  });

  it('scales with the pane, so a resize moves every socket together', () => {
    // The canvas is resizable from the column seam and the window, so a fixed
    // pixel offset would hold at exactly one size.
    const tall = railY(0, 900, 1, 3);
    const short = railY(0, 300, 1, 3);
    expect(tall / 900).toBeCloseTo(short / 300, 2);
    expect(tall).toBeGreaterThan(short);
  });

  it('a socket is the same distance from the top as the wire aimed at it', () => {
    // PreviewLink calls this with the SVG's box and `PreviewRail` positions by
    // the same fraction of its own — the two boxes are the same pane, so the
    // wire ends on the disc rather than near it.
    const top = 40;
    const height = 720;
    for (let i = 0; i < 4; i++) {
      expect(railY(top, height, i, 4) - top).toBe(Math.round(height * railFraction(i, 4)));
    }
  });
});
