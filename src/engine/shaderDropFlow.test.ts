/**
 * The dropped-shader dialog's two answers, end to end against the store:
 * `openDroppedShader` (replace the document, adopt a name) and
 * `addDroppedShader` (park it beside the graph in a group, wired to nothing).
 *
 * Node-env safe, the `paletteProject.test.ts` shape: `buildProjectState`'s
 * localStorage reads are individually try/catch'd, and every `window` dispatch
 * on this path carries a `typeof window` guard.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { HISTORY_IDLE, makeNode, makeEdge } from '@/test-utils';
import { buildProjectState } from './exportShader';
import { embedProjectState } from './fastShadersProject';
import { addDroppedShader, openDroppedShader } from './projectImport';
import type { AppNode } from '@/types';

const SCRIPT = [
  'import { color } from "three/tsl";',
  '',
  'export default function () {',
  '  return { colorNode: color(0xffffff) };',
  '}',
  '',
].join('\n');

function at(id: string, type: string, x = 0, y = 0): AppNode {
  const n = makeNode(id, type);
  n.position = { x, y };
  return n;
}

/** The text of a `.fastshader`-style export of the given graph and name. */
function projectText(nodes: AppNode[], edges: ReturnType<typeof makeEdge>[], shaderName: string): string {
  const before = useAppStore.getState();
  useAppStore.setState({ nodes, edges, drawings: [], shaderPalettes: [], shaderName });
  const project = buildProjectState();
  const text = embedProjectState(SCRIPT, project);
  useAppStore.setState({
    nodes: before.nodes,
    edges: before.edges,
    drawings: before.drawings,
    shaderPalettes: before.shaderPalettes,
    shaderName: before.shaderName,
  });
  return text;
}

function file(text: string, name: string): File {
  return new File([text], name, { type: 'text/javascript' });
}

/** A canvas with one chain and its Output — the shader being worked on. */
function liveGraph(): void {
  useAppStore.setState({
    nodes: [at('live-uv', 'uv', 0, 0), at('live-out', 'output', 300, 0)],
    edges: [makeEdge('live-uv', 'out', 'live-out', 'color')],
    drawings: [],
    shaderPalettes: [],
    shaderName: 'My Shader',
    past: [],
    future: [],
    ...HISTORY_IDLE,
  });
}

beforeEach(() => {
  useAppStore.setState({
    nodes: [],
    edges: [],
    drawings: [],
    shaderPalettes: [],
    shaderName: 'My Shader',
    past: [],
    future: [],
    ...HISTORY_IDLE,
    pendingLimitNotices: [],
    pendingShaderImports: [],
    previewMesh: null,
  });
});

afterAll(() => cancelPendingGraphSave());

describe('openDroppedShader: the name', () => {
  it('keeps the AUTHORED name when the file supplies one', async () => {
    const text = projectText([at('n', 'uv')], [], 'Ocean Waves');
    await openDroppedShader(file(text, 'waves (1).js'));
    expect(useAppStore.getState().shaderName).toBe('Ocean Waves');
  });

  it('adopts the FILE stem when the block ships no name', async () => {
    // The bug this closes: the document kept the PREVIOUS shader's name, and
    // that name is what the next export would have been written under.
    const text = projectText([at('n', 'uv')], [], '');
    await openDroppedShader(file(text, 'lo_udens.js'));
    expect(useAppStore.getState().shaderName).toBe('lo_udens');
  });

  it('replaces the graph — that is what Open means', async () => {
    liveGraph();
    const text = projectText([at('theirs', 'noise')], [], 'Theirs');
    await openDroppedShader(file(text, 'theirs.js'));
    const ids = useAppStore.getState().nodes.map((n) => n.id);
    expect(ids).not.toContain('live-uv');
  });
});

