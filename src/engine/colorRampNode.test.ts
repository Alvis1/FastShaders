import { describe, it, expect } from 'vitest';
import type { AppEdge, AppNode } from '@/types';
import { getNodeValues } from '@/types';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { evaluateEdgeSource, evaluateNodeOutput, evaluateNodeRange } from './cpuEvaluator';
import { NODE_REGISTRY, getAllDefinitions, nodeMatchRank, NO_MATCH } from '@/registry/nodeRegistry';
import { getCitation } from '@/registry/citations';
import { usesOperatorLayout, hasNodeGlyph } from '@/components/NodeEditor/nodes/glyphs/NodeGlyph';
import { buildRows } from '@/components/NodeEditor/nodes/ShaderNode';
import { formatNodeLabel, nodeDescription, portLabel, t } from '@/i18n';
import { readColorRamp, rampFetch, rampRangeOver, DEFAULT_RAMP_STOPS } from '@/utils/colorRamp';
import { resetNodeValues } from '@/utils/resetNodeValues';
import { nodeCostPoints, freshNodeCost } from '@/utils/nodeCost';
import { getCost, getBaseCosts, setCostOverrides } from '@/utils/costTable';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * Color Ramp — Blender's node, ONE `fsColorRamp` call whose Color/Alpha are
 * `.rgb`/`.a` of its sample, and whose ramp rides in the call as a canonical
 * string RE-FORMATTED from the parse. These pin the emitted text, the round
 * trip through the code panel (no Split spliced, no key changed), the hand-
 * edited-code warnings, the adversarial `values` a `.fastshader` can carry,
 * and the CPU twin the card and the edge readouts show.
 */

const def = NODE_REGISTRY.get('colorRamp')!;
type Graph = { nodes: AppNode[]; edges: AppEdge[] };
const code = (g: Graph): string => graphToCode(g.nodes, g.edges).code;
const body = (c: string): string => c.slice(c.indexOf('const shader = Fn('));
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

const wrap = (call: string, ret = '{ color: colorRamp1.rgb }') =>
  [
    "import { Fn } from 'three/tsl';",
    'const shader = Fn(() => {',
    `  const colorRamp1 = ${call};`,
    `  return ${ret};`,
    '});',
    'export default shader;',
  ].join('\n');

describe('Color Ramp — the definition', () => {
  it('has Blender’s sockets, its 0.5 Factor, and keeps the ramp out of defaultValues', () => {
    expect(def.inputs.map((p) => [p.id, p.dataType])).toEqual([['fac', 'float']]);
    // `out` stays outputs[0] — the defensive default the whole codebase assumes.
    expect(def.outputs.map((p) => [p.id, p.label, p.dataType])).toEqual([['out', 'Color', 'vec3'], ['alpha', 'Alpha', 'float']]);
    expect(def.defaultValues).toEqual({ fac: 0.5 });
    expect([def.tslFunction, def.tslImportModule, def.category]).toEqual(['fsColorRamp', '', 'type']);
  });

  it('cites Blender, has no glyph (its art is the ramp), and is translated', () => {
    expect(getCitation('node', 'colorRamp')?.ref).toMatch(/BKE_colorband_evaluate/);
    expect(hasNodeGlyph('colorRamp')).toBe(false);
    expect(formatNodeLabel(def.label, def.type, 'lv')).toBe('Krāsu josla (Color Ramp)');
    expect(nodeDescription(def.description, def.type, 'lv')).toMatch(/Blenderī/);
    for (const p of [...def.inputs, ...def.outputs]) expect(portLabel(p.label, 'lv'), p.label).not.toBe(p.label);
    for (const k of ['Linear', 'Constant', 'Ease', 'B-Spline', 'Cardinal', 'Flip', 'Position', 'Stop {n} of {total}']) {
      expect(t(k, 'lv'), k).not.toBe(k);
    }
  });

  it('takes the ROWS layout: Factor beside Color, then Alpha', () => {
    expect(usesOperatorLayout(def)).toBe(false);
    expect(buildRows(def).map((r) => [r.input?.id ?? null, r.output?.id ?? null])).toEqual([['fac', 'out'], [null, 'alpha']]);
  });
});

