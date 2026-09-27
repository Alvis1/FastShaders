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
 *  - the Splat Output shades Gaussian splats only — and while it is UNLIT a
 *    Normal node reads the direction to the camera inside it (a splat carries
 *    no normal until "React to light" derives one), so a Normal feeding it on a
 *    shown splat is reported too: a rim or a fresnel comes out flat with no
 *    error anywhere, the one splat pattern that still fails silently now that
 *    UV is projected (utils/sdfPartition.ts SPLAT_CONSTANTS). A Normal that
 *    reaches only a Light socket is not counted: unlit, those are read by
 *    nothing.
 *
 * Only a CONNECTED output is judged: a node with nothing wired shades nothing,
 * so there is nothing wrong to report. Pure; pass UNWRAPPED edges.
 */
import type { AppEdge, AppNode } from '@/types';
import { activeSink, implicitRootOf, isMarchOutput, isSplatOutput, isUntargetedOutput, SPLAT_NORMAL_ROOTS } from './sdfPartition';
import { isSplatLit, SPLAT_LIGHT_PORTS } from './splatLight';
import { sameGraphSemantics } from './graphSemantics';
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
    if (!showsSplat) return shown.splatLoaded ? 'splat-pick-splat' : 'splat-needs-splat';
    if (isSplatLit((sink.data as { values?: unknown }).values)) return null;
    return feedsSplatNormal(sink.id, edges, nodes) ? 'splat-normal-faces-camera' : null;
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

/**
 * Does a node the splat program reads `n` through feed the Splat Output,
 * through any number of nodes? A Normal node itself (Normal (World) is `n`,
 * Normal (Local) a constant built from it — SPLAT_NORMAL_ROOTS), or a node that
 * reads one IMPLICITLY through an unwired input (a noise whose stored position
 * is `normalWorld`): the emitter's own `implicitRootOf`, so the two cannot
 * disagree. One upstream walk over the edges given (UNWRAPPED — a feeder
 * inside a collapsed group still counts) from every socket but the Light ones,
 * which an unlit node — the only kind asked — reads nowhere.
 *
 * This runs from a store selector on EVERY notify once a splat is shown and an
 * unlit Splat Output drives — the ordinary splat workflow — so the answer is
 * kept for the next call while the graph means the same (`sameGraphSemantics`:
 * a drag frame changes positions, never `data` or wiring), and the walk's maps
 * are built only when it really changed.
 */
let lastNormalWalk: { nodes: readonly AppNode[]; edges: readonly AppEdge[]; sinkId: string; feeds: boolean } | null = null;

function feedsSplatNormal(sinkId: string, edges: readonly AppEdge[], nodes: readonly AppNode[]): boolean {
  const last = lastNormalWalk;
  if (last && last.sinkId === sinkId && sameGraphSemantics(last.nodes as AppNode[], nodes as AppNode[], last.edges as AppEdge[], edges as AppEdge[])) {
    if (last.nodes !== nodes || last.edges !== edges) lastNormalWalk = { ...last, nodes, edges };
    return last.feeds;
  }
  const feeds = walkSplatNormal(sinkId, edges, nodes);
  lastNormalWalk = { nodes, edges, sinkId, feeds };
  return feeds;
}

function walkSplatNormal(sinkId: string, edges: readonly AppEdge[], nodes: readonly AppNode[]): boolean {
  const into = new Map<string, string[]>();
  const handles = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.target === sinkId && SPLAT_LIGHT_PORTS.includes(e.targetHandle ?? '')) continue;
    const list = into.get(e.target);
    if (list) list.push(e.source);
    else into.set(e.target, [e.source]);
    if (e.targetHandle) {
      const set = handles.get(e.target);
      if (set) set.add(e.targetHandle);
      else handles.set(e.target, new Set([e.targetHandle]));
    }
  }
  const readsN = (node: AppNode): boolean => {
    if (SPLAT_NORMAL_ROOTS.has(node.data.registryType)) return true;
    const implicit = implicitRootOf(node, (h) => handles.get(node.id)?.has(h) ?? false);
    return implicit !== null && SPLAT_NORMAL_ROOTS.has(implicit);
  };
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const seen = new Set<string>([sinkId]);
  const stack = [sinkId];
  while (stack.length > 0) {
    for (const src of into.get(stack.pop()!) ?? []) {
      if (seen.has(src)) continue;
      seen.add(src);
      const node = byId.get(src);
      if (node && readsN(node)) return true;
      stack.push(src);
    }
  }
  return false;
}
