import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { computeReachableCost, nodeCostPoints, getCost } from '@/utils/nodeCost';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * SDF Output — the raymarcher. The field chain is emitted inside
 * `Fn(([p]) => …)` and evaluated per step; the node discards misses and
 * shades hits with a gradient normal. See utils/sdfPartition.ts.
 */
const sphereGraph = () => {
  const nodes = [
    makeNode('pos', 'positionLocal'),
    makeNode('sd', 'sdCircle'),
    makeNode('col', 'color'),
    makeNode('sdf', 'sdfOutput'),
  ];
  const edges = [
    makeEdge('pos', 'out', 'sd', 'p'),
    makeEdge('sd', 'out', 'sdf', 'field'),
    makeEdge('col', 'out', 'sdf', 'color'),
  ];
  return { nodes, edges };
};

describe('SDF Output emission', () => {
  it('emits the field as a per-step Fn with the root bound to p, the march, the cutout and the normal', () => {
    const { nodes, edges } = sphereGraph();
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('const sdfOut1Field = Fn(([p]) => {');
    expect(code).toContain('    const positionLocal1 = p;');
    expect(code).toContain('    const sdCircle1 = sdCircle(positionLocal1, 0.5);');
    expect(code).toContain('    return sdCircle1;');
    expect(code).toContain('Loop(int(48), () => {');
    expect(code).toContain('If(d.lessThan(0.002), () => { hit.assign(1); Break(); });');
    expect(code).toContain('If(t.greaterThan(4), () => { Break(); });');
    expect(code).toContain('  Discard(sdfOut1.w.lessThan(0.5));');
    expect(code).toContain('  return { color: color1, normal: sdfOut1N };');
    // The field chain is NOT also emitted in the flat body.
    expect(code.split('const sdCircle1 = ')).toHaveLength(2);
    // The root IS (harmless, and keeps any dangling consumer valid).
    expect(code).toContain('  const positionLocal1 = positionLocal;');
    for (const name of ['Loop', 'If', 'Break', 'int', 'modelWorldMatrixInverse', 'transformNormalToView', 'Discard']) {
      expect(code.split('\n')[0], name).toContain(name);
    }
  });

  it('round-trips byte-identically through codeToGraph, with no imperative-block warnings', () => {
    const { nodes, edges } = sphereGraph();
    const { code } = graphToCode(nodes, edges);
    const r = codeToGraph(code);
    expect(r.errors).toEqual([]);
    const types = r.nodes.map((n) => n.data.registryType).sort();
    expect(types).toEqual(['color', 'positionLocal', 'sdCircle', 'sdfOutput']);
    const again = graphToCode(r.nodes, r.edges).code;
    expect(again).toBe(code);
  });

  it('carries tuned steps/maxDist/epsilon across the round trip', () => {
    const { nodes, edges } = sphereGraph();
    (nodes[3].data as { values?: Record<string, number> }).values = { steps: 32, maxDist: 3, epsilon: 0.01 };
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('Loop(int(32)');
    const r = codeToGraph(code);
    const sdf = r.nodes.find((n) => n.data.registryType === 'sdfOutput')!;
    expect((sdf.data as { values: Record<string, number> }).values).toMatchObject({ steps: 32, maxDist: 3, epsilon: 0.01 });
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });

  it('a wired step-count uniform reaches the loop and survives the round trip', () => {
    const { nodes, edges } = sphereGraph();
    nodes.push(makeNode('st', 'property_float'));
    (nodes[4].data as { values?: Record<string, unknown> }).values = { value: 24, name: 'marchSteps' };
    edges.push(makeEdge('st', 'out', 'sdf', 'steps'));
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('Loop(int(marchSteps)');
    const r = codeToGraph(code);
    expect(r.edges.some((e) => e.targetHandle === 'steps')).toBe(true);
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });

  it('a position-dependent colour chain is evaluated once at the hit point', () => {
    const nodes = [
      makeNode('pos', 'positionLocal'),
      makeNode('sd', 'sdCircle'),
      makeNode('len', 'length'),
      makeNode('sdf', 'sdfOutput'),
    ];
    const edges = [
      makeEdge('pos', 'out', 'sd', 'p'),
      makeEdge('sd', 'out', 'sdf', 'field'),
      makeEdge('pos', 'out', 'len', 'v'),
      makeEdge('len', 'out', 'sdf', 'color'),
    ];
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('const sdfOut1Color = Fn(([p]) => {');
    expect(code).toContain('    return vec3(length1);');
    expect(code).toContain('return { color: sdfOut1Color(sdfOut1Hit), normal: sdfOut1N };');
    const r = codeToGraph(code);
    expect(r.errors).toEqual([]);
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });

  it('an unwired colour emits no colour key (the __pixel wrapper supplies white) and round-trips', () => {
    const { nodes, edges } = sphereGraph();
    const noColor = edges.filter((e) => e.targetHandle !== 'color');
    const { code } = graphToCode(nodes.filter((n) => n.id !== 'col'), noColor);
    expect(code).toContain('  return { normal: sdfOut1N };');
    const r = codeToGraph(code);
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });

  it('an unwired field falls back to the red sentinel and never marches', () => {
    const nodes = [makeNode('sdf', 'sdfOutput')];
    const { code } = graphToCode(nodes, []);
    expect(code).toContain('return vec3(1, 0, 0);');
    expect(code).not.toContain('Loop(');
  });

  it('prices the field body once per step plus four normal taps, on top of the fixed march cost', () => {
    const { nodes, edges } = sphereGraph();
    const body = nodeCostPoints(nodes[1], edges) + nodeCostPoints(nodes[0], edges);
    const expected = body * (48 + 4) + nodeCostPoints(nodes[2], edges) + getCost('sdfOutput');
    expect(computeReachableCost(nodes, edges)).toBe(expected);
  });
});

describe('SDF Output stored colour', () => {
  it('a colour picked on the node emits color(0x…) and round-trips as the stored value', () => {
    const nodes = [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('sdf', 'sdfOutput', { color: '#2d6cdf' })];
    const edges = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sdf', 'field')];
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('return { color: color(0x2d6cdf), normal: sdfOut1N };');
    const r = codeToGraph(code);
    const sdf = r.nodes.find((n) => n.data.registryType === 'sdfOutput')!;
    expect((sdf.data as { values: Record<string, unknown> }).values.color).toBe('#2d6cdf');
    expect(graphToCode(r.nodes, r.edges).code).toBe(code);
  });
});
