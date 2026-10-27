import { describe, it, expect } from 'vitest';
import {
  evaluateNodeOutput,
  evaluateNodeRange,
  evaluateEdgeSource,
  evaluateEdgeRange,
  getFieldUpstreamSet,
  getSurfaceFieldUpstreamSet,
  getTimeUpstreamSet,
} from './cpuEvaluator';
import { makeNode, makeEdge } from '@/test-utils';
import { graphToCode } from './graphToCode';
import { getNodeOutputShape } from './cpuEvaluator';
import { makeDataNodeData } from '@/utils/dataNode';
import type { AppNode, AppEdge } from '@/types';

/**
 * What an edge SHOWS must be what the shader computes on that wire (owner
 * report 2026-10-27: "some values do not display accurately on edges — U = 10
 * on the UV node does not show, although the preview is clearly overblown").
 * An audit of every node family measured each case below against graphToCode's
 * emitted TSL and three r184's semantics; these pin the evaluator half. A
 * RANGE may be loose (interval arithmetic over-approximates, by design) but
 * must CONTAIN every value the wire carries; a POINT must equal it.
 */

const range = (id: string, nodes: AppNode[], edges: AppEdge[], t = 0) => evaluateNodeRange(id, nodes, edges, t)!;
const point = (id: string, nodes: AppNode[], edges: AppEdge[], t = 0) => evaluateNodeOutput(id, nodes, edges, t);

/** `lo…hi` contains every sample, channel by channel (a 1e-9 float slack). */
function expectContains(r: { min: number[]; max: number[] }, samples: number[][], label: string) {
  for (const s of samples) {
    s.forEach((v, i) => {
      expect(v, `${label} ch${i}: ${v} in ${r.min[i]}…${r.max[i]}`).toBeGreaterThanOrEqual(r.min[i] - 1e-9);
      expect(v, `${label} ch${i}: ${v} in ${r.min[i]}…${r.max[i]}`).toBeLessThanOrEqual(r.max[i] + 1e-9);
    });
  }
}

const grid = (n = 33): number[][] => {
  const out: number[][] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push([i / (n - 1), j / (n - 1)]);
  return out;
};

describe('UV — the reported case: tiling and turn reach the label', () => {
  it('U = 10 spans 0…10 (the wire read 0…1 while the preview tiled ten times)', () => {
    const nodes = [makeNode('u', 'uv', { tilingU: 10, tilingV: 1, rotation: 0 })];
    expect(range('u', nodes, [])).toEqual({ min: [0, 0], max: [10, 1] });
  });

  it('a negative or a wired tiling is read as a range', () => {
    expect(range('u', [makeNode('u', 'uv', { tilingU: -2 })], [])).toEqual({ min: [-2, 0], max: [0, 1] });
    // Time → U: the bound follows the clock (`mul(uv(), vec2(time, 1))`).
    const nodes = [makeNode('t', 'time'), makeNode('u', 'uv')];
    const edges = [makeEdge('t', 'out', 'u', 'tilingU')];
    expect(range('u', nodes, edges, 4)).toEqual({ min: [0, 0], max: [4, 1] });
  });

  it('a turn about (½, ½) is the emitted map\'s exact box, and contains every rotated sample', () => {
    // The emitted lines, run on the CPU: s = uv·(U, V), c = s − ½, out = R(θ)c + ½.
    const emitted = (u: number, v: number, tu: number, tv: number, th: number) => {
      const cu = u * tu - 0.5, cv = v * tv - 0.5;
      return [cu * Math.cos(th) - cv * Math.sin(th) + 0.5, cu * Math.sin(th) + cv * Math.cos(th) + 0.5];
    };
    for (const [tu, tv, th] of [[1, 1, Math.PI / 4], [3, 2, 0.5236], [10, 1, -1.2], [1, 4, 2.5]]) {
      const r = range('u', [makeNode('u', 'uv', { tilingU: tu, tilingV: tv, rotation: th })], []);
      expectContains(r, grid().map(([u, v]) => emitted(u, v, tu, tv, th)), `uv ${tu} ${tv} ${th}`);
    }
    const r45 = range('u', [makeNode('u', 'uv', { rotation: Math.PI / 4 })], []);
    expect(r45.min[0]).toBeCloseTo(0.5 - Math.SQRT1_2, 9);
    expect(r45.max[0]).toBeCloseTo(0.5 + Math.SQRT1_2, 9);
  });

  it('flows downstream: UV(U 8) → Floor reads 0…8', () => {
    const nodes = [makeNode('u', 'uv', { tilingU: 8, tilingV: 8 }), makeNode('f', 'floor')];
    const r = range('f', nodes, [makeEdge('u', 'out', 'f', 'x')]);
    expect(r).toEqual({ min: [0, 0], max: [8, 8] });
  });
});

