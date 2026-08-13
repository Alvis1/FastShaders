import { describe, it, expect } from 'vitest';
import { fmtEdgeNum, edgeRangeText, liveEdgeText } from './edgeValueText';
import { makeNode, makeEdge } from '../test-utils';

describe('fmtEdgeNum', () => {
  it('keeps up to 2 decimals and trims trailing zeros', () => {
    expect(fmtEdgeNum(3.687)).toBe('3.69');
    expect(fmtEdgeNum(5)).toBe('5');
    expect(fmtEdgeNum(-0.7)).toBe('-0.7');
    expect(fmtEdgeNum(Number.NaN)).toBe('0');
  });
});

describe('edgeRangeText', () => {
  it('collapses near-equal endpoints to a single value with decimals', () => {
    expect(edgeRangeText(3.687, 3.694)).toBe('3.69');
  });
  it('rounds true ranges to whole numbers', () => {
    expect(edgeRangeText(-0.8, 0.8)).toBe('-1…1');
  });
  it('collapses a range whose rounded ends meet', () => {
    expect(edgeRangeText(0.9, 1.1)).toBe('1');
  });
});

describe('liveEdgeText', () => {
  it('evaluates a time-driven chain at the given t (the frozen-t=0 bug case)', () => {
    // time → sin: at t = 0 this is the "dead wire 0" the on-node labels used
    // to freeze on; at a real t it is the live value.
    const nodes = [
      makeNode('t1', 'time', { speed: 1 }),
      makeNode('s1', 'sin', {}),
    ];
    const edges = [makeEdge('t1', 'out', 's1', 'x')];
    expect(liveEdgeText('s1', nodes, edges, 0)).toBe('0');
    expect(liveEdgeText('s1', nodes, edges, Math.PI / 2)).toBe('1');
    expect(liveEdgeText('t1', nodes, edges, 3.66)).toBe('3.66');
  });
});
