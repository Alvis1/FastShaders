import type { AppNode, AppEdge, PortDefinition } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { isOutputNode, outputsInEmitOrder } from '@/utils/outputMaterials';
import { activeSink, isSinkNode } from '@/utils/sdfPartition';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { previewableOutputs, type NodePreviewTarget } from '@/utils/nodePreview';

/**
 * ATTACH — wire a node into an Output socket picked from a list.
 *
 * Ctrl/⌘+click a node (or right-click → Attach, the row after Preview) and the
 * context menu lists every socket of every Output on the canvas; picking one
 * connects the node to it. Preview mode's PERMANENT twin: where Preview shows
 * a socket on the 3D view without touching the graph (utils/nodePreview.ts),
 * Attach IS an edit — it goes through NodeEditor's one connect path
 * (`applyConnection`: single-input replacement, hidden-socket exposure, the
 * image→Normal colour-space flip, the study's `edge-connect` event) under one
 * `pushHistory`, exactly as dragging the wire by hand would.
 *
 * This module is the pure half — which sinks the list offers, in what order,
 * and which socket of the node the wire leaves from — so the menu and the tests
 * cannot each hold their own reading of the rules.
 */

/** One sink's block in the Attach list. */
export interface AttachSink {
  node: AppNode;
  /** Its input sockets, in the registry's (= the card's) order. */
  sockets: readonly PortDefinition[];
}

/**
 * The sinks a node can be attached to, in list order: the ACTIVE sink first —
 * the one rendering the 3D view now, so on an ordinary document the list
 * opens on the Output's own sockets — then the other plain Outputs in EMIT
 * order (the order their `_01`, `_02` header suffixes count in, never array
 * order, which a drag-into-group reshuffles), then the remaining Raymarch and
 * Splat Outputs in array order.
 *
 * HIDDEN sinks are left out: a member of a collapsed group has no handle on
 * the canvas, and a wire landed on one would sit in the store, emit, and never
 * draw. A sink the registry does not know (cannot happen from the app, can
 * from a hand-edited file) has no socket list and is left out too.
 */
export function attachSinks(nodes: readonly AppNode[], edges: readonly AppEdge[]): AttachSink[] {
  const visible = nodes.filter((n) => isSinkNode(n) && !n.hidden);
  if (visible.length === 0) return [];
  const active = activeSink(nodes, unwrapCollapsedGroupEdges(nodes as AppNode[], edges as AppEdge[]));
  const plain = outputsInEmitOrder(visible.filter(isOutputNode));
  const custom = visible.filter((n) => !isOutputNode(n));
  const ordered = [...plain, ...custom];
  if (active && ordered.includes(active)) {
    ordered.splice(ordered.indexOf(active), 1);
    ordered.unshift(active);
  }
  const out: AttachSink[] = [];
  for (const node of ordered) {
    const def = NODE_REGISTRY.get(String(node.data.registryType ?? ''));
    if (def && def.inputs.length > 0) out.push({ node, sockets: def.inputs });
  }
  return out;
}

/**
 * Which of the node's output sockets the wire leaves from when the list opens:
 * the socket being PREVIEWED when it is this node's (Alt+click a Split's `y`
 * from the menu, like what you see, attach it), else the first output — the
 * socket Alt+click previews. Null for a node with nothing to attach (a sink,
 * a group, a note), which therefore gets no Attach row and whose Ctrl/⌘+click
 * falls through to ordinary selection.
 */
export function defaultAttachHandle(node: AppNode, preview: NodePreviewTarget | null): string | null {
  const outs = previewableOutputs(node);
  if (outs.length === 0) return null;
  if (preview?.nodeId === node.id && outs.some((p) => p.id === preview.handleId)) return preview.handleId;
  return outs[0].id;
}

/** The edge feeding one sink socket, if any (an input takes one wire). */
export function socketFeed(edges: readonly AppEdge[], sinkId: string, socketId: string): AppEdge | undefined {
  return edges.find((e) => e.target === sinkId && e.targetHandle === socketId);
}
