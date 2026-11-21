/**
 * BAKE TO TEXTURE — the module the sandbox renders (docs/dev/baking.md).
 *
 * The graph is Preview mode's DERIVED graph (`previewGraph`, utils/nodePreview.ts):
 * the baked socket wired into the Output's Color, every other input of every
 * sink unplugged, every other plain Output gone. Two changes on top:
 *
 *   - the one Output left is UNLIT (`materialSettings.unlit`, loader 0.8 delta
 *     13), so the colour reaches the render target as it is — no light, no
 *     environment, nothing added — and it has no Position wire, so nothing is
 *     displaced;
 *   - for a vec4's ALPHA pass, a synthesized Split takes the socket and its
 *     `w` is what is routed, so the fourth channel bakes as a grey picture of
 *     its own.
 *
 * The text then goes through the code panel's own codegen and the preview's
 * own module builder — the same bytes the 3D view would run if the user wired
 * the socket to an unlit Color by hand. Its `fs-asset:` placeholders resolve in
 * the stage from the preview's asset feed, like every module it runs.
 */
import type { AppEdge, AppNode } from '@/types';
import { previewGraph } from '@/utils/nodePreview';
import { makeTypedEdge } from '@/utils/edgeUtils';
import { panelCodegen } from './panelCode';
import { buildPreviewShaderModule } from './tslToPreviewHTML';
import type { BakeSocket } from '@/utils/bakePlan';

/** The id of the Split an alpha pass adds. Exists only in the derived graph. */
export const BAKE_SPLIT_ID = '__fs-bake-split';

export type BakePass = 'value' | 'alpha';

/** The derived graph a bake renders (pure). */
export function bakeGraph(
  nodes: AppNode[],
  edges: AppEdge[],
  socket: BakeSocket,
  pass: BakePass = 'value',
): { nodes: AppNode[]; edges: AppEdge[] } {
  let ns = nodes;
  let es = edges;
  let target = socket;
  if (pass === 'alpha') {
    const split = {
      id: BAKE_SPLIT_ID,
      type: 'shader',
      position: { x: 0, y: 0 },
      data: { registryType: 'split', label: 'Split', cost: 0, values: {} },
    } as unknown as AppNode;
    ns = [...nodes, split];
    es = [...edges, makeTypedEdge(socket.nodeId, socket.handleId, BAKE_SPLIT_ID, 'v')];
    target = { nodeId: BAKE_SPLIT_ID, handleId: 'w' };
  }
  const derived = previewGraph(ns, es, target);
  return {
    nodes: derived.nodes.map((n) =>
      n.data.registryType === 'output'
        ? ({ ...n, data: { ...n.data, materialSettings: { unlit: true } } } as AppNode)
        : n,
    ),
    edges: derived.edges,
  };
}

/** The module text a bake posts to the stage. */
export function bakeModuleText(
  nodes: AppNode[],
  edges: AppEdge[],
  socket: BakeSocket,
  pass: BakePass = 'value',
): string {
  const g = bakeGraph(nodes, edges, socket, pass);
  const code = panelCodegen(g.nodes, g.edges, false).result.code;
  return buildPreviewShaderModule(code, { unlit: true });
}
