import { describe, it, expect } from 'vitest';
import {
  tokenizePath, serializePath, segStart, pathSegEnds, degradeCurve,
  pathSpans, insertIntoPath, insertIntoPoly, canInsertInto, PATH_ARGC,
} from './glyphPath';
import { evalCubic, evalQuad, projectOnSegment, type Pt } from './glyphGeometry';
import { CUSTOM_GLYPHS } from '@/components/NodeEditor/nodes/glyphs/customGlyphs';

/**
 * The load-bearing property of "add a point" is that the DRAWN CURVE does not
 * move — a glyph is 56px across, so a subdivision that shifts the art by a
 * hundredth of a unit is visible. Every insert test below therefore samples the
 * path densely before and after and measures how far each sample strays from the
 * OTHER path's curve, in both directions — path data necessarily differs, so
 * comparing strings would prove nothing.
 */

/** Dense sample of everything a path draws, as one polyline per drawn span. */
function samplePath(d: string, per = 60): Pt[][] {
  return pathSpans(tokenizePath(d)).map(({ pts }) => {
    const line: Pt[] = [];
    for (let i = 0; i <= per; i++) {
      const t = i / per;
      if (pts.length === 4) line.push(evalCubic(pts[0], pts[1], pts[2], pts[3], t));
      else if (pts.length === 3) line.push(evalQuad(pts[0], pts[1], pts[2], t));
      else line.push({ x: pts[0].x + (pts[1].x - pts[0].x) * t, y: pts[0].y + (pts[1].y - pts[0].y) * t });
    }
    return line;
  });
}

/**
 * Worst distance from any sample of `a` to the CURVE of `b`.
 *
 * Point-to-polyline, not point-to-sample: two samplings of the same curve differ
 * by up to half a sample spacing, so comparing point sets would measure the
 * sampling and not the shape (a split segment is sampled twice as densely, which
 * is exactly the case under test).
 */
function deviation(a: Pt[][], b: Pt[][]): number {
  let worst = 0;
  a.forEach((line) => line.forEach((p) => {
    let best = Infinity;
    b.forEach((other) => {
      for (let i = 0; i + 1 < other.length; i++) {
        const d = Math.sqrt(projectOnSegment(p, other[i], other[i + 1]).d2);
        if (d < best) best = d;
      }
    });
    if (best > worst) worst = best;
  }));
  return worst;
}

/**
 * `serializePath` writes 2 decimals (`fmtN`), so a subdivision's control points
 * are quantized on the way out and the curve can shift by at most half that. The
 * bound below is the editor's own number grid — 0.01 view units is 0.05px on the
 * 280px canvas, i.e. a twentieth of a pixel. Anything larger is a real defect.
 */
const GRID_EPS = 0.01;

function expectSameDrawing(before: string, after: string, eps = GRID_EPS) {
  const A = samplePath(before), B = samplePath(after);
  expect(A.length).toBeGreaterThan(0);
  expect(B.length).toBeGreaterThan(0);
  expect(deviation(A, B)).toBeLessThan(eps);
  expect(deviation(B, A)).toBeLessThan(eps);
}

const shippedPaths = Object.entries(CUSTOM_GLYPHS)
  .flatMap(([type, d]) => {
    const svg = (d as { svg?: string }).svg || '';
    return Array.from(svg.matchAll(/<path[^>]*\sd="([^"]*)"/g)).map((m) => [type, m[1]] as const);
  });

describe('tokenizePath / serializePath', () => {
  it('reads commands, arguments and the implicit lineto after a moveto', () => {
    expect(tokenizePath('M 0 0 4 4')).toEqual([{ cmd: 'M', args: [0, 0] }, { cmd: 'L', args: [4, 4] }]);
    expect(tokenizePath('m1 2l3 4')).toEqual([{ cmd: 'm', args: [1, 2] }, { cmd: 'l', args: [3, 4] }]);
  });
  it('reads leading-dot, exponent and negative numbers', () => {
    expect(tokenizePath('M .5 -1.5e1 L -.25 2')).toEqual([{ cmd: 'M', args: [0.5, -15] }, { cmd: 'L', args: [-0.25, 2] }]);
  });
  it('stops at the first thing it cannot read instead of throwing', () => {
    expect(tokenizePath('M 0 0 L 4')).toEqual([{ cmd: 'M', args: [0, 0] }]);
    expect(() => tokenizePath('')).not.toThrow();
    expect(tokenizePath('')).toEqual([]);
  });
  it('declares an argument count for every command it accepts', () => {
    Object.keys(PATH_ARGC).forEach((k) => expect(k).toMatch(/^[a-z]$/));
  });
  it('round-trips every shipped path to the same drawing', () => {
    expect(shippedPaths.length).toBeGreaterThan(10);
    shippedPaths.forEach(([type, d]) => {
      const again = serializePath(tokenizePath(d));
      expect(deviation(samplePath(d), samplePath(again)), type).toBeLessThan(GRID_EPS);
    });
  });
});

