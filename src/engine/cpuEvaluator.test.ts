import { describe, it, expect } from 'vitest';
import {
  evaluateNodeOutput,
  evaluateNodeScalar,
  getComponentCount,
  getNodeOutputShape,
  evaluateNodeRange,
} from './cpuEvaluator';
import { makeNode, makeEdge } from '@/test-utils';

describe('evaluateNodeOutput — constants', () => {
  it('emits a scalar for float / int / slider / property_float', () => {
    for (const type of ['float', 'int', 'slider', 'property_float']) {
      const n = makeNode('n', type, { value: 3.25 });
      expect(evaluateNodeOutput('n', [n], [], 0)).toEqual([3.25]);
    }
  });

  it('falls back to 0 when value is missing', () => {
    const n = makeNode('n', 'float');
    expect(evaluateNodeOutput('n', [n], [], 0)).toEqual([0]);
  });

  it('emits the current time for the time node', () => {
    const t = makeNode('t', 'time');
    expect(evaluateNodeOutput('t', [t], [], 1.5)).toEqual([1.5]);
  });

  it('emits screen-UV centre for screenUV', () => {
    const n = makeNode('n', 'screenUV');
    expect(evaluateNodeOutput('n', [n], [], 0)).toEqual([0.5, 0.5]);
  });

  it('returns null for unevaluable nodes like positionGeometry', () => {
    const n = makeNode('n', 'positionGeometry');
    expect(evaluateNodeOutput('n', [n], [], 0)).toBeNull();
  });
});

describe('evaluateNodeOutput — vector constructors', () => {
  it('builds a vec2 from inline x/y', () => {
    const n = makeNode('v', 'vec2', { x: 1, y: 2 });
    expect(evaluateNodeOutput('v', [n], [], 0)).toEqual([1, 2]);
  });

  it('builds a vec3 from inline x/y/z', () => {
    const n = makeNode('v', 'vec3', { x: 1, y: 2, z: 3 });
    expect(evaluateNodeOutput('v', [n], [], 0)).toEqual([1, 2, 3]);
  });

  it('builds a vec4 from inline x/y/z/w', () => {
    const n = makeNode('v', 'vec4', { x: 1, y: 2, z: 3, w: 4 });
    expect(evaluateNodeOutput('v', [n], [], 0)).toEqual([1, 2, 3, 4]);
  });

  it('decodes a hex color into 0..1 RGB', () => {
    const n = makeNode('c', 'color', { hex: '#ff0000' });
    expect(evaluateNodeOutput('c', [n], [], 0)).toEqual([1, 0, 0]);
  });
});

describe('evaluateNodeOutput — arithmetic with broadcast', () => {
  const A = makeNode('a', 'float', { value: 2 });
  const B = makeNode('b', 'float', { value: 3 });

  it('add(2, 3) = 5', () => {
    const op = makeNode('op', 'add');
    const edges = [makeEdge('a', 'out', 'op', 'a'), makeEdge('b', 'out', 'op', 'b')];
    expect(evaluateNodeOutput('op', [A, B, op], edges, 0)).toEqual([5]);
  });

  it('sub(2, 3) = -1', () => {
    const op = makeNode('op', 'sub');
    const edges = [makeEdge('a', 'out', 'op', 'a'), makeEdge('b', 'out', 'op', 'b')];
    expect(evaluateNodeOutput('op', [A, B, op], edges, 0)).toEqual([-1]);
  });

  it('mul(2, 3) = 6', () => {
    const op = makeNode('op', 'mul');
    const edges = [makeEdge('a', 'out', 'op', 'a'), makeEdge('b', 'out', 'op', 'b')];
    expect(evaluateNodeOutput('op', [A, B, op], edges, 0)).toEqual([6]);
  });

  it('div(2, 0) returns 0 (safe-divide)', () => {
    const zero = makeNode('z', 'float', { value: 0 });
    const op = makeNode('op', 'div');
    const edges = [makeEdge('a', 'out', 'op', 'a'), makeEdge('z', 'out', 'op', 'b')];
    expect(evaluateNodeOutput('op', [A, zero, op], edges, 0)).toEqual([0]);
  });

  it('broadcasts a scalar across a vec3 (vec3 + float = vec3)', () => {
    const v = makeNode('v', 'vec3', { x: 1, y: 2, z: 3 });
    const s = makeNode('s', 'float', { value: 10 });
    const op = makeNode('op', 'add');
    const edges = [makeEdge('v', 'out', 'op', 'a'), makeEdge('s', 'out', 'op', 'b')];
    expect(evaluateNodeOutput('op', [v, s, op], edges, 0)).toEqual([11, 12, 13]);
  });

  it('uses inline port defaults when there is no incoming edge', () => {
    // add with no inputs — both default to 0
    const op = makeNode('op', 'add');
    expect(evaluateNodeOutput('op', [op], [], 0)).toEqual([0]);
  });
});