describe('Split — a pass-through, padded as TSL pads', () => {
  it('a constant vector through Split.y is exact (it read 0…2 for a wire that is 12)', () => {
    const nodes = [makeNode('v', 'vec3', { x: 5, y: 6, z: 7 }), makeNode('s', 'split'), makeNode('m', 'mul', { b: 2 })];
    const edges = [makeEdge('v', 'out', 's', 'v'), makeEdge('s', 'y', 'm', 'a')];
    expect(point('m', nodes, edges)).toEqual([12]);
  });

  it('a field channel keeps its sign: normalWorld.y × 0.5 + 0.5 is 0…1, not "1"', () => {
    const nodes = [makeNode('n', 'normalWorld'), makeNode('s', 'split'), makeNode('m', 'mul', { b: 0.5 }), makeNode('a', 'add', { b: 0.5 })];
    const edges = [makeEdge('n', 'out', 's', 'v'), makeEdge('s', 'y', 'm', 'a'), makeEdge('m', 'out', 'a', 'a')];
    expect(range('a', nodes, edges)).toEqual({ min: [0], max: [1] });
  });

  it('pads like SplitNode: vec2.z = 0, vec2.w = 1, a scalar answers every component', () => {
    const v2 = [makeNode('v', 'vec2', { x: 2, y: 3 }), makeNode('s', 'split')];
    const e2 = [makeEdge('v', 'out', 's', 'v')];
    expect(evaluateEdgeSource({ source: 's', sourceHandle: 'z' }, v2, e2, 0)).toEqual([0]);
    expect(evaluateEdgeSource({ source: 's', sourceHandle: 'w' }, v2, e2, 0)).toEqual([1]);
    const f = [makeNode('f', 'float', { value: 4 }), makeNode('s', 'split')];
    expect(evaluateEdgeSource({ source: 's', sourceHandle: 'y' }, f, [makeEdge('f', 'out', 's', 'v')], 0)).toEqual([4]);
  });

  it('a wire codegen resolves to nothing is UNWIRED at the consumer (dangling Split → the default 1)', () => {
    // graphToCode gives Split no variable: with nothing in `v` the consumer
    // emits its own default, `mul(float1, 1)`.
    const nodes = [makeNode('f', 'float', { value: 3 }), makeNode('s', 'split'), makeNode('m', 'mul')];
    const edges = [makeEdge('f', 'out', 'm', 'a'), makeEdge('s', 'y', 'm', 'b')];
    expect(point('m', nodes, edges)).toEqual([3]);
    // …and the Split wire itself carries nothing.
    expect(evaluateEdgeSource({ source: 's', sourceHandle: 'y' }, nodes, edges, 0)).toBeNull();
  });

  it('from a scalar socket of a socket-aware source only .x exists', () => {
    // toHsl.s → Split: graphToCode emits `toHsl1.y` for .x and null for .y.
    const nodes = [
      makeNode('c', 'color', { hex: '#3366cc' }), makeNode('th', 'toHsl'), makeNode('s', 'split'),
      makeNode('m', 'mul', { b: 2 }), makeNode('k', 'mul'),
    ];
    const edges = [
      makeEdge('c', 'out', 'th', 'rgb'), makeEdge('th', 's', 's', 'v'),
      makeEdge('s', 'x', 'm', 'a'), makeEdge('s', 'y', 'k', 'a'),
    ];
    const sat = evaluateEdgeSource({ source: 'th', sourceHandle: 's' }, nodes, edges, 0)![0];
    expect(point('m', nodes, edges)).toEqual([sat * 2]);
    expect(point('k', nodes, edges)).toEqual([1]); // `mul(1, 1)`: both sockets unwired in the shader
  });
});

describe('an unknown upstream is unknown — never an invented 0…1', () => {
  it('Position (world) × 2 has no bound ("…"), and a self-bounding op still bounds it', () => {
    const nodes = [makeNode('w', 'positionWorld'), makeNode('m', 'mul', { b: 2 }), makeNode('ss', 'smoothstep', { edge0: 6, edge1: 10 })];
    const edges = [makeEdge('w', 'out', 'm', 'a'), makeEdge('m', 'out', 'ss', 'x')];
    const m = range('m', nodes, edges);
    expect(m.min.every((v) => v === -Infinity) && m.max.every((v) => v === Infinity)).toBe(true);
    expect(range('ss', nodes, edges)).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
  });

  it('distance(Position (world), Camera) is unbounded (it read 0…1 for a wire that is 7…9)', () => {
    const nodes = [makeNode('w', 'positionWorld'), makeNode('c', 'cameraPosition'), makeNode('d', 'distance')];
    const edges = [makeEdge('w', 'out', 'd', 'a'), makeEdge('c', 'out', 'd', 'b')];
    expect(range('d', nodes, edges).max[0]).toBe(Infinity);
  });

  it('a WIRED socket whose upstream has no value makes the node unknown, never its stored number', () => {
    // Mix with t ← length(Position (world)) printed the inline t = 0.5 blend.
    const nodes = [makeNode('w', 'positionWorld'), makeNode('l', 'length'), makeNode('x', 'mix', { a: 0, b: 1, t: 0.5 })];
    const edges = [makeEdge('w', 'out', 'l', 'v'), makeEdge('l', 'out', 'x', 't')];
    expect(point('x', nodes, edges)).toBeNull();
    expect(getFieldUpstreamSet(nodes, edges).has('x')).toBe(true);
  });

  it('Ray Direction is a unit vector, and a field', () => {
    const nodes = [makeNode('r', 'rayDirection'), makeNode('m', 'mul', { b: 0.5 }), makeNode('a', 'add', { b: 0.5 })];
    const edges = [makeEdge('r', 'out', 'm', 'a'), makeEdge('m', 'out', 'a', 'a')];
    expect(range('a', nodes, edges)).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
  });
});

describe('the range rules contain the shader\'s values', () => {
  it('division by a field reaching 0 keeps its finite end: 0.05 / length(uv − ½) is 0.07…∞', () => {
    const nodes = [
      makeNode('u', 'uv'), makeNode('s', 'sub', { b: 0.5 }), makeNode('l', 'length'),
      makeNode('k', 'float', { value: 0.05 }), makeNode('d', 'div'), makeNode('c', 'clamp', { min: 0, max: 1 }),
    ];
    const edges = [
      makeEdge('u', 'out', 's', 'a'), makeEdge('s', 'out', 'l', 'v'),
      makeEdge('k', 'out', 'd', 'a'), makeEdge('l', 'out', 'd', 'b'), makeEdge('d', 'out', 'c', 'x'),
    ];
    const d = range('d', nodes, edges);
    expect(d.min[0]).toBeCloseTo(0.05 / Math.SQRT1_2, 9);
    expect(d.max[0]).toBe(Infinity);
    expect(range('c', nodes, edges).max[0]).toBe(1);
  });

  it('clamp never inverts: clamp(uv, 1.5, 2) is 1.5', () => {
    const nodes = [makeNode('u', 'uv'), makeNode('c', 'clamp', { min: 1.5, max: 2 })];
    expect(range('c', nodes, [makeEdge('u', 'out', 'c', 'x')])).toEqual({ min: [1.5, 1.5], max: [1.5, 1.5] });
  });

  it('clamp reads a vector bound per channel', () => {
    const nodes = [makeNode('u', 'uv'), makeNode('v', 'vec2', { x: 0.5, y: 1 }), makeNode('c', 'clamp', { min: 0 })];
    const edges = [makeEdge('u', 'out', 'c', 'x'), makeEdge('v', 'out', 'c', 'max')];
    expect(range('c', nodes, edges)).toEqual({ min: [0, 0], max: [0.5, 1] });
  });

  it('mix extrapolates when its factor leaves 0…1 (signed Perlin: 0.2 + 0.6t, t in ±1)', () => {
    const nodes = [makeNode('p', 'perlin'), makeNode('x', 'mix', { a: 0.2, b: 0.8 })];
    const r = range('x', nodes, [makeEdge('p', 'out', 'x', 't')]);
    expect(r.min[0]).toBeCloseTo(-0.4, 9);
    expect(r.max[0]).toBeCloseTo(0.8, 9);
  });

  it('remap is unclamped: remap(uv, ¼, ¾ → 0, 2) spans −1…3', () => {
    const nodes = [makeNode('u', 'uv'), makeNode('r', 'remap', { inLow: 0.25, inHigh: 0.75, outLow: 0, outHigh: 2 })];
    expect(range('r', nodes, [makeEdge('u', 'out', 'r', 'x')])).toEqual({ min: [-1, -1], max: [3, 3] });
  });

  it('HSL leaves the unit cube at Saturation 3 (−1…2) and stays in it in gamut', () => {
    const p = makeNode('p', 'perlin', { signed: 0 });
    const out = range('h', [p, makeNode('h', 'hsl', { s: 3, l: 0.5 })], [makeEdge('p', 'out', 'h', 'h')]);
    expect(out).toEqual({ min: [-1, -1, -1], max: [2, 2, 2] });
    const inGamut = range('h', [makeNode('u', 'uv'), makeNode('s', 'split'), makeNode('h', 'hsl', { s: 1 })],
      [makeEdge('u', 'out', 's', 'v'), makeEdge('s', 'x', 'h', 'l')]);
    expect(inGamut).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
  });

  it('sin/cos/fract follow their input: sin(uv·π) is the 0…1 arch', () => {
    const chain = (op: string, k: number) => {
      const nodes = [makeNode('u', 'uv'), makeNode('s', 'split'), makeNode('m', 'mul', { b: k }), makeNode('o', op)];
      const edges = [makeEdge('u', 'out', 's', 'v'), makeEdge('s', 'x', 'm', 'a'), makeEdge('m', 'out', 'o', 'x')];
      return range('o', nodes, edges);
    };
    const s = chain('sin', Math.PI);
    expect(s.min[0]).toBeCloseTo(0, 9);
    expect(s.max[0]).toBe(1);
    expect(chain('cos', 0.5).min[0]).toBeCloseTo(Math.cos(0.5), 9);
    expect(chain('fract', 0.5)).toEqual({ min: [0], max: [0.5] });
  });

  it('Voronoi is a SQUARED distance and fBm sums its octaves — neither is boxed in 0…1', () => {
    expect(range('v', [makeNode('v', 'voronoiVec3')], []).max).toEqual([3, 3, 3.5]);
    expect(range('f', [makeNode('f', 'fbm')], [])).toEqual({ min: [-1.75], max: [1.75] });
  });
});

