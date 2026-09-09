/**
 * Transform and Repeat take ONE vec3 socket per group (2026-09-09), where each
 * took three floats.
 *
 * The whole change hangs on one TSL fact, and it is the kind that produces
 * perfect-looking source and a blank preview if it is wrong: `vec3()` on a vec3
 * must be the IDENTITY, and on a float the FILL. The helpers rely on both,
 * because a socket that is wired arrives as a vec3 and the same socket unwired
 * arrives as the port's scalar default.
 *
 * Why the broadcast is in the HELPER and not in codegen: emitting `vec3(0)` at
 * the call site makes `codeToGraph` see a Vec3 CONSTRUCTOR and mint a node for
 * it, so the graph grows by one node per Apply — measured, it took sdfExtrude's
 * round trip from 3 nodes to 4. Emission therefore still writes the bare
 * number, exactly as it did before this change.
 */
import { describe, it, expect } from 'vitest';
import * as TSL from 'three/tsl';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { graphToCode } from './graphToCode';
import { makeNode, makeEdge } from '@/test-utils';
import { evaluateNodeOutput } from './cpuEvaluator';
import type { AppNode } from '@/types';

describe('the TSL fact the helpers rest on', () => {
  it('vec3() fills from a float and is the identity on a vec3', () => {
    // Built against the REAL three/tsl: a text assertion cannot catch a
    // constructor that does not accept this shape.
    const filled = TSL.vec3(TSL.float(2));
    expect(filled).toBeTruthy();
    const v = TSL.vec3(1, 2, 3);
    const same = TSL.vec3(v);
    expect(same).toBeTruthy();
    // …and the components are reachable, which is what the helpers do with it.
    expect(() => TSL.vec3(TSL.vec3(1, 2, 3)).x).not.toThrow();
    expect(() => TSL.vec3(TSL.float(0)).z).not.toThrow();
  });
});