describe('evaluateNodeOutput — unary math', () => {
  function unary(type: string, value: number): number {
    const x = makeNode('x', 'float', { value });
    const op = makeNode('op', type);
    return evaluateNodeOutput('op', [x, op], [makeEdge('x', 'out', 'op', 'x')], 0)![0];
  }

  it('sin/cos match Math.* on real numbers', () => {
    expect(unary('sin', 0)).toBe(0);
    expect(unary('cos', 0)).toBe(1);
    expect(unary('sin', Math.PI / 2)).toBeCloseTo(1, 10);
  });

  it('abs is component-wise', () => {
    expect(unary('abs', -7)).toBe(7);
    expect(unary('abs', 7)).toBe(7);
  });

  it('sqrt clamps negatives to 0 (no NaN)', () => {
    expect(unary('sqrt', 9)).toBe(3);
    expect(unary('sqrt', -4)).toBe(0);
  });

  it('exp / log2 use Math equivalents (log2 guarded against 0)', () => {
    expect(unary('exp', 1)).toBeCloseTo(Math.E, 10);
    expect(unary('log2', 8)).toBe(3);
    expect(unary('log2', 0)).toBeLessThan(0); // guarded but still very negative
    expect(Number.isFinite(unary('log2', 0))).toBe(true);
  });

  it('floor / round / fract', () => {
    expect(unary('floor', 1.7)).toBe(1);
    expect(unary('round', 1.7)).toBe(2);
    expect(unary('fract', 1.25)).toBe(0.25);
    expect(unary('fract', -0.25)).toBeCloseTo(0.75, 10);
  });

  it('oneMinus = 1 - x', () => {
    expect(unary('oneMinus', 0.25)).toBe(0.75);
    expect(unary('oneMinus', 1)).toBe(0);
  });
});

describe('evaluateNodeOutput — binary math and clamp', () => {
  it('pow(2, 10) = 1024', () => {
    const base = makeNode('b', 'float', { value: 2 });
    const exp = makeNode('e', 'float', { value: 10 });
    const op = makeNode('op', 'pow');
    const edges = [makeEdge('b', 'out', 'op', 'base'), makeEdge('e', 'out', 'op', 'exp')];
    expect(evaluateNodeOutput('op', [base, exp, op], edges, 0)).toEqual([1024]);
  });

  it('mod handles divisor=0 with safe return', () => {
    const x = makeNode('x', 'float', { value: 5 });
    const y = makeNode('y', 'float', { value: 0 });
    const op = makeNode('op', 'mod');
    const edges = [makeEdge('x', 'out', 'op', 'x'), makeEdge('y', 'out', 'op', 'y')];
    expect(evaluateNodeOutput('op', [x, y, op], edges, 0)).toEqual([0]);
  });

  it('min and max', () => {
    const a = makeNode('a', 'float', { value: 2 });
    const b = makeNode('b', 'float', { value: 7 });
    const mn = makeNode('mn', 'min');
    const mx = makeNode('mx', 'max');
    const mnEdges = [makeEdge('a', 'out', 'mn', 'a'), makeEdge('b', 'out', 'mn', 'b')];
    const mxEdges = [makeEdge('a', 'out', 'mx', 'a'), makeEdge('b', 'out', 'mx', 'b')];
    expect(evaluateNodeOutput('mn', [a, b, mn], mnEdges, 0)).toEqual([2]);
    expect(evaluateNodeOutput('mx', [a, b, mx], mxEdges, 0)).toEqual([7]);
  });

  it('min passes the wired input through when b is unwired (identity=1, not annihilator=0)', () => {
    // Regression: min's unwired `b` used to fall back to 0, so min(a, 0) = 0
    // silently zeroed any non-negative input. It must fall back to the identity.
    const a = makeNode('a', 'float', { value: 0.7 });
    const mn = makeNode('mn', 'min'); // b unwired + unset
    const edges = [makeEdge('a', 'out', 'mn', 'a')];
    expect(evaluateNodeOutput('mn', [a, mn], edges, 0)).toEqual([0.7]);
    // An explicit b = 0 is still honoured (real min against 0).
    const mn0 = makeNode('mn', 'min', { b: 0 });
    expect(evaluateNodeOutput('mn', [a, mn0], edges, 0)).toEqual([0]);
  });

  it('clamp pins values to [min, max]', () => {
    const x = makeNode('x', 'vec3', { x: -1, y: 0.5, z: 2 });
    const op = makeNode('op', 'clamp', { min: 0, max: 1 });
    const edges = [makeEdge('x', 'out', 'op', 'x')];
    expect(evaluateNodeOutput('op', [x, op], edges, 0)).toEqual([0, 0.5, 1]);
  });
});

