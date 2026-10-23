/**
 * A PRESSED Preset/Texture lands beside the Output, wired into every socket it
 * feeds that is still EMPTY — in ONE history entry (owner, 2026-10-16; per
 * socket 2026-10-17). With no free socket it is the usual scattered add. The wires are the
 * asset's own (`outputEdges`, kept by buildCodeGroup), never a guess.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useAppStore, cancelPendingGraphSave, groupFrameSize } from '@/store/useAppStore';
import { HISTORY_IDLE, makeEdge, makeNode } from '@/test-utils';
import { LIBRARY_WIRE_GAP } from '@/utils/libraryAutoWire';
import type { AppNode } from '@/types';

const NODE_EDITOR = readFileSync(resolve(__dirname, '../components/NodeEditor/NodeEditor.tsx'), 'utf8');

const OUT_AT = { x: 600, y: 120 };
const lone = (): AppNode => ({ ...makeNode('out', 'output'), position: { ...OUT_AT } }) as AppNode;
const intoOutput = () => useAppStore.getState().edges.filter((e) => e.target === 'out');
const frame = () => useAppStore.getState().nodes.find((n) => n.type === 'group')!;
const beside = { x: OUT_AT.x - LIBRARY_WIRE_GAP, y: OUT_AT.y };
/** The press's scattered point — used only when nothing gets wired. */
const SCATTER = { x: -3000, y: -3000 };
const WIRE = { outputId: 'out', beside };

beforeEach(() => {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [lone()], edges: [], past: [], future: [], ...HISTORY_IDLE });
});
afterAll(() => {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [] });
});

describe('every built-in asset knows its Output wires', () => {
  it('presets and textures each carry ≥ 1, all from members', async () => {
    const { getBuiltinPresets } = await import('@/registry/builtinPresets');
    const { getBuiltinTextures } = await import('@/registry/builtinTextures');
    for (const asset of [...getBuiltinPresets(), ...getBuiltinTextures()]) {
      const members = new Set(asset.nodes.slice(1).map((n) => n.id));
      expect(asset.outputEdges.length, asset.id).toBeGreaterThan(0);
      for (const e of asset.outputEdges) {
        expect(members.has(e.source), `${asset.id}: ${e.source}`).toBe(true);
        expect(typeof e.targetHandle, asset.id).toBe('string');
      }
    }
  });
});

