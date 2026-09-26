/**
 * Does the output node that DRIVES the shader fit the 3D object the preview
 * shows? The ONE answer behind the preview pane's standing notice and the
 * canvas note posted when a wire makes the pairing wrong.
 *
 * Each output kind shades one kind of object:
 *
 *  - the plain Output is a MATERIAL — meshes only: loader 0.8 skips a Gaussian
 *    splat in every material pass, so a wired Output does nothing to one;
 *  - the Raymarch Output marches from each front face of a MESH surface (the
 *    window sphere, or any model picked in its place) — a splat has none — and
 *    while it drives every plain Output is silenced, the per-mesh ones of a
 *    dropped model included;
 *  - the Splat Output shades Gaussian splats only.
 *
 * Only a CONNECTED output is judged: a node with nothing wired shades nothing,
 * so there is nothing wrong to report. Pure; pass UNWRAPPED edges.
 */
import type { AppEdge, AppNode } from '@/types';
import { activeSink, isMarchOutput, isSplatOutput, isUntargetedOutput } from './sdfPartition';
import { contributingOutputs } from './outputMaterials';
import type { SinkModelIssue } from './sinkModelCopy';

export type { SinkModelIssue } from './sinkModelCopy';
export { SINK_MODEL_ISSUE_KEY } from './sinkModelCopy';

export interface ShownModel {
  /** The preview's rendered geometry ('custom' = the dropped model). */
  geometry: string;
  /** A dropped model is loaded and it is a Gaussian splat. */
  splatLoaded: boolean;
}

export function sinkModelIssue(
  nodes: readonly AppNode[],
  edges: readonly AppEdge[],
  shown: ShownModel,
): SinkModelIssue | null {
  const showsSplat = shown.geometry === 'custom' && shown.splatLoaded;
  const sink = activeSink(nodes, edges);
  // The common case — a plain material on a mesh — returns before any set is
  // built: this runs from a store selector, i.e. on every notification.
  if (!showsSplat && !(sink && (isSplatOutput(sink) || isMarchOutput(sink)))) return null;
  const wired = new Set<string>();
  for (const e of edges) wired.add(e.target);

  if (sink && isSplatOutput(sink)) {
    if (showsSplat) return null;
    return shown.splatLoaded ? 'splat-pick-splat' : 'splat-needs-splat';
  }
  if (sink && isMarchOutput(sink)) {
    if (showsSplat) return 'march-on-splat';
    if (shown.geometry === 'custom' && nodes.some((n) => n.data.registryType === 'output' && !isUntargetedOutput(n) && wired.has(n.id))) {
      return 'march-over-mesh-outputs';
    }
    return null;
  }
  // A plain material drives, and a splat is shown.
  if (!contributingOutputs(nodes).some((n) => wired.has(n.id))) return null;
  return nodes.some((n) => isSplatOutput(n) && wired.has(n.id)) ? 'output-on-splat-parked' : 'output-on-splat';
}