describe('evaluateNodeOutput — interpolation', () => {
  it('mix(0, 10, 0.25) = 2.5', () => {
    const a = makeNode('a', 'float', { value: 0 });
    const b = makeNode('b', 'float', { value: 10 });
    const op = makeNode('op', 'mix', { t: 0.25 });
    const edges = [makeEdge('a', 'out', 'op', 'a'), makeEdge('b', 'out', 'op', 'b')];
    expect(evaluateNodeOutput('op', [a, b, op], edges, 0)).toEqual([2.5]);
  });

  it('smoothstep is 0 at edge0, 1 at edge1, 0.5 at midpoint', () => {
    const make = (v: number) => {
      const x = makeNode('x', 'float', { value: v });
      const op = makeNode('op', 'smoothstep', { edge0: 0, edge1: 1 });
      return evaluateNodeOutput('op', [x, op], [makeEdge('x', 'out', 'op', 'x')], 0)![0];
    };
    expect(make(0)).toBe(0);
    expect(make(1)).toBe(1);
    expect(make(0.5)).toBeCloseTo(0.5, 10);
  });

  it('remap rescales an input range to an output range', () => {
    const x = makeNode('x', 'float', { value: 5 });
    const op = makeNode('op', 'remap', {
      inLow: 0, inHigh: 10, outLow: -1, outHigh: 1,
    });
    const edges = [makeEdge('x', 'out', 'op', 'x')];
    expect(evaluateNodeOutput('op', [x, op], edges, 0)).toEqual([0]);
  });

  it('select picks a when condition ≥ 0.5, else b', () => {
    const a = makeNode('a', 'float', { value: 100 });
    const b = makeNode('b', 'float', { value: 200 });
    const onTrue = makeNode('op', 'select', { condition: 1 });
    const onFalse = makeNode('op', 'select', { condition: 0 });
    const edges = [makeEdge('a', 'out', 'op', 'a'), makeEdge('b', 'out', 'op', 'b')];
    expect(evaluateNodeOutput('op', [a, b, onTrue], edges, 0)).toEqual([100]);
    expect(evaluateNodeOutput('op', [a, b, onFalse], edges, 0)).toEqual([200]);
  });
});

describe('evaluateNodeOutput — vector ops', () => {
  const v3 = (x: number, y: number, z: number, id = 'v') =>
    makeNode(id, 'vec3', { x, y, z });

  it('length of (3, 4, 0) = 5', () => {
    const v = v3(3, 4, 0);
    const op = makeNode('op', 'length');
    const edges = [makeEdge('v', 'out', 'op', 'v')];
    expect(evaluateNodeOutput('op', [v, op], edges, 0)).toEqual([5]);
  });

  it('distance is symmetric and Euclidean', () => {
    const a = v3(0, 0, 0, 'a');
    const b = v3(3, 4, 0, 'b');
    const op = makeNode('op', 'distance');
    const edges = [makeEdge('a', 'out', 'op', 'a'), makeEdge('b', 'out', 'op', 'b')];
    expect(evaluateNodeOutput('op', [a, b, op], edges, 0)).toEqual([5]);
  });

  it('dot of orthogonal vectors is 0', () => {
    const a = v3(1, 0, 0, 'a');
    const b = v3(0, 1, 0, 'b');
    const op = makeNode('op', 'dot');
    const edges = [makeEdge('a', 'out', 'op', 'a'), makeEdge('b', 'out', 'op', 'b')];
    expect(evaluateNodeOutput('op', [a, b, op], edges, 0)).toEqual([0]);
  });

  it('normalize produces a unit-length vector', () => {
    const v = v3(0, 3, 4);
    const op = makeNode('op', 'normalize');
    const edges = [makeEdge('v', 'out', 'op', 'v')];
    const out = evaluateNodeOutput('op', [v, op], edges, 0)!;
    const mag = Math.hypot(...out);
    expect(mag).toBeCloseTo(1, 10);
  });

  it('cross(x, y) = z (right-handed)', () => {
    const a = v3(1, 0, 0, 'a');
    const b = v3(0, 1, 0, 'b');
    const op = makeNode('op', 'cross');
    const edges = [makeEdge('a', 'out', 'op', 'a'), makeEdge('b', 'out', 'op', 'b')];
    expect(evaluateNodeOutput('op', [a, b, op], edges, 0)).toEqual([0, 0, 1]);
  });

  it('append concatenates channels', () => {
    const a = makeNode('a', 'vec2', { x: 1, y: 2 });
    const b = makeNode('b', 'float', { value: 3 });
    const op = makeNode('op', 'append');
    const edges = [makeEdge('a', 'out', 'op', 'a'), makeEdge('b', 'out', 'op', 'b')];
    expect(evaluateNodeOutput('op', [a, b, op], edges, 0)).toEqual([1, 2, 3]);
  });
});

