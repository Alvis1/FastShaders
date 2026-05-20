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
