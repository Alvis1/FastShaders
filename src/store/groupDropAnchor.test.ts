/**
 * A group DRAGGED from the asset bar lands with its frame's TOP-RIGHT corner
 * on the drop point (owner, 2026-10-01); a click/Enter add keeps the top-left
 * at its scattered centre point. One rule for all three group sources — saved
 * groups, built-in presets and built-in textures — decided in
 * `cloneGroupSnapshot`, from the frame's DRAWN width (`groupFrameSize`, which
 * also reads the `style`-only frames the built-in builder used to write).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useAppStore, cancelPendingGraphSave, groupFrameSize } from '@/store/useAppStore';
import { HISTORY_IDLE, makeNode } from '@/test-utils';
import type { AppNode } from '@/types';

const NODE_EDITOR = readFileSync(resolve(__dirname, '../components/NodeEditor/NodeEditor.tsx'), 'utf8');

const frame = (id: string, size: { width?: number; style?: { width: number; height: number } }): AppNode =>
  ({
    id,
    type: 'group',
    position: { x: 0, y: 0 },
    ...(size.width ? { width: size.width, height: 120 } : {}),
    ...(size.style ? { style: size.style } : {}),
    data: { label: id, color: '#dde', collapsed: false },
  }) as unknown as AppNode;

function seed(group: AppNode) {
  useAppStore.setState({
    savedGroups: [
      {
        id: 'sg1',
        name: 'g',
        nodes: [group, { ...makeNode('m', 'float'), parentId: group.id, position: { x: 24, y: 60 } } as AppNode],
        edges: [],
      },
    ] as never,
  });
}

const placedFrame = () => useAppStore.getState().nodes.find((n) => n.type === 'group')!;
const placedMember = () => useAppStore.getState().nodes.find((n) => n.type !== 'group')!;

beforeEach(() => {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], savedGroups: [], ...HISTORY_IDLE });
});
afterAll(() => {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], savedGroups: [] });
});

describe('saved groups', () => {
  it('top-right: the frame hangs LEFT of the drop point by its own width', () => {
    seed(frame('g', { width: 260 }));
    useAppStore.getState().instantiateSavedGroup('sg1', { x: 500, y: 300 }, { anchor: 'top-right' });
    expect(placedFrame().position).toEqual({ x: 240, y: 300 });
    // Members are parent-relative, so they follow the frame untouched.
    expect(placedMember().position).toEqual({ x: 24, y: 60 });
    expect(placedMember().parentId).toBe(placedFrame().id);
  });

  it('the default (and a click/Enter add) keeps the top-left corner on the point', () => {
    seed(frame('g', { width: 260 }));
    useAppStore.getState().instantiateSavedGroup('sg1', { x: 500, y: 300 });
    expect(placedFrame().position).toEqual({ x: 500, y: 300 });
    useAppStore.getState().instantiateSavedGroup('sg1', { x: 500, y: 300 }, { anchor: 'top-left' });
    expect(useAppStore.getState().nodes.filter((n) => n.type === 'group')[0].position).toEqual({ x: 500, y: 300 });
  });

  it('reads a style-only frame through groupFrameSize', () => {
    seed(frame('g', { style: { width: 180, height: 90 } }));
    useAppStore.getState().instantiateSavedGroup('sg1', { x: 500, y: 300 }, { anchor: 'top-right' });
    expect(placedFrame().position).toEqual({ x: 320, y: 300 });
  });

  it('the over-budget retry keeps the anchor (it re-spreads the options)', () => {
    const store = readFileSync(resolve(__dirname, 'useAppStore.ts'), 'utf8');
    expect(store).toContain("proceed: () => get().instantiateSavedGroup(savedId, position, { ...opts, overBudgetOk: true })");
    expect(store).toContain('cloneGroupSnapshot(saved, position, opts?.anchor)');
  });
});

describe('built-in presets and textures', () => {
  it('a preset dragged top-right lands its frame left of the point by the frame width', async () => {
    const { getBuiltinPresets } = await import('@/registry/builtinPresets');
    const preset = getBuiltinPresets()[0];
    const w = groupFrameSize(preset.nodes[0]).w;
    expect(w).toBeGreaterThan(0);
    useAppStore.getState().instantiateBuiltinPreset(preset.id, { x: 1000, y: 50 }, 'top-right');
    // The library resolves on a dynamic import; let its `.then` run.
    await new Promise((r) => setTimeout(r, 0));
    expect(placedFrame().position).toEqual({ x: 1000 - w, y: 50 });
  });

  it('a texture follows the same rule, and the default stays top-left', async () => {
    const { getBuiltinTextures } = await import('@/registry/builtinTextures');
    const tex = getBuiltinTextures()[0];
    const w = groupFrameSize(tex.nodes[0]).w;
    useAppStore.getState().instantiateBuiltinTexture(tex.id, { x: 700, y: 20 }, 'top-right');
    await new Promise((r) => setTimeout(r, 0));
    expect(placedFrame().position).toEqual({ x: 700 - w, y: 20 });

    useAppStore.setState({ nodes: [], edges: [] });
    useAppStore.getState().instantiateBuiltinTexture(tex.id, { x: 700, y: 20 });
    await new Promise((r) => setTimeout(r, 0));
    expect(placedFrame().position).toEqual({ x: 700, y: 20 });
  });
});

describe('NodeEditor placeTilePayload', () => {
  const at = NODE_EDITOR.indexOf('const placeTilePayload = useCallback(');
  const body = NODE_EDITOR.slice(at, NODE_EDITOR.indexOf("const def = NODE_REGISTRY.get(payload.nodeType);", at));

  it('a DRAG anchors top-right, a click/Enter activation top-left', () => {
    expect(at).toBeGreaterThan(-1);
    expect(body).toContain("const anchor: GroupDropAnchor = activate ? 'top-left' : 'top-right';");
  });

  it('passes the anchor to all three group sources', () => {
    expect(body).toContain('instantiateSavedGroup(payload.id, position, { anchor })');
    expect(body).toContain('instantiateBuiltinTexture(payload.id, position, anchor)');
    expect(body).toContain('instantiateBuiltinPreset(payload.id, position, anchor)');
  });
});