describe('addDroppedShader: the document survives', () => {
  it('keeps every live node and wire, and adds the file beside them', async () => {
    liveGraph();
    const text = projectText(
      [at('their-uv', 'uv', 0, 0), at('their-noise', 'noise', 200, 0), at('their-out', 'output', 400, 0)],
      [makeEdge('their-uv', 'out', 'their-noise', 'pos'), makeEdge('their-noise', 'out', 'their-out', 'color')],
      'Theirs',
    );
    const r = await addDroppedShader(file(text, 'lo_udens.js'));
    expect(r.ok).toBe(true);

    const s = useAppStore.getState();
    // The live graph is untouched, wires included.
    expect(s.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['live-uv', 'live-out']));
    expect(s.edges.some((e) => e.source === 'live-uv' && e.target === 'live-out')).toBe(true);
    // …and the document did not change its name.
    expect(s.shaderName).toBe('My Shader');
  });

  it('brings NO second Output — "not attached to output"', async () => {
    liveGraph();
    const text = projectText(
      [at('their-noise', 'noise', 0, 0), at('their-out', 'output', 300, 0)],
      [makeEdge('their-noise', 'out', 'their-out', 'color')],
      'Theirs',
    );
    const r = await addDroppedShader(file(text, 'waves.js'));
    expect(r.ok && r.droppedSinks).toBe(1);
    const outputs = useAppStore.getState().nodes.filter((n) => n.data.registryType === 'output');
    expect(outputs).toHaveLength(1);
    expect(outputs[0].id).toBe('live-out');
  });

  it('frames the arrivals in a group named after the FILE', async () => {
    liveGraph();
    const text = projectText([at('their-noise', 'noise')], [], 'Some Other Name');
    await addDroppedShader(file(text, 'lo_udens.js'));
    const groups = useAppStore.getState().nodes.filter((n) => n.type === 'group');
    expect(groups).toHaveLength(1);
    expect((groups[0].data as { label: string }).label).toBe('lo_udens');
    // React Flow requires a parent BEFORE its children in the array.
    const nodes = useAppStore.getState().nodes;
    const gi = nodes.findIndex((n) => n.id === groups[0].id);
    const member = nodes.findIndex((n) => n.parentId === groups[0].id);
    expect(member).toBeGreaterThan(gi);
  });

  it('is ONE undo entry, and undo puts the canvas back', async () => {
    liveGraph();
    const text = projectText([at('their-noise', 'noise')], [], 'Theirs');
    await addDroppedShader(file(text, 'waves.js'));
    expect(useAppStore.getState().past).toHaveLength(1);
    useAppStore.getState().undo();
    const s = useAppStore.getState();
    expect(s.nodes.map((n) => n.id).sort()).toEqual(['live-out', 'live-uv']);
    expect(s.nodes.some((n) => n.type === 'group')).toBe(false);
  });

  it('leaves the preview mesh alone — an Add is not a new document', async () => {
    liveGraph();
    const mesh = { fileName: 'm.glb', kind: 'glb', bytes: new Uint8Array([1]) };
    useAppStore.setState({ previewMesh: mesh as never });
    const text = projectText([at('their-noise', 'noise')], [], 'Theirs');
    await addDroppedShader(file(text, 'waves.js'));
    expect(useAppStore.getState().previewMesh).toBe(mesh);
  });

  it('refuses a file with nothing but an Output rather than dropping an empty frame', async () => {
    liveGraph();
    const text = projectText([at('their-out', 'output')], [], 'Theirs');
    const r = await addDroppedShader(file(text, 'empty.js'));
    expect(r).toEqual({ ok: false, reason: 'nothing-to-add' });
    expect(useAppStore.getState().nodes.some((n) => n.type === 'group')).toBe(false);
    // A refused add leaves no undo entry.
    expect(useAppStore.getState().past).toHaveLength(0);
  });

  it('does not collide with a file exported from THIS very shader', async () => {
    liveGraph();
    // Same ids as the live graph — the ordinary case for a shader someone
    // saved, edited and dropped back in.
    const text = projectText(
      [at('live-uv', 'uv'), at('live-out', 'output', 300, 0)],
      [makeEdge('live-uv', 'out', 'live-out', 'color')],
      'Mine',
    );
    const r = await addDroppedShader(file(text, 'mine.js'));
    expect(r.ok).toBe(true);
    const ids = useAppStore.getState().nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
