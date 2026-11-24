import { describe, it, expect } from 'vitest';
import { sanitizeEdgeExtras } from './edgeExtras';
import type { AppEdge } from '@/types';

const withData = (data: unknown): AppEdge =>
  ({ id: 'e1', source: 'a', target: 'b', type: 'typed', data } as unknown as AppEdge);

describe('sanitizeEdgeExtras', () => {
  it('returns the SAME array (and same edge objects) when nothing needs fixing', () => {
    const edges = [withData({ dataType: 'float' })];
    const out = sanitizeEdgeExtras(edges);
    expect(out).toBe(edges);
    expect(out[0]).toBe(edges[0]);
  });

  it('passes through an edge with no data at all', () => {
    const edges = [{ id: 'e1', source: 'a', target: 'b' } as unknown as AppEdge];
    expect(sanitizeEdgeExtras(edges)).toBe(edges);
  });

  // A file's edge `className` is adversarial: TypedEdge's dive selector called
  // `.includes` on it during render and blanked the app on every boot.
  it('strips a NON-STRING className (keeping the wire), and keeps a string one by identity', () => {
    for (const className of [5, true, { a: 1 }, ['fs-collapsed-edge'], null]) {
      const out = sanitizeEdgeExtras([{ ...withData({ dataType: 'float' }), className } as unknown as AppEdge]);
      expect('className' in out[0], String(className)).toBe(false);
      expect(out[0]).toMatchObject({ id: 'e1', source: 'a', target: 'b', data: { dataType: 'float' } });
    }
    const clean = [{ ...withData({ dataType: 'float' }), className: 'fs-collapsed-edge' } as unknown as AppEdge];
    expect(sanitizeEdgeExtras(clean)).toBe(clean);
  });

  // Routing points were REMOVED (owner, 2026-11-24): an older file's
  // `waypoints` — well-formed or poisoned — is simply dropped, never converted.
  it('DROPS an older file\'s routing points, keeping the wire and its type', () => {
    const out = sanitizeEdgeExtras([withData({ dataType: 'vec3', waypoints: [{ x: 1, y: 2 }, { x: 3, y: 4 }] })]);
    expect(out[0].data).toEqual({ dataType: 'vec3' });
    expect(out[0]).toMatchObject({ id: 'e1', source: 'a', target: 'b' });
  });

  it('drops a poisoned routing-point list too (null entries, a string, Infinity, thousands of points)', () => {
    for (const waypoints of [
      [null, { x: 1, y: 2 }],
      'abc',
      [{ x: Infinity, y: 0 }, { x: NaN, y: 1 }],
      Array.from({ length: 5000 }, (_, i) => ({ x: i, y: i })),
    ]) {
      const out = sanitizeEdgeExtras([withData({ dataType: 'any', waypoints })]);
      expect(out[0].data).toEqual({ dataType: 'any' });
    }
  });

  it('degrades an unknown dataType to any', () => {
    const out = sanitizeEdgeExtras([withData({ dataType: 'mat4x4' })]);
    expect(out[0].data!.dataType).toBe('any');
  });

  it('strips keys outside the edge.data vocabulary', () => {
    const out = sanitizeEdgeExtras([withData({ dataType: 'any', evil: 'x'.repeat(1000) })]);
    expect(Object.keys(out[0].data!)).toEqual(['dataType']);
  });

  it('replaces a non-object data with a valid default', () => {
    const out = sanitizeEdgeExtras([withData('nonsense')]);
    expect(out[0].data).toEqual({ dataType: 'any' });
  });

  it('DROPS a non-object edge element rather than throwing inside loadGraph', () => {
    const good = withData({ dataType: 'any' });
    const out = sanitizeEdgeExtras([
      null as unknown as AppEdge,
      good,
      undefined as unknown as AppEdge,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(good);
  });
});
