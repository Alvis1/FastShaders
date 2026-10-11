import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { HISTORY_IDLE, makeNode, makeEdge } from '@/test-utils';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import type { AppNode } from '@/types';
import { COLLAPSED_MEMBER_CLASS } from './groupFrame';
import { attachEmptyReason, attachSinks, defaultAttachHandle, socketFeed } from './nodeAttach';

/**
 * Attach (utils/nodeAttach.ts): Ctrl/⌘+click a node, or its menu's Attach row,
 * and pick an Output socket from a list. The pure half is pinned here — which
 * sinks the list offers and in what order, which socket the wire leaves from —
 * plus the source-level wiring of the gestures nothing else would catch.
 */

const withData = (n: AppNode, extra: Record<string, unknown>): AppNode =>
  ({ ...n, data: { ...n.data, ...extra } }) as AppNode;
const sink = (id: string, type: 'raymarchOutput' | 'splatOutput'): AppNode =>
  ({ ...makeNode(id, type), type }) as AppNode;
const ids = (nodes: readonly { node: AppNode }[]) => nodes.map((s) => s.node.id);

describe('attachSinks', () => {
  it('an ordinary document offers its one Output, every channel in the card’s order', () => {
    const nodes = [makeNode('n', 'noise'), makeNode('out', 'output')];
    const sinks = attachSinks(nodes, []);
    expect(ids(sinks)).toEqual(['out']);
    // ALL nine, hidden ones included: the connect path exposes the socket a
    // wire lands on, so Emissive is one pick away rather than a settings trip.
    expect(sinks[0].sockets.map((p) => p.id)).toEqual(
      NODE_REGISTRY.get('output')!.inputs.map((p) => p.id),
    );
    expect(sinks[0].sockets.map((p) => p.id)).toContain('emissive');
  });

  it('nothing to attach to on a canvas without a sink', () => {
    expect(attachSinks([makeNode('n', 'noise')], [])).toEqual([]);
  });

  it('the RENDERING sink comes first, then plain Outputs in emit order, then the rest', () => {
    const nodes = [
      withData(makeNode('o2', 'output'), { emitOrder: 2 }),
      sink('sp', 'splatOutput'),
      withData(makeNode('o1', 'output'), { emitOrder: 1 }),
      sink('rm', 'raymarchOutput'),
      makeNode('f', 'float'),
    ];
    // Nothing drives a custom sink: the lowest-ranked plain Output renders.
    expect(ids(attachSinks(nodes, []))).toEqual(['o1', 'o2', 'sp', 'rm']);
    // A wired Field makes the Raymarch Output the one on screen — it leads.
    const march = [makeEdge('f', 'out', 'rm', 'field')];
    expect(ids(attachSinks(nodes, march))).toEqual(['rm', 'o1', 'o2', 'sp']);
  });

  it('leaves out a sink React Flow hides — it has no handle to land on', () => {
    const nodes = [makeNode('out', 'output'), { ...sink('rm', 'raymarchOutput'), hidden: true } as AppNode];
    expect(ids(attachSinks(nodes, []))).toEqual(['out']);
    // …read as React Flow reads it, by truthiness: a file's `hidden: 1` hides
    // the node on the canvas, so it must not come back here either.
    const truthy = [makeNode('out', 'output'), { ...sink('rm', 'raymarchOutput'), hidden: 1 } as unknown as AppNode];
    expect(ids(attachSinks(truthy, []))).toEqual(['out']);
  });

  it('every sink type offers its registry inputs', () => {
    const nodes = [makeNode('out', 'output'), sink('rm', 'raymarchOutput'), sink('sp', 'splatOutput')];
    for (const s of attachSinks(nodes, [])) {
      expect(s.sockets).toBe(NODE_REGISTRY.get(String(s.node.data.registryType))!.inputs);
    }
  });
});

