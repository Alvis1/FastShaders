import type { AppNode, AppEdge } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY, effectiveInputs } from '@/registry/nodeRegistry';
import { getCost } from '@/utils/costTable';
import { activeSink, isSinkNode, isMarchOutput, marchPartition } from '@/utils/sdfPartition';

/**
 * GPU cost READERS that need the node graph — the per-instance price and the
 * reachable-subtree total.
 *
 * The TABLE itself (the authored prices, the measured override, the sanitizer)
 * lives in `costTable.ts`, deliberately: this module sits in an import cycle
 * (outputMaterials -> exposedPorts -> edgeUtils -> useAppStore -> back here),
 * and the store calls the table's functions during its own module
 * initialisation. Read costTable.ts's header before moving anything back —
 * that split is what stopped the test suite failing at random.
 *
 * Re-exported here so every existing consumer keeps one import site for
 * "costs", and because `getCost`/`getBaseCosts` read naturally beside
 * `nodeCostPoints`.
 */
export {
  MAX_NODE_COST,
  sanitizeCostMap,
  setCostOverrides,
  getCost,
  getBaseCosts,
} from '@/utils/costTable';

/**
 * The Image node's price scales with its stored RESOLUTION — as a DISCOUNT from
 * the table value, never a surcharge above it.
 *
 * The table value (`getCost('imageNode')`, authored 10 in complexity.json) is
 * the price of the LARGEST image the app produces: its own meta derives it
 * for "a mipmapped texture of up to ~16 MB", i.e. the 2048² the shipped Quest
 * 3 profile caps drops at. So a full-size image pays exactly the table, an
 * existing graph is never repriced UPWARD by this, and a cost profile that
 * overrides `imageNode` still moves every image node — the whole curve is a
 * multiplier on the table entry, never a literal.
 *
 * Smaller textures pay less because their compulsory traffic is less and more
 * of it stays in cache: a 256² RGBA8 with mips is ~350 KB, a 2048² ~22 MB.
 * The discount is LOG-LINEAR in the geometric-mean side between
 * `IMAGE_COST_FLOOR_SIDE` (256, ×0.5) and `IMAGE_COST_REF_SIDE` (2048, ×1), so
 * every halving the settings menu's Resolution ladder offers steps the price
 * down by the same amount — the control is CONSEQUENTIAL, which is the point.
 * That shape is a judgement between two physical bounds, not a measurement:
 * compulsory (coherent) DRAM traffic is LINEAR in area — a shallower discount
 * than this at the small end — while an INCOHERENT access pattern (a
 * noise-warped uv, an unmipped data map) makes size matter more than area
 * alone. Log-linear sits between them, on the side that prices small textures
 * higher rather than lower, since underpricing is the dangerous direction for
 * a budget. The floor (×0.5 → 5 at the authored 10) stays strictly above the
 * table's LUT sampler `colormap` (4) and its SFU ops (`sin` 4): a 2D fetch with
 * mip selection is never cheaper than a 1 KB ramp lookup.
 *
 * NOT re-purposed here: complexity.json's "~4 … ~26" band. That band sweeps
 * CACHE BEHAVIOUR for one fetch (texture-unit throughput vs. every tap
 * missing) and is size-free at both ends — an audit on 2026-09-09 caught a
 * first cut of this function mapping 256 px → 4 and 2048 px → 26 onto it,
 * which priced a small image at exactly colormap's 4 and repriced every 2048²
 * image to 13 % of the Quest 3 budget. The coherence axis is a different
 * lever (the `data` colour space turns mipmaps off) and is not priced yet.
 *
 * `width`/`height` come off `values`, i.e. out of a `.fastshader` file, and
 * NOTHING validates them on the restore paths (`sanitizeImageNodes` inspects
 * only the payload and the provenance keys). So the gate here is strict and
 * mirrors `decodeImageNode`'s: a REAL positive integer no larger than the
 * texture field cap. Anything else — absent, null, a string, a boolean, an
 * array, 0, negative, NaN, Infinity, oversized — prices at the flat table
 * value. Not `Number()`-coerced: `Number(null)`, `Number('')` and
 * `Number([])` are all 0 and `Number(true)` is 1, which a finiteness check
 * would pass and then price at the FLOOR — a 50 % silent underprice on junk;
 * and `Math.max(0, NaN)` is NaN, so a clamp alone would let `sqrt(-1 × 4)`
 * reach the badge as `#NaNNaNNaN`. The result is rounded: every other price
 * in the table is an integer and every surface renders the number raw.
 */
