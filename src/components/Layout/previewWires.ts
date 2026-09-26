/**
 * THE preview-wire set, derived once and shared by all three surfaces that draw
 * it: the wires themselves (`PreviewLink`), the rail on the canvas's right edge
 * and the rail on the 3D preview's left edge.
 *
 * One derivation, because the three must agree exactly. The wire a card's
 * socket emits, the rail socket it ends on and the preview socket that mirrors
 * it are the same connection seen three times — if any of them computed its own
 * list, a condition gained by one and not the others would show a wire ending
 * on nothing, or a preview socket for a material the module ignores.
 *
 * MEMOIZED at module scope on the store slices it reads, which matters now that
 * three subscribers ask per notify rather than one. zustand re-runs every
 * selector on every `setState` and NodeEditor notifies at refresh rate through
 * a drag, so the un-memoized form walked the whole Output set — allocating a
 * `Set` of the mesh names PER contributing node inside `dormantMaterialIndices`
 * — three times a frame. The key is `outputBindingsKey` (which folds the node
 * data these answers depend on and is itself keyed on the nodes array, so an
 * ordinary drag frame is a hit), the custom sinks' ids and flags
 * (`customSinksKey`, the half of the active-sink election the first key does
 * not see), plus the identity of everything else read:
 * `edges` for the default-contributes walk, and the three preview fields
 * dormancy is judged on.
 */
import { drivingCustomSink, hasActiveFlag, isCustomSink } from '@/utils/sdfPartition';
import { previewWireTargets, type PreviewWireTarget } from '@/utils/outputMaterials';
import { getUnwrappedEdges } from '@/engine/cpuEvaluator';
import { outputBindingsKey } from '@/components/NodeEditor/nodes/outputNodePlans';
import type { AppNode, AppEdge } from '@/types';

/** The store shape these read — the same slices `previewWireTargets` takes. */
export interface WireState {
  nodes: AppNode[];
  edges: AppEdge[];
  previewMesh?: unknown;
  previewMeshInventory?: { meshes?: { name: string }[] } | null;
  previewShowsModel?: boolean;
}

let memo:
  | {
    key: string;
    sinks: string;
    edges: unknown;
    mesh: unknown;
    inventory: unknown;
    shows: unknown;
    wires: PreviewWireTarget[];
  }
  | null = null;

let sinksMemo: { nodes: readonly AppNode[]; key: string } | null = null;

/**
 * The custom sinks' ids and active flags, in array order — the part of
 * `drivingCustomSink`'s answer that neither `outputBindingsKey` (PLAIN Outputs
 * only) nor the edges carry. Without it, clicking a Raymarch or Splat Output's
 * preview socket on a document where no plain Output carried the flag moved
 * neither key, and the wire kept leaving the node that no longer rendered.
 * Memoized on the nodes array, like `outputBindingsKey`.
 */
function customSinksKey(nodes: readonly AppNode[]): string {
  if (sinksMemo && sinksMemo.nodes === nodes) return sinksMemo.key;
  let key = '';
  for (const n of nodes) {
    if (isCustomSink(n)) key += `${n.id.length}:${n.id};${hasActiveFlag(n) ? 1 : 0};`;
  }
  sinksMemo = { nodes, key };
  return key;
}

/**
 * The Output nodes the preview wires leave, in emit order.
 *
 * A DRIVING custom sink (Raymarch or Splat Output) collapses the set to
 * itself: it silences every plain Output, and a wire from a silenced one would
 * claim the viewer renders what it does not. It is asked HERE rather than
 * inside `previewWireTargets` because `activeSink`'s fallbacks are array-order
 * dependent and its callers do not all hold the same array.
 */
export function resolveWireTargets(s: WireState): PreviewWireTarget[] {
  // Two cached strings compared apart — never concatenated per call, which
  // would allocate on every store notify of a drag.
  const key = outputBindingsKey(s.nodes);
  const sinks = customSinksKey(s.nodes);
  if (
    memo
    && memo.key === key
    && memo.sinks === sinks
    && memo.edges === s.edges
    && memo.mesh === s.previewMesh
    && memo.inventory === s.previewMeshInventory
    && memo.shows === s.previewShowsModel
  ) {
    return memo.wires;
  }
  const custom = drivingCustomSink(s.nodes, getUnwrappedEdges(s.nodes, s.edges));
  // A march renders the whole preview window, and a splat program the whole
  // splat model, which is what the DEFAULT label says — so neither needs a
  // branch of its own nor a string of its own.
  const wires = custom
    ? [{ id: custom.id, label: { kind: 'default' } } as PreviewWireTarget]
    : previewWireTargets(s as Parameters<typeof previewWireTargets>[0]);
  memo = {
    key,
    sinks,
    edges: s.edges,
    mesh: s.previewMesh,
    inventory: s.previewMeshInventory,
    shows: s.previewShowsModel,
    wires,
  };
  return wires;
}

/**
 * The cheap-string change signal for a subscriber.
 *
 * The ids alone would be wrong: a material renamed or re-targeted keeps its id
 * while the LABEL the rail shows on hover changes, so the label rides the key
 * as data. Length-prefixed, since both an id and a mesh name come out of a
 * `.fastshader` and may spell any separator.
 */
export function wireTargetsKey(s: WireState): string {
  let k = '';
  for (const w of resolveWireTargets(s)) {
    const l = w.label;
    const label = l.kind === 'index' ? `i${l.gltfIndex}:${l.name}`
      : l.kind === 'named' ? `n${l.first}:${l.more ? 1 : 0}`
        : l.kind;
    k += `${w.id.length}:${w.id};${label.length}:${label};`;
  }
  return k;
}