describe('sources the shader reads but the card misread', () => {
  it('a Colour is LINEAR light, as `color(0x…)` holds it (#808080 is 0.216, not 0.5)', () => {
    const v = point('c', [makeNode('c', 'color', { hex: '#808080' })], [])!;
    for (const ch of v) expect(ch).toBeCloseTo(0.21586, 4);
  });

  it('a Data column is a field bounded by its samples (it read "…", and ×0.1 read "0")', () => {
    const data = makeDataNodeData({ columnNames: ['t'], columns: [[15, 20, 35, 28]], rowCount: 4 }, 0);
    const d = { ...makeNode('d', 'dataNode'), data } as AppNode;
    const nodes = [d, makeNode('m', 'mul', { b: 0.1 })];
    const edges = [makeEdge('d', 'col0', 'm', 'a')];
    expect(evaluateEdgeRange({ source: 'd', sourceHandle: 'col0' }, nodes, edges, 0)).toEqual({ min: [15], max: [35] });
    const m = range('m', nodes, edges);
    expect(m.min[0]).toBeCloseTo(1.5, 5);
    expect(m.max[0]).toBeCloseTo(3.5, 5);
    // A handle naming no column is unknown, never every column at once.
    expect(evaluateEdgeRange({ source: 'd', sourceHandle: 'col7' }, nodes, edges, 0)).toBeNull();
  });

  it('a Sound wire is its live range 0…gain, per socket — never the static 0', () => {
    const nodes = [makeNode('s', 'soundNode', { gain: 3 }), makeNode('m', 'mul', { b: 2 })];
    const edges = [makeEdge('s', 'bass', 'm', 'a')];
    expect(evaluateEdgeRange({ source: 's', sourceHandle: 'bass' }, nodes, edges, 0)).toEqual({ min: [0], max: [3] });
    expect(range('m', nodes, edges)).toEqual({ min: [0], max: [6] });
    expect(getFieldUpstreamSet(nodes, edges).has('m')).toBe(true);
  });
});

describe('point values agree with the emitted code', () => {
  it('mixed widths pad as TSL pads (vec2 × vec3 is (2, 3, 0), not (2, 3, 2))', () => {
    const nodes = [makeNode('a', 'vec2', { x: 2, y: 3 }), makeNode('b', 'vec3', { x: 1, y: 1, z: 1 }), makeNode('m', 'mul')];
    expect(point('m', nodes, [makeEdge('a', 'out', 'm', 'a'), makeEdge('b', 'out', 'm', 'b')])).toEqual([2, 3, 0]);
  });

  it('a vector into a constructor socket spreads as JoinNode does: vec3(vec2(.3, .7), .25, .5) is (.3, .7, .25)', () => {
    const nodes = [makeNode('a', 'vec2', { x: 0.3, y: 0.7 }), makeNode('v', 'vec3', { y: 0.25, z: 0.5 })];
    expect(point('v', nodes, [makeEdge('a', 'out', 'v', 'x')])).toEqual([0.3, 0.7, 0.25]);
  });

  it('Select reads a comparison vector with all(), not channel 0', () => {
    const nodes = [
      makeNode('v', 'vec3', { x: 0.9, y: 0.2, z: 0.7 }), makeNode('g', 'greaterThan', { b: 0.5 }),
      makeNode('s', 'select', { a: 1, b: 0 }),
    ];
    const edges = [makeEdge('v', 'out', 'g', 'a'), makeEdge('g', 'out', 's', 'condition')];
    expect(point('s', nodes, edges)).toEqual([0]);
  });

  it('HSL wraps any hue, as the helper\'s mod(h·6, 6) does (Time → Hue turned black after 2 s)', () => {
    const nodes = [makeNode('t', 'time'), makeNode('h', 'hsl', { s: 1, l: 0.5 })];
    const rgb = point('h', nodes, [makeEdge('t', 'out', 'h', 'h')], 2)!;
    expect(rgb[0]).toBeCloseTo(1, 9);
    expect(rgb[1]).toBeCloseTo(0, 9);
    expect(rgb[2]).toBeCloseTo(0, 9);
  });

  it('round is WGSL\'s half-to-even', () => {
    const r = (v: number) => point('r', [makeNode('f', 'float', { value: v }), makeNode('r', 'round')], [makeEdge('f', 'out', 'r', 'x')])![0];
    expect(r(0.5)).toBe(0);
    expect(r(1.5)).toBe(2);
    expect(r(2.5)).toBe(2);
    expect(r(-0.5)).toBe(0);
    expect(r(1.7)).toBe(2);
  });

  it('equal smoothstep edges have no value (WebGPU refuses the module), not a width-1 ramp', () => {
    const nodes = [makeNode('f', 'float', { value: 0.7 }), makeNode('s', 'smoothstep', { edge0: 0.5, edge1: 0.5 })];
    expect(point('s', nodes, [makeEdge('f', 'out', 's', 'x')])).toEqual([NaN]);
  });

  it('Transform reads its vec3 Move socket (the twin read the retired tx/ty/tz ids)', () => {
    const nodes = [
      makeNode('p', 'vec3', { x: 0.6, y: 0, z: 0 }), makeNode('t', 'vec3', { x: 0.6, y: 0, z: 0 }),
      makeNode('tr', 'sdfTransform'), makeNode('c', 'sdCircle', { r: 0.3 }),
    ];
    const edges = [makeEdge('p', 'out', 'tr', 'p'), makeEdge('t', 'out', 'tr', 't'), makeEdge('tr', 'out', 'c', 'p')];
    expect(point('tr', nodes, edges)).toEqual([0, 0, 0]);
    expect(point('c', nodes, edges)![0]).toBeCloseTo(-0.3, 12);
  });

  it('a vec2 into a vec3 socket pads with 0 (Plane normal vec2(0, 1) is (0, 1, 0))', () => {
    const nodes = [makeNode('p', 'vec3', { x: 0.3, y: -0.4, z: 0.5 }), makeNode('n', 'vec2', { x: 0, y: 1 }), makeNode('pl', 'sdPlane', { h: 0 })];
    const edges = [makeEdge('p', 'out', 'pl', 'p'), makeEdge('n', 'out', 'pl', 'n')];
    expect(point('pl', nodes, edges)![0]).toBeCloseTo(-0.4, 12);
  });
});