export const IMAGE_COST_REF_SIDE = 2048;
export const IMAGE_COST_FLOOR_SIDE = 256;
export const IMAGE_COST_MIN_SCALE = 0.5;
/** The texture FIELD cap `decodeImageNode` enforces — beyond it a stored
 *  dimension is junk, not a big image. */
export const IMAGE_COST_MAX_DIM = 8192;

function validImageDim(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= IMAGE_COST_MAX_DIM;
}

export function imageNodeCost(base: number, width: unknown, height: unknown): number {
  if (!validImageDim(width) || !validImageDim(height)) return base;
  const side = Math.sqrt(width * height);
  const span = Math.log2(IMAGE_COST_REF_SIDE / IMAGE_COST_FLOOR_SIDE);
  const t = Math.min(1, Math.max(0, Math.log2(side / IMAGE_COST_FLOOR_SIDE) / span));
  return Math.round(base * (IMAGE_COST_MIN_SCALE + (1 - IMAGE_COST_MIN_SCALE) * t));
}

/**
 * GPU cost points for a node instance.
 *
 * A `chainable` (variadic) arithmetic node scales with its operand count: an
 * N-operand op performs N−1 operations, so its cost is `base × (N−1)`. A plain
 * 2-operand node is therefore unchanged (base × 1). Every other node type is the
 * flat registry cost.
 *
 * Operand count is the *semantic* count (`effectiveInputs(..., false)`) — wired
 * operands plus any interior identity gaps, excluding the empty grow socket —
 * so the price tracks exactly what graphToCode emits. Reads the ACTIVE table so
 * a measured override reprices every node without touching stored snapshots.
 */
export function nodeCostPoints(node: AppNode, edges: AppEdge[]): number {
  const type = node.data.registryType;
  if (!type) return 0;
  const base = getCost(type);
  if (type === 'imageNode') {
    const v = getNodeValues(node);
    return imageNodeCost(base, v.width, v.height);
  }
  const def = NODE_REGISTRY.get(type);
  if (!def?.chainable) return base;
  // One pass, one array. This runs inside a store SELECTOR (ShaderNode), i.e.
  // once per chainable node on every store notification, so the filter+map pair
  // this replaces allocated two throwaway arrays per node per round on top of
  // the unavoidable O(E) scan.
  const connected: string[] = [];
  for (const e of edges) {
    if (e.target === node.id && typeof e.targetHandle === 'string') connected.push(e.targetHandle);
  }
  const operands = effectiveInputs(def, connected, false, Object.keys(getNodeValues(node))).length;
  return base * Math.max(1, operands - 1);
}

/**
 * Sum the GPU cost of every node reachable (backward) from an Output node —
 * the number the CostBar shows. Reverse-BFS over an incoming-edge adjacency map
 * (O(V+E)). Callers MUST hand in edges already run through
 * `unwrapCollapsedGroupEdges` — collapsing a group must never change the
 * budget, so the walk reaches the real members either way. The group container
 * itself has no `registryType`, so `nodeCostPoints` prices it at 0 and only the
 * members are counted. Returns 0 when there's no Output node.
 *
 * The ACTIVE sink seeds the walk (`activeSink` — the flagged Output or
 * Raymarch Output, else the historical fallback): the total is the price of
 * what the shader actually RENDERS, and an inactive output's chain emits
 * nothing, so pricing it would put points on the meter that no headset ever
 * pays. `sinkCosts` prices every sink on its own for the badges, so two
 * alternative outputs can be compared before one is activated.
 *
 * A node feeding two materials is counted ONCE (the `visited` set), so the
 * total is a lower bound on true multi-pipeline cost: the GPU compiles the
 * shared node into every material that uses it. Real per-part pricing needs a
 * ShaderCarousel calibration entry and is still to come.
 *
 * Shared by useSyncEngine (runs per graph change) and the store's device
 * selection (activating a cost profile changes the table, not the graph, so the
 * `[nodes, edges]` effect wouldn't otherwise re-fire).
 */
