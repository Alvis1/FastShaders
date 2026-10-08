import { describe, it, expect } from 'vitest';
import * as TSL from 'three/tsl';
import type { AppEdge, AppNode } from '@/types';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { evaluateEdgeSource, evaluateNodeOutput, evaluateNodeRange } from './cpuEvaluator';
import { MODULE_HELPERS } from './moduleHelpers';
import { NODE_REGISTRY, getAllDefinitions, nodeMatchRank, NO_MATCH } from '@/registry/nodeRegistry';
import { getCitation } from '@/registry/citations';
import { CUSTOM_GLYPHS } from '@/components/NodeEditor/nodes/glyphs/customGlyphs';
import { usesOperatorLayout } from '@/components/NodeEditor/nodes/glyphs/NodeGlyph';
import { buildRows } from '@/components/NodeEditor/nodes/ShaderNode';
import { formatNodeLabel, nodeDescription, portLabel } from '@/i18n';
import { fresnelFacing } from '@/utils/fresnel';
import { sinkModelIssue } from '@/utils/sinkModelFit';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * Fresnel — Blender's node (Cycles svm_node_fresnel + fresnel_dielectric_cos)
 * plus Layer Weight's Facing at Blend 0.5, from ONE `fsFresnel` call.
 *
 * The maths lives in three places that can drift apart silently — the helper
 * the shader runs, the CPU twin behind the card's numbers, the `construction`
 * line the settings menu shows — so the helper TEXT is executed here through a
 * numeric stand-in for its TSL calls and held, with the twin, to a
 * transcription of Cycles.
 */

const def = NODE_REGISTRY.get('fresnel')!;
type Graph = { nodes: AppNode[]; edges: AppEdge[] };
const code = (g: Graph): string => graphToCode(g.nodes, g.edges).code;
const body = (c: string): string => c.slice(c.indexOf('const shader = Fn('));

/**
 * Cycles, intern/cycles/kernel/closure/bsdf_util.h + kernel/svm/fresnel.h:
 *
 *   eta = fmaxf(eta, 1e-5f);
 *   eta = (sd->flag & SD_BACKFACING) ? 1.0f / eta : eta;
 *   float c = fabsf(cosi);
 *   float g = eta * eta - 1 + c * c;
 *   if (g > 0) {
 *     g = sqrtf(g);
 *     float A = (g - c) / (g + c);
 *     float B = (c * (g + c) - 1) / (c * (g - c) + 1);
 *     result = 0.5f * A * A * (1 + B * B);
 *   } else result = 1.0f;  // TIR
 *
 * Layer Weight's Facing at Blend 0.5 is 1 − |cos|.
 */
function cycles(cosi: number, ior: number, front: boolean): [number, number] {
  let eta = Math.max(ior, 1e-5);
  eta = front ? eta : 1 / eta;
  const c = Math.abs(cosi);
  let g = eta * eta - 1 + c * c;
  let result: number;
  if (g > 0) {
    g = Math.sqrt(g);
    const A = (g - c) / (g + c);
    const B = (c * (g + c) - 1) / (c * (g - c) + 1);
    result = 0.5 * A * A * (1 + B * B);
  } else result = 1;
  return [result, 1 - c];
}

/** Run the helper's own source with plain numbers standing in for TSL nodes. The camera sits at the origin and
 *  the surface point at (0, 0, −1), so V = +Z and a normal (√(1−c²), 0, c) gives N·V = c. */