/**
 * The SDF family: a primitive is an EXACT distance, so over a position box it
 * lies within its value at the centre ± the box's half diagonal; the domain
 * operators carry positions. Each sweep holds the interval over a FIELD
 * position to the twin's own value at sampled constant positions inside it.
 */
describe('distance fields — bounded, and containing every sample', () => {
  const samples3 = (n: number, s: number) => {
    const out: number[][] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      out.push([-s + (2 * s * i) / (n - 1), -s + (2 * s * j) / (n - 1), -s + (2 * s * k) / (n - 1)]);
    }
    return out;
  };

  /** The node fed by a ±1 position field (range) and by constant points (samples). */
  const sweep3 = (type: string, values: Record<string, string | number>, port = 'p') => {
    const r = range('n', [makeNode('pg', 'positionGeometry'), makeNode('n', type, values)], [makeEdge('pg', 'out', 'n', port)]);
    const vals = samples3(7, 1).map(([x, y, z]) =>
      point('n', [makeNode('v', 'vec3', { x, y, z }), makeNode('n', type, values)], [makeEdge('v', 'out', 'n', port)])!);
    return { r, vals };
  };

  for (const [type, values] of [
    ['sdBox', { b: 0.4, round: 0.05 }], ['sdTorus', {}], ['sdCylinder', {}], ['sdCapsule', {}], ['sdCone', {}],
    ['sdPlane', { n: 0.7, h: 0.1 }], ['sdOctahedron', {}],
  ] as [string, Record<string, number>][]) {
    it(`${type}: the Lipschitz bound contains the twin over the ±1 box`, () => {
      const { r, vals } = sweep3(type, values);
      expect(r.min[0]).toBeGreaterThan(-Infinity);
      expectContains(r, vals, type);
    });
  }

  it('2D shapes over a centred UV: a Box (or a Star) reads its signed span, not "…" or 0…1', () => {
    for (const type of ['sdBox', 'sdStar']) {
      const nodes = [makeNode('u', 'uv'), makeNode('s', 'sub', { b: 0.5 }), makeNode('n', type)];
      const r = range('n', nodes, [makeEdge('u', 'out', 's', 'a'), makeEdge('s', 'out', 'n', 'p')]);
      const vals = grid(17).map(([u, v]) =>
        point('n', [makeNode('c', 'vec2', { x: u - 0.5, y: v - 0.5 }), makeNode('n', type)], [makeEdge('c', 'out', 'n', 'p')])!);
      expect(r.min[0]).toBeLessThan(0);
      expectContains(r, vals, type);
    }
  });

  it('a shape parameter that varies over the surface leaves the bound unknown rather than guessing', () => {
    // (A Time-driven one is a constant at each instant — the label ticks it.)
    const nodes = [makeNode('pg', 'positionGeometry'), makeNode('u', 'uv'), makeNode('s', 'split'), makeNode('n', 'sdTorus')];
    const edges = [makeEdge('pg', 'out', 'n', 'p'), makeEdge('u', 'out', 's', 'v'), makeEdge('s', 'x', 'n', 'tubeR')];
    expect(evaluateNodeRange('n', nodes, edges, 0)).toBeNull();
    const timed = [makeNode('pg', 'positionGeometry'), makeNode('t', 'time'), makeNode('n', 'sdTorus')];
    expect(range('n', timed, [makeEdge('pg', 'out', 'n', 'p'), makeEdge('t', 'out', 'n', 'tubeR')], 0.1).max[0]).toBeLessThan(Infinity);
  });

  for (const [type, values] of [
    ['sdfTransform', { t: 0.3, s: 2 }], ['sdfTransform', { r: 30 }], ['sdfMirror', { m: 0.5 }], ['sdfMirror', {}],
    ['sdfRevolve', {}], ['sdfRepeatPolar', {}], ['sdfRepeat', { s: 0.4 }], ['sdfRepeat', { s: 0.4, l: 1 }],
    ['sdfDeform', { mode: 'twist', amount: 2 }], ['sdfDeform', { mode: 'bend', amount: 2 }],
    ['sdfDeform', { mode: 'elongate', h: 0.3 }],
  ] as [string, Record<string, string | number>][]) {
    it(`${type} ${JSON.stringify(values)}: the position bound contains every moved sample`, () => {
      const { r, vals } = sweep3(type, values);
      expect(r.min.every(Number.isFinite) && r.max.every(Number.isFinite)).toBe(true);
      expectContains(r, vals, type);
    });
  }

  it('Extrude is monotone in the 2D distance and the depth', () => {
    const circle = (p: AppNode) => [p, makeNode('c', 'sdCircle', { r: 0.3 }), makeNode('e', 'sdfExtrude', { h: 0.2 })];
    const r = range('e', circle(makeNode('pg', 'positionGeometry')),
      [makeEdge('pg', 'out', 'c', 'p'), makeEdge('c', 'out', 'e', 'd'), makeEdge('pg', 'out', 'e', 'p')]);
    const vals = samples3(7, 1).map(([x, y, z]) =>
      point('e', circle(makeNode('v', 'vec3', { x, y, z })), [makeEdge('v', 'out', 'c', 'p'), makeEdge('c', 'out', 'e', 'd'), makeEdge('v', 'out', 'e', 'p')])!);
    expectContains(r, vals, 'extrude');
  });
});

