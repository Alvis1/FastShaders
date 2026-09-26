import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeNode, makeEdge, HISTORY_IDLE } from '@/test-utils';
import type { AppNode } from '@/types';
import { NODE_REGISTRY, getFlowNodeType } from '@/registry/nodeRegistry';
import { SPLAT_DEFAULT_EXPOSED, effectiveExposedPorts, usesExposedPorts, autoExposeConnectedParamPorts } from './exposedPorts';
import { graphToCode } from '@/engine/graphToCode';
import { estimateNodeSize } from '@/engine/layoutEngine';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { SPLAT_NODE_CONFIG, splatStoredColor, splatClearable } from '@/components/NodeEditor/nodes/SplatOutputNode';
import { splatInvertValues } from '@/components/NodeEditor/menus/SplatSettingsMenu';

/**
 * The Splat Output shows the four sockets that decide what the splats LOOK
 * like and hides Feather and Size behind its settings menu — the Raymarch
 * Output's rule (raymarchExposure.test.ts), with values editable there and
 * applied whether or not the socket is on the node.
 */
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

/** A Splat Output carrying `values` exactly as given (booleans included). */
function splat(values: Record<string, unknown> = {}, id = 'sp'): AppNode {
  const n = makeNode(id, 'splatOutput');
  return { ...n, data: { ...n.data, values } } as AppNode;
}
/** Local Position → sdCircle → Cut: a splat document that DRIVES. */
function cutGraph(values: Record<string, unknown> = {}) {
  return {
    nodes: [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), splat(values)],
    edges: [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sp', 'cut')],
  };
}

