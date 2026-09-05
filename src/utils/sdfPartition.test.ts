import { describe, it, expect } from 'vitest';
import { marchPartition } from './sdfPartition';
import { makeNode, makeEdge } from '@/test-utils';

const part = (nodes: ReturnType<typeof makeNode>[], edges: ReturnType<typeof makeEdge>[], id: string) => {
  const p = marchPartition(nodes, edges, id);
  return { field: p.scopes.get('field')!, color: p.scopes.get('color')!, mainAlso: p.mainAlso };
};

describe('marchPartition', () => {
  const nodes = [
    makeNode('pos', 'positionLocal'),
    makeNode('r', 'property_float'),
    makeNode('sd', 'sdCircle'),
    makeNode('col', 'color'),
    makeNode('sdf', 'raymarchOutput'),
  ];
  const edges = [
    makeEdge('pos', 'out', 'sd', 'p'),
    makeEdge('r', 'out', 'sd', 'r'),
    makeEdge('sd', 'out', 'sdf', 'field'),
    makeEdge('col', 'out', 'sdf', 'color'),
  ];

  it('field = the position-dependent ancestors of the field socket, roots included', () => {
    const p = part(nodes, edges, 'sdf');
    expect([...p.field].sort()).toEqual(['pos', 'sd']);
  });

  it('a uniform feeding the field is NOT in the set (captured by closure instead)', () => {
    expect(part(nodes, edges, 'sdf').field.has('r')).toBe(false);
  });

  it('a constant colour is not position-dependent, so the colour set is empty', () => {
    expect(part(nodes, edges, 'sdf').color.size).toBe(0);
  });

  it('roots are always emitted in the flat body too', () => {
    expect(part(nodes, edges, 'sdf').mainAlso.has('pos')).toBe(true);
  });

  it('a set member with a consumer outside the sets is emitted in the flat body too', () => {
    const n2 = [...nodes, makeNode('dangle', 'abs')];
    const e2 = [...edges, makeEdge('sd', 'out', 'dangle', 'x')];
    const p = part(n2, e2, 'sdf');
    expect(p.field.has('sd')).toBe(true);
    expect(p.mainAlso.has('sd')).toBe(true);
    expect(p.field.has('dangle')).toBe(false);
  });

  it('a position-dependent colour chain lands in the colour set', () => {
    const n2 = [...nodes, makeNode('len', 'length')];
    const e2 = [
      makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sdf', 'field'),
      makeEdge('pos', 'out', 'len', 'v'), makeEdge('len', 'out', 'sdf', 'color'),
    ];
    const p = part(n2, e2, 'sdf');
    expect([...p.color].sort()).toEqual(['len', 'pos']);
    expect(p.field.has('len')).toBe(false);
  });
});

describe('drivingMarchOutput', () => {
  it('a Raymarch Output drives only when Field or Density is wired', async () => {
    const { drivingMarchOutput, marchOutputDrives } = await import('./sdfPartition');
    const nodes = [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('sdf', 'raymarchOutput'), makeNode('out', 'output')];
    const unwired = [makeEdge('pos', 'out', 'sd', 'p')];
    expect(marchOutputDrives(nodes, unwired)).toBe(false);
    const wired = [...unwired, makeEdge('sd', 'out', 'sdf', 'field')];
    expect(drivingMarchOutput(nodes, wired)?.id).toBe('sdf');
  });
});
