/**
 * Routing points were REMOVED (owner, 2026-11-24: "just remove the routing
 * points without replacing"). An older graph's `edge.data.waypoints` is simply
 * DROPPED on every restore path — fs:graph (loadGraph / parseStoredGraph), a
 * project block (importShaderText → applyProjectToStore) and fs:savedGroups
 * (loadSavedGroups) — through the one sanitizer, `sanitizeEdgeExtras`. No
 * conversion, the wire draws as its plain curve, and the emitted code is the
 * same as before: no engine ever read the points.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import type { AppEdge, AppNode } from '@/types';
import { HISTORY_IDLE, makeNode, stubLocalStorage } from '@/test-utils';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { graphToCode } from '@/engine/graphToCode';
import { embedProjectState, type FastShadersProject } from '@/engine/fastShadersProject';
import { importShaderText } from '@/engine/projectImport';
import { makeTypedEdge } from '@/utils/edgeUtils';
import { cancelPendingGraphSave, loadGraph, loadSavedGroups, parseStoredGraph, useAppStore } from './useAppStore';

const nodes: AppNode[] = [
  makeNode('f', 'float', { value: 0.25 }),
  makeNode('s', 'sin'),
  makeNode('o', 'output'),
];
const plain: AppEdge[] = [makeTypedEdge('f', 'out', 's', 'x'), makeTypedEdge('s', 'out', 'o', 'color')];
/** The same wires as an older file stored them: with routing points. */
const routed: AppEdge[] = plain.map((e, i) => ({
  ...e,
  data: { dataType: 'any', waypoints: [{ x: 100 + i, y: 50 }, { x: 200, y: -30 }] },
}));
const codeOf = (n: AppNode[], e: AppEdge[]) => graphToCode(n, e, NODE_REGISTRY).code;
const noPoints = (edges: readonly AppEdge[]) => {
  expect(edges.length).toBeGreaterThan(0);
  for (const e of edges) expect(Object.keys((e.data ?? {}) as object)).not.toContain('waypoints');
};

let savedName = '';
function reset() {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], importNote: null, ...HISTORY_IDLE });
}
beforeEach(() => {
  savedName = useAppStore.getState().shaderName;
  reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  reset();
  useAppStore.setState({ shaderName: savedName });
});
afterAll(reset);

describe('an older graph\'s routing points are dropped on every restore path', () => {
  it('fs:graph — loadGraph and the parse it shares with the desktop autosave', () => {
    const stored = { nodes, edges: routed, drawings: [] };
    stubLocalStorage({ 'fs:graph': JSON.stringify(stored) });
    const loaded = loadGraph()!;
    expect(loaded).not.toBeNull();
    noPoints(loaded.edges);
    expect(codeOf(loaded.nodes, loaded.edges)).toBe(codeOf(nodes, plain));
    const parsed = parseStoredGraph(JSON.parse(JSON.stringify(stored)))!;
    noPoints(parsed.edges);
    expect(parsed.edges.map((e) => e.id)).toEqual(plain.map((e) => e.id));
  });

  it('a project block — importShaderText → applyProjectToStore', () => {
    const project = { version: 1, shaderName: 'old', graph: { nodes, edges: routed }, preview: {}, ui: {} } as FastShadersProject;
    const text = embedProjectState('export default function () {}\n', project);
    expect(importShaderText(text)).toBe('project');
    const st = useAppStore.getState();
    noPoints(st.edges);
    expect(st.edges.map((e) => e.id)).toEqual(plain.map((e) => e.id));
    expect(codeOf(st.nodes, st.edges)).toBe(codeOf(nodes, plain));
  });

  it('fs:savedGroups — loadSavedGroups', () => {
    stubLocalStorage({
      'fs:savedGroups': JSON.stringify([{ id: 'g1', name: 'old', color: '#336699', nodes, edges: routed }]),
    });
    const groups = loadSavedGroups();
    expect(groups).toHaveLength(1);
    noPoints(groups[0].edges);
    expect(codeOf(groups[0].nodes, groups[0].edges)).toBe(codeOf(nodes, plain));
  });

  it('the points never reached the code to begin with', () => {
    expect(codeOf(nodes, routed)).toBe(codeOf(nodes, plain));
  });
});