describe('data viz — bounded by what the shader computes', () => {
  const column = () => {
    const data = makeDataNodeData({ columnNames: ['T'], columns: [[251, 262, 275, 288, 296, 303, 309]], rowCount: 7 }, 0);
    return { ...makeNode('d', 'dataNode'), data } as AppNode;
  };

  it('Data Range maps the column through its plan; unclamped it overshoots 0…1 as the shader does', () => {
    const open = range('r', [column(), makeNode('r', 'dataRange', { mode: 'manual', domainMin: 260, domainMax: 300, clamp: 0 })],
      [makeEdge('d', 'col0', 'r', 'value')]);
    expect(open.min[0]).toBeCloseTo((251 - 260) / 40, 9);
    expect(open.max[0]).toBeCloseTo((309 - 260) / 40, 9);
    const clamped = range('r', [column(), makeNode('r', 'dataRange', { mode: 'manual', domainMin: 260, domainMax: 300 })],
      [makeEdge('d', 'col0', 'r', 'value')]);
    expect(clamped).toEqual({ min: [0], max: [1] });
    // min-max over the column's own statistics spans exactly 0…1.
    const mm = range('r', [column(), makeNode('r', 'dataRange', { mode: 'minmax', clamp: 0 })], [makeEdge('d', 'col0', 'r', 'value')]);
    expect(mm.min[0]).toBeCloseTo(0, 9);
    expect(mm.max[0]).toBeCloseTo(1, 9);
  });

  it('Colormap is 0…1 per channel, and a Data Viz value socket its own t', () => {
    expect(range('c', [makeNode('c', 'colormap')], [])).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    const nodes = [makeNode('v', 'dataviz', { lowColor: '#000000', highColor: '#ffffff' })];
    expect(evaluateEdgeRange({ source: 'v', sourceHandle: 'value' }, nodes, [], 0)).toEqual({ min: [0], max: [1] });
    expect(evaluateEdgeRange({ source: 'v', sourceHandle: 'out' }, nodes, [], 0)).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
  });

  it('Stripes carry a wired ramp end past 1 (it read 0…1 for white × 4)', () => {
    const nodes = [makeNode('c', 'color', { hex: '#ffffff' }), makeNode('m', 'mul', { b: 4 }), makeNode('s', 'stripes', { lineStrength: 0.5 })];
    const r = range('s', nodes, [makeEdge('c', 'out', 'm', 'a'), makeEdge('m', 'out', 's', 'highColor')]);
    expect(r.max).toEqual([4, 4, 4]);
  });
});

/**
 * Review round (2026-10-27): every confirmed finding of the six-lens review of
 * this change, each measured against the emitted TSL / three r184 semantics.
 */
