import { describe, it, expect } from 'vitest';
import { sdfPartition } from './sdfPartition';
import { makeNode, makeEdge } from '@/test-utils';

describe('sdfPartition', () => {
  const nodes = [
    makeNode('pos', 'positionLocal'),
    makeNode('r', 'property_float'),
    makeNode('sd', 'sdCircle'),
    makeNode('col', 'color'),
    makeNode('sdf', 'sdfOutput'),
  ];
  const edges = [
    makeEdge('pos', 'out', 'sd', 'p'),
    makeEdge('r', 'out', 'sd', 'r'),
    makeEdge('sd', 'out', 'sdf', 'field'),
    makeEdge('col', 'out', 'sdf', 'color'),
  ];

  it('field = the position-dependent ancestors of the field socket, roots included', () => {
    const p = sdfPartition(nodes, edges, 'sdf');
    expect([...p.field].sort()).toEqual(['pos', 'sd']);
  });

  it('a uniform feeding the field is NOT in the set (captured by closure instead)', () => {
    expect(sdfPartition(nodes, edges, 'sdf').field.has('r')).toBe(false);
  });

  it('a constant colour is not position-dependent, so the colour set is empty', () => {
    expect(sdfPartition(nodes, edges, 'sdf').color.size).toBe(0);
  });

  it('roots are always emitted in the flat body too', () => {
    expect(sdfPartition(nodes, edges, 'sdf').mainAlso.has('pos')).toBe(true);
  });

  it('a set member with a consumer outside the sets is emitted in the flat body too', () => {
    const n2 = [...nodes, makeNode('dangle', 'abs')];
    const e2 = [...edges, makeEdge('sd', 'out', 'dangle', 'x')];
    const p = sdfPartition(n2, e2, 'sdf');
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
    const p = sdfPartition(n2, e2, 'sdf');
    expect([...p.color].sort()).toEqual(['len', 'pos']);
    expect(p.field.has('len')).toBe(false);
  });
});

describe('drivingSdfOutput', () => {
  it('an SDF Output drives only when its field socket is wired', async () => {
    const { drivingSdfOutput, sdfOutputDrives } = await import('./sdfPartition');
    const nodes = [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('sdf', 'sdfOutput'), makeNode('out', 'output')];
    const unwired = [makeEdge('pos', 'out', 'sd', 'p')];
    expect(sdfOutputDrives(nodes, unwired)).toBe(false);
    const wired = [...unwired, makeEdge('sd', 'out', 'sdf', 'field')];
    expect(drivingSdfOutput(nodes, wired)?.id).toBe('sdf');
  });
});