describe('Plane and Mirror — the two whose default was NOT uniform', () => {
  it('Plane keeps its floor default through a DEGENERATE normal, not a literal', () => {
    // A normal must point somewhere, and (0,1,0) cannot be broadcast from one
    // scalar. Emitting `vec3(0, 1, 0)` instead would parse back as a real Vec3
    // node and grow the graph on the first Apply, so the zero vector carries
    // the default: the helper reads a zero-length normal as "up".
    expect(NODE_REGISTRY.get('sdPlane')!.inputs.map((i) => i.id)).toEqual(['p', 'n', 'h']);
    const code = graphToCode(
      [makeNode('pos', 'positionLocal'), makeNode('pl', 'sdPlane')],
      [makeEdge('pos', 'out', 'pl', 'p')],
    ).code;
    expect(code).toMatch(/sdPlane\(\w+, 0, 0\)/);
    // Scoped to the CALL: the helper's own body legitimately contains that
    // literal now — it is the fallback — so a whole-module search would pass
    // for the wrong reason and fail for the right one.
    const call = code.split('\n').find((l) => /const sdPlane\d+ = sdPlane\(/.test(l))!;
    expect(call).not.toContain('vec3(');
    expect(readFileSyncHelpers()).toContain("select(greaterThan(length(n0), float(1e-6)), n0, vec3(0, 1, 0))");
  });

  it('an unwired Plane still measures distance to the FLOOR — evaluator included', () => {
    // The behavioural half: the evaluator carries its own copy of the formula,
    // so the degenerate fallback has to live in both or the card contradicts
    // the picture. A point 2 units up is 2 from the y=0 plane.
    const nodes = [
      { ...makeNode('v', 'vec3'), data: { ...makeNode('v', 'vec3').data, values: { x: 0, y: 2, z: 0 } } },
      makeNode('pl', 'sdPlane'),
    ] as AppNode[];
    const out = evaluateNodeOutput('pl', nodes, [makeEdge('v', 'out', 'pl', 'p')], 0);
    expect(out?.[0]).toBeCloseTo(2, 6);
  });

  it('Mirror folds all three axes by default, which is a CHANGE from X only', () => {
    // Unlike Plane there is no degenerate value to hang the old (1,0,0) on: 0
    // is a meaningful weight (fold nothing), so it cannot double as a sentinel.
    // Mirroring all three beat mirroring none because a freshly dropped node
    // that visibly does nothing reads as broken.
    expect(NODE_REGISTRY.get('sdfMirror')!.inputs.map((i) => i.id)).toEqual(['p', 'm']);
    expect(NODE_REGISTRY.get('sdfMirror')!.defaultValues!.m).toBe(1);
    const nodes = [
      { ...makeNode('v', 'vec3'), data: { ...makeNode('v', 'vec3').data, values: { x: -1, y: -2, z: -3 } } },
      makeNode('mi', 'sdfMirror'),
    ] as AppNode[];
    const out = evaluateNodeOutput('mi', nodes, [makeEdge('v', 'out', 'mi', 'p')], 0);
    expect(out).toEqual([1, 2, 3]);
  });
});

describe('the consolidated sockets', () => {
  it('Transform takes Position + three vec3 groups, and nothing per-axis', () => {
    const ids = NODE_REGISTRY.get('sdfTransform')!.inputs.map((i) => i.id);
    expect(ids).toEqual(['p', 't', 'r', 's']);
    for (const id of ['t', 'r', 's']) {
      expect(NODE_REGISTRY.get('sdfTransform')!.inputs.find((i) => i.id === id)!.dataType).toBe('vec3');
    }
  });

  it('Repeat takes Position + Spacing + Limit', () => {
    const ids = NODE_REGISTRY.get('sdfRepeat')!.inputs.map((i) => i.id);
    expect(ids).toEqual(['p', 's', 'l']);
  });

  it('Box takes Position + one Half size + Rounding', () => {
    const ids = NODE_REGISTRY.get('sdBox')!.inputs.map((i) => i.id);
    expect(ids).toEqual(['p', 'b', 'round']);
    expect(NODE_REGISTRY.get('sdBox')!.inputs.find((i) => i.id === 'b')!.dataType).toBe('vec3');
  });

  it('Deform keeps Amount scalar and folds Stretch into one vec3', () => {
    // `amount` drives twist and bend and is genuinely one number; only the
    // elongate mode's three stretch axes were a group.
    const ids = NODE_REGISTRY.get('sdfDeform')!.inputs.map((i) => i.id);
    expect(ids).toEqual(['p', 'amount', 'h']);
    expect(NODE_REGISTRY.get('sdfDeform')!.inputs.find((i) => i.id === 'amount')!.dataType).toBe('float');
    expect(NODE_REGISTRY.get('sdfDeform')!.inputs.find((i) => i.id === 'h')!.dataType).toBe('vec3');
  });

  it('the Box width dispatch now changes the CALLEE only, not the arity', () => {
    // Both variants take (position, half size, rounding). The flat case simply
    // ignores `.z`, where before it had a Half depth socket that meant nothing.
    const src = readFileSyncHelpers();
    expect(src).toContain("'const sdBox2 = Fn(([p, b, r]) => {',");
    expect(src).toContain("'const sdBox3 = Fn(([p, b, r]) => {',");
    expect((src.match(/ports: \['p', 'b', 'round'\]/g) ?? []).length).toBe(2);
  });

  it('emits the bare default for an unwired group — never a Vec3 constructor', () => {
    // The identity of each group: Move 0, Turn 0, Scale 1 — broadcast inside
    // the helper. A `vec3(...)` here is the regression that grows the graph.
    const code = graphToCode(
      [makeNode('pos', 'positionLocal'), makeNode('tr', 'sdfTransform'), makeNode('rp', 'sdfRepeat')],
      [makeEdge('pos', 'out', 'tr', 'p'), makeEdge('pos', 'out', 'rp', 'p')],
    ).code;
    expect(code).toMatch(/sdfTransform\(\w+, 0, 0, 1\)/);
    expect(code).toMatch(/sdfRepeat\(\w+, 1, 0\)/);
    // …and the same for the two added later: a 0.5 half-size broadcasts to the
    // 1x1x1 box the three separate 0.5 sockets used to describe.
    const box = graphToCode(
      [makeNode('pos', 'positionLocal'), makeNode('bx', 'sdBox')],
      [makeEdge('pos', 'out', 'bx', 'p')],
    ).code;
    expect(box).toMatch(/sdBox3\(\w+, 0.5, 0\)/);
  });

  it('scale is non-uniform now, so the helper divides per axis', () => {
    // The consequence to remember: a non-uniformly scaled field is a BOUND, not
    // a distance. Multiply back with Modify: scale using the smallest
    // component, and lower the Raymarch Step scale on a strongly anisotropic
    // shape.
    const src = readFileSyncHelpers();
    expect(src).toContain("const s3 = vec3(s);");
    expect(src).toContain("div(sub(p, t3), max(s3, vec3(1e-6)))");
  });
});

function readFileSyncHelpers(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs').readFileSync(new URL('./moduleHelpers.ts', import.meta.url), 'utf8');
}
