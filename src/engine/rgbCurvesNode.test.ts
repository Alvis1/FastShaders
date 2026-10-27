import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as THREE from 'three/webgpu';
import type { AppEdge, AppNode } from '@/types';
import { getNodeValues } from '@/types';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { evaluateNodeOutput, evaluateNodeRange } from './cpuEvaluator';
import { NODE_REGISTRY, getAllDefinitions, nodeMatchRank, NO_MATCH } from '@/registry/nodeRegistry';
import { getCitation } from '@/registry/citations';
import { usesOperatorLayout, hasNodeGlyph } from '@/components/NodeEditor/nodes/glyphs/NodeGlyph';
import { formatNodeLabel, nodeDescription, portLabel, t } from '@/i18n';
import { readRgbCurves, evalRgbCurves, rgbCurvesRange, IDENTITY_CURVE } from '@/utils/rgbCurves';
import { resetNodeValues } from '@/utils/resetNodeValues';
import { nodeCostPoints, freshNodeCost } from '@/utils/nodeCost';
import { getCost, getBaseCosts, setCostOverrides } from '@/utils/costTable';
import { bakeEditorModule } from '@/lutHelperHarness';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * RGB Curves — Blender's node, ONE `fsRgbCurves` call returning the vec3, its
 * four curves riding in the call as canonical strings RE-FORMATTED from the
 * parse. These pin the emitted text, the round trip through the code panel,
 * the hand-edited-code warnings, the adversarial `values` a `.fastshader` can
 * carry, that the generated module RUNS (and bakes nothing in its identity
 * form), the CPU twin and the price. The table itself is held to Blender in
 * utils/rgbCurves.test.ts and to the helper text in lutHelpers.test.ts.
 */

const def = NODE_REGISTRY.get('rgbCurves')!;
type Graph = { nodes: AppNode[]; edges: AppEdge[] };
const code = (g: Graph): string => graphToCode(g.nodes, g.edges).code;
const out = () => makeNode('out', 'output');
const S = '0 0,0.25 0.15,0.75 0.85,1 1';
const DEFAULT_CALL = '  const rgbCurves1 = fsRgbCurves(1, 1, "0 0,1 1", "0 0,1 1", "0 0,1 1", "0 0,1 1", "extrapolate");';

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

const wrap = (call: string) =>
  [
    "import { Fn } from 'three/tsl';",
    'const shader = Fn(() => {',
    `  const rgbCurves1 = ${call};`,
    '  return rgbCurves1;',
    '});',
    'export default shader;',
  ].join('\n');
const curvesNode = (r: { nodes: AppNode[] }) => r.nodes.find((n) => n.data.registryType === 'rgbCurves')!;
/** Run the generated module and the shader BODY (lutHelperHarness.ts): that is what calls fsRgbCurves and
 *  bakes. Returns every DataTexture made. */
const runModule = bakeEditorModule;

describe('RGB Curves — the definition', () => {
  it('has Blender’s sockets (Color first), its defaults, and keeps the curves out of defaultValues', () => {
    expect(def.inputs.map((p) => [p.id, p.dataType])).toEqual([['color', 'vec3'], ['fac', 'float']]);
    expect(def.outputs.map((p) => [p.id, p.label, p.dataType])).toEqual([['out', 'Color', 'vec3']]);
    expect(def.defaultValues).toEqual({ color: 1, fac: 1 });
    expect([def.tslFunction, def.tslImportModule, def.category]).toEqual(['fsRgbCurves', '', 'type']);
  });

  it('cites Blender, has no glyph (its art is the curves), takes the rows layout, and is translated', () => {
    expect(getCitation('node', 'rgbCurves')?.ref).toMatch(/curvemap_make_table/);
    expect(hasNodeGlyph('rgbCurves')).toBe(false);
    expect(usesOperatorLayout(def)).toBe(false);
    expect(formatNodeLabel(def.label, def.type, 'lv')).toBe('RGB līknes (RGB Curves)');
    expect(nodeDescription(def.description, def.type, 'lv')).toMatch(/Blenderī/);
    for (const p of [...def.inputs, ...def.outputs]) expect(portLabel(p.label, 'lv'), p.label).not.toBe(p.label);
    for (const k of ['Combined', 'Red', 'Green', 'Blue', 'Extend', 'Extrapolated', 'Horizontal', 'Delete point', 'Reset curve', 'Point {n} of {total}']) {
      expect(t(k, 'lv'), k).not.toBe(k);
    }
  });
});