describe('Color Ramp — emission and the round trip', () => {
  it('the default: one call, the canonical string, the helper and fsLut once', () => {
    const { first, r } = roundTrip({ nodes: [makeNode('c', 'colorRamp', { fac: 0.5 }), out()], edges: [makeEdge('c', 'out', 'out', 'color')] });
    expect(first).toContain(`  const colorRamp1 = fsColorRamp(0.5, "${DEFAULT_RAMP_STOPS}", "linear");`);
    expect(first).toContain('return colorRamp1.rgb;');
    expect(first.split('const fsLut = (() => {')).toHaveLength(2);
    expect(first.split('const fsColorRamp = (fac, stops, interp) => {')).toHaveLength(2);
    // fsLut is emitted BEFORE the helper that calls it (table order).
    expect(first.indexOf('const fsLut = ')).toBeLessThan(first.indexOf('const fsColorRamp = '));
    expect(first).toMatch(/^import \{[^}]*\btexture\b[^}]*\} from 'three\/tsl';$/m);
    expect(r.errors).toEqual([]);
    expect(r.nodes.map((n) => n.data.registryType).sort()).toEqual(['colorRamp', 'output']);
    // The default is stored as NOTHING: absent = default.
    const back = r.nodes.find((n) => n.data.registryType === 'colorRamp')!;
    expect(getNodeValues(back)).toEqual({ fac: 0.5 });
  });

  it('edited: Constant, two stops, Factor from a noise, Color → color, Alpha → opacity', () => {
    const stops = '0 #ff0000 1,0.5 #0000ff 0.25';
    const { first, r } = roundTrip({
      nodes: [makeNode('n', 'perlin'), makeNode('c', 'colorRamp', { fac: 0.5, stops, interp: 'constant' }), out()],
      edges: [makeEdge('n', 'out', 'c', 'fac'), makeEdge('c', 'out', 'out', 'color'), makeEdge('c', 'alpha', 'out', 'opacity')],
    });
    expect(first).toMatch(new RegExp(`  const colorRamp1 = fsColorRamp\\((noise|perlin)\\w*, "${stops}", "constant"\\);`));
    expect(first).toContain('return { color: colorRamp1.rgb, opacity: colorRamp1.a };');
    expect(r.errors).toEqual([]);
    expect(r.nodes.some((n) => n.data.registryType === 'split')).toBe(false);
    const back = r.nodes.find((n) => n.data.registryType === 'colorRamp')!;
    expect(getNodeValues(back)).toMatchObject({ stops, interp: 'constant' });
    expect(r.edges.map((e) => `${e.sourceHandle}->${e.targetHandle}`).sort()).toEqual(['alpha->opacity', 'out->color', 'out->fac']);
  });

  it('two equal ramps share one helper block and get two calls', () => {
    const stops = '0 #102030 1,1 #f0e0d0 0.5';
    const { first } = roundTrip({
      nodes: [makeNode('a', 'colorRamp', { fac: 0.2, stops }), makeNode('b', 'colorRamp', { fac: 0.7, stops }), out()],
      edges: [makeEdge('a', 'out', 'out', 'color'), makeEdge('b', 'out', 'out', 'emissive')],
    });
    expect(first.split('const fsLut = ')).toHaveLength(2);
    expect(first.split('const fsColorRamp = ')).toHaveLength(2);
    expect(first.match(/= fsColorRamp\(/g)).toHaveLength(2);
    expect(first).toContain('const colorRamp1 = ');
    expect(first).toContain('const colorRamp2 = ');
  });

  it('a vec3 into Factor emits the BARE ref (the helper takes .x), never `.x` at the call site', () => {
    const { first } = roundTrip({
      nodes: [makeNode('v', 'vec3', { x: 0.3, y: 0.6, z: 0.9 }), makeNode('c', 'colorRamp'), out()],
      edges: [makeEdge('v', 'out', 'c', 'fac'), makeEdge('c', 'out', 'out', 'color')],
    });
    expect(first).toMatch(/fsColorRamp\(vec3\d+, "/);
  });

  it('a Split of Color swizzles the bare variable (.w reads alpha); a Split of Alpha reads .a for x only', () => {
    const viaSplit = (handle: string, comp: string) =>
      code({
        nodes: [makeNode('c', 'colorRamp'), makeNode('s', 'split'), makeNode('k', 'float', { value: 0.5 }), out()],
        edges: [makeEdge('c', handle, 's', 'v'), makeEdge('s', comp, 'out', 'roughness'), makeEdge('k', 'out', 'out', 'metalness')],
      });
    expect(viaSplit('out', 'x')).toContain('roughness: colorRamp1.x');
    expect(viaSplit('out', 'z')).toContain('roughness: colorRamp1.z');
    expect(viaSplit('out', 'w')).toContain('roughness: colorRamp1.w');
    expect(viaSplit('alpha', 'x')).toContain('roughness: colorRamp1.a');
    expect(viaSplit('alpha', 'y')).not.toContain('roughness:');
    expect(viaSplit('alpha', 'x')).not.toContain('colorRamp1.x');
  });

  it('Color into a scalar-narrowed socket is `colorRamp1.x`, never `.rgb.x` — one Split on the first Apply, then stable', () => {
    const g: Graph = {
      nodes: [makeNode('c', 'colorRamp'), makeNode('k', 'float', { value: 0.5 }), out()],
      edges: [makeEdge('c', 'out', 'out', 'discard'), makeEdge('k', 'out', 'out', 'color')],
    };
    const first = code(g);
    expect(first).toContain('Discard(colorRamp1.x)');
    expect(first).not.toContain('.rgb.x');
    const r = codeToGraph(first);
    expect(r.errors.filter((e) => e.severity !== 'warning')).toEqual([]);
    roundTrip({ nodes: r.nodes, edges: r.edges });
  });

  it('into a Splat Output shade Fn: no geometry read, and it parses back to ONE node', () => {
    const sp = makeNode('sp', 'splatOutput');
    const first = code({ nodes: [makeNode('c', 'colorRamp', { fac: 0.25 }), sp], edges: [makeEdge('c', 'out', 'sp', 'color')] });
    expect(body(first)).not.toMatch(/\b(positionGeometry|positionLocal|positionWorld|positionView|normalLocal|normalWorld|screenUV|tangentLocal)\b|\buv\(/);
    const r = codeToGraph(first);
    expect(r.errors).toEqual([]);
    expect(r.nodes.filter((n) => n.data.registryType === 'colorRamp')).toHaveLength(1);
    expect(graphToCode(r.nodes, r.edges).code).toBe(first);
  });

  it('a property named `colorRamp` keeps its bare name; the helper name is never a variable', () => {
    const { first } = roundTrip({
      nodes: [makeNode('p', 'property_float', { value: 0.4, name: 'colorRamp' }), makeNode('c', 'colorRamp'), out()],
      edges: [makeEdge('p', 'out', 'c', 'fac'), makeEdge('c', 'out', 'out', 'color')],
    });
    expect(first).toMatch(/const colorRamp = uniform\(/);
    expect(first).toContain('fsColorRamp(colorRamp, "');
    expect(first).toContain('const colorRamp1 = ');
  });
});

describe('Color Ramp — hand-edited code reads through the same grammar', () => {
  it('a valid but non-canonical string is stored canonical; a bare `colorRamp1` is Color', () => {
    const r = codeToGraph(wrap('fsColorRamp(0.3, "0 #FF0000 1,  0.50 #00ff00 0.250", "ease")', '{ color: colorRamp1 }'));
    expect(r.errors).toEqual([]);
    const c = r.nodes.find((n) => n.data.registryType === 'colorRamp')!;
    expect(getNodeValues(c)).toEqual({ fac: 0.3, stops: '0 #ff0000 1,0.5 #00ff00 0.25', interp: 'ease' });
    expect(r.edges.find((e) => e.targetHandle === 'color')?.sourceHandle).toBe('out');
    expect(graphToCode(r.nodes, r.edges).code).toContain('return colorRamp1.rgb;');
  });

  it('hand-written `.xyz` / `.w` read Color / Alpha — no Split — and re-emit as `.rgb` / `.a`', () => {
    const r = codeToGraph(wrap('fsColorRamp(0.3)', '{ color: colorRamp1.xyz, opacity: colorRamp1.w }'));
    expect(r.errors).toEqual([]);
    expect(r.nodes.some((n) => n.data.registryType === 'split')).toBe(false);
    expect(r.edges.map((e) => `${e.sourceHandle}->${e.targetHandle}`).sort()).toEqual(['alpha->opacity', 'out->color']);
    const regenerated = graphToCode(r.nodes, r.edges).code;
    expect(regenerated).toContain('color: colorRamp1.rgb');
    expect(regenerated).toContain('opacity: colorRamp1.a');
  });

  it('an unreadable string warns and stores nothing; so does an unknown interpolation', () => {
    const bad = codeToGraph(wrap('fsColorRamp(0.5, "0 #zz0000 1", "linear")'));
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]).toMatchObject({ severity: 'warning' });
    // A string literal is quoted by its VALUE — once (its source text already carries quotes).
    expect(bad.errors[0].message).toContain('the stops "0 #zz0000 1" could not be read');
    expect(bad.errors[0].message).not.toContain('""');
    expect(getNodeValues(bad.nodes.find((n) => n.data.registryType === 'colorRamp')!)).toEqual({ fac: 0.5 });
    const notLiteral = codeToGraph(wrap('fsColorRamp(0.5, someStops, "linear")'));
    expect(notLiteral.errors.map((e) => e.message)).toEqual([
      'fsColorRamp: the stops "someStops" could not be read — the default black-to-white ramp is used.',
    ]);
    const interp = codeToGraph(wrap('fsColorRamp(0.5, "0 #000000 1", "Smooth")'));
    expect(interp.errors.map((e) => e.message)).toEqual(['fsColorRamp: "Smooth" is not linear, constant, ease, bspline or cardinal — Linear is used.']);
    expect(getNodeValues(interp.nodes.find((n) => n.data.registryType === 'colorRamp')!)).toEqual({ fac: 0.5, stops: '0 #000000 1' });
  });

  it('extra arguments and a chained call warn; nothing blocks the Apply', () => {
    const extra = codeToGraph(wrap(`fsColorRamp(0.5, "${DEFAULT_RAMP_STOPS}", "linear", 7, 8)`));
    expect(extra.errors.map((e) => e.message)).toEqual(['fsColorRamp: 2 extra arguments dropped.']);
    const chained = codeToGraph(wrap(`x.fsColorRamp(0.5, "${DEFAULT_RAMP_STOPS}", "constant")`));
    expect(chained.errors.some((e) => /must be called as a plain function/.test(e.message))).toBe(true);
    for (const r of [extra, chained]) expect(r.errors.every((e) => e.severity === 'warning')).toBe(true);
  });

  it('a quote in user text is capped at 80 characters', () => {
    const long = '0 #000000 1,'.repeat(20);
    const r = codeToGraph(wrap(`fsColorRamp(0.5, "${long}", "linear")`));
    expect(r.errors[0].message.length).toBeLessThan(200);
    expect(r.errors[0].message).toContain('…');
  });
});

describe('Color Ramp — adversarial values never throw and never reach the code', () => {
  const POISON: Array<[string, Record<string, unknown>]> = [
    ['stops toString', { stops: { toString: 1 } }],
    ['stops symbol', { stops: Symbol('s') }],
    ['stops 5 MB', { stops: '0 #000000 1,'.repeat(450_000) }],
    ['stops array', { stops: ['0 #000000 1'] }],
    ['stops injection', { stops: '0 #000000 1"); alert(1); ("' }],
    ['stops comment closer', { stops: '0 #000000 1*/ alert(1) /*' }],
    ['interp object', { interp: { toString: () => 'constant' } }],
    ['interp proto', { interp: '__proto__' }],
    ['fac valueOf throws', { fac: { valueOf() { throw new Error('boom'); } } }],
    ['fac NaN', { fac: 'NaN' }],
  ];
  for (const [name, values] of POISON) {
    it(name, () => {
      const c = makeNode('c', 'colorRamp');
      (c.data as { values: Record<string, unknown> }).values = values;
      const nodes = [c, out()];
      const edges = [makeEdge('c', 'out', 'out', 'color'), makeEdge('c', 'alpha', 'out', 'opacity')];
      let text = '';
      expect(() => { text = code({ nodes, edges }); }).not.toThrow();
      expect(text).toMatch(/const colorRamp1 = fsColorRamp\(0\.5, "[0-9a-f#., ]*", "(linear|constant|ease|bspline|cardinal)"\);/);
      expect(text).not.toContain('alert');
      expect(() => evaluateNodeOutput('c', nodes, edges, 0)).not.toThrow();
      expect(() => evaluateNodeRange('c', nodes, edges, 0)).not.toThrow();
      expect(evaluateNodeOutput('c', nodes, edges, 0)).toEqual(rampFetch(readColorRamp(getNodeValues(c)), 0.5));
    });
  }

  it('a REJECTED stored string says so in the generated code', () => {
    const c = makeNode('c', 'colorRamp', { fac: 0.5, stops: '0 #zz0000 1' });
    const text = code({ nodes: [c, out()], edges: [makeEdge('c', 'out', 'out', 'color')] });
    expect(text).toContain('  // colorRamp1: stored ramp unreadable - default used\n');
    expect(text).toContain(`fsColorRamp(0.5, "${DEFAULT_RAMP_STOPS}", "linear")`);
    expect(text).not.toContain('stored interpolation');
  });

  it('a junk stored interpolation says THAT — the readable stops are kept, never called "default"', () => {
    const c = makeNode('c', 'colorRamp', { fac: 0.5, stops: '0 #ff0000 1,1 #0000ff 1', interp: 'Linear' });
    const text = code({ nodes: [c, out()], edges: [makeEdge('c', 'out', 'out', 'color')] });
    expect(text).toContain('  // colorRamp1: stored interpolation unreadable - linear used\n');
    expect(text).not.toContain('stored ramp unreadable');
    expect(text).toContain('fsColorRamp(0.5, "0 #ff0000 1,1 #0000ff 1", "linear")');
  });

  it('fuzz: 500 random stored strings only ever emit the canonical alphabet', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const ALPHABET = ['0', '1', '.', ' ', ',', '#', 'a', 'F', '9', '"', "'", '*/', '</script>', ' ', '١', '٫', '\\', 'e', '-', '\n'];
    for (let k = 0; k < 500; k++) {
      const len = Math.floor(rnd() * 60);
      let s = '';
      for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
      if (rnd() < 0.5) s = `0 #${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0')} ${rnd().toFixed(3)},${s}`;
      const interp = ['linear', 'constant', 'Ease', s, '__proto__'][Math.floor(rnd() * 5)];
      const text = code({ nodes: [makeNode('c', 'colorRamp', { fac: 0.5, stops: s, interp }), out()], edges: [makeEdge('c', 'out', 'out', 'color')] });
      const m = /fsColorRamp\(0\.5, ("[^"]*"), ("[^"]*")\);/.exec(text);
      expect(m, s).not.toBeNull();
      expect(m![1]).toMatch(/^"[0-9a-f#., ]*"$/);
      expect(m![2]).toMatch(/^"(linear|constant|ease|bspline|cardinal)"$/);
    }
  });

  it('Reset drops the ramp back to the default', () => {
    expect(resetNodeValues(def, { fac: 0.9, stops: '0 #ff0000 1', interp: 'constant' })).toEqual({ fac: 0.5 });
  });
});