function runHelperText(c: number, ior: number, front: boolean, normal?: number[]): [number, number] {
  const lines = MODULE_HELPERS.get('fsFresnel')!.lines.join('\n');
  type V = number[];
  const zip = (f: (x: number, y: number) => number) => (x: V, y: V): V => {
    const n = Math.max(x.length, y.length);
    return Array.from({ length: n }, (_, i) => f(x[i % x.length], y[i % y.length]));
  };
  const each = (f: (x: number) => number) => (x: V): V => x.map(f);
  const shim: Record<string, unknown> = {
    Fn: (fn: (args: V[]) => V) => (...args: V[]) => fn(args),
    float: (x: number | V): V => (Array.isArray(x) ? [x[0]] : [x]),
    vec2: (a: V, b: V): V => [a[0], b[0]],
    vec3: (v: V): V => (v.length === 1 ? [v[0], v[0], v[0]] : [v[0], v[1] ?? 0, v[2] ?? 0]),
    add: zip((x, y) => x + y),
    sub: zip((x, y) => x - y),
    mul: zip((x, y) => x * y),
    div: zip((x, y) => x / y),
    max: zip((x, y) => Math.max(x, y)),
    abs: each(Math.abs),
    sqrt: each(Math.sqrt),
    clamp: (x: V, lo: V, hi: V): V => x.map((v) => Math.min(Math.max(v, lo[0]), hi[0])),
    dot: (a: V, b: V): V => [a.reduce((s, v, i) => s + v * b[i], 0)],
    normalize: (a: V): V => { const l = Math.hypot(...a); return a.map((v) => v / l); },
    greaterThan: zip((x, y) => (x > y ? 1 : 0)),
    select: (cond: V | boolean, a: V, b: V): V => ((Array.isArray(cond) ? cond[0] !== 0 : cond) ? a : b),
    cameraPosition: [0, 0, 0],
    frontFacing: front,
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const helper = new Function(...Object.keys(shim), `${lines}\nreturn fsFresnel;`)(...Object.values(shim));
  const n = normal ?? [Math.sqrt(Math.max(1 - c * c, 0)), 0, c];
  const out = helper([ior], n, [0, 0, -1]) as V;
  return [out[0], out[1]];
}

const COS = [0, 1e-3, 0.25, 0.5, 0.745, 0.9, 1];
const ETA = [1e-9, 0.5, 0.7, 1, 1.33, 1.45, 1.5, 2.4, 1e6];

describe('Fresnel — the definition', () => {
  it('has Blender’s sockets and default, and a Normal with no value box', () => {
    expect(def.inputs.map((p) => [p.id, p.dataType])).toEqual([['ior', 'float'], ['normal', 'vec3']]);
    expect(def.inputs.find((p) => p.id === 'normal')!.hideValue).toBe(true);
    expect(def.inputs.find((p) => p.id === 'ior')!.hideValue).toBeUndefined();
    // `out` stays outputs[0] — the defensive default the whole codebase assumes.
    expect(def.outputs.map((p) => [p.id, p.label, p.dataType])).toEqual([['out', 'Fresnel', 'float'], ['facing', 'Facing', 'float']]);
    // No `normal` entry: its unwired meaning is the surface normal, which no number can say.
    expect(def.defaultValues).toEqual({ ior: 1.5 });
    expect([def.tslFunction, def.tslImportModule, def.category]).toEqual(['fsFresnel', '', 'input']);
  });

  it('cites Blender, carries a glyph and is translated — label, description and every socket', () => {
    expect(getCitation('node', 'fresnel')?.ref).toMatch(/fresnel_dielectric_cos/);
    expect(CUSTOM_GLYPHS.fresnel?.svg).toBeTruthy();
    expect(formatNodeLabel(def.label, def.type, 'lv')).toBe('Frenela efekts (Fresnel)');
    expect(nodeDescription(def.description, def.type, 'lv')).toMatch(/Blenderī/);
    for (const p of [...def.inputs, ...def.outputs]) expect(portLabel(p.label, 'lv'), p.label).not.toBe(p.label);
    expect(portLabel('Facing', 'lv')).toBe('Skata leņķis');
  });
});

describe('Fresnel — the shipped helper computes Cycles', () => {
  for (const front of [true, false]) {
    it(`helper text and CPU twin equal Cycles over c × η (${front ? 'front' : 'back'} faces)`, () => {
      for (const c of COS) {
        for (const eta of ETA) {
          const got = runHelperText(c, eta, front);
          const twin = fresnelFacing(c, eta, front);
          expect(twin[0], `twin c=${c} η=${eta}`).toBeCloseTo(got[0], 12);
          expect(twin[1], `twin c=${c} η=${eta}`).toBeCloseTo(got[1], 12);
          expect(Number.isFinite(got[0]) && Number.isFinite(got[1]), `finite c=${c} η=${eta}`).toBe(true);
          if (eta > 1e4) continue; // the helper clamps η at 1e4 (η² would overflow float32 into NaN); Cycles does not
          const want = cycles(c, eta, front);
          expect(got[0], `F c=${c} η=${eta}`).toBeCloseTo(want[0], 12);
          expect(got[1], `Facing c=${c} η=${eta}`).toBeCloseTo(want[1], 12);
        }
      }
    });
  }

  it('the landmarks: F0 of glass and of 1.45, the silhouette, IOR 1, total internal reflection', () => {
    expect(runHelperText(1, 1.5, true)[0]).toBeCloseTo(0.04, 12);
    expect(runHelperText(1, 1.45, true)[0]).toBeCloseTo(0.03374, 5);
    expect(runHelperText(0, 1.5, true)).toEqual([1, 1]);
    for (const c of [0.25, 0.5, 1]) expect(runHelperText(c, 1, true)[0]).toBe(0);
    expect(runHelperText(1e-3, 0.7, true)[0]).toBe(1);
    // A back face at 1.5 is a front face at 1/1.5.
    for (const c of COS) expect(runHelperText(c, 1.5, false)[0]).toBeCloseTo(runHelperText(c, 1 / 1.5, true)[0], 12);
    // A wired normal is NOT normalized (Cycles): a zero normal is c = 0, never NaN.
    expect(runHelperText(0, 1.5, true, [0, 0, 0])).toEqual([1, 1]);
  });

  it('calls only real three/tsl exports, and names none of the geometry globals', () => {
    const helper = MODULE_HELPERS.get('fsFresnel')!;
    for (const name of helper.imports) expect((TSL as Record<string, unknown>)[name], name).toBeDefined();
    expect(helper.lines.join('\n')).not.toMatch(/\b(positionGeometry|positionLocal|positionWorld|normalLocal|normalWorld|ior)\b/);
  });

  it('the construction line states the formula the helper runs', () => {
    const line = def.construction!;
    expect(line).not.toContain('\n');
    for (const part of ['|N·V|', 'IOR', 'η²', '1/η', '≤ 0', 'Facing = 1 − c']) expect(line, part).toContain(part);
  });
});

describe('Fresnel — emission and the round trip', () => {
  const out = () => makeNode('out', 'output');
  /** graph → code → graph → code: byte-identical, same counts, no blocking error. */
  const roundTrip = (g: Graph) => {
    const first = code(g);
    const r = codeToGraph(first);
    expect(r.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    const second = graphToCode(r.nodes, r.edges).code;
    expect(second).toBe(first);
    const again = codeToGraph(second);
    expect([again.nodes.length, again.edges.length]).toEqual([r.nodes.length, r.edges.length]);
    return { first, r };
  };

  it('unwired: the bare globals, the helper once, its imports completed', () => {
    const { first, r } = roundTrip({ nodes: [makeNode('f', 'fresnel', { ior: 1.5 }), out()], edges: [makeEdge('f', 'out', 'out', 'opacity')] });
    expect(first).toContain('  const fresnel1 = fsFresnel(1.5, normalWorld, positionWorld);');
    expect(first).toMatch(/^import \{[^}]*\bnormalWorld\b[^}]*\bpositionWorld\b[^}]*\} from 'three\/tsl';$/m);
    expect(first).toMatch(/^import \{[^}]*\bfrontFacing\b[^}]*\} from 'three\/tsl';$/m);
    expect(first).not.toMatch(/import \{[^}]*\bfsFresnel\b/);
    expect(r.errors).toEqual([]);
    // The Normal is unwired again: no Normal (world) / Position (world) node was minted.
    expect(r.nodes.map((n) => n.data.registryType).sort()).toEqual(['fresnel', 'output']);
  });

  it('IOR 1.33, a wired Normal, an IOR wired from a property', () => {
    expect(roundTrip({ nodes: [makeNode('f', 'fresnel', { ior: 1.33 }), out()], edges: [makeEdge('f', 'out', 'out', 'opacity')] }).first)
      .toContain('fsFresnel(1.33, normalWorld, positionWorld)');
    const wired = roundTrip({
      nodes: [makeNode('nw', 'normalWorld'), makeNode('f', 'fresnel', { ior: 1.33 }), out()],
      edges: [makeEdge('nw', 'out', 'f', 'normal'), makeEdge('f', 'out', 'out', 'opacity')],
    });
    expect(wired.first).toContain('  const fresnel1 = fsFresnel(1.33, normalWorld1, positionWorld);');
    expect(wired.r.edges.some((e) => e.targetHandle === 'normal')).toBe(true);
    const prop = roundTrip({
      nodes: [makeNode('p', 'property_float', { value: 1.4, name: 'glass' }), makeNode('f', 'fresnel'), out()],
      edges: [makeEdge('p', 'out', 'f', 'ior'), makeEdge('f', 'out', 'out', 'opacity')],
    });
    expect(prop.first).toContain('fsFresnel(glass, normalWorld, positionWorld)');
  });

  it('two nodes are fresnel1 and fresnel2 with ONE helper; a property named `fresnel` keeps its bare name', () => {
    const { first } = roundTrip({
      nodes: [makeNode('p', 'property_float', { value: 2, name: 'fresnel' }), makeNode('a', 'fresnel'), makeNode('b', 'fresnel', { ior: 2.4 }), out()],
      edges: [makeEdge('p', 'out', 'a', 'ior'), makeEdge('a', 'out', 'out', 'opacity'), makeEdge('b', 'facing', 'out', 'roughness')],
    });
    expect(first.split('const fsFresnel = Fn(')).toHaveLength(2);
    expect(first).toMatch(/const fresnel[12] = fsFresnel\(fresnel, normalWorld, positionWorld\);/);
    expect(first).toMatch(/const fresnel[12] = fsFresnel\(2\.4, normalWorld, positionWorld\);/);
    expect(first).toContain('const fresnel1 = ');
    expect(first).toContain('const fresnel2 = ');
    expect(first).toMatch(/const fresnel = uniform\(/);
  });

  it('Facing → Emissive and Fresnel → Opacity are .y and .x, and parse back to their sockets with NO Split', () => {
    const { first, r } = roundTrip({
      nodes: [makeNode('f', 'fresnel'), out()],
      edges: [makeEdge('f', 'facing', 'out', 'emissive'), makeEdge('f', 'out', 'out', 'opacity')],
    });
    expect(first).toContain('emissive: vec3(fresnel1.y)');
    expect(first).toContain('opacity: fresnel1.x');
    expect(r.nodes.some((n) => n.data.registryType === 'split')).toBe(false);
    const handles = r.edges.map((e) => `${e.sourceHandle}->${e.targetHandle}`).sort();
    expect(handles).toEqual(['facing->emissive', 'out->opacity']);
  });

  it('Split: Facing → Split.x reads .y; Fresnel → Split.x reads .x; Split.y of a scalar is nothing; Apply drops the Split', () => {
    const g = (handle: string, comp: string): Graph => ({
      nodes: [makeNode('f', 'fresnel'), makeNode('s', 'split'), makeNode('k', 'float', { value: 0.5 }), out()],
      edges: [makeEdge('f', handle, 's', 'v'), makeEdge('s', comp, 'out', 'emissive'), makeEdge('k', 'out', 'out', 'roughness')],
    });
    expect(code(g('facing', 'x'))).toContain('emissive: vec3(fresnel1.y)');
    expect(code(g('out', 'x'))).toContain('emissive: vec3(fresnel1.x)');
    expect(code(g('facing', 'y'))).not.toContain('emissive');
    const first = code(g('facing', 'x'));
    const r = codeToGraph(first);
    expect(r.nodes.some((n) => n.data.registryType === 'split')).toBe(false);
    expect(r.edges.some((e) => e.sourceHandle === 'facing' && e.targetHandle === 'emissive')).toBe(true);
    roundTrip({ nodes: r.nodes, edges: r.edges });
  });

  it('an ALIAS of one socket is a swizzle of THAT socket: `f.x` of `const f = fresnel1.y` is fed from Facing', () => {
    const src = [
      "import { Fn } from 'three/tsl';",
      'const shader = Fn(() => {',
      '  const fresnel1 = fsFresnel(1.5);',
      '  const f = fresnel1.y;',
      '  return { roughness: f.x };',
      '});',
      'export default shader;',
    ].join('\n');
    const r = codeToGraph(src);
    const split = r.nodes.find((n) => n.data.registryType === 'split')!;
    expect(split).toBeDefined();
    const into = r.edges.find((e) => e.target === split.id && e.targetHandle === 'v')!;
    expect(into.sourceHandle).toBe('facing');
  });

  it('hand-written calls: a bare `fsFresnel(1.5)` is Normal unwired; a foreign position or a literal normal warns', () => {
    const wrap = (call: string) => [
      "import { Fn, normalWorld } from 'three/tsl';",
      'const shader = Fn(() => {',
      `  const fresnel1 = ${call};`,
      '  return { opacity: fresnel1.x };',
      '});',
      'export default shader;',
    ].join('\n');
    const bare = codeToGraph(wrap('fsFresnel(1.5)'));
    expect(bare.errors).toEqual([]);
    expect(bare.edges.filter((e) => e.targetHandle === 'normal')).toEqual([]);
    const pw = codeToGraph(wrap('fsFresnel(1.5, normalWorld, foo)'));
    expect(pw.errors).toHaveLength(1);
    expect(pw.errors[0]).toMatchObject({ severity: 'warning' });
    expect(pw.errors[0].message).toContain('"foo"');
    const lit = codeToGraph(wrap('fsFresnel(1.5, 0, positionWorld)'));
    expect(lit.errors).toHaveLength(1);
    expect(lit.errors[0].message).toMatch(/Normal takes a wire/);
    expect(lit.edges.filter((e) => e.targetHandle === 'normal')).toEqual([]);
    const extra = codeToGraph(wrap('fsFresnel(1.5, normalWorld, positionWorld, 7)'));
    expect(extra.errors.map((e) => e.message)).toEqual(['fsFresnel: 1 extra argument dropped.']);
    const chained = codeToGraph(wrap('x.fsFresnel(1.5)'));
    expect(chained.errors.some((e) => /must be called as a plain function/.test(e.message))).toBe(true);
  });

  it('a module that is not the app\'s own: the helper declaration is skipped by name, never graph content', () => {
    const first = code({ nodes: [makeNode('f', 'fresnel'), out()], edges: [makeEdge('f', 'out', 'out', 'opacity')] });
    const r = codeToGraph(first);
    expect(r.nodes).toHaveLength(2);
  });
});

