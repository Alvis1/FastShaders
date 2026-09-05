import { describe, it, expect } from 'vitest';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { evaluateNodeOutput } from './cpuEvaluator';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { migrateLegacyNodeTypes, LEGACY_NODE_TYPES } from '@/registry/legacyNodeTypes';
import { getNodeValues } from '@/types';
import { resetNodeValues } from '@/utils/resetNodeValues';

/**
 * Two folds (2026-09-03): sdBox2 + sdBox3 → Box (the wired position's WIDTH
 * picks the helper), smoothUnion + sdSubtract → Combine (a MODE picks the
 * helper). One def each; the emitted helper name carries the choice and the
 * parser maps it back (engine/moduleHelpers.ts). Legacy names and legacy
 * registry types both keep loading.
 */

const out = () => makeNode('out', 'output');
const withValues = (n: AppNode, v: Record<string, string | number>): AppNode =>
  ({ ...n, data: { ...n.data, values: { ...getNodeValues(n), ...v } } }) as AppNode;

describe('Combine — one def, four helpers', () => {
  const graph = (mode?: string, k = 0.2) => {
    const a = makeNode('a', 'sdCircle');
    const b = makeNode('b', 'sdCircle');
    let c = withValues(makeNode('c', 'sdCombine'), { k });
    if (mode) c = withValues(c, { mode });
    const edges = [makeEdge('a', 'out', 'c', 'a'), makeEdge('b', 'out', 'c', 'b'), makeEdge('c', 'out', 'out', 'color')];
    return { nodes: [a, b, c, out()], edges };
  };

  it('emits the mode\'s helper — union by default, xor WITHOUT the smoothness argument', () => {
    const { nodes, edges } = graph();
    const code = graphToCode(nodes, edges).code;
    expect(code).toContain('const sdCombine1 = sdUnion(sdCircle1, sdCircle2, 0.2);');
    expect(code).toContain('const sdUnion = Fn(');
    expect(code).not.toContain('const sdIntersect = Fn(');
    for (const [mode, call] of [['subtract', 'sdSubtract(sdCircle1, sdCircle2, 0.2)'], ['intersect', 'sdIntersect(sdCircle1, sdCircle2, 0.2)'], ['xor', 'sdXor(sdCircle1, sdCircle2)']]) {
      const g = graph(mode);
      const c = graphToCode(g.nodes, g.edges).code;
      expect(c, mode).toContain(`const sdCombine1 = ${call};`);
    }
  });

  it('every mode survives a round trip, byte-identically, with the mode stamped back', () => {
    for (const mode of NODE_REGISTRY.get('sdCombine')!.modes!.values) {
      const g = graph(mode);
      const code = graphToCode(g.nodes, g.edges).code;
      const r = codeToGraph(code);
      expect(r.errors.filter((e) => e.severity !== 'warning'), mode).toHaveLength(0);
      const c = r.nodes.find((n) => n.data.registryType === 'sdCombine')!;
      expect(c, mode).toBeTruthy();
      expect(getNodeValues(c).mode ?? 'union', mode).toBe(mode);
      expect(r.nodes.map((n) => n.data.registryType).sort()).toEqual(['output', 'sdCircle', 'sdCircle', 'sdCombine']);
      expect(graphToCode(r.nodes, r.edges).code, mode).toBe(code);
    }
  });

  it('a junk or absent mode is union, and emits exactly what a graph saved before modes did', () => {
    const junk = graph('bogus');
    expect(graphToCode(junk.nodes, junk.edges).code).toBe(graphToCode(graph().nodes, graph().edges).code);
  });

  it('the legacy names still parse: smoothUnion → union with its k, a 2-argument sdSubtract → subtract', () => {
    const code = [
      "import { Fn, vec3, uniform } from 'three/tsl';",
      'const smoothUnion = Fn(([a, b, k]) => { return a; });',
      'const sdSubtract = Fn(([a, b]) => { return a; });',
      'const shader = Fn(() => {',
      '  const f1 = float(0.3);',
      '  const f2 = float(0.7);',
      '  const su = smoothUnion(f1, f2, 0.1);',
      '  const cut = sdSubtract(f1, f2);',
      '  return vec3(su, cut, 0);',
      '});',
      'export default shader;',
    ].join('\n');
    const r = codeToGraph(code);
    const combines = r.nodes.filter((n) => n.data.registryType === 'sdCombine');
    expect(combines.map((n) => getNodeValues(n).mode)).toEqual(['union', 'subtract']);
    expect(getNodeValues(combines[0]).k).toBe(0.1);
    expect(r.nodes.some((n) => n.data.registryType === 'unknown')).toBe(false);
  });

  it('the CPU twin agrees with the helper: hard at k = 0, IQ quadratic smin otherwise', () => {
    const eva = (mode: string, a: number, b: number, k: number) => {
      const A = withValues(makeNode('a', 'float'), { value: a });
      const B = withValues(makeNode('b', 'float'), { value: b });
      const c = withValues(makeNode('c', 'sdCombine'), { mode, k });
      const edges = [makeEdge('a', 'out', 'c', 'a'), makeEdge('b', 'out', 'c', 'b')];
      return evaluateNodeOutput('c', [A, B, c], edges, 0)?.[0];
    };
    expect(eva('union', 0.3, -0.2, 0)).toBeCloseTo(-0.2, 6);
    expect(eva('intersect', 0.3, -0.2, 0)).toBeCloseTo(0.3, 6);
    expect(eva('subtract', 0.3, -0.2, 0)).toBeCloseTo(0.3, 6); // max(a, -b) = max(0.3, 0.2)
    expect(eva('xor', 0.3, -0.2, 0)).toBeCloseTo(-0.2, 6); // max(min, -max) = max(-0.2, -0.3)
    // Smooth union at equal distances undershoots by k/4 (h = k).
    expect(eva('union', 0.1, 0.1, 0.4)).toBeCloseTo(0.1 - 0.4 / 4, 6);
  });
});