describe('review round — the twins read what the helpers read', () => {
  it('a SCALAR position splats through every swizzle, as SplitNode does', () => {
    // A typed 0.5 in the Position box emits `sdTorus(0.5, …)`: the helper's
    // length(p.xz) is |(0.5, 0.5)|, not |(0.5, 0)| — outside, not inside.
    const torus = point('n', [makeNode('n', 'sdTorus', { p: 0.5 })], [])![0];
    expect(torus).toBeCloseTo(Math.hypot(Math.hypot(0.5, 0.5) - 0.5, 0.5) - 0.15, 12);
    const box = point('n', [makeNode('n', 'sdBox', { p: 0.8, b: 0.5 })], [])![0];
    expect(box).toBeCloseTo(Math.hypot(0.3, 0.3, 0.3), 12);
    expect(point('n', [makeNode('n', 'sdfTransform', { p: 0.5 })], [])).toEqual([0.5, 0.5, 0.5]);
    const ex = point('n', [makeNode('n', 'sdfExtrude', { p: 0.5, d: -0.5, h: 0.2 })], [])![0];
    expect(ex).toBeCloseTo(0.3, 12);
  });

  it('a scalar FIELD position keeps the Lipschitz bound sound (the box is the splatted one)', () => {
    const nodes = [makeNode('u', 'uv'), makeNode('s', 'split'), makeNode('m', 'mul', { b: 0.2 }), makeNode('a', 'add', { b: 0.9 }), makeNode('n', 'sdBox')];
    const edges = [makeEdge('u', 'out', 's', 'v'), makeEdge('s', 'x', 'm', 'a'), makeEdge('m', 'out', 'a', 'a'), makeEdge('a', 'out', 'n', 'p')];
    const r = range('n', nodes, edges);
    const vals = Array.from({ length: 21 }, (_, i) => 0.9 + (0.2 * i) / 20)
      .map((v) => point('n', [makeNode('n', 'sdBox', { p: v })], [])!);
    expectContains(r, vals, 'scalar box');
  });

  it('Star reads |p| over the position\'s own channels', () => {
    const star = point('n', [makeNode('v', 'vec3', { x: 0.3, y: 0.2, z: 0.5 }), makeNode('n', 'sdStar')], [makeEdge('v', 'out', 'n', 'p')])![0];
    // length(pIn) is the 3-D length: the twin read |(x, y)| alone (0.07 vs 0.255).
    expect(star).toBeCloseTo(0.2554, 3);
  });

  it('a dangling Split into Append keeps the operand codegen emits (`vec4(0, 0, 0, 0)`)', () => {
    const nodes = [makeNode('s', 'split'), makeNode('ap', 'append')];
    const edges = ['x', 'y', 'z', 'w'].map((h, i) => makeEdge('s', h, 'ap', 'abcd'[i]));
    expect(point('ap', nodes, edges)).toEqual([0, 0, 0, 0]);
  });

  it('a non-swizzle Split handle carries nothing (a tampered `out` read the whole padded vector)', () => {
    const nodes = [makeNode('v', 'vec3', { x: 5, y: 6, z: 7 }), makeNode('s', 'split'), makeNode('m', 'mul', { b: 2 })];
    const edges = [makeEdge('v', 'out', 's', 'v'), makeEdge('s', 'out', 'm', 'a')];
    expect(evaluateEdgeSource({ source: 's', sourceHandle: 'out' }, nodes, edges, 0)).toBeNull();
    expect(evaluateEdgeRange({ source: 's', sourceHandle: null }, nodes, edges, 0)).toBeNull();
    expect(point('m', nodes, edges)).toEqual([2]); // `mul(1, 2)`
  });

  it('Select builds both branches at the wider type', () => {
    const sel = (t: AppNode, f: AppNode) => point('s', [t, f, makeNode('s', 'select', { condition: 0 })],
      [makeEdge(t.id, 'out', 's', 'a'), makeEdge(f.id, 'out', 's', 'b')]);
    expect(sel(makeNode('t', 'vec2', { x: 1, y: 2 }), makeNode('f', 'float', { value: 0.3 }))).toEqual([0.3, 0.3]);
    expect(sel(makeNode('t', 'vec3', { x: 1, y: 2, z: 3 }), makeNode('f', 'vec2', { x: 0.5, y: 0.7 }))).toEqual([0.5, 0.7, 0]);
  });

  it('pow has no value for a negative base, and its range bounds the in-domain part', () => {
    const p = point('p', [makeNode('f', 'float', { value: -2 }), makeNode('p', 'pow', { exp: 2 })], [makeEdge('f', 'out', 'p', 'base')]);
    expect(p).toEqual([NaN]);
    const r = range('p', [makeNode('n', 'perlin'), makeNode('p', 'pow', { exp: 2 })], [makeEdge('n', 'out', 'p', 'base')]);
    expect(r).toEqual({ min: [0], max: [1] });
  });

  it('a mode reads only the sockets its helper takes (xor has no Smoothness)', () => {
    const nodes = [
      makeNode('w', 'positionWorld'), makeNode('l', 'length'),
      makeNode('c', 'sdCombine', { mode: 'xor', a: 0.2, b: 0.5 }),
    ];
    expect(point('c', nodes, [makeEdge('w', 'out', 'l', 'v'), makeEdge('l', 'out', 'c', 'k')])).toEqual([0.2]);
  });

  it('Extrude with a wired position that has no value is unknown, not z = 0', () => {
    const nodes = [makeNode('w', 'positionWorld'), makeNode('e', 'sdfExtrude', { d: 0.1, h: 0.2 })];
    expect(point('e', nodes, [makeEdge('w', 'out', 'e', 'p')])).toBeNull();
  });

  it('Elongate with a half size that can go below 0 is unknown (low > high in its clamp)', () => {
    const nodes = [makeNode('pg', 'positionGeometry'), makeNode('n', 'perlin'), makeNode('d', 'sdfDeform', { mode: 'elongate' })];
    const r = range('d', nodes, [makeEdge('pg', 'out', 'd', 'p'), makeEdge('n', 'out', 'd', 'h')]);
    expect(r.min.every((v) => v === -Infinity)).toBe(true);
  });

  it('a primitive outside its exact-distance domain gets no Lipschitz bound', () => {
    const at = (type: string, values: Record<string, number>) =>
      evaluateNodeRange('n', [makeNode('u', 'uv'), makeNode('n', type, values)], [makeEdge('u', 'out', 'n', 'p')], 0);
    expect(at('sdStar', { n: 1 })).toBeNull();
    expect(at('sdStar', { m: 1 })).toBeNull();
    expect(at('sdOctahedron', { s: -0.3 })).toBeNull();
    expect(at('sdStar', {})).not.toBeNull();
  });

  it('Smoothstep and Remap apply a vector bound per channel (MathNode / OperatorNode widths)', () => {
    const e0 = makeNode('e0', 'vec3', { x: 0, y: 0.4, z: 0 }), e1 = makeNode('e1', 'vec3', { x: 0.1, y: 0.5, z: 0.1 });
    const ss = point('s', [e0, e1, makeNode('x', 'float', { value: 0.45 }), makeNode('s', 'smoothstep')],
      [makeEdge('e0', 'out', 's', 'edge0'), makeEdge('e1', 'out', 's', 'edge1'), makeEdge('x', 'out', 's', 'x')])!;
    expect(ss[0]).toBe(1);
    expect(ss[1]).toBeCloseTo(0.5, 12);
    expect(ss[2]).toBe(1);
    const rm = point('r', [e0, makeNode('x', 'float', { value: 0.45 }), makeNode('r', 'remap', { inHigh: 1 })],
      [makeEdge('e0', 'out', 'r', 'inLow'), makeEdge('x', 'out', 'r', 'x')])!;
    expect(rm[0]).toBeCloseTo(0.45, 12);
    expect(rm[1]).toBeCloseTo(0.05 / 0.6, 12);
    expect(rm[2]).toBeCloseTo(0.45, 12);
  });

  it('a Sound- or camera-built vec2 is a range on a label but NOT a surface coordinate', () => {
    const nodes = [makeNode('s', 'soundNode'), makeNode('ap', 'append')];
    const edges = [makeEdge('s', 'level', 'ap', 'a'), makeEdge('s', 'bass', 'ap', 'b')];
    expect(getFieldUpstreamSet(nodes, edges).has('ap')).toBe(true);
    expect(getSurfaceFieldUpstreamSet(nodes, edges).has('ap')).toBe(false);
    const uvNodes = [makeNode('u', 'uv'), makeNode('m', 'mul', { b: 2 })];
    expect(getSurfaceFieldUpstreamSet(uvNodes, [makeEdge('u', 'out', 'm', 'a')]).has('m')).toBe(true);
  });
});