describe('Splat Output socket exposure', () => {
  it('exposes Color, Opacity, Cut and Move, and hides Feather and Size', () => {
    const def = NODE_REGISTRY.get('splatOutput')!;
    expect(SPLAT_DEFAULT_EXPOSED).toEqual(['color', 'opacity', 'cut', 'move']);
    for (const p of SPLAT_DEFAULT_EXPOSED) expect(def.inputs.some((i) => i.id === p), p).toBe(true);
    const hidden = def.inputs.map((i) => i.id).filter((id) => !SPLAT_DEFAULT_EXPOSED.includes(id));
    expect(hidden).toEqual(['feather', 'size']);
    expect(usesExposedPorts(def)).toBe(true);
    expect(effectiveExposedPorts(makeNode('sp', 'splatOutput'))).toBe(SPLAT_DEFAULT_EXPOSED);
  });

  it('is its own flow type, so it renders SplatOutputNode rather than a generic ShaderNode', () => {
    expect(getFlowNodeType(NODE_REGISTRY.get('splatOutput')!)).toBe('splatOutput');
    const flow = read('../components/NodeEditor/flowTypes.ts');
    expect(flow).toContain('splatOutput: SplatOutputNode,');
    // The three places that describe the same set of flow types.
    expect(read('../registry/nodeRegistry.ts')).toMatch(/export type FlowNodeType = [^;]*'splatOutput'/);
    expect(read('../types/node.types.ts')).toMatch(/\|\s*SplatOutputFlowNode\s*\n/);
  });

  it('the node groups every socket once, in the registry’s order, under Shade / Cut / Shape', () => {
    const def = NODE_REGISTRY.get('splatOutput')!;
    expect(SPLAT_NODE_CONFIG.sections.map((s) => s.label)).toEqual(['Shade', 'Cut', 'Shape']);
    expect(SPLAT_NODE_CONFIG.sections.flatMap((s) => s.ports)).toEqual(def.inputs.map((p) => p.id));
    // Every numeric setting is a registry default, so the cell shows what an
    // absent key emits.
    for (const key of Object.keys(SPLAT_NODE_CONFIG.settings)) expect(def.defaultValues, key).toHaveProperty(key);
    expect(SPLAT_NODE_CONFIG.settings.opacity.clamp(2)).toBe(1);
    expect(SPLAT_NODE_CONFIG.settings.opacity.clamp(-1)).toBe(0);
    expect(SPLAT_NODE_CONFIG.settings.feather.clamp(-0.5)).toBe(0);
    expect(SPLAT_NODE_CONFIG.settings.size.clamp(-3)).toBe(0);
  });

  it('auto-layout sizes it by the rows it shows, not as a generic ShaderNode', () => {
    // Header + two subdividers + one 18px row per exposed socket (four by
    // default), the Output chrome's pitch — and a wire into a hidden socket
    // (auto-exposed on ingestion) counts through the in-degree floor.
    expect(estimateNodeSize(makeNode('sp', 'splatOutput'))).toEqual({ width: 150, height: 34 + 28 + 4 * 18 });
    const all = makeNode('sp', 'splatOutput');
    (all.data as { exposedPorts?: string[] }).exposedPorts = ['color', 'opacity', 'cut', 'feather', 'move', 'size'];
    expect(estimateNodeSize(all).height).toBe(34 + 28 + 6 * 18);
    expect(estimateNodeSize(makeNode('sp', 'splatOutput'), 5).height).toBe(34 + 28 + 5 * 18);
    // A tampered list cannot blow the footprint up past the def's six sockets.
    const junk = makeNode('sp', 'splatOutput');
    (junk.data as { exposedPorts?: string[] }).exposedPorts = Array.from({ length: 60 }, (_, i) => `x${i}`);
    expect(estimateNodeSize(junk).height).toBe(34 + 28 + 6 * 18);
  });

  it('a wire into a hidden socket exposes it on every ingestion path (autoExpose), keeping the defaults', () => {
    const sp = makeNode('sp', 'splatOutput');
    const f = makeNode('f', 'float');
    autoExposeConnectedParamPorts([sp, f], [makeEdge('f', 'out', 'sp', 'feather')]);
    expect(effectiveExposedPorts(sp)).toEqual([...SPLAT_DEFAULT_EXPOSED, 'feather']);
  });

  it('a hidden Feather and Size still EMIT — they apply whether or not their socket is shown', () => {
    const g = cutGraph({ feather: 0.2, size: 1.5 });
    // Nothing exposes them: the node is on the implicit default list.
    expect(effectiveExposedPorts(g.nodes[2])).not.toContain('feather');
    const code = graphToCode(g.nodes, g.edges).code;
    expect(code).toContain('return { splat: { shape: sp1Shape, size: 1.5, feather: 0.2 } };');
  });

  it('the Color cell shows a swatch only for a colour the emitter uses — otherwise "Own colour"', () => {
    expect(splatStoredColor('#2d6cdf')).toBe('#2d6cdf');
    for (const bad of [undefined, '', '#fff', 'red', '#2d6cdg', 12, { toString: () => '#ffffff' }]) {
      expect(splatStoredColor(bad), String(bad)).toBeNull();
    }
    // …and the emitter agrees: the same junk emits the splat's own colour.
    const n = splat({ color: '#fff', opacity: 0.5 });
    const flagged = { ...n, data: { ...n.data, activeOutput: true } } as AppNode;
    expect(graphToCode([flagged], []).code).toContain('return vec4(c.rgb, 0.5);');
  });

  it('the Color reset row is offered only when a value is STORED — never on a fresh node', () => {
    // The popover brackets BEFORE it calls onClear, and beginInteraction
    // clears the redo stack; a reset row on a node that stores nothing is a
    // no-op write that still costs the user their redo (CLAUDE.md: never
    // bracket a write that might change nothing).
    expect(splatClearable({}, 'color')).toBe(false);
    expect(splatClearable({ opacity: 0.5 }, 'color')).toBe(false);
    // An OWN key only: `values` is a plain object, so `in` would see these.
    for (const inherited of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(splatClearable({}, inherited), inherited).toBe(false);
    }
    expect(splatClearable({ color: '#2d6cdf' }, 'color')).toBe(true);
    // A PRESENT value the emitter ignores is still clearable — the reset row is
    // how a user gets rid of it; gating on `splatStoredColor` would strand it.
    expect(splatClearable({ color: '#fff' }, 'color')).toBe(true);
    expect(splatStoredColor('#fff')).toBeNull();
    // A null-prototype values map (JSON is never one, but a sanitizer may mint one).
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { color: '#2d6cdf' });
    expect(splatClearable(bare, 'color')).toBe(true);
    expect(splatClearable(Object.create(null) as Record<string, unknown>, 'color')).toBe(false);
  });
});

describe('Invert cut — one checkbox, one history entry, never `false`', () => {
  beforeEach(() => {
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
  });
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
  });

  it('adds the literal `true` or DELETES the key, without mutating the input', () => {
    const before = { feather: 0.1 };
    const on = splatInvertValues(before, true);
    expect(on).toEqual({ feather: 0.1, invert: true });
    expect(before).toEqual({ feather: 0.1 });
    const off = splatInvertValues(on, false);
    expect(off).toEqual({ feather: 0.1 });
    expect('invert' in off).toBe(false);
  });

  it('the menu’s write is ONE updateNodeData — one undo entry — and the module follows it', () => {
    const g = cutGraph();
    useAppStore.setState({ nodes: g.nodes, edges: g.edges });
    const store = () => useAppStore.getState();
    const values = () => (store().nodes.find((n) => n.id === 'sp')!.data as { values: Record<string, unknown> }).values;

    store().updateNodeData('sp', { values: splatInvertValues(values(), true) } as never);
    expect(store().past).toHaveLength(1);
    expect(values().invert).toBe(true);
    expect(graphToCode(store().nodes, store().edges).code).toContain('return { splat: { shape: sp1Shape, invert: true } };');

    store().updateNodeData('sp', { values: splatInvertValues(values(), false) } as never);
    expect(store().past).toHaveLength(2);
    expect('invert' in values()).toBe(false);
    expect(graphToCode(store().nodes, store().edges).code).toContain('return { splat: { shape: sp1Shape } };');

    // Undo walks back one toggle at a time.
    store().undo();
    expect(values().invert).toBe(true);
  });
});