describe('Fresnel — adversarial values never throw and never reach the code', () => {
  const POISON: Array<[string, Record<string, unknown>, string]> = [
    ['ior toString', { ior: { toString: 1 } }, '1.5'],
    ['ior NaN string', { ior: 'NaN' }, '1.5'],
    ['ior Infinity', { ior: Infinity }, '1.5'],
    ['ior array', { ior: [1, 2] }, '1.5'],
    ['ior injection', { ior: '1); alert(1); (1' }, '1.5'],
    ['ior negative', { ior: -3 }, '-3'],
    ['normal number', { normal: 5 }, '1.5'],
    ['normal toString', { normal: { toString: 1 } }, '1.5'],
  ];
  for (const [name, values, eta] of POISON) {
    it(name, () => {
      const f = makeNode('f', 'fresnel');
      (f.data as { values: Record<string, unknown> }).values = values;
      const nodes = [f, makeNode('out', 'output')];
      const edges = [makeEdge('f', 'out', 'out', 'opacity')];
      const c = code({ nodes, edges });
      expect(c).toContain(`const fresnel1 = fsFresnel(${eta}, normalWorld, positionWorld);`);
      expect(c).not.toContain('alert');
      expect(() => evaluateNodeOutput('f', nodes, edges, 0)).not.toThrow();
      expect(() => evaluateNodeRange('f', nodes, edges, 0)).not.toThrow();
      const cpu = evaluateNodeOutput('f', nodes, edges, 0)!;
      // The CPU reads the value codegen emits: non-finite → 1.5; −3 → the helper's clamp.
      expect(cpu).toEqual(fresnelFacing(1, Number(eta)));
    });
  }
});

