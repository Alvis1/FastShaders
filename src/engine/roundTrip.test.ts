/**
 * Round-trip invariant tests for the graphToCode ↔ codeToGraph pair.
 *
 * The contract we care about: starting from a graph G,
 *   code1 = graphToCode(G)
 *   G' = codeToGraph(code1)
 *   code2 = graphToCode(G')
 *   code1 === code2
 *
 * Node IDs are timestamps (non-deterministic across runs), so we compare on
 * the canonical text output instead. This catches the entire class of subtle
 * codegen-vs-parser mismatches — variable naming, import collection, hex
 * formatting, swizzle inlining, noise scale wrapping, etc.
 */
import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { makeNode, makeEdge } from '@/test-utils';
import { getNodeValues } from '@/types';
import type { AppNode, AppEdge } from '@/types';

function roundTrip(nodes: AppNode[], edges: AppEdge[]): { code1: string; code2: string } {
  const code1 = graphToCode(nodes, edges).code;
  const parsed = codeToGraph(code1);
  // The parser must not produce errors that block the sync (warnings on
  // unknown functions are fine — `severity: 'warning'` doesn't block sync).
  const blockers = parsed.errors.filter((e) => e.severity !== 'warning');
  if (blockers.length > 0) {
    throw new Error(
      `codeToGraph reported blocking errors during round-trip:\n${blockers.map((e) => e.message).join('\n')}\n--- code1 ---\n${code1}`,
    );
  }
  const code2 = graphToCode(parsed.nodes, parsed.edges).code;
  return { code1, code2 };
}