describe('RGB Curves — emission and the round trip', () => {
  it('the default: the exact call, the helper and fsLut once, nothing stored back', () => {
    const { first, r } = roundTrip({ nodes: [makeNode('k', 'rgbCurves', { color: 1, fac: 1 }), out()], edges: [makeEdge('k', 'out', 'out', 'color')] });
    expect(first).toContain(DEFAULT_CALL);
    expect(first.split('const fsLut = (() => {')).toHaveLength(2);
    expect(first.split('const fsRgbCurves = (col, fac, curveC, curveR, curveG, curveB, extend) => {')).toHaveLength(2);
    expect(first.indexOf('const fsLut = ')).toBeLessThan(first.indexOf('const fsRgbCurves = '));
    expect(first).toMatch(/^import \{[^}]*\bmix\b[^}]*\} from 'three\/tsl';$/m);
    expect(r.errors).toEqual([]);
    expect(getNodeValues(curvesNode(r))).toEqual({ color: 1, fac: 1 });
  });

  it('edited: S-curve on C, R lifted, a vec3 into Color, a Float into Factor, Horizontal', () => {
    const { first, r } = roundTrip({
      nodes: [
        makeNode('v', 'vec3', { x: 0.2, y: 0.5, z: 0.8 }),
        makeNode('f', 'float', { value: 0.75 }),
        makeNode('k', 'rgbCurves', { color: 1, fac: 1, curveC: S, curveR: '0 0.1,1 1', extend: 'horizontal' }),
        out(),
      ],
      edges: [makeEdge('v', 'out', 'k', 'color'), makeEdge('f', 'out', 'k', 'fac'), makeEdge('k', 'out', 'out', 'color')],
    });
    expect(first).toMatch(new RegExp(`  const rgbCurves1 = fsRgbCurves\\(vec3\\w*, float\\w*, "${S}", "0 0.1,1 1", "0 0,1 1", "0 0,1 1", "horizontal"\\);`));
    expect(r.errors).toEqual([]);
    expect(getNodeValues(curvesNode(r))).toMatchObject({ curveC: S, curveR: '0 0.1,1 1', extend: 'horizontal' });
    expect(getNodeValues(curvesNode(r))).not.toHaveProperty('curveG');
    expect(r.edges.filter((e) => e.target === curvesNode(r).id).map((e) => e.targetHandle).sort()).toEqual(['color', 'fac']);
  });

  it('a vec4 into Color and a vec3 into Factor emit BARE refs (the helper coerces), and round-trip', () => {
    const { first } = roundTrip({
      nodes: [makeNode('a', 'vec4', { x: 0.1, y: 0.2, z: 0.3, w: 1 }), makeNode('b', 'vec3', { x: 0.4, y: 0.5, z: 0.6 }), makeNode('k', 'rgbCurves', { curveC: S }), out()],
      edges: [makeEdge('a', 'out', 'k', 'color'), makeEdge('b', 'out', 'k', 'fac'), makeEdge('k', 'out', 'out', 'color')],
    });
    expect(first).toMatch(/fsRgbCurves\(vec4\w*, vec3\w*, "/);
  });

  it('two equal nodes share one helper block, get two calls, and bake ONE texture when the module runs', () => {
    const { first } = roundTrip({
      nodes: [makeNode('a', 'rgbCurves', { curveC: S }), makeNode('b', 'rgbCurves', { fac: 0.5, curveC: S }), out()],
      edges: [makeEdge('a', 'out', 'out', 'color'), makeEdge('b', 'out', 'out', 'emissive')],
    });
    expect(first.split('const fsRgbCurves = ')).toHaveLength(2);
    expect(first.match(/= fsRgbCurves\(/g)).toHaveLength(2);
    const made = runModule(first);
    expect(made).toHaveLength(1);
    expect([made[0].image.width, made[0].type, made[0].minFilter]).toEqual([257, THREE.HalfFloatType, THREE.LinearFilter]);
  });

  it('identity (Extrapolated) bakes NO texture when the module runs; identity + Horizontal bakes one', () => {
    const graph = (values: Record<string, string | number>) => ({ nodes: [makeNode('k', 'rgbCurves', values), out()], edges: [makeEdge('k', 'out', 'out', 'color')] });
    expect(runModule(code(graph({ color: 0.5, fac: 1 })))).toHaveLength(0);
    expect(runModule(code(graph({ color: 0.5, fac: 1, extend: 'horizontal' })))).toHaveLength(1);
  });

  it('a property named `rgbCurves` keeps its bare name; the helper name is never a variable', () => {
    const { first } = roundTrip({
      nodes: [makeNode('p', 'property_float', { name: 'rgbCurves', value: 0.5 }), makeNode('k', 'rgbCurves'), out()],
      edges: [makeEdge('p', 'out', 'k', 'fac'), makeEdge('k', 'out', 'out', 'color')],
    });
    expect(first).toMatch(/const rgbCurves = uniform\(/);
    expect(first).toContain('const rgbCurves1 = fsRgbCurves(1, rgbCurves, "');
    expect(first).not.toMatch(/const fsRgbCurves\d* = uniform/);
  });
});

describe('RGB Curves — hand-edited code reads through the same grammar', () => {
  it('valid but non-canonical curves are stored canonical; the identity line and Extrapolated store nothing', () => {
    const r = codeToGraph(wrap('fsRgbCurves(0.5, 0.3, "0 0, 0.250 0.15 ,0.75 0.85,1 1", "0 0,1 1", "1 1,0 0", "0 0,1 1", "extrapolate")'));
    expect(r.errors).toEqual([]);
    expect(getNodeValues(curvesNode(r))).toEqual({ color: 0.5, fac: 0.3, curveC: S });
  });

  it('a third token is a future handle type: dropped with a warning', () => {
    const r = codeToGraph(wrap('fsRgbCurves(1, 1, "0 0 vector,0.5 0.7 auto,1 1", "0 0,1 1", "0 0,1 1", "0 0,1 1", "extrapolate")'));
    expect(r.errors.map((e) => e.message)).toEqual(['fsRgbCurves: curve C carries handle types this version does not know — they were reset to Auto.']);
    expect(getNodeValues(curvesNode(r)).curveC).toBe('0 0,0.5 0.7,1 1');
  });

  it('an unreadable curve, a non-literal, or an unknown extend warns and stores nothing for it', () => {
    const bad = codeToGraph(wrap('fsRgbCurves(1, 1, "0 0,1 2e0", someCurve, "0 0,1 1", "0 0,1 1", "Horizontal")'));
    expect(bad.errors.map((e) => e.message)).toEqual([
      // A string literal is quoted ONCE, by its value; a non-literal by its source text.
      'fsRgbCurves: curve C "0 0,1 2e0" could not be read — a straight line is used.',
      'fsRgbCurves: curve R "someCurve" could not be read — a straight line is used.',
      'fsRgbCurves: "Horizontal" is not extrapolate or horizontal — Extrapolated is used.',
    ]);
    expect(bad.errors.every((e) => e.severity === 'warning')).toBe(true);
    expect(getNodeValues(curvesNode(bad))).toEqual({ color: 1, fac: 1 });
  });

  it('extra arguments and a chained call warn; nothing blocks the Apply', () => {
    const extra = codeToGraph(wrap('fsRgbCurves(1, 1, "0 0,1 1", "0 0,1 1", "0 0,1 1", "0 0,1 1", "extrapolate", 7)'));
    expect(extra.errors.map((e) => e.message)).toEqual(['fsRgbCurves: 1 extra argument dropped.']);
    const chained = codeToGraph(wrap('x.fsRgbCurves(1, 1, "0 0,1 1", "0 0,1 1", "0 0,1 1", "0 0,1 1", "horizontal")'));
    expect(chained.errors.some((e) => /must be called as a plain function/.test(e.message))).toBe(true);
    for (const r of [extra, chained]) expect(r.errors.every((e) => e.severity === 'warning')).toBe(true);
  });

  it('a short call (curves missing) reads as identity without a warning', () => {
    const r = codeToGraph(wrap('fsRgbCurves(0.4, 1)'));
    expect(r.errors).toEqual([]);
    expect(getNodeValues(curvesNode(r))).toEqual({ color: 0.4, fac: 1 });
  });
});

describe('RGB Curves — adversarial values never throw and never reach the code', () => {
  const POISON: Array<[string, Record<string, unknown>]> = [
    ['curveC toString', { curveC: { toString: 1 } }],
    ['curveC symbol', { curveC: Symbol('s') }],
    ['curveR throwing toPrimitive', { curveR: { [Symbol.toPrimitive]: () => { throw new Error('boom'); } } }],
    ['curveG 5 MB', { curveG: '0 0,'.repeat(1_300_000) }],
    ['curveB injection', { curveB: '0 0,1 1"); alert(1); ("' }],
    ['curveC comment closer', { curveC: '0 0,1 1*/ alert(1) /*' }],
    ['extend object', { extend: {} }],
    ['extend proto', { extend: '__proto__' }],
    ['color abc', { color: 'abc' }],
    ['fac NaN', { fac: NaN }],
    ['fac valueOf throws', { fac: { valueOf() { throw new Error('boom'); } } }],
  ];
  for (const [name, values] of POISON) {
    it(name, () => {
      const k = makeNode('k', 'rgbCurves');
      (k.data as { values: Record<string, unknown> }).values = values;
      const nodes = [k, out()];
      const edges = [makeEdge('k', 'out', 'out', 'color')];
      let text = '';
      expect(() => { text = code({ nodes, edges }); }).not.toThrow();
      expect(text).toMatch(/const rgbCurves1 = fsRgbCurves\(1, 1, "[0-9., ]*", "[0-9., ]*", "[0-9., ]*", "[0-9., ]*", "(extrapolate|horizontal)"\);/);
      expect(text).not.toContain('alert');
      expect(() => evaluateNodeOutput('k', nodes, edges, 0)).not.toThrow();
      expect(() => evaluateNodeRange('k', nodes, edges, 0)).not.toThrow();
      expect(evaluateNodeOutput('k', nodes, edges, 0)).toEqual([1, 1, 1]);
    });
  }

  it('a REJECTED stored curve says so in the generated code, naming the channels', () => {
    const k = makeNode('k', 'rgbCurves', { curveC: 'garbage', curveB: '0 0' });
    const text = code({ nodes: [k, out()], edges: [makeEdge('k', 'out', 'out', 'color')] });
    expect(text).toContain('  // rgbCurves1: stored curve C/B unreadable - straight line used\n');
    expect(text).toContain(DEFAULT_CALL);
    expect(text).not.toContain('stored extend');
  });

  it('a junk stored extend says so in the generated code (Color Ramp\'s interp rule); a valid one does not', () => {
    // (An UNCOERCIBLE value — `{toString: 1}` — never gets this far: getNodeValues drops it, so it reads as absent.)
    for (const bad of ['Horizontal', 5, {}]) {
      const k = makeNode('k', 'rgbCurves', { extend: bad as unknown as string });
      const text = code({ nodes: [k, out()], edges: [makeEdge('k', 'out', 'out', 'color')] });
      expect(text).toContain('  // rgbCurves1: stored extend unreadable - extrapolated used\n');
      expect(text).toContain(DEFAULT_CALL);
    }
    const ok = code({ nodes: [makeNode('k', 'rgbCurves', { extend: 'horizontal' }), out()], edges: [makeEdge('k', 'out', 'out', 'color')] });
    expect(ok).not.toContain('stored extend');
  });

  it('fuzz: 500 random stored strings only ever emit the canonical alphabet', () => {
    let seed = 13;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const ALPHABET = ['0', '1', '.', ' ', ',', 'a', 'auto', '9', '"', "'", '*/', '</script>', ' ', '١', '٫', '\\', 'e', '-', '\n', '0.5 0.5'];
    for (let n = 0; n < 500; n++) {
      const len = Math.floor(rnd() * 40);
      let s = '';
      for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
      if (rnd() < 0.5) s = `0 ${rnd().toFixed(3)},${s}`;
      const values = { curveC: s, curveR: rnd() < 0.5 ? s : '0 0,0.4 0.6,1 1', extend: ['extrapolate', 'horizontal', 'Horizontal', s][Math.floor(rnd() * 4)] };
      const text = code({ nodes: [makeNode('k', 'rgbCurves', values), out()], edges: [makeEdge('k', 'out', 'out', 'color')] });
      const m = /fsRgbCurves\(1, 1, ("[^"]*"), ("[^"]*"), ("[^"]*"), ("[^"]*"), ("[^"]*")\);/.exec(text);
      expect(m, s).not.toBeNull();
      for (const arg of m!.slice(1, 5)) expect(arg).toMatch(/^"[0-9., ]*"$/);
      expect(m![5]).toMatch(/^"(extrapolate|horizontal)"$/);
    }
  });

  it('Reset drops the curves and Extend back to the defaults', () => {
    expect(resetNodeValues(def, { color: 0.3, fac: 0.2, curveC: S, curveR: '0 0.1,1 1', extend: 'horizontal' })).toEqual({ color: 1, fac: 1 });
  });
});

describe('RGB Curves — the CPU twin, the range and the price', () => {
  // The ACTIVE table is a singleton shared with every suite in the worker (isolate:false): start and end shipped.
  beforeEach(() => {
    setCostOverrides(null);
  });
  afterEach(() => {
    setCostOverrides(null);
  });

  it('evaluateNodeOutput is evalRgbCurves on the stored colour and Factor', () => {
    const k = makeNode('k', 'rgbCurves', { color: 0.3, fac: 0.75, curveC: S, curveG: '0 0.2,1 0.6' });
    const c = readRgbCurves(getNodeValues(k));
    expect(evaluateNodeOutput('k', [k], [], 0)).toEqual(evalRgbCurves(c, [0.3, 0.3, 0.3], 0.75));
  });

  it('a wired colour flows through; a vec4 drops its fourth channel like vec3()', () => {
    const nodes = [makeNode('v', 'vec4', { x: 0.1, y: 0.5, z: 1.4, w: 0.2 }), makeNode('k', 'rgbCurves', { curveC: S })];
    const edges = [makeEdge('v', 'out', 'k', 'color')];
    expect(evaluateNodeOutput('k', nodes, edges, 0)).toEqual(evalRgbCurves(readRgbCurves({ curveC: S }), [0.1, 0.5, 1.4], 1));
  });

  it('the range of a wired colour brackets the CPU twin', () => {
    const nodes = [makeNode('u', 'uv'), makeNode('k', 'rgbCurves', { curveC: S, curveR: '0 0,0.5 1,1 0' })];
    const edges = [makeEdge('u', 'out', 'k', 'color')];
    const r = evaluateNodeRange('k', nodes, edges, 0)!;
    expect(r).toEqual(rgbCurvesRange(readRgbCurves({ curveC: S, curveR: '0 0,0.5 1,1 0' }), [0, 0, 0], [1, 1, 0], 1, 1));
    expect(r.max[0]).toBeGreaterThan(0.9);
  });

  it('an UNWIRED junk socket is its registry default in the range as in the value; a wired one is authoritative', () => {
    // The evaluator's one unwired rule (cpuEvaluator `unwiredValue`), reached here through the interval branch: the
    // colour is a field, so the deterministic shortcut does not apply.
    const nodes = [makeNode('u', 'uv'), makeNode('k', 'rgbCurves', { curveC: S, fac: 'abc' })];
    const edges = [makeEdge('u', 'out', 'k', 'color')];
    expect(evaluateNodeRange('k', nodes, edges, 0)).toEqual(rgbCurvesRange(readRgbCurves({ curveC: S }), [0, 0, 0], [1, 1, 0], 1, 1));
    // An unwired junk colour reads the registry's 1 (the POISON cases above pin the value); a wired NaN is unknown.
    // The NaN comes from √−1: a junk Float is no NaN source, it emits its default `float(0)`.
    const nan = [makeNode('f', 'float', { value: -1 }), makeNode('r', 'sqrt'), makeNode('k', 'rgbCurves', { curveC: S })];
    expect(evaluateNodeOutput('k', nan, [makeEdge('f', 'out', 'r', 'x'), makeEdge('r', 'out', 'k', 'color')], 0)).toBeNull();
  });

  it('costs 1 in its identity form and six colormap fetches + 16 ALU otherwise, repriced with Colormap', () => {
    expect(nodeCostPoints(makeNode('k', 'rgbCurves'), [])).toBe(1);
    expect(nodeCostPoints(makeNode('k', 'rgbCurves', { extend: 'horizontal' }), [])).toBe(6 * getCost('colormap') + 16);
    const bent = makeNode('k', 'rgbCurves', { curveC: S });
    // 16 = each of the two stages' 7 one-point add/mul/min/sub/max ops + the final mix's 2, at the table's own prices.
    const T = getBaseCosts();
    expect(2 * (2 * T.add + 2 * T.mul + T.min + T.sub + T.max) + T.mix).toBe(16);
    expect(nodeCostPoints(bent, [])).toBe(6 * getCost('colormap') + 16);
    expect(nodeCostPoints(bent, [])).toBe(40);
    // complexity.json's entry IS that derivation at the shipped colormap price.
    expect(T.rgbCurves, 'complexity.json rgbCurves is 6 × colormap + 16 — reprice it WITH colormap').toBe(6 * T.colormap + 16);
    setCostOverrides({ colormap: 10 });
    expect(nodeCostPoints(bent, [])).toBe(76);
  });

  it('a profile that moves the rgbCurves entry is CHARGED for a node that bakes, never for the identity form', () => {
    const bent = makeNode('k', 'rgbCurves', { curveC: S });
    setCostOverrides({ rgbCurves: 60 });
    expect(nodeCostPoints(bent, [])).toBe(60);
    expect(nodeCostPoints(makeNode('k', 'rgbCurves'), [])).toBe(1);
    // Its own entry wins over a colormap the same profile also moved…
    setCostOverrides({ rgbCurves: 60, colormap: 10 });
    expect(nodeCostPoints(bent, [])).toBe(60);
    // …while a "New profile…" table (seeded with EVERY shipped price) that moved only colormap still derives.
    setCostOverrides({ ...getBaseCosts(), colormap: 10 });
    expect(nodeCostPoints(bent, [])).toBe(76);
  });

  it('a fresh node is charged what its tile, menu row, Designer card and overview print; a parsed one its own price', () => {
    const fresh = makeNode('k', 'rgbCurves', { ...def.defaultValues });
    expect(freshNodeCost('rgbCurves')).toBe(1);
    expect(nodeCostPoints(fresh, [])).toBe(freshNodeCost('rgbCurves'));
    // codeToGraph stamps a parsed node's own price into its snapshot — what codeGroupBuilder totals for a
    // ready-made group (the layout and the card both price it live, never by the snapshot).
    const parsed = (call: string) => curvesNode(codeToGraph(wrap(call))).data.cost;
    expect(parsed('fsRgbCurves(1, 1, "0 0,1 1", "0 0,1 1", "0 0,1 1", "0 0,1 1", "extrapolate")')).toBe(1);
    expect(parsed(`fsRgbCurves(1, 1, "${S}", "0 0,1 1", "0 0,1 1", "0 0,1 1", "extrapolate")`)).toBe(40);
    expect(parsed('fsRgbCurves(1, 1, "0 0,1 1", "0 0,1 1", "0 0,1 1", "0 0,1 1", "horizontal")')).toBe(40);
  });

  it('is found by its name first and by "curves"', () => {
    const labels = (q: string) =>
      getAllDefinitions()
        .map((d) => ({ d, rank: nodeMatchRank(d, q) }))
        .filter((e) => e.rank !== NO_MATCH)
        .sort((a, b) => a.rank - b.rank)
        .map((e) => e.d.label);
    expect(labels('curves')[0]).toBe('RGB Curves');
    expect(labels('rgb curves')[0]).toBe('RGB Curves');
    expect(labels('tone curve')).toContain('RGB Curves');
    expect(labels('color correction')).toContain('RGB Curves');
  });

  it('the default stored-key alphabet never names the identity line', () => {
    expect(IDENTITY_CURVE).toBe('0 0,1 1');
  });
});
