import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import {
  isRecord,
  hasUsableNodeShape,
  hasUsablePosition,
  isRenderableNode,
  isUsableEdge,
  isUsableFlowType,
  isSelectorSafeId,
  sanitizeGraphShape,
} from './graphShape';
import { loadGraph, useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { BEGIN_MARKER, END_MARKER, extractProjectState } from '@/engine/fastShadersProject';
import { rawNodeTypes, edgeTypes } from '@/components/NodeEditor/flowTypes';
import { makeDataNodeData } from '@/utils/dataNode';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import { getNodeValues } from '@/types';
import type { AppNode } from '@/types';
import { HISTORY_IDLE, makeEdge, makeNode, stubLocalStorage } from '@/test-utils';

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

/**
 * React Flow interpolates node ids (useUpdateNodeInternals, on every node's
 * mount) and handle ids (isValidHandle, during a connection drag) into
 * attribute selectors WITHOUT escaping. Measured in Chrome 2026-10-11: `"`, CR,
 * LF and FF throw a SyntaxError — from a mount effect, with no error boundary,
 * that unmounted the whole app, and the autosave kept the id, so every reload
 * blanked again; `\` and NUL silently miss; U+2028/U+2029 match.
 */
describe('selector-unsafe ids', () => {
  const UNSAFE = ['"', '\\', '\r', '\n', '\f', '\0'];
  const node = (id: string) => ({ id, type: 'shader', data: { registryType: 'mul', values: {} }, position: { x: 1, y: 2 } });

  it('a node id holding any of them is unusable', () => {
    for (const c of UNSAFE) {
      expect(isSelectorSafeId(`n${c}1`), JSON.stringify(c)).toBe(false);
      expect(hasUsableNodeShape(node(`n${c}1`)), JSON.stringify(c)).toBe(false);
      expect(isRenderableNode(node(`n${c}1`)), JSON.stringify(c)).toBe(false);
    }
    // The literal probe: an id that closes the attribute string and opens a selector LIST.
    expect(hasUsableNodeShape(node('n"],[data-handleid="out'))).toBe(false);
  });

  it('every id and handle the app mints still passes', () => {
    for (const id of [
      'node_1791706040635_12', 'gi_output', 'gi_output_m3', 'node_1#m01', 'mul1', 'grp-note',
      // Characters a hand-edited or older file may hold that the measurement cleared.
      'färbe_π', 'a b', 'a b', "it's", 'a,b', 'a]b', 'a:b', 'x<y', '😀',
    ]) {
      expect(hasUsableNodeShape(node(id)), id).toBe(true);
    }
    for (const h of ['out', 'in', 'col12', 'm1:color', 'm12:emissive', '__in_node_1_2_color', '__out_node_1#m01_out', 'alpha']) {
      expect(isUsableEdge({ source: 'a', sourceHandle: h, target: 'b', targetHandle: h }), h).toBe(true);
    }
    // A missing or null handle is React Flow's default socket, as before.
    expect(isUsableEdge({ source: 'a', sourceHandle: null, target: 'b' })).toBe(true);
  });

  it('an edge with an unsafe endpoint or HANDLE is unusable', () => {
    for (const c of UNSAFE) {
      const q = JSON.stringify(c);
      expect(isUsableEdge({ source: `a${c}`, target: 'b' }), q).toBe(false);
      expect(isUsableEdge({ source: 'a', target: `b${c}` }), q).toBe(false);
      expect(isUsableEdge({ source: 'a', sourceHandle: `out${c}`, target: 'b' }), q).toBe(false);
      expect(isUsableEdge({ source: 'a', target: 'b', targetHandle: `in${c}` }), q).toBe(false);
    }
  });

  it('sanitizeGraphShape drops that node and those edges, and keeps everything else as it was', () => {
    const keep = node('keep');
    const other = node('other');
    const ok = { id: 'ok', source: 'keep', sourceHandle: 'out', target: 'other', targetHandle: 'a' };
    const r = sanitizeGraphShape<Record<string, unknown>, Record<string, unknown>>(
      [keep, node('bad"q'), other],
      [ok, { id: 'toBad', source: 'keep', target: 'bad"q' }, { id: 'badHandle', source: 'keep', sourceHandle: 'out"', target: 'other' }],
      { pruneDanglingEdges: true },
    );
    expect(r.nodes).toEqual([keep, other]);
    expect(r.nodes[0]).toBe(keep);
    expect(r.edges).toEqual([ok]);
    expect([r.droppedNodes, r.repairedPositions, r.droppedEdges]).toEqual([1, 0, 2]);
    // A SAVED GROUP (no dangling prune) still loses the edge whose handle is unsafe.
    const g = sanitizeGraphShape([keep], [{ source: 'outside', target: 'keep', targetHandle: 'a\nb' }]);
    expect(g.edges).toEqual([]);
  });

  it('a project block holding one is REJECTED, so the file opens as a plain script', () => {
    const block = (nodes: unknown[], edges: unknown[] = []) =>
      `const shader = 1;\n${BEGIN_MARKER}\n${JSON.stringify({ version: 1, graph: { nodes, edges } })}\n${END_MARKER}\n`;
    expect(extractProjectState(block([node('a'), node('b')]))).not.toBeNull();
    expect(extractProjectState(block([node('a'), node('b"')]))).toBeNull();
    expect(extractProjectState(block([node('a'), node('b')], [{ source: 'a', sourceHandle: 'o"', target: 'b' }]))).toBeNull();
  });
});

/**
 * Three more shapes that blanked the app for good, measured in Chrome
 * 2026-10-11 (each through `fs:graph`, so the autosave kept it):
 *  - a node or edge `type` naming an Object.prototype member: React Flow looks
 *    it up in its own builtin map, a plain object, and renders `Object` /
 *    `valueOf` / `Object.prototype` as a component;
 *  - a Data node's `dynamicOutputs` that is not a list of sockets (`5`,
 *    `[null]`): TypedEdge's store selector reads it on every wire's render;
 *  - a collapsed group's `collapsedInputs` that is not a list of sockets (`5`,
 *    `'abc'`, `[null]`): GroupNode maps it on render.
 */
describe('flow types and data-borne socket lists', () => {
  const node = (id: string, extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
    id, type: 'shader', position: { x: 1, y: 2 }, data: { registryType: 'mul', values: {}, ...data }, ...extra,
  });
  const PROTO_NAMES = ['constructor', 'valueOf', 'hasOwnProperty', 'toString', '__proto__', 'isPrototypeOf', '__defineGetter__'];

  it('a type naming an Object.prototype member, or a non-string type, is unusable on a node and an edge', () => {
    for (const t of PROTO_NAMES) {
      expect(isUsableFlowType(t), t).toBe(false);
      // JSON.parse, so `__proto__` is an OWN key exactly as a file delivers it.
      expect(hasUsableNodeShape(JSON.parse(`{"id":"a","type":${JSON.stringify(t)},"data":{}}`)), t).toBe(false);
      expect(isUsableEdge({ source: 'a', target: 'b', type: t }), t).toBe(false);
    }
    for (const t of [5, {}, { toString: 1 }, ['shader'], true]) {
      expect(isUsableFlowType(t), JSON.stringify(t)).toBe(false);
    }
    // Absent / null is React Flow's `default`; an unknown string falls back to it too.
    for (const t of [undefined, null, '', 'foo', 'default']) expect(isUsableFlowType(t), String(t)).toBe(true);
  });

  it('every flow type the app registers (and the legacy ones a migration reads) still passes', () => {
    const minted = [...Object.keys(rawNodeTypes), ...Object.keys(edgeTypes), 'mic', 'texturePreview'];
    expect(minted.length).toBeGreaterThan(10);
    for (const t of minted) expect(isUsableFlowType(t), t).toBe(true);
  });

  it('every built-in preset and texture graph passes the whole gate', () => {
    const assets = [...getBuiltinPresets(), ...getBuiltinTextures()];
    expect(assets.length).toBeGreaterThan(20);
    for (const a of assets) {
      const stored = JSON.parse(JSON.stringify({ nodes: a.nodes, edges: a.edges }));
      expect(stored.nodes.filter((n: unknown) => !isRenderableNode(n)), a.name).toEqual([]);
      expect(stored.edges.filter((e: unknown) => !isUsableEdge(e)), a.name).toEqual([]);
    }
  });

  it("a Data node's dynamicOutputs must be a list of sockets with selector-safe ids", () => {
    const real = makeDataNodeData({ columnNames: ['temp', 'höhe "m"'], columns: [[1, 2], [3, 4]], rowCount: 2 }, 2);
    expect(hasUsableNodeShape({ id: 'd', type: 'shader', data: real })).toBe(true);
    for (const ok of [undefined, null, [], [{ id: 'col0', label: 'a', dataType: 'float' }], [{ id: 'col0', label: 7 }]]) {
      expect(hasUsableNodeShape(node('d', {}, { dynamicOutputs: ok })), JSON.stringify(ok)).toBe(true);
    }
    for (const bad of [
      5, 'col0', { find: 1 }, [null], [5], [{ label: 'a' }], [{ id: 5 }], [{ id: 'c"0' }], [{ id: 'c\\0' }],
      [{ id: 'col0', label: { toString: 1 } }], [{ id: 'col0', dataType: {} }], [{ id: 'col0', hint: [] }],
    ]) {
      expect(hasUsableNodeShape(node('d', {}, { dynamicOutputs: bad })), JSON.stringify(bad)).toBe(false);
    }
  });

  it("a collapsed group's socket lists must be lists of sockets with selector-safe ids", () => {
    const sock = { socketId: '__in_a_b', originalNodeId: 'a', originalHandleId: 'b', dataType: 'float', name: 'B' };
    const grp = (data: Record<string, unknown>) => ({
      id: 'g', type: 'group', position: { x: 0, y: 0 },
      data: { registryType: 'group', label: 'G', color: '#888888', width: 160, height: 60, collapsed: true, ...data },
    });
    expect(hasUsableNodeShape(grp({ collapsedInputs: [sock], collapsedOutputs: [] }))).toBe(true);
    expect(hasUsableNodeShape(grp({ collapsedInputs: [{ ...sock, name: undefined, dataType: undefined }] }))).toBe(true);
    for (const key of ['collapsedInputs', 'collapsedOutputs']) {
      for (const bad of [
        5, 'abc', { length: 1 }, [null], [{ ...sock, socketId: 5 }], [{ ...sock, socketId: '__in_a"_b' }],
        [{ ...sock, originalNodeId: undefined }], [{ ...sock, originalHandleId: 'b\n' }],
        [{ ...sock, name: { toString: 1 } }], [{ ...sock, dataType: [] }],
      ]) {
        expect(hasUsableNodeShape(grp({ [key]: bad })), `${key} ${JSON.stringify(bad)}`).toBe(false);
      }
    }
  });

  it('a label that cannot render is unusable: React Flow\'s fallback node renders it as a child', () => {
    for (const ok of [undefined, null, 'Multiply', '', 7]) {
      expect(hasUsableNodeShape(node('a', {}, { label: ok })), String(ok)).toBe(true);
    }
    for (const bad of [{ a: 1 }, { toString: 1 }, ['x'], true]) {
      expect(hasUsableNodeShape(node('a', { type: 'foo' }, { label: bad })), JSON.stringify(bad)).toBe(false);
    }
  });

  it('a project block holding any of them is REJECTED', () => {
    const block = (nodes: unknown[], edges: unknown[] = []) =>
      `const shader = 1;\n${BEGIN_MARKER}\n${JSON.stringify({ version: 1, graph: { nodes, edges } })}\n${END_MARKER}\n`;
    expect(extractProjectState(block([node('a'), node('b')], [{ source: 'a', target: 'b', type: 'typed' }]))).not.toBeNull();
    expect(extractProjectState(block([node('a', { type: 'constructor' })]))).toBeNull();
    expect(extractProjectState(block([node('a'), node('b')], [{ source: 'a', target: 'b', type: 'valueOf' }]))).toBeNull();
    expect(extractProjectState(block([node('a', {}, { dynamicOutputs: 5 })]))).toBeNull();
    expect(extractProjectState(block([node('a', {}, { collapsedInputs: [null] })]))).toBeNull();
  });
});