describe('round-trip: graphToCode → codeToGraph → graphToCode is stable', () => {
  it('color → output', () => {
    const c = makeNode('c', 'color', { hex: '#ff8800' });
    const out = makeNode('out', 'output');
    const { code1, code2 } = roundTrip([c, out], [makeEdge('c', 'out', 'out', 'color')]);
    expect(code2).toBe(code1);
  });

  it('vec3 constant → output', () => {
    const v = makeNode('v', 'vec3', { x: 0.1, y: 0.2, z: 0.3 });
    const out = makeNode('out', 'output');
    const { code1, code2 } = roundTrip([v, out], [makeEdge('v', 'out', 'out', 'color')]);
    expect(code2).toBe(code1);
  });

  it('time with a speed multiplier', () => {
    const t = makeNode('t', 'time', { speed: 2.5 });
    const out = makeNode('out', 'output');
    const { code1, code2 } = roundTrip([t, out], [makeEdge('t', 'out', 'out', 'opacity')]);
    expect(code2).toBe(code1);
    // Text stability alone is not enough here: the broken `time(1)` form is also
    // text-stable and raises no blocking error, so pin the literal shape too.
    expect(code1).toContain('const time1 = time.mul(2.5);');
  });

  it('a scalar driving Color (the vec3 widening)', () => {
    // graphToCode widens the scalar to `vec3(noise1)` so it can't leak into
    // alpha; codeToGraph has to unwrap that back to a plain Noise→Color edge.
    // Without the unwrap the parse grows a Vec3 node whose y/z default to 0,
    // and the re-emit turns a grey ramp red — text-unstable AND wrong.
    const n = makeNode('n', 'perlin');
    const out = makeNode('out', 'output');
    const { code1, code2 } = roundTrip([n, out], [makeEdge('n', 'out', 'out', 'color')]);
    expect(code2).toBe(code1);
    expect(code1).toContain('return vec3(noise1);');
    // The graph must come back unchanged — no Vec3 node conjured by the parse.
    const parsed = codeToGraph(code1);
    expect(parsed.nodes.filter((x) => x.data.registryType === 'vec3')).toHaveLength(0);
  });

  it('time with a WIRED speed socket', () => {
    // The wired form emits the same method chain with a var in place of the
    // literal. If the parser failed to collapse it, each pass would add another
    // Multiply node — text-unstable, and the graph would grow without bound.
    const s = makeNode('s', 'property_float', { value: 4, name: 'tempo' });
    const t = makeNode('t', 'time', { speed: 2.5 });
    const out = makeNode('out', 'output');
    const { code1, code2 } = roundTrip(
      [s, t, out],
      [makeEdge('s', 'out', 't', 'speed'), makeEdge('t', 'out', 'out', 'opacity')],
    );
    expect(code2).toBe(code1);
    // The edge wins over the stored 2.5.
    expect(code1).toContain('const time1 = time.mul(tempo);');
  });

  it('time with speed 1 stays byte-identical to the legacy emission', () => {
    const out = makeNode('out', 'output');
    const e = [makeEdge('t', 'out', 'out', 'opacity')];
    const withSpeed = graphToCode([makeNode('t', 'time', { speed: 1 }), out], e).code;
    const legacy = graphToCode([makeNode('t', 'time'), out], e).code; // no speed key
    expect(withSpeed).toBe(legacy);
    expect(withSpeed).toContain('const time1 = time;');
  });

  it('restores values.speed across graph → code → graph', () => {
    // useSyncEngine's node matching does NOT carry data.values across a resync,
    // so a parser gap would silently reset every Time node to 1x on the next
    // code-panel Apply.
    const t = makeNode('t', 'time', { speed: 2.5 });
    const out = makeNode('out', 'output');
    const code = graphToCode([t, out], [makeEdge('t', 'out', 'out', 'opacity')]).code;
    const parsed = codeToGraph(code);
    const tn = parsed.nodes.find((n) => n.data.registryType === 'time')!;
    expect(getNodeValues(tn).speed).toBe(2.5);
    expect(parsed.nodes.find((n) => n.data.registryType === 'mul')).toBeUndefined();
  });

  it('multi-channel output (color + opacity + roughness)', () => {
    const c = makeNode('c', 'color', { hex: '#80ff00' });
    const op = makeNode('op', 'float', { value: 0.7 });
    const rg = makeNode('rg', 'float', { value: 0.4 });
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('c', 'out', 'out', 'color'),
      makeEdge('op', 'out', 'out', 'opacity'),
      makeEdge('rg', 'out', 'out', 'roughness'),
    ];
    const { code1, code2 } = roundTrip([c, op, rg, out], edges);
    expect(code2).toBe(code1);
  });

  it('arithmetic chain: add(time, float)', () => {
    const t = makeNode('t', 'time');
    const f = makeNode('f', 'float', { value: 0.5 });
    const ad = makeNode('ad', 'add');
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('t', 'out', 'ad', 'a'),
      makeEdge('f', 'out', 'ad', 'b'),
      makeEdge('ad', 'out', 'out', 'opacity'),
    ];
    const { code1, code2 } = roundTrip([t, f, ad, out], edges);
    expect(code2).toBe(code1);
  });

  it('unary math: sin(time)', () => {
    const t = makeNode('t', 'time');
    const s = makeNode('s', 'sin');
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('t', 'out', 's', 'x'),
      makeEdge('s', 'out', 'out', 'opacity'),
    ];
    const { code1, code2 } = roundTrip([t, s, out], edges);
    expect(code2).toBe(code1);
  });

  it('noise: mx_noise_float with default position', () => {
    const p = makeNode('p', 'perlin', { pos: 'positionGeometry', scale: 1 });
    const out = makeNode('out', 'output');
    const { code1, code2 } = roundTrip([p, out], [makeEdge('p', 'out', 'out', 'color')]);
    expect(code2).toBe(code1);
  });

  it('noise with non-default scale (mul wrapping)', () => {
    const p = makeNode('p', 'perlin', { pos: 'positionGeometry', scale: 4 });
    const out = makeNode('out', 'output');
    const { code1, code2 } = roundTrip([p, out], [makeEdge('p', 'out', 'out', 'color')]);
    expect(code2).toBe(code1);
  });

  it('UV with tiling', () => {
    const uv = makeNode('uv', 'uv', {
      channel: 0,
      tilingU: 4,
      tilingV: 2,
      rotation: 0,
    });
    const out = makeNode('out', 'output');
    const { code1, code2 } = roundTrip([uv, out], [makeEdge('uv', 'out', 'out', 'color')]);
    expect(code2).toBe(code1);
  });

  it('split swizzle: vec3.x wired to opacity', () => {
    const v = makeNode('v', 'vec3', { x: 1, y: 2, z: 3 });
    const sp = makeNode('sp', 'split');
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('v', 'out', 'sp', 'v'),
      makeEdge('sp', 'x', 'out', 'opacity'),
    ];
    const { code1, code2 } = roundTrip([v, sp, out], edges);
    expect(code2).toBe(code1);
  });

  it('unknown node preserves its raw expression verbatim', () => {
    const u = makeNode('u', 'unknown', {
      functionName: 'foo',
      rawExpression: 'foo(1, 2)',
    });
    const out = makeNode('out', 'output');
    const { code1, code2 } = roundTrip([u, out], [makeEdge('u', 'out', 'out', 'color')]);
    expect(code2).toBe(code1);
    // And the raw expression survives both passes
    expect(code1).toContain('foo(1, 2)');
    expect(code2).toContain('foo(1, 2)');
  });
});