describe('soundness sweep — the review round\'s shapes', () => {
  /** A scalar field position v ∈ [lo, hi] (uv.x stretched), and the twin at constant v. */
  const scalarSweep = (type: string, values: Record<string, string | number>, port = 'p') => {
    const field = [makeNode('u', 'uv'), makeNode('s', 'split'), makeNode('m', 'mul', { b: 1.6 }), makeNode('a', 'sub', { b: 0.8 })];
    const fe = [makeEdge('u', 'out', 's', 'v'), makeEdge('s', 'x', 'm', 'a'), makeEdge('m', 'out', 'a', 'a')];
    const r = range('n', [...field, makeNode('n', type, values)], [...fe, makeEdge('a', 'out', 'n', port)]);
    const vals = Array.from({ length: 33 }, (_, i) => -0.8 + (1.6 * i) / 32)
      .map((v) => point('n', [makeNode('f', 'float', { value: v }), makeNode('n', type, values)], [makeEdge('f', 'out', 'n', port)])!);
    return { r, vals };
  };

  for (const [type, values] of [
    ['sdBox', {}], ['sdTorus', {}], ['sdCylinder', {}], ['sdCapsule', {}], ['sdCone', {}], ['sdPlane', {}],
    ['sdOctahedron', {}], ['sdStar', {}], ['sdfTransform', { r: 20 }], ['sdfMirror', { m: 0.5 }], ['sdfRevolve', {}],
    ['sdfRepeat', { s: 0.3 }], ['sdfRepeatPolar', {}], ['sdfDeform', { mode: 'twist' }], ['sdfDeform', { mode: 'elongate', h: 0.2 }],
  ] as [string, Record<string, string | number>][]) {
    it(`${type} ${JSON.stringify(values)} over a SCALAR position`, () => {
      const { r, vals } = scalarSweep(type, values);
      expectContains(r, vals.filter((v) => v.every(Number.isFinite)), type);
    });
  }

  it('Smoothstep with vector edges over a field x', () => {
    const e0 = makeNode('e0', 'vec3', { x: 0, y: 0.4, z: 0.2 }), e1 = makeNode('e1', 'vec3', { x: 0.1, y: 0.5, z: 0.9 });
    const ends = [makeEdge('e0', 'out', 's', 'edge0'), makeEdge('e1', 'out', 's', 'edge1')];
    const r = range('s', [makeNode('u', 'uv'), makeNode('sp', 'split'), e0, e1, makeNode('s', 'smoothstep')],
      [makeEdge('u', 'out', 'sp', 'v'), makeEdge('sp', 'x', 's', 'x'), ...ends]);
    const vals = Array.from({ length: 41 }, (_, i) => i / 40).map((v) =>
      point('s', [makeNode('x', 'float', { value: v }), e0, e1, makeNode('s', 'smoothstep')], [makeEdge('x', 'out', 's', 'x'), ...ends])!);
    expectContains(r, vals, 'smoothstep vec edges');
  });

  it('Remap with a vector In Low over a field x', () => {
    const lo = makeNode('lo', 'vec3', { x: 0, y: 0.4, z: -0.5 });
    const r = range('r', [makeNode('u', 'uv'), makeNode('sp', 'split'), lo, makeNode('r', 'remap', { inHigh: 1, outHigh: 2 })],
      [makeEdge('u', 'out', 'sp', 'v'), makeEdge('sp', 'x', 'r', 'x'), makeEdge('lo', 'out', 'r', 'inLow')]);
    const vals = Array.from({ length: 41 }, (_, i) => i / 40).map((v) =>
      point('r', [makeNode('x', 'float', { value: v }), lo, makeNode('r', 'remap', { inHigh: 1, outHigh: 2 })],
        [makeEdge('x', 'out', 'r', 'x'), makeEdge('lo', 'out', 'r', 'inLow')])!);
    expectContains(r, vals, 'remap vec bound');
  });
});

/**
 * Soundness sweep: for each op, the interval over a uv.x field must CONTAIN
 * the op's own point value at every sampled u — the same evaluator, with a
 * Float standing in for the field at that point. An unsound rule (the old div
 * and clamp, the cycling broadcast) fails here whatever node it sits on.
 */
describe('soundness sweep — every op\'s interval contains its own samples', () => {
  const samples = Array.from({ length: 41 }, (_, i) => -2 + (i / 40) * 5); // −2 … 3

  const fieldChain = (op: string, port: string, extra: Record<string, number>, k: number) => {
    // uv.x · k − 1: a field spanning [−1, k − 1].
    const nodes = [
      makeNode('u', 'uv'), makeNode('s', 'split'), makeNode('m', 'mul', { b: k }), makeNode('a', 'sub', { b: 1 }),
      makeNode('o', op, extra),
    ];
    const edges = [
      makeEdge('u', 'out', 's', 'v'), makeEdge('s', 'x', 'm', 'a'), makeEdge('m', 'out', 'a', 'a'),
      makeEdge('a', 'out', 'o', port),
    ];
    return range('o', nodes, edges);
  };
  const atPoint = (op: string, port: string, extra: Record<string, number>, v: number) =>
    point('o', [makeNode('f', 'float', { value: v }), makeNode('o', op, extra)], [makeEdge('f', 'out', 'o', port)]);

  const CASES: [string, string, Record<string, number>][] = [
    ['sin', 'x', {}], ['cos', 'x', {}], ['fract', 'x', {}], ['abs', 'x', {}], ['floor', 'x', {}],
    ['round', 'x', {}], ['oneMinus', 'x', {}], ['exp', 'x', {}], ['sqrt', 'x', {}], ['log2', 'x', {}],
    ['smoothstep', 'x', { edge0: 0.2, edge1: 0.8 }], ['smoothstep', 'x', { edge0: 0.8, edge1: 0.2 }],
    ['clamp', 'x', { min: 0.25, max: 0.5 }], ['remap', 'x', { inLow: 0.25, inHigh: 0.75, outLow: 0, outHigh: 2 }],
    ['mix', 't', { a: 0.2, b: 0.8 }], ['mod', 'x', { y: 0.75 }], ['mod', 'x', { y: -0.75 }],
    ['div', 'b', { a: 1 }], ['div', 'a', { b: -0.5 }], ['pow', 'base', { exp: 2 }],
    ['min', 'a', { b: 0.3 }], ['max', 'a', { b: 0.3 }], ['greaterThan', 'a', { b: 0.3 }],
    ['hsl', 'l', { s: 2 }], ['hsl', 'h', { s: 1.5, l: 0.6 }],
  ];

  for (const [op, port, extra] of CASES) {
    it(`${op}(${port}) ${JSON.stringify(extra)}`, () => {
      for (const k of [0.5, 3]) {
        const r = fieldChain(op, port, extra, k);
        const vals = samples
          .filter((v) => v >= -1 && v <= k - 1)
          .map((v) => atPoint(op, port, extra, v))
          .filter((p): p is number[] => !!p && p.every(Number.isFinite));
        expectContains(r, vals, `${op} k=${k}`);
      }
    });
  }
});