export function computeReachableCost(
  nodes: AppNode[],
  edges: AppEdge[],
  seed?: AppNode | null,
  /** Prebuilt incoming-edge adjacency, when the caller prices several sinks
   *  over the same edge list (`sinkCosts`) and would otherwise rebuild it per
   *  sink. Omit and it is built here. */
  incoming?: ReadonlyMap<string, string[]>,
): number {
  const sink = seed === undefined ? activeSink(nodes, edges) : seed;
  if (!sink) return 0;
  const sinkIds = new Set(nodes.filter(isSinkNode).map((n) => n.id));
  let total = sumReachable(nodes, edges, [sink.id], sinkIds, incoming);
  // The Raymarch Output evaluates its per-step bodies once per ray STEP (the
  // Field also four more times for the gradient normal) and pays its own fixed
  // march overhead. Each body was counted once above; add the remaining
  // evaluations, using the SAME partition the emitter uses
  // (utils/sdfPartition.ts). The hit-shaded and direction scopes run once.
  if (isMarchOutput(sink)) {
    const march = sink;
    const raw = Number(getNodeValues(march).steps);
    const dflt = Number(NODE_REGISTRY.get(march.data.registryType)?.defaultValues?.steps ?? 64);
    const steps = Number.isFinite(raw) ? raw : dflt;
    const part = marchPartition(nodes, edges, march.id);
    // Occlusion taps the Field 5 more times at the hit, a soft shadow marches
    // it up to 24 more — both only when switched on (non-zero or wired).
    const on = (key: string): boolean => {
      const v = Number(getNodeValues(march)[key]);
      return (Number.isFinite(v) && v !== 0) || edges.some((e) => e.target === march.id && e.targetHandle === key);
    };
    const fieldExtra = steps + 4 - 1 + (on('ao') ? 5 : 0) + (on('shadow') ? 24 : 0);
    const extraEvals: Record<string, number> = { field: fieldExtra, density: steps - 1, glow: steps - 1 };
    for (const [handle, extra] of Object.entries(extraEvals)) {
      const set = part.scopes.get(handle);
      if (!set) continue;
      let body = 0;
      for (const n of nodes) if (set.has(n.id)) body += nodeCostPoints(n, edges);
      total += body * Math.max(0, extra);
    }
    total += getCost(march.data.registryType);
  }
  return total;
}

/**
 * Every sink's OWN price — what the shader would cost with THAT node active.
 * The active sink's entry equals `computeReachableCost(nodes, edges)`; the
 * badges on inactive outputs show theirs muted, so two candidate outputs can
 * be compared before clicking one. Keyed by node id.
 *
 * `known` lets a caller that has ALREADY priced a sink hand the answer in
 * instead of paying for it twice: useSyncEngine computes the ACTIVE sink's
 * total first (it is the CostBar's number and gates the whole write), and that
 * entry is this map's active row by construction.
 */
export function sinkCosts(
  nodes: AppNode[],
  edges: AppEdge[],
  known?: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  // One adjacency build for the whole set — a document may hold several sinks
  // now that outputs coexist, and each walk would otherwise rebuild it.
  const incoming = buildIncoming(edges);
  for (const n of nodes) {
    if (!isSinkNode(n)) continue;
    const pre = known?.get(n.id);
    out.set(n.id, pre !== undefined ? pre : computeReachableCost(nodes, edges, n, incoming));
  }
  return out;
}

/** Incoming-edge adjacency (target → sources) for the reverse walk. */
function buildIncoming(edges: AppEdge[]): Map<string, string[]> {
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    const list = incoming.get(e.target);
    if (list) list.push(e.source);
    else incoming.set(e.target, [e.source]);
  }
  return incoming;
}

/** Reverse-BFS from `seeds`, summing everything reached except the Outputs. */
function sumReachable(
  nodes: AppNode[],
  edges: AppEdge[],
  seeds: string[],
  outputIds: Set<string>,
  prebuiltIncoming?: ReadonlyMap<string, string[]>,
): number {
  const incoming = prebuiltIncoming ?? buildIncoming(edges);
  const visited = new Set<string>();
  const queue = [...seeds];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    if (visited.has(id)) continue;
    visited.add(id);
    const sources = incoming.get(id);
    if (sources) {
      for (const src of sources) if (!visited.has(src)) queue.push(src);
    }
  }

  let total = 0;
  for (const node of nodes) {
    // Every Output is excluded, not just the seeds: an Output is a sink, not a
    // priced operation, and with per-mesh materials there are several.
    if (!visited.has(node.id) || outputIds.has(node.id)) continue;
    // No collapsed-group branch: `data.cost` was a snapshot taken at collapse
    // time over ALL members with no reachability filter, so collapsing a group
    // that held a dead-end branch inflated the budget, a group saved before the
    // field existed reported 0, and a library group carried a price from
    // whatever cost table was active when it was saved. Group containers price
    // at 0 here (no registryType) and their members are walked normally.
    total += nodeCostPoints(node, edges);
  }
  return total;
}