describe('Box — one def, the position width picks the helper', () => {
  const build = (posType: 'uv' | 'positionLocal', round = 0) => {
    const p = makeNode('p', posType);
    const b = withValues(makeNode('b', 'sdBox'), { w: 0.4, h: 0.3, d: 0.2, round });
    const edges = [makeEdge('p', 'out', 'b', 'p'), makeEdge('b', 'out', 'out', 'color')];
    return graphToCode([p, b, out()], edges).code;
  };

  it('a vec2 position emits sdBox2 without Half depth; a vec3 one emits sdBox3 with it', () => {
    expect(build('uv')).toContain('const sdBox1 = sdBox2(uv1, 0.4, 0.3, 0);');
    expect(build('uv')).toContain('const sdBox2 = Fn(');
    expect(build('uv')).not.toContain('const sdBox3 = Fn(');
    expect(build('positionLocal', 0.05)).toContain('const sdBox1 = sdBox3(positionLocal1, 0.4, 0.3, 0.2, 0.05);');
  });

  it('both helpers parse back to ONE Box def, byte-identically', () => {
    for (const pt of ['uv', 'positionLocal'] as const) {
      const code = build(pt, 0.05);
      const r = codeToGraph(code);
      expect(r.errors.filter((e) => e.severity !== 'warning')).toHaveLength(0);
      const box = r.nodes.find((n) => n.data.registryType === 'sdBox')!;
      expect(box).toBeTruthy();
      expect(getNodeValues(box).round).toBe(0.05);
      expect(graphToCode(r.nodes, r.edges).code).toBe(code);
    }
  });

  it('the CPU twin: 2D for a two-channel position; a rounded box gives up its corners', () => {
    const uv = makeNode('uv', 'uv');
    // uv's sample point is (0.5, 0.5) — exactly the CORNER of a half-extent
    // 0.5 box centred on the origin: on the sharp box d = 0; on a rounded one
    // the corner is cut back, so the point is (√2 − 1)·r outside.
    const at = (round: number) => evaluateNodeOutput('b', [uv, withValues(makeNode('b', 'sdBox'), { w: 0.5, h: 0.5, round })], [makeEdge('uv', 'out', 'b', 'p')], 0)?.[0];
    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(0.1)).toBeCloseTo((Math.SQRT2 - 1) * 0.1, 6);
  });
});

describe('legacy registry types migrate on load', () => {
  it('sdBox2/sdBox3 → sdBox, smoothUnion → union, sdSubtract → subtract; ports and values kept; same array when clean', () => {
    const clean = [makeNode('a', 'sdCircle')];
    expect(migrateLegacyNodeTypes(clean)).toBe(clean);
    const old = [
      withValues(makeNode('b2', 'sdBox2'), { w: 0.1, h: 0.2 }),
      withValues(makeNode('b3', 'sdBox3'), { w: 0.1, h: 0.2, d: 0.3 }),
      withValues(makeNode('su', 'smoothUnion'), { k: 0.25 }),
      makeNode('cut', 'sdSubtract'),
    ];
    const next = migrateLegacyNodeTypes(old);
    expect(next.map((n) => n.data.registryType)).toEqual(['sdBox', 'sdBox', 'sdCombine', 'sdCombine']);
    expect(getNodeValues(next[0])).toEqual({ w: 0.1, h: 0.2 });
    expect(getNodeValues(next[2])).toEqual({ k: 0.25, mode: 'union' });
    expect(getNodeValues(next[3]).mode).toBe('subtract');
    // Every legacy type maps onto a def that exists.
    for (const to of LEGACY_NODE_TYPES.values()) expect(NODE_REGISTRY.get(to.type), to.type).toBeTruthy();
  });
});