describe('a group the app itself collapsed passes the gate', () => {
  // Drift guard for isUsableBoundarySocket: the sockets toggleGroupCollapsed
  // MINTS must pass, or every saved graph holding a collapsed group would lose
  // that group on its next reload.
  afterAll(() => {
    vi.unstubAllGlobals();
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
  });
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const member = (n: AppNode, x: number): AppNode => ({ ...n, parentId: 'g', position: { x, y: 40 } }) as AppNode;
    useAppStore.setState({
      nodes: [
        { id: 'g', type: 'group', position: { x: 100, y: 50 }, width: 300, height: 200,
          data: { registryType: 'group', label: 'g', color: '#dde', collapsed: false, width: 300, height: 200 } } as unknown as AppNode,
        member(makeNode('a', 'mul'), 20),
        member(makeNode('b', 'mul'), 160),
        makeNode('src', 'float'),
        makeNode('o', 'output'),
      ],
      edges: [makeEdge('src', 'out', 'a', 'a'), makeEdge('a', 'out', 'b', 'a'), makeEdge('b', 'out', 'o', 'color')],
      past: [],
      future: [],
      ...HISTORY_IDLE,
    });
  });

  it('both socket lists populated, every node and edge still usable', () => {
    useAppStore.getState().toggleGroupCollapsed('g');
    const { nodes, edges } = useAppStore.getState();
    const g = nodes.find((n) => n.id === 'g')!;
    const data = g.data as { collapsedInputs?: unknown[]; collapsedOutputs?: unknown[] };
    expect(data.collapsedInputs?.length).toBe(1);
    expect(data.collapsedOutputs?.length).toBe(1);
    // A JSON round trip, as fs:graph stores it.
    const stored = JSON.parse(JSON.stringify({ nodes, edges }));
    expect(stored.nodes.every(isRenderableNode)).toBe(true);
    expect(stored.edges.every(isUsableEdge)).toBe(true);
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
    stubLocalStorage({ 'fs:graph': JSON.stringify(payload) });
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

  it('a node whose id would blank the app is dropped with its wires; the rest restores intact', () => {
    // The verifier's reproduction: one id ending in a double quote. Before the
    // gate React Flow's mount selector threw, the root unmounted, and this
    // same fs:graph came back on every reload.
    stub({
      nodes: [
        { id: 'a', type: 'shader', position: { x: 5, y: 6 }, data: { registryType: 'mul', values: { b: 2 } } },
        { id: 'evil"q', type: 'shader', position: { x: 0, y: 0 }, data: { registryType: 'mul', values: {} } },
        { id: 'o', type: 'output', position: { x: 300, y: 0 }, data: { registryType: 'output', values: {} } },
      ],
      edges: [
        { id: 'e1', source: 'a', sourceHandle: 'out', target: 'o', targetHandle: 'color' },
        { id: 'e2', source: 'evil"q', sourceHandle: 'out', target: 'a', targetHandle: 'a' },
        { id: 'e3', source: 'a', sourceHandle: 'out"', target: 'o', targetHandle: 'roughness' },
      ],
      drawings: [],
    });
    const g = loadGraph();
    expect(g).not.toBeNull();
    expect(g!.nodes.map((n) => n.id)).toEqual(['a', 'o']);
    expect(g!.nodes.find((n) => n.id === 'a')!.position).toEqual({ x: 5, y: 6 });
    expect(getNodeValues(g!.nodes.find((n) => n.id === 'a')!)).toEqual({ b: 2 });
    expect(g!.edges.map((e) => e.id)).toEqual(['e1']);
  });

  it('a prototype-named type or a broken socket list is dropped; the rest restores intact', () => {
    // Each of these blanked the app on every reload (Chrome, 2026-10-11).
    const text = JSON.stringify({
      nodes: [
        { id: 'a', type: 'shader', position: { x: 5, y: 6 }, data: { registryType: 'mul', values: { b: 2 } } },
        { id: 'o', type: 'output', position: { x: 300, y: 0 }, data: { registryType: 'output', values: {} } },
        { id: 'ctor', type: 'constructor', position: { x: 0, y: 0 }, data: { registryType: 'mul', values: {} } },
        { id: 'dyn', type: 'shader', position: { x: 0, y: 0 }, data: { registryType: 'dataNode', values: {}, dynamicOutputs: 5 } },
        { id: 'grp', type: 'group', position: { x: 0, y: 0 }, width: 160, height: 60,
          data: { registryType: 'group', label: 'G', color: '#888888', width: 160, height: 60, collapsed: true, collapsedInputs: [null] } },
      ],
      edges: [
        { id: 'e1', source: 'a', sourceHandle: 'out', target: 'o', targetHandle: 'color', type: 'typed' },
        { id: 'e2', source: 'a', sourceHandle: 'out', target: 'o', targetHandle: 'roughness', type: 'proto' },
        { id: 'e3', source: 'dyn', sourceHandle: 'col0', target: 'a', targetHandle: 'a', type: 'typed' },
      ],
      drawings: [],
    }).replace('"type":"proto"', '"type":"__proto__"');
    stubLocalStorage({ 'fs:graph': text });
    const g = loadGraph();
    expect(g).not.toBeNull();
    expect(g!.nodes.map((n) => n.id)).toEqual(['a', 'o']);
    expect(getNodeValues(g!.nodes.find((n) => n.id === 'a')!)).toEqual({ b: 2 });
    expect(g!.edges.map((e) => e.id)).toEqual(['e1']);
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
