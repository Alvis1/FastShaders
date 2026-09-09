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

  it('emits the bare default for an unwired group — never a Vec3 constructor', () => {
    // The identity of each group: Move 0, Turn 0, Scale 1 — broadcast inside
    // the helper. A `vec3(...)` here is the regression that grows the graph.
    const code = graphToCode(
      [makeNode('pos', 'positionLocal'), makeNode('tr', 'sdfTransform'), makeNode('rp', 'sdfRepeat')],
      [makeEdge('pos', 'out', 'tr', 'p'), makeEdge('pos', 'out', 'rp', 'p')],
    ).code;
    expect(code).toMatch(/sdfTransform\(\w+, 0, 0, 1\)/);
    expect(code).toMatch(/sdfRepeat\(\w+, 1, 0\)/);
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