describe('segStart / segEnd / pathSegEnds', () => {
  it('rebases relative commands on the previous segment', () => {
    const segs = tokenizePath('M 10 10 l 5 0 l 0 5');
    expect(segStart(segs, 0)).toEqual({ x: 0, y: 0 });
    expect(segStart(segs, 1)).toEqual({ x: 10, y: 10 });
    expect(segStart(segs, 2)).toEqual({ x: 15, y: 10 });
    expect(pathSegEnds(segs)).toEqual([{ x: 10, y: 10 }, { x: 15, y: 10 }, { x: 15, y: 15 }]);
  });
  it('sends Z back to the subpath start, not to the origin', () => {
    const segs = tokenizePath('M 4 4 L 20 4 L 20 20 Z M 30 30 L 40 30');
    const ends = pathSegEnds(segs);
    expect(ends[3]).toEqual({ x: 4, y: 4 });
    expect(segStart(segs, 4)).toEqual({ x: 4, y: 4 });
  });
  it('carries the unwritten axis through H and V', () => {
    const segs = tokenizePath('M 2 3 H 9 V 1');
    expect(pathSegEnds(segs)).toEqual([{ x: 2, y: 3 }, { x: 9, y: 3 }, { x: 9, y: 1 }]);
  });
});

describe('degradeCurve', () => {
  it('keeps the endpoint bit-identical and drops only the curvature', () => {
    expect(degradeCurve({ cmd: 'C', args: [1, 2, 3, 4, 5, 6] })).toEqual({ cmd: 'L', args: [5, 6] });
    expect(degradeCurve({ cmd: 'q', args: [1, 2, 3, 4] })).toEqual({ cmd: 'l', args: [3, 4] });
    expect(degradeCurve({ cmd: 'L', args: [1, 2] })).toEqual({ cmd: 'L', args: [1, 2] });
  });
});

describe('pathSpans', () => {
  it('skips movetos and materialises S/T against the previous control point', () => {
    const segs = tokenizePath('M 0 0 C 0 -10 10 -10 10 0 S 20 10 20 0');
    const spans = pathSpans(segs);
    expect(spans.map((s) => s.si)).toEqual([1, 2]);
    // the S's implied first control is the reflection of (10,-10) about (10,0)
    expect(spans[1].pts[1]).toEqual({ x: 10, y: 10 });
  });
  it('gives Z a real span back to the subpath start', () => {
    const spans = pathSpans(tokenizePath('M 4 4 L 20 4 Z'));
    expect(spans).toHaveLength(2);
    expect(spans[1].pts).toEqual([{ x: 20, y: 4 }, { x: 4, y: 4 }]);
  });
  it('refuses arcs — nothing to subdivide safely', () => {
    expect(pathSpans(tokenizePath('M 0 0 A 5 5 0 0 1 10 0'))).toHaveLength(0);
    expect(canInsertInto('A')).toBe(false);
    expect(canInsertInto('M')).toBe(false);
  });
});