describe('attachSinks — a sink inside a group the STORE collapsed', () => {
  // Reached through the real collapse action, not a hand-set `hidden: true`:
  // the collapse marks members with a CLASS and never sets `hidden`, so the
  // old hand-set case passed while the app offered the collapsed Output
  // (measured 2026-10-11: a pick wrote `emissive: color1` through a wire that
  // never drew, React Flow error 008).
  beforeEach(() => {
    // The collapse's phase 2 runs on the next frame; there is none under node.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    useAppStore.setState({
      nodes: [makeNode('out', 'output'), makeNode('m', 'mul'), sink('rm', 'raymarchOutput')],
      edges: [],
      past: [],
      future: [],
      ...HISTORY_IDLE,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(() => {
    cancelPendingGraphSave();
    useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
  });

  it('is left out while collapsed and offered again once expanded', () => {
    const store = useAppStore.getState();
    const groupId = store.groupSelection(['out', 'm'])!;
    expect(groupId).toBeTruthy();
    expect(ids(attachSinks(useAppStore.getState().nodes, []))).toEqual(['out', 'rm']);

    useAppStore.getState().toggleGroupCollapsed(groupId);
    const collapsed = useAppStore.getState().nodes;
    const out = collapsed.find((n) => n.id === 'out')!;
    // The shape the bug lived in: a class, no `hidden`.
    expect(out.className).toBe(COLLAPSED_MEMBER_CLASS);
    expect(out.hidden).toBeUndefined();
    expect(ids(attachSinks(collapsed, useAppStore.getState().edges))).toEqual(['rm']);

    useAppStore.getState().toggleGroupCollapsed(groupId);
    expect(ids(attachSinks(useAppStore.getState().nodes, useAppStore.getState().edges))).toEqual(['out', 'rm']);
  });

  it('an empty list says the Output is in a collapsed group, not that there is none', () => {
    useAppStore.setState({ nodes: [makeNode('out', 'output'), makeNode('m', 'mul'), makeNode('c', 'color')] });
    const groupId = useAppStore.getState().groupSelection(['out', 'm'])!;
    useAppStore.getState().toggleGroupCollapsed(groupId);
    const collapsed = useAppStore.getState().nodes;
    expect(attachSinks(collapsed, useAppStore.getState().edges)).toEqual([]);
    expect(attachEmptyReason(collapsed)).toBe('collapsed');
    // Expanded again, the Output is offered and nothing is hidden.
    useAppStore.getState().toggleGroupCollapsed(groupId);
    expect(attachEmptyReason(useAppStore.getState().nodes)).toBe('none');
  });
});

describe('attachEmptyReason', () => {
  it('no sink at all is "none"', () => {
    expect(attachEmptyReason([makeNode('n', 'noise')])).toBe('none');
    expect(attachEmptyReason([])).toBe('none');
  });

  it('a sink React Flow hides is not "inside a collapsed group" — no group sets `hidden`', () => {
    expect(attachEmptyReason([{ ...makeNode('out', 'output'), hidden: true } as AppNode])).toBe('none');
  });

  it('a non-sink inside a collapsed group does not count; a junk className cannot throw', () => {
    expect(attachEmptyReason([{ ...makeNode('m', 'mul'), className: COLLAPSED_MEMBER_CLASS } as AppNode])).toBe('none');
    expect(
      attachEmptyReason([{ ...makeNode('out', 'output'), className: { includes: 1 } } as unknown as AppNode]),
    ).toBe('none');
    expect(attachEmptyReason([{ ...sink('rm', 'raymarchOutput'), className: COLLAPSED_MEMBER_CLASS } as AppNode])).toBe(
      'collapsed',
    );
  });

  it('the menu words both answers, in English and Latvian', () => {
    const menu = readFileSync(new URL('../components/NodeEditor/menus/AttachMenu.tsx', import.meta.url), 'utf8');
    const COLLAPSED = 'The Output is inside a collapsed group — expand it to attach';
    expect(menu).toContain("attachEmptyReason(nodes) === 'collapsed'");
    expect(menu).toContain(`t('${COLLAPSED}', language)`);
    expect(menu).toContain("t('No Output on the canvas', language)");
    const lv = JSON.parse(readFileSync(new URL('../i18n/lv.json', import.meta.url), 'utf8')) as {
      ui: Record<string, string>;
    };
    expect(typeof lv.ui[COLLAPSED]).toBe('string');
    expect(lv.ui[COLLAPSED]).not.toBe(COLLAPSED);
  });
});

describe('defaultAttachHandle', () => {
  const split = makeNode('s', 'split');

  it('the first output — the socket Alt+click previews', () => {
    expect(defaultAttachHandle(split, null)).toBe(NODE_REGISTRY.get('split')!.outputs[0].id);
  });

  it('the PREVIEWED socket when this node is the one previewed', () => {
    const y = NODE_REGISTRY.get('split')!.outputs[1].id;
    expect(defaultAttachHandle(split, { nodeId: 's', handleId: y })).toBe(y);
    // Another node's preview, or a socket the node no longer has, is ignored.
    expect(defaultAttachHandle(split, { nodeId: 'other', handleId: y })).not.toBe(y);
    expect(defaultAttachHandle(split, { nodeId: 's', handleId: 'gone' }))
      .toBe(NODE_REGISTRY.get('split')!.outputs[0].id);
  });

  it('null for a node with no output — sinks, groups and notes get no Attach', () => {
    expect(defaultAttachHandle(makeNode('out', 'output'), null)).toBeNull();
    expect(defaultAttachHandle(sink('rm', 'raymarchOutput'), null)).toBeNull();
    expect(defaultAttachHandle({ ...makeNode('g', 'group'), type: 'group' } as AppNode, null)).toBeNull();
    expect(defaultAttachHandle({ ...makeNode('t', 'note'), type: 'note' } as AppNode, null)).toBeNull();
  });
});

describe('socketFeed', () => {
  it('finds the one wire into a socket, and only that socket', () => {
    const e = makeEdge('n', 'out', 'out', 'color');
    const edges = [makeEdge('m', 'out', 'out', 'roughness'), e];
    expect(socketFeed(edges, 'out', 'color')).toBe(e);
    expect(socketFeed(edges, 'out', 'emissive')).toBeUndefined();
    expect(socketFeed(edges, 'other', 'color')).toBeUndefined();
  });
});

describe('attach wiring (source pins)', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const editor = read('../components/NodeEditor/NodeEditor.tsx');
  const menu = read('../components/NodeEditor/menus/AttachMenu.tsx');
  const shared = read('../components/NodeEditor/menus/menuShared.tsx');
  const dispatcher = read('../components/NodeEditor/menus/ContextMenu.tsx');

  it('Ctrl/⌘+click opens the list from BOTH events — click, and the contextmenu macOS turns Ctrl+click into', () => {
    expect(editor).toContain("store.openContextMenu(e.clientX, e.clientY, 'attach', node.id)");
    const i = editor.indexOf('const onNodeContextMenu = useCallback(');
    const block = editor.slice(i, i + 600);
    expect(block).toContain('if (event.ctrlKey && previewableOutputs(node).length > 0) {');
    expect(block).toContain("openContextMenu(event.clientX, event.clientY, 'attach', node.id)");
  });

  it('a pick goes through the ONE connect path, as one undo entry', () => {
    const i = editor.indexOf('const onAttach = useCallback(');
    const block = editor.slice(i, i + 300);
    expect(block).toContain('useAppStore.getState().pushHistory();');
    expect(block).toContain('applyConnection(connection);');
    expect(editor).toContain('<ContextMenu onAttach={onAttach} />');
    expect(dispatcher).toContain("{type === 'attach' && nodeId && <AttachMenu nodeId={nodeId} onAttach={onAttach} />}");
    expect(menu).toContain('onAttach({ source: nodeId, sourceHandle: handle, target: sink.id, targetHandle: socket.id })');
    // Picking the socket this node already feeds unwires it instead.
    expect(menu).toContain('if (mine && feed) removeEdge(feed.id);');
  });

  it('the node menu’s Attach row sits right after the Preview rows and swaps the menu in place', () => {
    const preview = shared.indexOf("t('Stop preview', language)");
    const attach = shared.indexOf("t('Attach to Output…', language)");
    const reset = shared.indexOf("t('Reset Values', language)");
    expect(preview).toBeGreaterThan(-1);
    expect(attach).toBeGreaterThan(preview);
    expect(attach).toBeLessThan(reset);
    expect(shared).toContain("openContextMenu(x, y, 'attach', nodeId);");
  });
});