describe('a press with a plain Output on the canvas', () => {
  it('Gradient lands its frame left of the Output and feeds its colour', async () => {
    const placed = await useAppStore.getState().instantiateBuiltinPreset('gradient', SCATTER, 'top-left', WIRE);
    expect(placed?.wired).toBe(1);
    const g = frame();
    expect(g.id).toBe(placed?.groupId);
    expect(g.position.x + groupFrameSize(g).w).toBe(OUT_AT.x - LIBRARY_WIRE_GAP);
    expect(g.position.y).toBe(OUT_AT.y);
    const wires = intoOutput();
    expect(wires.map((e) => e.targetHandle)).toEqual(['color']);
    const src = useAppStore.getState().nodes.find((n) => n.id === wires[0].source);
    expect(src?.parentId).toBe(g.id);
  });

  it('Teleport Beam brings colour, emissive and discard, and exposes discard', async () => {
    const placed = await useAppStore.getState().instantiateBuiltinPreset('teleport-beam', SCATTER, 'top-left', WIRE);
    expect(placed?.wired).toBe(3);
    expect(intoOutput().map((e) => e.targetHandle).sort()).toEqual(['color', 'discard', 'emissive']);
    const out = useAppStore.getState().nodes.find((n) => n.id === 'out')!;
    expect((out.data as { exposedPorts?: string[] }).exposedPorts).toContain('discard');
    expect((out.data as { exposedPorts?: string[] }).exposedPorts).toContain('emissive');
  });

  it('the Ghost recipe brings colour AND opacity, and exposes opacity', async () => {
    const placed = await useAppStore.getState().instantiateBuiltinPreset('recipe-ghost', SCATTER, 'top-left', WIRE);
    expect(placed?.wired).toBe(2);
    expect(intoOutput().map((e) => e.targetHandle).sort()).toEqual(['color', 'opacity']);
    const out = useAppStore.getState().nodes.find((n) => n.id === 'out')!;
    expect((out.data as { exposedPorts?: string[] }).exposedPorts).toContain('opacity');
    // Opacity is fed by the Fresnel's FACING socket, not its first output.
    const opacity = intoOutput().find((e) => e.targetHandle === 'opacity')!;
    expect(opacity.sourceHandle).toBe('facing');
    // …and is READ: an opaque material ignores Opacity, so the press ticks
    // Transparent too — in the same history entry, which one undo takes back.
    expect((out.data as { materialSettings?: { transparent?: boolean } }).materialSettings?.transparent).toBe(true);
    expect(useAppStore.getState().past.length).toBe(1);
    useAppStore.getState().undo();
    const restored = useAppStore.getState().nodes.find((n) => n.id === 'out')!;
    expect((restored.data as { materialSettings?: unknown }).materialSettings).toBeUndefined();
  });

  it('a wire into Opacity keeps an Alpha Clip the Output already reads it through', async () => {
    useAppStore.setState({
      nodes: [{ ...lone(), data: { ...lone().data, materialSettings: { alphaTest: 0.5 } } } as AppNode],
      edges: [],
    });
    await useAppStore.getState().instantiateBuiltinPreset('recipe-ghost', SCATTER, 'top-left', WIRE);
    const out = useAppStore.getState().nodes.find((n) => n.id === 'out')!;
    expect((out.data as { materialSettings?: unknown }).materialSettings).toEqual({ alphaTest: 0.5 });
  });

  it('a preset that wires no Opacity leaves the material settings alone', async () => {
    await useAppStore.getState().instantiateBuiltinPreset('teleport-beam', SCATTER, 'top-left', WIRE);
    const out = useAppStore.getState().nodes.find((n) => n.id === 'out')!;
    expect((out.data as { materialSettings?: unknown }).materialSettings).toBeUndefined();
  });

  it('the Holes recipe wires Discard AND a colour — Discard alone draws the red sentinel', async () => {
    const placed = await useAppStore.getState().instantiateBuiltinPreset('recipe-holes', SCATTER, 'top-left', WIRE);
    expect(placed?.wired).toBe(2);
    expect(intoOutput().map((e) => e.targetHandle).sort()).toEqual(['color', 'discard']);
  });

  it('a texture wires too', async () => {
    const { getBuiltinTextures } = await import('@/registry/builtinTextures');
    const tex = getBuiltinTextures()[0];
    const placed = await useAppStore.getState().instantiateBuiltinTexture(tex.id, SCATTER, 'top-left', WIRE);
    expect(placed?.wired).toBe(tex.outputEdges.length);
    expect(intoOutput().length).toBe(tex.outputEdges.length);
  });

  it('is ONE history entry: a single undo returns the lone Output, unwired', async () => {
    await useAppStore.getState().instantiateBuiltinPreset('teleport-beam', SCATTER, 'top-left', WIRE);
    expect(useAppStore.getState().past.length).toBe(1);
    useAppStore.getState().undo();
    const { nodes, edges } = useAppStore.getState();
    expect(nodes.map((n) => n.id)).toEqual(['out']);
    expect(edges).toEqual([]);
    expect((nodes[0].data as { exposedPorts?: unknown }).exposedPorts).toBeUndefined();
  });

  it('a wire in ANOTHER socket leaves Color free: Gradient still wires into it', async () => {
    useAppStore.setState({ nodes: [lone(), makeNode('f', 'float')], edges: [makeEdge('f', 'out', 'out', 'roughness')] });
    const placed = await useAppStore.getState().instantiateBuiltinPreset('gradient', SCATTER, 'top-left', WIRE);
    expect(placed?.wired).toBe(1);
    expect(intoOutput().map((e) => e.targetHandle).sort()).toEqual(['color', 'roughness']);
  });

  it('Color already fed: a colour preset is the usual scattered add, and the wire stays', async () => {
    useAppStore.setState({ nodes: [lone(), makeNode('f', 'float')], edges: [makeEdge('f', 'out', 'out', 'color')] });
    const placed = await useAppStore.getState().instantiateBuiltinPreset('gradient', SCATTER, 'top-left', WIRE);
    expect(placed?.wired).toBe(0);
    expect(frame().position).toEqual(SCATTER);
    expect(intoOutput().map((e) => [e.source, e.targetHandle])).toEqual([['f', 'color']]);
  });

  it('Color already fed: a DISPLACEMENT preset still wires into Displacement, beside the Output', async () => {
    useAppStore.setState({ nodes: [lone(), makeNode('f', 'float')], edges: [makeEdge('f', 'out', 'out', 'color')] });
    const placed = await useAppStore.getState().instantiateBuiltinPreset('vertex-wave', SCATTER, 'top-left', WIRE);
    expect(placed?.wired).toBe(1);
    expect(intoOutput().map((e) => e.targetHandle).sort()).toEqual(['color', 'position']);
    expect(intoOutput().find((e) => e.targetHandle === 'color')?.source).toBe('f');
    expect(frame().position).not.toEqual(SCATTER);
  });

  it('a multi-socket preset fills only the FREE sockets', async () => {
    useAppStore.setState({ nodes: [lone(), makeNode('f', 'float')], edges: [makeEdge('f', 'out', 'out', 'color')] });
    const placed = await useAppStore.getState().instantiateBuiltinPreset('teleport-beam', SCATTER, 'top-left', WIRE);
    expect(placed?.wired).toBe(2);
    expect(intoOutput().map((e) => e.targetHandle).sort()).toEqual(['color', 'discard', 'emissive']);
    expect(intoOutput().find((e) => e.targetHandle === 'color')?.source).toBe('f');
  });

  it('the Output gone by the time the library resolved: the scattered add', async () => {
    useAppStore.setState({ nodes: [], edges: [] });
    const placed = await useAppStore.getState().instantiateBuiltinPreset('gradient', SCATTER, 'top-left', WIRE);
    expect(placed?.wired).toBe(0);
    expect(frame().position).toEqual(SCATTER);
  });

  it('never lands on a group already beside the Output', async () => {
    const other = {
      id: 'other', type: 'group', position: { x: 100, y: 60 }, width: 420, height: 260,
      data: { registryType: 'group', label: 'other', collapsed: false },
    } as unknown as AppNode;
    useAppStore.setState({ nodes: [other, lone()], edges: [] });
    await useAppStore.getState().instantiateBuiltinPreset('gradient', SCATTER, 'top-left', WIRE);
    const g = useAppStore.getState().nodes.find((n) => n.type === 'group' && n.id !== 'other')!;
    const { w, h } = groupFrameSize(g);
    const o = { x: 100, y: 60, w: 420, h: 260 };
    const apart =
      g.position.x + w <= o.x || o.x + o.w <= g.position.x || g.position.y + h <= o.y || o.y + o.h <= g.position.y;
    expect(apart).toBe(true);
    expect(intoOutput().map((e) => e.targetHandle)).toEqual(['color']);
  });

  it('an UNWIRED add never lands on anything either — a drag at its top-right corner, a press anywhere', async () => {
    const other = {
      id: 'other', type: 'group', position: { x: 100, y: 60 }, width: 420, height: 260,
      data: { registryType: 'group', label: 'other', collapsed: false },
    } as unknown as AppNode;
    for (const anchor of ['top-right', 'top-left'] as const) {
      useAppStore.setState({ nodes: [other], edges: [] });
      const placed = await useAppStore.getState().instantiateBuiltinPreset('gradient', { x: 300, y: 120 }, anchor);
      expect(placed?.wired).toBe(0);
      const g = useAppStore.getState().nodes.find((n) => n.type === 'group' && n.id !== 'other')!;
      const { w, h } = groupFrameSize(g);
      const o = { x: 100, y: 60, w: 420, h: 260 };
      const apart =
        g.position.x + w <= o.x || o.x + o.w <= g.position.x || g.position.y + h <= o.y || o.y + o.h <= g.position.y;
      expect(apart, anchor).toBe(true);
    }
  });

  it('no wire request: today’s unwired add', async () => {
    const placed = await useAppStore.getState().instantiateBuiltinPreset('gradient', { x: 0, y: 0 });
    expect(placed?.wired).toBe(0);
    expect(intoOutput()).toEqual([]);
  });
});

describe('NodeEditor placeTilePayload', () => {
  const at = NODE_EDITOR.indexOf('const placeTilePayload = useCallback(');
  const body = NODE_EDITOR.slice(at, NODE_EDITOR.indexOf('const def = NODE_REGISTRY.get(payload.nodeType);', at));

  it('asks for a wire target only on a PRESS of a preset or texture', () => {
    expect(body).toContain("activate && (payload.kind === 'preset' || payload.kind === 'texture')");
    expect(body).toContain('libraryWireOutput(state.nodes, state.edges)');
  });

  it('every preset/texture add, wired or not, reveals the frame\'s top-right corner', () => {
    expect(body.match(/if \(placed\) revealLibraryCorner\(placed\.groupId\);/g)).toHaveLength(2);
    expect(NODE_EDITOR).toContain('revealCornerViewport(corner, getViewport(), { w: rect.width, h: rect.height }, chrome)');
    expect(NODE_EDITOR).toContain("const corner = { x: group.position.x + groupFrameSize(group).w, y: group.position.y };");
  });
});