describe('every multi-mode def round-trips every mode', () => {
  for (const def of [...NODE_REGISTRY.values()].filter((d) => d.modes)) {
    for (const mode of def.modes!.values) {
      it(`${def.type} / ${mode}: emits its variant, parses back with the mode, re-emits byte-identically`, () => {
        const src = makeNode('src', def.inputs[0].dataType === 'vec3' ? 'positionLocal' : 'float');
        const n = withValues(makeNode('n', def.type), { mode });
        const edges = [makeEdge('src', 'out', 'n', def.inputs[0].id), makeEdge('n', 'out', 'out', 'color')];
        const code = graphToCode([src, n, out()], edges).code;
        const r = codeToGraph(code);
        expect(r.errors.filter((e) => e.severity !== 'warning')).toHaveLength(0);
        const back = r.nodes.find((x) => x.data.registryType === def.type)!;
        expect(back).toBeTruthy();
        expect(getNodeValues(back).mode ?? def.modes!.default).toBe(mode);
        expect(graphToCode(r.nodes, r.edges).code).toBe(code);
      });
    }
  }
});

describe('helper names are reserved from the variable namer', () => {
  it('two Box nodes never mint `sdBox2`/`sdBox3` as node variables — that shadowed the helper and threw at runtime', () => {
    const p = makeNode('p', 'positionLocal');
    const b1 = makeNode('b1', 'sdBox');
    const b2 = makeNode('b2', 'sdBox');
    const b3 = makeNode('b3', 'sdBox');
    const c = makeNode('c', 'sdCombine');
    const edges = [
      makeEdge('p', 'out', 'b1', 'p'), makeEdge('p', 'out', 'b2', 'p'), makeEdge('p', 'out', 'b3', 'p'),
      makeEdge('b1', 'out', 'c', 'a'), makeEdge('b2', 'out', 'c', 'b'), makeEdge('c', 'out', 'out', 'color'),
    ];
    const code = graphToCode([p, b1, b2, b3, c, out()], edges).code;
    for (const name of ['sdBox2', 'sdBox3', 'sdUnion', 'sdCircle', 'sdfTwist']) {
      const decls = code.match(new RegExp(`\\bconst ${name} = `, 'g')) ?? [];
      expect(decls.length, `${name} declared more than once`).toBeLessThanOrEqual(1);
      if (decls.length === 1) expect(code, `${name} must be the helper, never a node`).toMatch(new RegExp(`const ${name} = Fn\\(`));
    }
    expect(code).toContain('const sdBox1 = sdBox3(');
    expect(code).toContain('const sdBox4 = sdBox3(');
    expect(code).toContain('const sdBox5 = sdBox3(');
  });
});

describe('a node Reset keeps the mode', () => {
  it('restores the numbers but never the operation', () => {
    for (const [type, mode] of [['sdCombine', 'xor'], ['sdfModify', 'shell'], ['sdfDeform', 'bend']] as const) {
      const def = NODE_REGISTRY.get(type)!;
      const reset = resetNodeValues(def, { ...def.defaultValues, mode, amount: 9, k: 9 });
      expect(reset.mode, type).toBe(mode);
      for (const [k, v] of Object.entries(def.defaultValues ?? {})) expect(reset[k], `${type}.${k}`).toBe(v);
    }
  });
});

describe('legacy exports and hostile arities', () => {
  it('an old exported module declaring the FULL smoothUnion body parses to one Combine and no stray arithmetic nodes', () => {
    const code = [
      "import { Fn, vec3, float, clamp, add, mul, sub, div, mix } from 'three/tsl';",
      'const smoothUnion = Fn(([a, b, k]) => {',
      '  const h = clamp(add(mul(sub(b, a), div(float(0.5), k)), float(0.5)), float(0), float(1));',
      '  return sub(mix(b, a, h), mul(mul(k, h), sub(float(1), h)));',
      '});',
      'const shader = Fn(() => {',
      '  const f1 = float(0.3);',
      '  const f2 = float(0.7);',
      '  const su = smoothUnion(f1, f2, 0.1);',
      '  return vec3(su);',
      '});',
      'export default shader;',
    ].join('\n');
    const r = codeToGraph(code);
    expect(r.nodes.map((n) => n.data.registryType).sort()).toEqual(['float', 'float', 'output', 'sdCombine']);
    expect(getNodeValues(r.nodes.find((n) => n.data.registryType === 'sdCombine')!)).toMatchObject({ mode: 'union', k: 0.1 });
  });

  it('a variant called with MORE arguments than its port list does not throw — the extra is dropped with a warning', () => {
    const code = [
      "import { Fn, vec3, float } from 'three/tsl';",
      'const sdXor = Fn(([a, b]) => { return a; });',
      'const shader = Fn(() => {',
      '  const f1 = float(0.3);',
      '  const f2 = float(0.7);',
      '  const x = sdXor(f1, f2, 0.2);',
      '  return vec3(x);',
      '});',
      'export default shader;',
    ].join('\n');
    const r = codeToGraph(code);
    const c = r.nodes.find((n) => n.data.registryType === 'sdCombine')!;
    expect(c).toBeTruthy();
    expect(getNodeValues(c).mode).toBe('xor');
    expect(r.errors.every((e) => e.severity === 'warning')).toBe(true);
  });
});