describe('the label reads the wire the SHADER reads', () => {
  it('a vector in a chain growth socket widens the result (an Append after it emitted vec2(div1, 3))', () => {
    const nodes = [
      makeNode('f', 'float', { value: 1 }), makeNode('g', 'float', { value: 2 }), makeNode('ap', 'append'),
      makeNode('d', 'div'), makeNode('ap2', 'append', { b: 3 }), makeNode('o', 'output'),
    ];
    const edges = [
      makeEdge('f', 'out', 'ap', 'a'), makeEdge('g', 'out', 'ap', 'b'), makeEdge('f', 'out', 'd', 'a'),
      makeEdge('ap', 'out', 'd', 'c'), makeEdge('d', 'out', 'ap2', 'a'), makeEdge('ap2', 'out', 'o', 'color'),
    ];
    expect(getNodeOutputShape('d', nodes, edges)).toBe(2);
    expect(graphToCode(nodes, edges).code).toContain('const append2 = vec3(div1, 3);');
    expect(point('ap2', nodes, edges)).toEqual([1, 0.5, 3]);
  });

  it('two wires into one socket: the FIRST is the one codegen reads — dead, so the socket is unwired', () => {
    const nodes = [makeNode('i', 'int', { value: 7 }), makeNode('j', 'int', { value: 2 }), makeNode('sp', 'split'), makeNode('d', 'div'), makeNode('o', 'output')];
    const edges = [
      makeEdge('i', 'out', 'd', 'a'), makeEdge('sp', 'x', 'd', 'b'), { ...makeEdge('j', 'out', 'd', 'b'), id: 'second-into-b' },
      makeEdge('d', 'out', 'o', 'color'),
    ];
    expect(graphToCode(nodes, edges).code).toContain('div(float(int1), 1)');
    expect(point('d', nodes, edges)).toEqual([7]);
  });
});

describe('the WIDTH of a node is what three builds', () => {
  it('a node met again on another path keeps its width (one walk-wide guard read it as a scalar)', () => {
    // Case A: Add#1 is reached first through Mul's growth socket c, then again as Append.b.
    const nodes = [
      makeNode('v1', 'vec2', { x: 0.75, y: 0.3 }), makeNode('v2', 'vec2', { x: 0.25, y: 0.5 }),
      makeNode('a1', 'add'), makeNode('m', 'mul', { b: 2 }), makeNode('ap', 'append'), makeNode('o', 'output'),
    ];
    const edges = [
      makeEdge('v1', 'out', 'a1', 'a'), makeEdge('v2', 'out', 'm', 'a'), makeEdge('a1', 'out', 'm', 'c'),
      makeEdge('m', 'out', 'ap', 'a'), makeEdge('a1', 'out', 'ap', 'b'), makeEdge('ap', 'out', 'o', 'color'),
    ];
    expect(getNodeOutputShape('ap', nodes, edges)).toBe(4);
    expect(graphToCode(nodes, edges).code).toContain('return vec3(append1);'); // w never reaches alpha
    // Case B: the wrong Box helper on a vec3.
    const box = [
      makeNode('v', 'vec2', { x: 0.4, y: 0.5 }), makeNode('a1', 'add'), makeNode('f1', 'float', { value: 0.1 }),
      makeNode('f2', 'float', { value: 0.2 }), makeNode('a2', 'add'), makeNode('f3', 'float', { value: 0.9 }),
      makeNode('ap', 'append'), makeNode('a3', 'add'), makeNode('b', 'sdBox'), makeNode('o', 'output'),
    ];
    const boxEdges = [
      makeEdge('v', 'out', 'a1', 'a'), makeEdge('f1', 'out', 'a2', 'a'), makeEdge('f2', 'out', 'a2', 'b'),
      makeEdge('a1', 'out', 'a2', 'c'), makeEdge('a1', 'out', 'ap', 'a'), makeEdge('f3', 'out', 'ap', 'b'),
      makeEdge('a2', 'out', 'a3', 'a'), makeEdge('ap', 'out', 'a3', 'b'), makeEdge('a3', 'out', 'b', 'p'),
      makeEdge('b', 'out', 'o', 'color'),
    ];
    expect(getNodeOutputShape('a3', box, boxEdges)).toBe(3);
    expect(graphToCode(box, boxEdges).code).toContain('sdBox3(add3');
  });

  it("Mod's divisor and Select's condition never widen the result (a scalar leaked into alpha)", () => {
    const mod = [makeNode('f', 'float', { value: 0.3 }), makeNode('v', 'vec3', { x: 1, y: 1, z: 1 }), makeNode('md', 'mod'), makeNode('o', 'output')];
    const modEdges = [makeEdge('f', 'out', 'md', 'x'), makeEdge('v', 'out', 'md', 'y'), makeEdge('md', 'out', 'o', 'color')];
    expect(getNodeOutputShape('md', mod, modEdges)).toBe(1);
    expect(graphToCode(mod, modEdges).code).toContain('return vec3(mod1);');
    const sel = [
      makeNode('v1', 'vec3', { x: 1, y: 1, z: 1 }), makeNode('v0', 'vec3', { x: 0, y: 0, z: 0 }), makeNode('gt', 'greaterThan'),
      makeNode('a', 'float', { value: 0.3 }), makeNode('b', 'float', { value: 0.6 }), makeNode('s', 'select'), makeNode('o', 'output'),
    ];
    const selEdges = [
      makeEdge('v1', 'out', 'gt', 'a'), makeEdge('v0', 'out', 'gt', 'b'), makeEdge('gt', 'out', 's', 'condition'),
      makeEdge('a', 'out', 's', 'a'), makeEdge('b', 'out', 's', 'b'), makeEdge('s', 'out', 'o', 'color'),
    ];
    expect(getNodeOutputShape('s', sel, selEdges)).toBe(1);
    expect(graphToCode(sel, selEdges).code).toContain('return vec3(select1);');
  });
});

describe('a wire codegen ignores neither animates a constant nor makes it a range', () => {
  const modWithSecondY = (second: AppNode, handle: string): [AppNode[], AppEdge[]] => [
    [makeNode('i', 'int', { value: 7 }), makeNode('j', 'int', { value: 2 }), second, makeNode('md', 'mod'), makeNode('o', 'output')],
    [
      makeEdge('i', 'out', 'md', 'x'), makeEdge('j', 'out', 'md', 'y'),
      { ...makeEdge(second.id, handle, 'md', 'y'), id: 'ignored-second-y' }, makeEdge('md', 'out', 'o', 'color'),
    ],
  ];

  it('a second wire from a field is not the field the socket reads', () => {
    const [nodes, edges] = modWithSecondY(makeNode('u', 'uv'), 'out');
    expect(getFieldUpstreamSet(nodes, edges).has('md')).toBe(false);
    expect(range('md', nodes, edges)).toEqual({ min: [1], max: [1] });
  });

  it('a second wire from Time does not make a constant tick', () => {
    const [nodes, edges] = modWithSecondY(makeNode('t', 'time'), 'out');
    expect(getTimeUpstreamSet(nodes, edges).has('md')).toBe(false);
  });
});