describe('round-trip: node topology is preserved', () => {
  it('produces the same set of registry types after a round trip', () => {
    const t = makeNode('t', 'time');
    const f = makeNode('f', 'float', { value: 2 });
    const m = makeNode('m', 'mul');
    const s = makeNode('s', 'sin');
    const out = makeNode('out', 'output');
    const edges = [
      makeEdge('t', 'out', 'm', 'a'),
      makeEdge('f', 'out', 'm', 'b'),
      makeEdge('m', 'out', 's', 'x'),
      makeEdge('s', 'out', 'out', 'opacity'),
    ];
    const code = graphToCode([t, f, m, s, out], edges).code;
    const parsed = codeToGraph(code);

    const types = (ns: AppNode[]) => ns.map((n) => n.data.registryType).sort();
    expect(types(parsed.nodes)).toEqual(types([t, f, m, s, out]));
    // Same edge count
    expect(parsed.edges.length).toBe(edges.length);
  });
});

describe('round-trip: Discard', () => {
  // Each graph wires Colour as well: with NO channel wired graphToCode emits the
  // `return vec3(1, 0, 0)` fallback, which re-imports as a real Vec3 node — a
  // pre-existing quirk of the fallback that has nothing to do with Discard.
  const colour = () => makeNode('c', 'color', { hex: '#ff8800' });
  const colourEdge = () => makeEdge('c', 'out', 'out', 'color');

  it('a scalar condition survives unchanged', () => {
    const { code1, code2 } = roundTrip(
      [colour(), makeNode('f', 'float', { value: 0.5 }), makeNode('out', 'output')],
      [colourEdge(), makeEdge('f', 'out', 'out', 'discard')],
    );
    expect(code1).toContain('Discard(float1);');
    expect(code2).toBe(code1);
  });

  it('a vec3 condition coerced to .x re-imports as a Split feeding Discard', () => {
    // graphToCode narrows a non-logic vec3 source to `.x` (an `all(vecN)`
    // condition does not compile); the parser must read that back the same way
    // it reads `.x` in any other channel position, or the round trip drifts.
    const { code1, code2 } = roundTrip(
      [colour(), makeNode('n', 'perlinVec3'), makeNode('out', 'output')],
      [colourEdge(), makeEdge('n', 'out', 'out', 'discard')],
    );
    expect(code1).toMatch(/Discard\(\w+\.x\);/);
    expect(code2).toBe(code1);
  });

  it('a logic condition survives unchanged', () => {
    const { code1, code2 } = roundTrip(
      [
        colour(),
        makeNode('p', 'positionLocal'),
        makeNode('f', 'float', { value: 0 }),
        makeNode('g', 'greaterThan'),
        makeNode('out', 'output'),
      ],
      [
        colourEdge(),
        makeEdge('p', 'out', 'g', 'a'),
        makeEdge('f', 'out', 'g', 'b'),
        makeEdge('g', 'out', 'out', 'discard'),
      ],
    );
    expect(code1).toContain('Discard(greaterThan1);');
    expect(code2).toBe(code1);
  });
});

describe('round-trip: noise range flag', () => {
  const rt = (type: string, values: Record<string, unknown>) => {
    const { code1, code2 } = roundTrip(
      [makeNode('n', type, values as never), makeNode('out', 'output')],
      [makeEdge('n', 'out', 'out', 'color')],
    );
    return { code1, code2 };
  };

  it('the 0-1 remap survives graph → code → graph', () => {
    const { code1, code2 } = rt('perlin', { pos: 'positionGeometry', scale: 1, signed: 0 });
    expect(code1).toContain('const noise1 = mx_noise_float(positionGeometry).mul(0.5).add(0.5);');
    expect(code2).toBe(code1);
  });

  it('scale survives the collapse — it delegates to processNoiseCall', () => {
    const { code1, code2 } = rt('perlin', { pos: 'positionGeometry', scale: 4, signed: 0 });
    expect(code1).toContain('mx_noise_float(positionGeometry.mul(4)).mul(0.5).add(0.5)');
    expect(code2).toBe(code1);
  });

  it('a legacy node and an explicitly signed one both emit the bare call', () => {
    for (const values of [{ pos: 'positionGeometry', scale: 1 }, { pos: 'positionGeometry', scale: 1, signed: 1 }]) {
      const { code1, code2 } = rt('perlin', values);
      expect(code1).toContain('const noise1 = mx_noise_float(positionGeometry);');
      expect(code2).toBe(code1);
    }
  });

  it('re-imports as ONE node carrying the flag, not noise + Multiply + Add', () => {
    // The guard against useSyncEngine's mergeMatch gap: it carries no
    // data.values across a resync, so without the collapse every code-panel
    // Apply would reset the node to signed AND grow a junk pair.
    const code = graphToCode(
      [makeNode('n', 'perlin', { pos: 'positionGeometry', scale: 1, signed: 0 } as never), makeNode('out', 'output')],
      [makeEdge('n', 'out', 'out', 'color')],
    ).code;
    const parsed = codeToGraph(code);
    expect(parsed.nodes.map((n) => n.data.registryType).sort()).toEqual(['output', 'perlin']);
    const noise = parsed.nodes.find((n) => n.data.registryType === 'perlin')!;
    expect(getNodeValues(noise).signed).toBe(0);
  });

  it('a tampered flag on an already-[0,1] type stays a bare call', () => {
    const { code1, code2 } = rt('voronoi', { pos: 'positionGeometry', scale: 1, signed: 0 });
    expect(code1).toContain('const worley_noise1 = mx_worley_noise_float(positionGeometry);');
    expect(code2).toBe(code1);
  });

  it('vec3 noise takes the un-widened return path', () => {
    const { code1, code2 } = rt('perlinVec3', { pos: 'positionGeometry', scale: 1, signed: 0 });
    expect(code1).toContain('.mul(0.5).add(0.5)');
    expect(code2).toBe(code1);
  });
});