describe('Color Ramp — the CPU twin, the range and the price', () => {
  const stops = '0 #ff0000 1,0.5 #0000ff 0.25,1 #00ff00 0.5';

  it('evaluateNodeOutput is rampFetch (LINEAR rgba from the half table); unwired Factor is 0.5', () => {
    const c = makeNode('c', 'colorRamp', { fac: 0.3, stops });
    expect(evaluateNodeOutput('c', [c], [], 0)).toEqual(rampFetch(readColorRamp({ stops }), 0.3));
    const d = makeNode('d', 'colorRamp');
    expect(evaluateNodeOutput('d', [d], [], 0)).toEqual(rampFetch(readColorRamp({}), 0.5));
  });

  it('an UNWIRED junk Factor is the registry 0.5 in the value AND the range — never NaN, the whole ramp', () => {
    const at = rampFetch(readColorRamp({ stops }), 0.5);
    for (const fac of ['abc', 'NaN', 'Infinity']) {
      const c = makeNode('c', 'colorRamp', { fac, stops });
      expect(evaluateNodeOutput('c', [c], [], 0)).toEqual(at);
      expect(evaluateNodeRange('c', [c], [], 0)).toEqual({ min: at, max: at });
    }
  });

  it('per socket: Alpha is ONE channel, Color three — a tampered handle reads Color', () => {
    const c = makeNode('c', 'colorRamp', { fac: 0.3, stops });
    const all = evaluateNodeOutput('c', [c], [], 0)!;
    expect(evaluateEdgeSource({ source: 'c', sourceHandle: 'alpha' }, [c], [], 0)).toEqual([all[3]]);
    expect(evaluateEdgeSource({ source: 'c', sourceHandle: 'out' }, [c], [], 0)).toEqual(all.slice(0, 3));
    expect(evaluateEdgeSource({ source: 'c', sourceHandle: '__proto__' }, [c], [], 0)).toEqual(all.slice(0, 3));
  });

  it('a wired Factor over [0.2, 0.4] has exactly rampRangeOver’s range', () => {
    const nodes = [
      makeNode('u', 'uv'),
      makeNode('s', 'split'),
      makeNode('m', 'remap', { inLow: 0, inHigh: 1, outLow: 0.2, outHigh: 0.4 }),
      makeNode('c', 'colorRamp', { stops }),
    ];
    const edges = [makeEdge('u', 'out', 's', 'v'), makeEdge('s', 'x', 'm', 'x'), makeEdge('m', 'out', 'c', 'fac')];
    const fac = evaluateNodeRange('m', nodes, edges, 0)!;
    expect([fac.min[0], fac.max[0]].map((v) => +v.toFixed(9))).toEqual([0.2, 0.4]);
    expect(evaluateNodeRange('c', nodes, edges, 0)).toEqual(rampRangeOver(readColorRamp({ stops }), fac.min[0], fac.max[0]));
  });

  it('is charged at colormap’s price — one LUT fetch — and its fresh node at what its tile prints', () => {
    setCostOverrides(null); // the ACTIVE table is shared with every suite in the worker (isolate:false)
    try {
      expect(nodeCostPoints(makeNode('c', 'colorRamp'), [])).toBe(getCost('colormap'));
      // complexity.json's entry IS that derivation at the shipped colormap price, and is what every surface shows.
      expect(getBaseCosts().colorRamp, 'complexity.json colorRamp is one colormap fetch — reprice it WITH colormap').toBe(getBaseCosts().colormap);
      expect(freshNodeCost('colorRamp')).toBe(nodeCostPoints(makeNode('c', 'colorRamp', { ...def.defaultValues }), []));
      // A measured profile (the bench prices colormap, never colorRamp) reprices it…
      setCostOverrides({ colormap: 9 });
      expect(nodeCostPoints(makeNode('c', 'colorRamp'), [])).toBe(9);
      // …and a profile that moves the colorRamp entry itself is CHARGED it, colormap or not.
      setCostOverrides({ colorRamp: 6, colormap: 9 });
      expect(nodeCostPoints(makeNode('c', 'colorRamp'), [])).toBe(6);
      // A "New profile…" table (every shipped price seeded) that moved only colormap still follows colormap.
      setCostOverrides({ ...getBaseCosts(), colormap: 9 });
      expect(nodeCostPoints(makeNode('c', 'colorRamp'), [])).toBe(9);
    } finally {
      setCostOverrides(null);
    }
  });

  it('is found by its name first, by "gradient", and does not displace Color', () => {
    const labels = (q: string) =>
      getAllDefinitions()
        .map((d) => ({ d, rank: nodeMatchRank(d, q) }))
        .filter((e) => e.rank !== NO_MATCH)
        .sort((a, b) => a.rank - b.rank)
        .map((e) => e.d.label);
    expect(labels('ramp')[0]).toBe('Color Ramp');
    expect(labels('color ramp')[0]).toBe('Color Ramp');
    expect(labels('gradient')).toContain('Color Ramp');
    expect(labels('colorband')).toContain('Color Ramp');
    expect(labels('color')[0]).toBe('Color');
  });
});