describe('Fresnel — inside a Splat Output Fn', () => {
  const GEOMETRY_READ = /\b(positionGeometry|positionLocal|positionWorld|positionView|normalLocal|normalWorld|screenUV|tangentLocal)\b|\buv\(/;
  const splat = (lit = false) => {
    const n = makeNode('sp', 'splatOutput');
    (n.data as { values: Record<string, unknown> }).values = lit ? { lit: true } : {};
    return n;
  };

  it('binds the normal and the world position to the splat\'s own `n`/`pw`, and round-trips', () => {
    const g: Graph = { nodes: [makeNode('f', 'fresnel'), splat()], edges: [makeEdge('f', 'out', 'sp', 'cut'), makeEdge('f', 'facing', 'sp', 'color')] };
    const first = code(g);
    expect(first).toContain('    const fresnel1 = fsFresnel(1.5, n, pw);');
    expect(body(first)).not.toMatch(GEOMETRY_READ);
    const r = codeToGraph(first);
    expect(r.errors).toEqual([]);
    expect(r.nodes.filter((n) => n.data.registryType === 'fresnel')).toHaveLength(1);
    expect(r.edges.filter((e) => e.targetHandle === 'normal')).toEqual([]);
    expect(graphToCode(r.nodes, r.edges).code).toBe(first);
  });

  it('read flat AND in a Fn: the flat copy keeps the globals, the Fn copy is bound, and it parses as ONE node', () => {
    const g: Graph = {
      nodes: [makeNode('f', 'fresnel'), makeNode('ab', 'abs'), splat()],
      edges: [makeEdge('f', 'out', 'sp', 'opacity'), makeEdge('f', 'out', 'ab', 'x')],
    };
    const first = code(g);
    expect(first).toContain('  const fresnel1 = fsFresnel(1.5, normalWorld, positionWorld);');
    expect(first).toContain('    const fresnel1 = fsFresnel(1.5, n, pw);');
    const r = codeToGraph(first);
    expect(r.errors).toEqual([]);
    expect(r.nodes.filter((n) => n.data.registryType === 'fresnel')).toHaveLength(1);
    expect(graphToCode(r.nodes, r.edges).code).toBe(first);
  });

  it('an UNLIT Splat Output fed by an unwired Fresnel says the normal faces the camera; a wired non-Normal does not', () => {
    const SPLAT = { geometry: 'custom', splatLoaded: true };
    const sink = () => ({ ...splat(), type: 'splatOutput' }) as AppNode;
    expect(sinkModelIssue([makeNode('f', 'fresnel'), sink()], [makeEdge('f', 'facing', 'sp', 'color')], SPLAT)).toBe('splat-normal-faces-camera');
    expect(sinkModelIssue(
      [makeNode('v', 'vec3', { x: 0, y: 0, z: 1 }), makeNode('f', 'fresnel'), sink()],
      [makeEdge('v', 'out', 'f', 'normal'), makeEdge('f', 'facing', 'sp', 'color')],
      SPLAT,
    )).toBeNull();
  });
});

describe('Fresnel — the CPU twin and the range', () => {
  it('the head-on sample: [F0, Facing] = [0.04, 0], per socket', () => {
    const f = makeNode('f', 'fresnel');
    expect(evaluateNodeOutput('f', [f], [], 0)![0]).toBeCloseTo(0.04, 12);
    expect(evaluateEdgeSource({ source: 'f', sourceHandle: 'out' }, [f], [], 0)!.map((v) => +v.toFixed(12))).toEqual([0.04]);
    expect(evaluateEdgeSource({ source: 'f', sourceHandle: 'facing' }, [f], [], 0)).toEqual([0]);
    // A tampered handle reads Fresnel, as graphToCode's `?? 'x'` does.
    expect(evaluateEdgeSource({ source: 'f', sourceHandle: '__proto__' }, [f], [], 0)![0]).toBeCloseTo(0.04, 12);
  });

  it('a sampled field: [0, 1] on both sockets, and a consumer shows an interval, not a constant', () => {
    const f = makeNode('f', 'fresnel');
    expect(evaluateNodeRange('f', [f], [], 0)).toEqual({ min: [0, 0], max: [1, 1] });
    const rm = makeNode('rm', 'remap', { inLow: 0, inHigh: 1, outLow: 0, outHigh: 10 });
    const r = evaluateNodeRange('rm', [f, rm], [makeEdge('f', 'facing', 'rm', 'x')], 0)!;
    expect(r.min[0]).toBeLessThan(r.max[0]);
  });

  it('a WIRED normal widens the range unless it is a unit vector (no normalize — Cycles)', () => {
    const f = makeNode('f', 'fresnel');
    const nw = makeNode('n', 'normalWorld');
    expect(evaluateNodeRange('f', [nw, f], [makeEdge('n', 'out', 'f', 'normal')], 0)).toEqual({ min: [0, 0], max: [1, 1] });
    const nz = makeNode('n', 'normalize');
    const v = makeNode('v', 'vec3', { x: 2, y: 0, z: 0 });
    expect(evaluateNodeRange('f', [v, nz, f], [makeEdge('v', 'out', 'n', 'x'), makeEdge('n', 'out', 'f', 'normal')], 0))
      .toEqual({ min: [0, 0], max: [1, 1] });
    const big = evaluateNodeRange('f', [v, f], [makeEdge('v', 'out', 'f', 'normal')], 0)!;
    expect(big.min).toEqual([0, -1]);
    expect(big.max).toEqual([Infinity, 1]);
  });
});

describe('Fresnel — the card and search', () => {
  it('takes the ROWS layout (two outputs), and its Normal row carries no value', () => {
    expect(usesOperatorLayout(def)).toBe(false);
    const rows = buildRows(def);
    const normal = rows.find((r) => r.input?.id === 'normal')!;
    expect(normal.settingKey).toBeNull();
    expect(normal.input!.hideValue).toBe(true);
    expect(rows.map((r) => [r.input?.id ?? null, r.output?.id ?? null])).toEqual([['ior', 'out'], ['normal', 'facing']]);
  });

  it('is found by its name first, and by rim and layer weight', () => {
    const labels = (q: string) => getAllDefinitions()
      .map((d) => ({ d, rank: nodeMatchRank(d, q) }))
      .filter((e) => e.rank !== NO_MATCH)
      .sort((a, b) => a.rank - b.rank)
      .map((e) => e.d.label);
    expect(labels('fresnel')[0]).toBe('Fresnel');
    expect(labels('rim')).toContain('Fresnel');
    expect(labels('layer weight')).toContain('Fresnel');
  });
});
