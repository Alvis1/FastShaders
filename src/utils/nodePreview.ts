import type { AppNode, AppEdge, OutputNodeData, PortDefinition, ShaderNodeData } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { findDefaultOutput } from '@/utils/outputMaterials';
import { isSinkNode, hasActiveFlag, ACTIVE_OUTPUT_KEY } from '@/utils/sdfPartition';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { generateEdgeId } from '@/utils/idGenerator';

/**
 * PREVIEW MODE — look at ONE node's output on the 3D view.
 *
 * Right-click a node → Preview (or ⌘/Ctrl+click it) and, for as long as the
 * mode lasts, the 3D preview renders THAT socket on the Output's Color channel
 * with every other input of the Output disabled; the canvas dims everything
 * else and draws a straight line along the route. A press anywhere else, or
 * Escape, ends it. Nothing here is an edit: the real graph, its code panel,
 * the export and the undo history are untouched throughout, because the
 * rerouting happens in a DERIVED graph that only the sync engine's
 * `previewCode` pass ever sees (`previewGraph`).
 *
 * The state itself lives in the store (`nodePreview`, session-only like
 * `hoveredNodeId`); this module is the pure half — what a node offers to
 * preview, whether a stored target is still valid, and the rerouted graph —
 * so it is node-testable and so the sync engine, the menus, the canvas and
 * the line overlay cannot each hold their own reading of the rules.
 */

export interface NodePreviewTarget {
  /** The previewed node. */
  nodeId: string;
  /** Which of its output sockets — `outputs[0]` from ⌘/Ctrl+click, any from the menu. */
  handleId: string;
}

/** The Output channel the previewed socket is routed to. */
export const PREVIEW_CHANNEL = 'color';

/**
 * The id of the Output node `previewGraph` SYNTHESIZES when the graph has no
 * plain Output of its own (a Raymarch-only document, or one whose Output was
 * deleted). It exists only inside the derived graph: it is never added to the
 * store and no line is drawn to it, since there is nothing on the canvas to
 * draw to — the 3D view still shows the node.
 */
export const PREVIEW_OUTPUT_ID = '__fs-preview-output';

/**
 * Surfaces a press must NOT end the mode from. The context menus (a
 * right-click on the previewed node opens one, and its Stop-preview row is
 * what the press is aimed at) with the popovers they portal out of their own
 * subtree — the ContextMenu dismiss-exempt pair — and the whole 3D pane:
 * orbiting the model IS looking at the preview, and the pane's uniform,
 * light and model controls serve the same look. The previewed node itself is
 * exempt by the caller (it is found by id, not by class).
 */
export const PREVIEW_KEEP_SELECTOR = '.context-menu, .palette-pop, .mesh-picker__pop, .shader-preview';

/**
 * The output sockets a node offers to preview, in socket order: a Data node's
 * per-column `dynamicOutputs` when it has them, else the registry definition's
 * `outputs`. Empty for the sinks (both Output kinds declare `outputs: []`),
 * groups and notes — a node with nothing to route gets no Preview row and
 * ⌘/Ctrl+click on it falls through to ordinary selection.
 */
export function previewableOutputs(node: AppNode): PortDefinition[] {
  if (node.type === 'group' || node.type === 'note') return [];
  const data = node.data as Partial<ShaderNodeData>;
  const dynamic = data.dynamicOutputs;
  if (Array.isArray(dynamic) && dynamic.length > 0) return dynamic;
  const def = NODE_REGISTRY.get(String(data.registryType ?? ''));
  return def?.outputs ?? [];
}

/**
 * A stored target that still names a live node AND one of its current
 * sockets, else null — the node may have been deleted (or undone away), the
 * graph replaced, or a Data node's columns re-dropped. The sync engine asks
 * this on every pass and clears a stale target, so the mode can never outlive
 * the node it is about.
 */
export function resolveNodePreview(
  nodes: readonly AppNode[],
  preview: NodePreviewTarget | null,
): NodePreviewTarget | null {
  if (!preview) return null;
  const node = nodes.find((n) => n.id === preview.nodeId);
  if (!node) return null;
  return previewableOutputs(node).some((p) => p.id === preview.handleId) ? preview : null;
}

/**
 * The DERIVED graph the 3D preview renders while a node is previewed. Three
 * rewrites, applied to copies — the store's arrays are never mutated:
 *
 *   1. Every edge INTO any sink (plain Output or Raymarch Output) is dropped —
 *      "disable all other inputs to the Output". Edges are unwrapped first
 *      (`unwrapCollapsedGroupEdges`), so a wire that reaches the Output
 *      through a collapsed group's boundary socket is dropped too.
 *   2. The target Output — `findDefaultOutput`, i.e. the flagged plain Output
 *      else the first — is replaced by a CLEAN one at the same id: no stored
 *      channel values (an exposure-gated `roughness: float(0.3)` would
 *      otherwise survive the wire removal), no added materials, its ACTIVE
 *      flag set so a flagged Raymarch Output cannot outrank it, and only its
 *      `materialSettings` kept — side, wireframe and the like are settings of
 *      the material, not inputs to it. Every other sink loses its flag, so
 *      `drivingMarchOutput` (unwired AND unflagged now) yields nothing and the
 *      plain Output emits. With no plain Output at all, one is synthesized
 *      under `PREVIEW_OUTPUT_ID`.
 *   3. ONE edge is added, the previewed socket → the Output's Color. Codegen's
 *      own Color rules then apply unchanged: a scalar or a vec2 is widened to
 *      `vec3(ref)`, a logic node is coerced, a colour goes straight through.
 *
 * The result is a graph like any other, so `graphToCode` needs no preview
 * branch and the emitted module is exactly what the user would get by wiring
 * the socket to Color by hand and unplugging everything else.
 */
export function previewGraph(
  nodes: AppNode[],
  edges: AppEdge[],
  preview: NodePreviewTarget,
): { nodes: AppNode[]; edges: AppEdge[] } {
  const src = nodes.find((n) => n.id === preview.nodeId);
  if (!src) return { nodes, edges };

  const target = findDefaultOutput(nodes);
  const outId = target?.id ?? PREVIEW_OUTPUT_ID;
  const settings = target ? (target.data as OutputNodeData).materialSettings : undefined;
  const clean = {
    ...(target ?? { id: PREVIEW_OUTPUT_ID, type: 'output' as const, position: { x: 0, y: 0 } }),
    data: {
      registryType: 'output' as const,
      label: 'Output',
      cost: 0,
      ...(settings ? { materialSettings: settings } : {}),
      [ACTIVE_OUTPUT_KEY]: true,
    },
  } as AppNode;

  const previewNodes: AppNode[] = nodes.map((n) => {
    if (n.id === outId) return clean;
    if (isSinkNode(n) && hasActiveFlag(n)) {
      const d = { ...(n.data as Record<string, unknown>) };
      delete d[ACTIVE_OUTPUT_KEY];
      return { ...n, data: d } as AppNode;
    }
    return n;
  });
  if (!target) previewNodes.push(clean);

  const sinkIds = new Set(nodes.filter(isSinkNode).map((n) => n.id));
  const kept = unwrapCollapsedGroupEdges(nodes, edges).filter((e) => !sinkIds.has(e.target));
  const route: AppEdge = {
    id: generateEdgeId(src.id, preview.handleId, outId, PREVIEW_CHANNEL),
    source: src.id,
    sourceHandle: preview.handleId,
    target: outId,
    targetHandle: PREVIEW_CHANNEL,
    type: 'typed',
    data: { dataType: 'any' },
  };
  return { nodes: previewNodes, edges: [...kept, route] };
}
