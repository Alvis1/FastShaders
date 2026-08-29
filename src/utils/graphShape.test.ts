import { describe, it, expect, afterAll, vi } from 'vitest';
import {
  isRecord,
  hasUsableNodeShape,
  hasUsablePosition,
  isRenderableNode,
  isUsableEdge,
  sanitizeGraphShape,
} from './graphShape';
import { loadGraph } from '@/store/useAppStore';
import { getNodeValues } from '@/types';
import type { AppNode } from '@/types';

/**
 * The element-shape gate for the untrusted graph restore paths.
 *
 * The defect class this closes is DATA LOSS, not a wrong picture: React Flow
 * dereferences `node.position.x` unguarded during commit and there is no error
 * boundary above the canvas, so one malformed element blanks the page — and the
 * 300 ms autosave, armed by zustand's synchronous notify before React renders,
 * writes that same graph straight back. Every later boot blanks again. The
 * sanitizers had the mirror problem: `n.data.registryType` on a null element
 * throws inside `loadGraph`, which returns null and lets the demo graph
 * overwrite the user's real work.
 */
describe('graphShape predicates', () => {
  it('isRecord rejects null and arrays, which are the two things typeof lies about', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord(5)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('a node needs a non-empty string id and a record data', () => {
    expect(hasUsableNodeShape({ id: 'a', data: {} })).toBe(true);
    expect(hasUsableNodeShape({ id: 'a' })).toBe(false);
    expect(hasUsableNodeShape({ id: '', data: {} })).toBe(false);
    expect(hasUsableNodeShape({ id: 5, data: {} })).toBe(false);
    expect(hasUsableNodeShape({ data: {} })).toBe(false);
    expect(hasUsableNodeShape(null)).toBe(false);
  });

  it('a position must be two FINITE numbers — NaN and Infinity are what get through JSON', () => {
    expect(hasUsablePosition({ position: { x: 0, y: 0 } })).toBe(true);
    expect(hasUsablePosition({ position: { x: -1e6, y: 12.5 } })).toBe(true);
    expect(hasUsablePosition({ position: { x: 0 } })).toBe(false);
    expect(hasUsablePosition({ position: { x: NaN, y: 0 } })).toBe(false);
    expect(hasUsablePosition({ position: { x: Infinity, y: 0 } })).toBe(false);
    expect(hasUsablePosition({ position: { x: '0', y: '0' } })).toBe(false);
    expect(hasUsablePosition({ position: null })).toBe(false);
    expect(hasUsablePosition({})).toBe(false);
  });

  it('isRenderableNode is exactly both halves — the shape extractProjectState rejects on', () => {
    expect(isRenderableNode({ id: 'a', data: {}, position: { x: 1, y: 2 } })).toBe(true);
    // This is the literal payload that blanked the app: id + data, no position.
    expect(isRenderableNode({ id: 'a', data: {} })).toBe(false);
  });

  it('an edge is gated on ENDPOINTS, deliberately not on id', () => {
    expect(isUsableEdge({ source: 'a', target: 'b' })).toBe(true);
    expect(isUsableEdge({ id: 'e1', source: 'a', target: 'b' })).toBe(true);
    expect(isUsableEdge({ source: 'a' })).toBe(false);
    expect(isUsableEdge(null)).toBe(false);
  });
});

describe('sanitizeGraphShape', () => {
  const ok = { id: 'a', type: 'shader', data: { registryType: 'mul' }, position: { x: 1, y: 2 } };

  it('returns the SAME arrays when nothing needed changing', () => {
    // Load-bearing: the autosave subscriber and selectionOnlyGraphChange compare
    // by reference, so a fresh array on every boot would arm a full-graph
    // JSON.stringify (multi-MB once images are embedded) for no reason at all.
    const nodes = [ok];
    const edges = [{ id: 'e', source: 'a', target: 'a' }];
    const r = sanitizeGraphShape(nodes, edges);
    expect(r.nodes).toBe(nodes);
    expect(r.edges).toBe(edges);
    expect(r.droppedNodes + r.repairedPositions + r.droppedEdges).toBe(0);
  });

  it('drops what cannot be repaired and repairs what can', () => {
    const r = sanitizeGraphShape<Record<string, unknown>, unknown>(
      [ok, { id: 'b', data: {} }, null, { data: {}, position: { x: 0, y: 0 } }],
      [],
    );
    // 'b' is KEPT — only its position was missing, and a coordinate is
    // recoverable by dragging where a deleted node is not.
    expect(r.nodes).toHaveLength(2);
    expect(r.droppedNodes).toBe(2);
    expect(r.repairedPositions).toBe(1);
    expect(r.nodes[1].position).toEqual({ x: 0, y: 0 });
  });

  it('prunes dangling edges only when asked', () => {
    const edges = [{ id: 'e', source: 'ghost', target: 'a' }];
    // A SAVED GROUP records its boundary wiring, so an edge whose source sits
    // outside the group is the normal case — pruning it there silently deletes
    // the connection instantiateSavedGroup is meant to re-resolve.
    expect(sanitizeGraphShape([ok], edges).edges).toBe(edges);
    expect(sanitizeGraphShape([ok], edges, { pruneDanglingEdges: true }).edges).toHaveLength(0);
  });
});

describe('getNodeValues coerces a non-object `values`', () => {
  it('a tampered primitive becomes {} instead of reaching callers', () => {
    // `data.values ?? {}` guarded nullish and nothing else, so `values: 5`
    // arrived as a primitive and `'originId' in values` THREW — inside
    // loadGraph that returns null and the autosave then overwrites the user's
    // entire saved graph with the demo one.
    const prim = { id: 'a', type: 'shader', data: { registryType: 'mul', values: 5 } };
    expect(getNodeValues(prim as unknown as AppNode)).toEqual({});
    const arr = { id: 'a', type: 'shader', data: { registryType: 'mul', values: [] } };
    expect(getNodeValues(arr as unknown as AppNode)).toEqual({});
    // The normal case keeps its IDENTITY, so no memo is invalidated.
    const values = { x: 1 };
    const good = { id: 'a', type: 'shader', data: { registryType: 'mul', values } };
    expect(getNodeValues(good as unknown as AppNode)).toBe(values);
  });
});

describe('loadGraph survives a poisoned fs:graph', () => {
  afterAll(() => vi.unstubAllGlobals());

  function stub(payload: unknown) {
    const store: Record<string, string> = { 'fs:graph': JSON.stringify(payload) };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
  }

  it('returns the repaired graph rather than null, so the demo graph cannot replace it', () => {
    stub({
      nodes: [
        { id: 'keep', type: 'shader', position: { x: 5, y: 6 }, data: { registryType: 'mul', values: {} } },
        // Each of these used to be fatal somewhere between here and render.
        { id: 'noPos', type: 'shader', data: { registryType: 'mul', values: {} } },
        { id: 'primValues', type: 'shader', position: { x: 0, y: 0 }, data: { registryType: 'imageNode', values: 5 } },
        null,
      ],
      edges: [{ id: 'e', source: 'keep', target: 'noPos' }],
      drawings: [],
    });

    const g = loadGraph();
    expect(g, 'a malformed element must not discard the whole saved graph').not.toBeNull();
    const ids = g!.nodes.map((n) => n.id);
    expect(ids).toContain('keep');
    expect(ids).toContain('noPos');
    expect(ids).toContain('primValues');
    expect(ids).not.toContain(undefined);
    expect(g!.nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
    // The intact node is untouched.
    expect(g!.nodes.find((n) => n.id === 'keep')!.position).toEqual({ x: 5, y: 6 });
  });

  it('drops an edge pointing at a node that did not survive', () => {
    stub({
      nodes: [{ id: 'a', type: 'shader', position: { x: 0, y: 0 }, data: { registryType: 'mul', values: {} } }],
      edges: [
        { id: 'ok', source: 'a', target: 'a' },
        { id: 'dangling', source: 'a', target: 'gone' },
      ],
      drawings: [],
    });
    const g = loadGraph();
    expect(g!.edges.map((e) => e.id)).toEqual(['ok']);
  });
});
