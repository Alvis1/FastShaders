import { describe, it, expect } from 'vitest';
import { sanitizeEdgeExtras, MAX_WAYPOINTS_PER_EDGE } from './edgeExtras';
import type { AppEdge } from '@/types';

const withData = (data: unknown): AppEdge =>
  ({ id: 'e1', source: 'a', target: 'b', type: 'typed', data } as unknown as AppEdge);

describe('sanitizeEdgeExtras', () => {
  it('returns the SAME array (and same edge objects) when nothing needs fixing', () => {
    const edges = [withData({ dataType: 'float', waypoints: [{ x: 1, y: 2 }] })];
    const out = sanitizeEdgeExtras(edges);
    expect(out).toBe(edges);
    expect(out[0]).toBe(edges[0]);
    expect(out[0].data!.waypoints).toBe(edges[0].data!.waypoints);
  });

  it('passes through an edge with no data at all', () => {
    const edges = [{ id: 'e1', source: 'a', target: 'b' } as unknown as AppEdge];
    expect(sanitizeEdgeExtras(edges)).toBe(edges);
  });

  // The crash set: these reach TypedEdge's render and throw with no error boundary.
  it('drops null waypoint entries (would throw on w.x during render)', () => {
    const out = sanitizeEdgeExtras([withData({ dataType: 'any', waypoints: [null, { x: 1, y: 2 }] })]);
    expect(out[0].data!.waypoints).toEqual([{ x: 1, y: 2 }]);
  });

  it('rejects a string masquerading as a waypoint list (its .length passes the gate)', () => {
    const out = sanitizeEdgeExtras([withData({ dataType: 'any', waypoints: 'abc' })]);
    expect(out[0].data!.waypoints).toBeUndefined();
  });

  it('drops non-finite coordinates (1e999 parses to Infinity and voids the path)', () => {
    const out = sanitizeEdgeExtras([
      withData({ dataType: 'any', waypoints: [{ x: Infinity, y: 0 }, { x: NaN, y: 1 }, { x: 5, y: 6 }] }),
    ]);
    expect(out[0].data!.waypoints).toEqual([{ x: 5, y: 6 }]);
  });

  it('clamps out-of-bounds coordinates rather than dropping them', () => {
    const out = sanitizeEdgeExtras([withData({ dataType: 'any', waypoints: [{ x: 1e12, y: -1e12 }] })]);
    expect(out[0].data!.waypoints).toEqual([{ x: 1e6, y: -1e6 }]);
  });

  it('caps the waypoint count', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ x: i, y: i }));
    const out = sanitizeEdgeExtras([withData({ dataType: 'any', waypoints: many })]);
    expect(out[0].data!.waypoints).toHaveLength(MAX_WAYPOINTS_PER_EDGE);
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