describe('round-trip: Output node stored channel values', () => {
  it('mixed wired + stored channels re-emit byte-identically', () => {
    const c = makeNode('c', 'color', { hex: '#ff8800' });
    const out = makeNode('out', 'output', { roughness: 0.35, metalness: 0.9, emissive: '#112233' });
    (out.data as { exposedPorts?: string[] }).exposedPorts = [
      'color', 'emissive', 'roughness', 'metalness', 'position',
    ];
    const { code1, code2 } = roundTrip([c, out], [makeEdge('c', 'out', 'out', 'color')]);
    expect(code2).toBe(code1);
    // Pin the shapes: stored values as inline wrappers, no extra nodes on re-parse.
    expect(code1).toContain('roughness: float(0.35)');
    expect(code1).toContain('metalness: float(0.9)');
    expect(code1).toContain('emissive: color(0x112233)');
  });

  it('a stored color alone (bare return form) is stable', () => {
    const out = makeNode('out', 'output', { color: '#3a86ff' });
    const { code1, code2 } = roundTrip([out], []);
    expect(code2).toBe(code1);
    expect(code1).toContain('return color(0x3a86ff);');
  });
});

describe('round-trip: explicitly hidden channels stay hidden', () => {
  it('a hidden default channel is not resurrected by the parse-seeded exposure', () => {
    // Roughness explicitly hidden (removed from exposedPorts) while color
    // carries a stored value. The parse seeds exposedPorts from the implicit
    // defaults ∪ valued — the RESYNC merge must union only the VALUED
    // channels into the old list, or the Apply un-hides roughness.
    const out = makeNode('out', 'output', { color: '#ff0000' });
    (out.data as { exposedPorts?: string[] }).exposedPorts = ['color', 'position'];
    const gen = graphToCode([out], []);
    const parsed = codeToGraph(gen.code);
    expect(parsed.errors).toEqual([]);
    const parsedOut = parsed.nodes.find((n) => n.data.registryType === 'output')!;
    // The mergeMatch rule (useSyncEngine): old ∪ valued-only.
    const oldExposed = ['color', 'position'];
    const valued = Object.keys((parsedOut.data as { values?: Record<string, unknown> }).values ?? {});
    const next = Array.from(new Set([...oldExposed, ...valued]));
    expect(next).not.toContain('roughness');
    expect(next).toContain('color');
  });
});

describe('round-trip: the wider stored-value channel set', () => {
  it('normal/env colors + displacement + discard values are stable', () => {
    const out = makeNode('out', 'output', {
      color: '#3a86ff',
      normal: '#112233',
      env: '#445566',
      position: 0.2,
      discard: 0.5,
    });
    (out.data as { exposedPorts?: string[] }).exposedPorts = [
      'color', 'discard', 'normal', 'env', 'position',
    ];
    const { code1, code2 } = roundTrip([out], []);
    expect(code2).toBe(code1);
    expect(code1).toContain('normal: normalMap(color(0x112233))');
    expect(code1).toContain('env: color(0x445566)');
    expect(code1).toContain('position: float(0.2)');
    expect(code1).toContain('Discard(float(0.5));');
  });
});
