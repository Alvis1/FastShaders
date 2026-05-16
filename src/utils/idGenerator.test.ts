import { describe, it, expect } from 'vitest';
import { generateId, generateEdgeId } from './idGenerator';

describe('generateId', () => {
  it('produces an id with the expected prefix', () => {
    expect(generateId()).toMatch(/^node_\d+_\d+$/);
  });

  it('produces unique ids across rapid successive calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(generateId());
    expect(ids.size).toBe(1000);
  });

  it('monotonically increases the suffix counter within the same millisecond', () => {
    const a = generateId();
    const b = generateId();
    const aSuffix = parseInt(a.split('_').pop()!, 10);
    const bSuffix = parseInt(b.split('_').pop()!, 10);
    expect(bSuffix).toBeGreaterThan(aSuffix);
  });
});

describe('generateEdgeId', () => {
  it('joins the four endpoint parts with the e- prefix', () => {
    expect(generateEdgeId('n1', 'out', 'n2', 'in')).toBe('e-n1-out-n2-in');
  });

  it('is deterministic for the same inputs', () => {
    expect(generateEdgeId('a', 'b', 'c', 'd')).toBe(generateEdgeId('a', 'b', 'c', 'd'));
  });

  it('produces different ids for different endpoints', () => {
    const a = generateEdgeId('n1', 'out', 'n2', 'in');
    const b = generateEdgeId('n1', 'out', 'n2', 'other');
    expect(a).not.toBe(b);
  });
});