describe('Splat Output wiring (source pins)', () => {
  it('the node renders exposed rows only, re-measures on the exposed set, and skips empty sections', () => {
    const node = read('../components/NodeEditor/nodes/SplatOutputNode.tsx');
    expect(node).toContain('effectiveExposedPorts({ id, data } as unknown as ShaderFlowNode)');
    expect(node).toContain('}, [id, exposedKey, updateNodeInternals]);');
    expect(node).toContain('ids.includes(p.id) && exposed.has(p.id)');
    expect(node).toContain('config.sections.filter((section) => section.ports.some((p) => exposed.has(p)))');
    // The activation control and the frame.
    expect(node).toContain('useMemo(() => isActiveSinkSelector(id), [id])');
    expect(node).toContain('setActiveOutput(id);');
    expect(node).toContain('output-node output-node--splat');
    expect(node).toContain('solid var(--cat-output)');
    // Own colour: no stored colour draws the UNSET swatch, and the popover's
    // reset row clears the key back to it — offered only while a key is
    // PRESENT, and the clear itself refuses a no-op write.
    expect(node).toContain('value={stored}');
    expectGatedClear(node);
    const card = read('../components/NodeEditor/NodePreviewCard.tsx');
    expect(card).toContain('new Set<string>(SPLAT_DEFAULT_EXPOSED)');
    expect(card).toContain('palette-swatch palette-swatch--unset output-node__val');
  });

  it('right-click opens the Splat settings menu, which toggles sockets, edits values and inverts (source pins)', () => {
    const editor = read('../components/NodeEditor/NodeEditor.tsx');
    expect(editor).toContain("splatOutput: 'splat',");
    const ctx = read('../components/NodeEditor/menus/ContextMenu.tsx');
    expect(ctx).toContain("{type === 'splat' && nodeId && <SplatSettingsMenu nodeId={nodeId} />}");
    expect(read('../store/useAppStore.ts')).toMatch(/\| 'raymarch'\s*\n\s*\| 'splat'/);
    const menu = read('../components/NodeEditor/menus/SplatSettingsMenu.tsx');
    expect(menu).toContain('toggleExposedPort(nodeId, exposedPorts, portId)');
    expect(menu).toContain('onCommit={(v) => setValue(portId, setting.clamp(v))}');
    expect(menu).toContain('history="bracket"');
    // Hiding keeps the value: the menu never clears values on a toggle.
    expect(menu).not.toContain('valuesWithout(');
    // Invert: read strictly, written through the helper in ONE call.
    expect(menu).toContain('(rawValues as Record<string, unknown>).invert === true');
    const toggle = menu.slice(menu.indexOf('const toggleInvert'), menu.indexOf('};', menu.indexOf('const toggleInvert')));
    expect(toggle.match(/updateNodeData\(/g)).toHaveLength(1);
    expect(toggle).toContain('splatInvertValues(values, !inverted)');
    expect(toggle).not.toContain('asOneHistoryEntry');
    // The same gated reset row as the node's.
    expectGatedClear(menu);
    // The count line comes from the session-only facts, through the formatter —
    // and only while the preview SHOWS the model, with the cost bar's own
    // selector: a splat parked behind a Sphere draws nothing, so "Loaded
    // scene: N splats" and its per-splat-cost hint would describe a scene the
    // pane is not rendering.
    const shown = 'useAppStore((s) => (s.previewShowsModel ? s.previewSplatFacts : null))';
    expect(menu).toContain(shown);
    expect(menu).not.toContain('useAppStore((s) => s.previewSplatFacts)');
    expect(read('../components/Layout/CostBar.tsx')).toContain(shown);
    expect(menu).toContain('splatCountLine(splatFacts, language)');
  });
});

/** The Splat Output's two colour sites share one reset-row contract: the row
 *  exists only while a value is stored, and `clearValue` returns before any
 *  write when the key is absent. */
function expectGatedClear(src: string) {
  expect(src).toContain('onClear={splatClearable(values, portId) ? () => clearValue(portId) : undefined}');
  expect(src).not.toContain('onClear={() => clearValue(portId)}');
  const at = src.indexOf('const clearValue = (key: string) => {');
  expect(at, 'clearValue was renamed').toBeGreaterThan(-1);
  // Up to the arrow's own closing line (`{ ...values };` inside it ends in `};` too).
  const body = src.slice(at, src.indexOf('\n  };', at));
  const guard = body.indexOf('if (!splatClearable(values, key)) return;');
  expect(guard).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(body.indexOf('updateNodeData('));
}