describe('insertIntoPath', () => {
  it('splits a lineto without moving the drawing', () => {
    const d = 'M 4 4 L 20 12';
    const r = insertIntoPath(tokenizePath(d), 1, 0.5);
    expect(r).not.toBeNull();
    const out = serializePath(r!.segs);
    expect(out).toBe('M 4 4 L 12 8 L 20 12');
    expectSameDrawing(d, out);
  });

  it('splits a cubic without moving the drawing', () => {
    const d = 'M 0 0 C 0 -20 40 -20 40 0';
    const r = insertIntoPath(tokenizePath(d), 1, 0.37)!;
    expectSameDrawing(d, serializePath(r.segs));
    expect(r.segs.filter((s) => s.cmd.toLowerCase() === 'c')).toHaveLength(2);
  });

  it('splits a quadratic without moving the drawing', () => {
    const d = 'M -20 0 Q 0 -24 20 0';
    const r = insertIntoPath(tokenizePath(d), 1, 0.62)!;
    expectSameDrawing(d, serializePath(r.segs));
    expect(r.segs.filter((s) => s.cmd.toLowerCase() === 'q')).toHaveLength(2);
  });

  it('splits H and V without moving the drawing', () => {
    ['M 2 3 H 9', 'M 2 3 V 9'].forEach((d) => {
      const r = insertIntoPath(tokenizePath(d), 1, 0.5)!;
      expectSameDrawing(d, serializePath(r.segs));
    });
  });

  it('does not translate the rest of a RELATIVE subpath', () => {
    const d = 'M 10 10 l 10 0 l 0 10 l -10 0';
    const r = insertIntoPath(tokenizePath(d), 1, 0.5)!;
    expectSameDrawing(d, serializePath(r.segs));
    // the tail really is still where it was
    expect(pathSegEnds(r.segs).slice(-1)[0]).toEqual({ x: 10, y: 20 });
  });

  it('keeps a subpath closed when the Z segment is split', () => {
    const d = 'M 4 4 L 20 4 L 20 20 Z';
    const segs = tokenizePath(d);
    const zi = segs.findIndex((s) => s.cmd.toLowerCase() === 'z');
    const r = insertIntoPath(segs, zi, 0.5)!;
    const out = serializePath(r.segs);
    expect(out.trim().endsWith('Z')).toBe(true);
    expectSameDrawing(d, out);
  });

  it('materialises a following S so it cannot re-reflect against the new neighbour', () => {
    const d = 'M 0 0 C 0 -10 10 -10 10 0 S 20 10 20 0';
    const r = insertIntoPath(tokenizePath(d), 1, 0.5)!;
    const out = serializePath(r.segs);
    expect(out).not.toMatch(/[sS] /);
    expectSameDrawing(d, out);
  });

  it('refuses a moveto and an arc rather than corrupting them', () => {
    expect(insertIntoPath(tokenizePath('M 0 0 L 4 4'), 0, 0.5)).toBeNull();
    expect(insertIntoPath(tokenizePath('M 0 0 A 5 5 0 0 1 10 0'), 1, 0.5)).toBeNull();
    expect(insertIntoPath(tokenizePath('M 0 0 L 4 4'), 9, 0.5)).toBeNull();
  });

  it('clamps a junk parameter instead of emitting NaN', () => {
    const r = insertIntoPath(tokenizePath('M 0 0 L 10 0'), 1, NaN)!;
    expect(serializePath(r.segs)).not.toContain('NaN');
    const r2 = insertIntoPath(tokenizePath('M 0 0 L 10 0'), 1, 5)!;
    expect(serializePath(r2.segs)).toBe('M 0 0 L 10 0 L 10 0');
  });

  it('leaves every shipped path drawing exactly the same after a mid-segment insert', () => {
    shippedPaths.forEach(([type, d]) => {
      const segs = tokenizePath(d);
      segs.forEach((s, si) => {
        if (!canInsertInto(s.cmd)) return;
        const r = insertIntoPath(segs, si, 0.4);
        expect(r, type + ' seg ' + si).not.toBeNull();
        const out = serializePath(r!.segs);
        const dev = Math.max(deviation(samplePath(d), samplePath(out)), deviation(samplePath(out), samplePath(d)));
        expect(dev, type + ' seg ' + si + ' → ' + out).toBeLessThan(GRID_EPS);
      });
    });
  });
});

describe('insertIntoPoly', () => {
  it('inserts on the segment after vertex vi and reports its arg index', () => {
    const r = insertIntoPoly([0, 0, 10, 0, 10, 10], 0, 0.5)!;
    expect(r.nums).toEqual([0, 0, 5, 0, 10, 0, 10, 10]);
    expect(r.at).toBe(2);
  });
  it('wraps the last segment only when the shape is closed', () => {
    expect(insertIntoPoly([0, 0, 10, 0, 10, 10], 2, 0.5, false)).toBeNull();
    const r = insertIntoPoly([0, 0, 10, 0, 10, 10], 2, 0.5, true)!;
    expect(r.nums.slice(-2)).toEqual([5, 5]);
  });
  it('refuses degenerate input', () => {
    expect(insertIntoPoly([1, 2], 0, 0.5, true)).toBeNull();
    expect(insertIntoPoly([0, 0, 1, 1], -1, 0.5, true)).toBeNull();
  });
});
