import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeNode, makeEdge } from '@/test-utils';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import type { AppNode } from '@/types';
import { attachSinks, defaultAttachHandle, socketFeed } from './nodeAttach';

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

  it('leaves out a sink hidden inside a collapsed group — it has no handle to land on', () => {
    const nodes = [makeNode('out', 'output'), { ...sink('rm', 'raymarchOutput'), hidden: true } as AppNode];
    expect(ids(attachSinks(nodes, []))).toEqual(['out']);
  });

  it('every sink type offers its registry inputs', () => {
    const nodes = [makeNode('out', 'output'), sink('rm', 'raymarchOutput'), sink('sp', 'splatOutput')];
    for (const s of attachSinks(nodes, [])) {
      expect(s.sockets).toBe(NODE_REGISTRY.get(String(s.node.data.registryType))!.inputs);
    }
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