describe('evaluateNodeOutput — HSL ↔ toHsl', () => {
  it('hsl(0, 1, 0.5) = red', () => {
    const op = makeNode('op', 'hsl', { h: 0, s: 1, l: 0.5 });
    const out = evaluateNodeOutput('op', [op], [], 0)!;
    expect(out[0]).toBeCloseTo(1, 10);
    expect(out[1]).toBeCloseTo(0, 10);
    expect(out[2]).toBeCloseTo(0, 10);
  });

  it('toHsl of red returns hue=0, sat=1, lum=0.5', () => {
    const rgb = makeNode('rgb', 'color', { hex: '#ff0000' });
    const op = makeNode('op', 'toHsl');
    const edges = [makeEdge('rgb', 'out', 'op', 'rgb')];
    const out = evaluateNodeOutput('op', [rgb, op], edges, 0)!;
    expect(out[0]).toBeCloseTo(0, 10);
    expect(out[1]).toBeCloseTo(1, 10);
    expect(out[2]).toBeCloseTo(0.5, 10);
  });

  it('toHsl of gray returns hue=0, sat=0, lum=mid', () => {
    const rgb = makeNode('rgb', 'vec3', { x: 0.5, y: 0.5, z: 0.5 });
    const op = makeNode('op', 'toHsl');
    const edges = [makeEdge('rgb', 'out', 'op', 'rgb')];
    const out = evaluateNodeOutput('op', [rgb, op], edges, 0)!;
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo(0.5, 10);
  });
});

describe('evaluateNodeOutput — null propagation and cycles', () => {
  it('returns null downstream of an unevaluable upstream', () => {
    // positionGeometry → add(time, pos) should propagate null,
    // *not* silently use the inline 0 fallback.
    const pos = makeNode('pos', 'positionGeometry');
    const t = makeNode('t', 'time');
    const op = makeNode('op', 'add');
    const edges = [makeEdge('t', 'out', 'op', 'a'), makeEdge('pos', 'out', 'op', 'b')];
    expect(evaluateNodeOutput('op', [pos, t, op], edges, 1)).toBeNull();
  });

  it('does not recurse forever on a cycle', () => {
    // a -> b -> a — neither has a real value source; result must be null and finite.
    const a = makeNode('a', 'add');
    const b = makeNode('b', 'add');
    const edges = [makeEdge('a', 'out', 'b', 'a'), makeEdge('b', 'out', 'a', 'a')];
    expect(evaluateNodeOutput('a', [a, b], edges, 0)).toBeNull();
  });
});

describe('evaluateNodeScalar', () => {
  it('returns the first channel of a vec3', () => {
    const v = makeNode('v', 'vec3', { x: 7, y: 8, z: 9 });
    expect(evaluateNodeScalar('v', [v], [], 0)).toBe(7);
  });

  it('returns null when the evaluator returns null', () => {
    const n = makeNode('n', 'positionGeometry');
    expect(evaluateNodeScalar('n', [n], [], 0)).toBeNull();
  });
});

describe('getComponentCount / getNodeOutputShape', () => {
  it('uses concrete port types when available', () => {
    const v = makeNode('v', 'vec3', { x: 0, y: 0, z: 0 });
    expect(getComponentCount('v', [v], [])).toBe(3);
    expect(getNodeOutputShape('v', [v], [])).toBe(3);
  });

  it('infers append output by summing input shapes', () => {
    const a = makeNode('a', 'vec2', { x: 0, y: 0 });
    const b = makeNode('b', 'float', { value: 0 });
    const op = makeNode('op', 'append');
    const edges = [makeEdge('a', 'out', 'op', 'a'), makeEdge('b', 'out', 'op', 'b')];
    expect(getNodeOutputShape('op', [a, b, op], edges)).toBe(3);
  });

  it('broadcasts arithmetic shape to the max of its inputs', () => {
    const v = makeNode('v', 'vec3', { x: 0, y: 0, z: 0 });
    const s = makeNode('s', 'float', { value: 1 });
    const op = makeNode('op', 'add');
    const edges = [makeEdge('v', 'out', 'op', 'a'), makeEdge('s', 'out', 'op', 'b')];
    expect(getNodeOutputShape('op', [v, s, op], edges)).toBe(3);
  });
});

describe('evaluateNodeRange', () => {
  it('reports a degenerate range for a constant', () => {
    const n = makeNode('n', 'float', { value: 4 });
    expect(evaluateNodeRange('n', [n], [], 0)).toEqual({ min: [4], max: [4] });
  });

  it('reports the analytical [0, 1] range for UV', () => {
    const n = makeNode('n', 'uv');
    expect(evaluateNodeRange('n', [n], [], 0)).toEqual({ min: [0, 0], max: [1, 1] });
  });

  it('reports [0, 1] for scalar MaterialX noise', () => {
    const n = makeNode('n', 'perlin');
    expect(evaluateNodeRange('n', [n], [], 0)).toEqual({ min: [0], max: [1] });
  });

  it('reports unit-vector ranges for normals, tangents, and view directions', () => {
    for (const type of ['normalLocal', 'tangentLocal', 'positionWorldDirection', 'positionViewDirection']) {
      const n = makeNode('n', type);
      expect(evaluateNodeRange('n', [n], [], 0)).toEqual({
        min: [-1, -1, -1], max: [1, 1, 1],
      });
    }
  });

  it('reports the fit-bounds range for model-space positions', () => {
    for (const type of ['positionGeometry', 'positionLocal']) {
      const n = makeNode('n', type);
      expect(evaluateNodeRange('n', [n], [], 0)).toEqual({
        min: [-0.8, -0.8, -0.8], max: [0.8, 0.8, 0.8],
      });
    }
  });

  it('propagates an additive offset through interval arithmetic', () => {
    // positionGeometry carries the analytical fit-bounds range [-0.8, 0.8] per
    // channel; the add shifts the interval: [-0.8..0.8] + 1 → [0.2..1.8].
    const pos = makeNode('p', 'positionGeometry');
    const one = makeNode('one', 'float', { value: 1 });
    const op = makeNode('op', 'add');
    const edges = [makeEdge('p', 'out', 'op', 'a'), makeEdge('one', 'out', 'op', 'b')];
    const r = evaluateNodeRange('op', [pos, one, op], edges, 0)!;
    expect(r).not.toBeNull();
    expect(r.min).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(r.min[i]).toBeCloseTo(0.2, 10);
      expect(r.max[i]).toBeCloseTo(1.8, 10);
    }
  });
});

describe('non-finite poisoning (noise pos = coordinate-source name)', () => {
  // Regression: the demo perlin node stores pos: 'positionGeometry' (a coord-source
  // NAME, not a number). Number('positionGeometry') is NaN, which used to poison the
  // CPU sample and every downstream value — the `mul → output` edge card rendered '…'.
  it('samples noise to a finite value when pos names a coordinate source', () => {
    const n = makeNode('n', 'perlin', { pos: 'positionGeometry' });
    const out = evaluateNodeOutput('n', [n], [], 0)!;
    expect(out).not.toBeNull();
    expect(out.every(Number.isFinite)).toBe(true);
  });

  it('keeps a downstream multiply finite (the edge-card bug)', () => {
    const noise = makeNode('noise', 'perlin', { pos: 'positionGeometry' });
    const prop = makeNode('prop', 'property_float', { value: 1 });
    const mul = makeNode('mul', 'mul');
    const edges = [makeEdge('noise', 'out', 'mul', 'a'), makeEdge('prop', 'out', 'mul', 'b')];
    const ev = evaluateNodeOutput('mul', [noise, prop, mul], edges, 0)!;
    expect(ev.every(Number.isFinite)).toBe(true);
    const r = evaluateNodeRange('mul', [noise, prop, mul], edges, 0)!;
    expect(r).not.toBeNull();
    expect(r.min.every(Number.isFinite) && r.max.every(Number.isFinite)).toBe(true);
  });

  it('never collapses a range to NaN even if eval is non-finite', () => {
    // exp(1000) overflows to Infinity in eval; the range must fall through to
    // interval arithmetic rather than wrap the Infinity into a NaN range.
    const big = makeNode('big', 'property_float', { value: 1000 });
    const e = makeNode('e', 'exp');
    const edges = [makeEdge('big', 'out', 'e', 'x')];
    const r = evaluateNodeRange('e', [big, e], edges, 0);
    // exp has no interval-propagation case → falls through to null rather than a
    // NaN/Infinity range. Either way it must NOT be a non-finite range.
    if (r) {
      expect(r.min.every(Number.isFinite) && r.max.every(Number.isFinite)).toBe(true);
    }
  });
});
