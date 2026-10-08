import type { AppNode, AppEdge } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY, effectiveInputs } from '@/registry/nodeRegistry';
import { getCost } from '@/utils/costTable';
import {
  activeSink, isSinkNode, isMarchOutput, isSplatOutput, isCustomSink, marchPartition,
  buildIncoming, closure,
} from '@/utils/sdfPartition';
import { contributingOutputs } from '@/utils/outputMaterials';

/**
 * GPU cost READERS that need the node graph — the per-instance price and the
 * reachable-subtree total. The TABLE lives in the leaf `costTable.ts` and is
 * re-exported here so consumers keep one import site for "costs".
 *
 * This module sits in the store's import cycle (nodeCost → outputMaterials →
 * exposedPorts → edgeUtils → useAppStore): evaluate NOTHING at module scope.
 * See costTable.ts's header.
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
 *
 * `wiredHandles` is the node's wired input handles when the caller has already
 * indexed the edges (the cost walks); omitted, they are scanned from `edges`.
 */
export function nodeCostPoints(node: AppNode, edges: AppEdge[], wiredHandles?: readonly string[]): number {
  const type = node.data.registryType;
  if (!type) return 0;
  // Color Ramp IS one 1-D LUT fetch — the same measurement as the Colormap
  // node — so it is charged at colormap's live price and a measured profile
  // reprices both; its own complexity.json entry is only what node creation
  // and the Designer read.
  if (type === 'colorRamp') return getCost('colormap');
  const base = getCost(type);
  if (type === 'imageNode') {
    const v = getNodeValues(node);
    return imageNodeCost(base, v.width, v.height);
  }
  const def = NODE_REGISTRY.get(type);
  if (!def?.chainable) return base;
  const connected = wiredHandles ?? wiredHandlesOf(node.id, edges);
  const operands = effectiveInputs(def, connected, false, Object.keys(getNodeValues(node))).length;
  return base * Math.max(1, operands - 1);
}

/** One node's wired input handles. One pass, one array: this runs inside a
 *  store SELECTOR (ShaderNode), once per chainable node per store notify. */
function wiredHandlesOf(id: string, edges: AppEdge[]): string[] {
  const out: string[] = [];
  for (const e of edges) {
    if (e.target === id && typeof e.targetHandle === 'string') out.push(e.targetHandle);
  }
  return out;
}

/** Every node's wired input handles (target → handles), built ONCE per walk so
 *  a chainable node does not rescan the edge list. Same filter as above. */
function buildWiredHandles(edges: AppEdge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (typeof e.targetHandle !== 'string') continue;
    const list = out.get(e.target);
    if (list) list.push(e.targetHandle);
    else out.set(e.target, [e.targetHandle]);
  }
  return out;
}

const NO_HANDLES: readonly string[] = [];

/**
 * THE nodes the cost total is walked back from — the ONE answer both the
 * CostBar's per-graph pass (useSyncEngine) and the store's device selection
 * read, so a headset change never prices a different set from the meter's.
 *
 * A driving custom sink (Raymarch or Splat Output) seeds ALONE: it suppresses
 * every plain Output. Otherwise the seeds are `contributingOutputs` — the
 * default plus EVERY targeted Output, since each emits its own `parts` /
 * `materialParts` entry. A PARKED Output emits nothing and is not priced.
 * See docs/dev/outputs-and-materials.md.
 */
export function costSeeds(nodes: AppNode[], edges: AppEdge[]): AppNode[] {
  const sink = activeSink(nodes, edges);
  if (sink && isCustomSink(sink)) return [sink];
  return contributingOutputs(nodes);
}

/**
 * The GPU cost of every node reachable (backward) from the seeds — the number
 * the CostBar shows. Callers MUST hand in edges already run through
 * `unwrapCollapsedGroupEdges`: collapsing a group must never change the budget.
 *
 * SEVERAL seeds are ONE walk, never a sum of walks, so a feeder shared by two
 * materials is counted once. March bodies are multiplied per step below.
 *
 * In POINTS PER PIXEL the total is an UPPER bound: a pixel runs exactly one
 * material. It UNDER-counts compile work and pipelines; texture memory is not
 * priced in points at all — utils/textureMemory.ts reports it as a separate
 * figure (bytes). Two Image nodes holding the same image still price twice.
 */
export function computeReachableCost(
  nodes: AppNode[],
  edges: AppEdge[],
  /** The sinks to walk back from. Omitted = `costSeeds`; `null` = none (0);
   *  one node or a list, unioned into a single walk. */
  seed?: AppNode | readonly AppNode[] | null,
  /** The three below are prebuilt by `sinkCosts`, which prices several sinks
   *  over ONE graph; each is a function of `nodes`/`edges` alone, never an
   *  answer for one seed. Omit and they are built here. */
  incoming?: ReadonlyMap<string, string[]>,
  sinks?: ReadonlySet<string>,
  wired?: ReadonlyMap<string, readonly string[]>,
): number {
  const seeds: readonly AppNode[] = seed === undefined
    ? costSeeds(nodes, edges)
    : seed === null
      ? []
      // Not `Array.isArray`'s narrowing: it widens a `readonly AppNode[]` arm
      // to `any[]`, which loses the element type on the branch that needs it.
      : (Array.isArray(seed) ? (seed as readonly AppNode[]) : [seed as AppNode]);
  if (seeds.length === 0) return 0;
  const sinkIds = sinks ?? new Set(nodes.filter(isSinkNode).map((n) => n.id));
  const handles = wired ?? buildWiredHandles(edges);
  const points = (n: AppNode): number => nodeCostPoints(n, edges, handles.get(n.id) ?? NO_HANDLES);

  // Every Output is excluded, not just the seeds: a sink is not a priced
  // operation. Group containers price at 0 (no registryType) and their members
  // are walked normally — a collapsed group's `data.cost` snapshot is never
  // read (it was taken over ALL members, under whatever table was active).
  const sources = incoming ?? buildIncoming(edges);
  const visited = closure(seeds.map((s) => s.id), (id) => sources.get(id) ?? []);
  let total = 0;
  for (const n of nodes) if (visited.has(n.id) && !sinkIds.has(n.id)) total += points(n);

  // The Raymarch Output evaluates its per-step bodies once per ray STEP (the
  // Field also four more times for the gradient normal) and pays its own fixed
  // march overhead. Each body was counted once above; add the remaining
  // evaluations, using the SAME partition the emitter uses
  // (utils/sdfPartition.ts). The hit-shaded and direction scopes run once.
  // PER MARCH SEED, never over the union: a per-step multiplier belongs to one
  // node's own loop. Only one march output can drive today.
  for (const march of seeds) {
    // A Splat Output's Fns run once per splat VERTEX, never per pixel or per
    // step — so its chain is priced once, plus the sink's own flat table cost.
    // The splat COUNT is a figure of the loaded model, not of the graph.
    if (isSplatOutput(march)) {
      total += getCost(march.data.registryType);
      continue;
    }
    if (!isMarchOutput(march)) continue;
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
      for (const n of nodes) if (set.has(n.id)) body += points(n);
      total += body * Math.max(0, extra);
    }
    total += getCost(march.data.registryType);
  }
  return total;
}

/**
 * Every sink's OWN price — what the shader would cost with THAT node active.
 * The badges on inactive outputs show theirs muted, so two candidate outputs
 * can be compared before clicking one. Keyed by node id.
 *
 * It takes no pre-priced entry for the active sink: that shortcut rested on
 * "the total IS one sink's subtree", which a union of several seeds is not —
 * the union price would land on one node's badge (pinned by nodeCost.test.ts).
 */
export function sinkCosts(nodes: AppNode[], edges: AppEdge[]): Map<string, number> {
  const out = new Map<string, number>();
  // ONE adjacency, ONE sink set and ONE handle index for every sink's walk.
  const incoming = buildIncoming(edges);
  const sinks = new Set(nodes.filter(isSinkNode).map((n) => n.id));
  const wired = buildWiredHandles(edges);
  for (const n of nodes) {
    // `isSinkNode(n)`, not `sinks.has(n.id)`: the two diverge on duplicate ids,
    // and the `has` form would price a NON-sink under a sink's id.
    if (!isSinkNode(n)) continue;
    out.set(n.id, computeReachableCost(nodes, edges, n, incoming, sinks, wired));
  }
  return out;
}

const badgeStale = (n: AppNode, perSink: ReadonlyMap<string, number>): boolean =>
  perSink.has(n.id) && n.data.cost !== perSink.get(n.id);

/** Whether any sink's badge differs from its price in `perSink` (`sinkCosts`). */
export function sinkBadgesStale(nodes: readonly AppNode[], perSink: ReadonlyMap<string, number>): boolean {
  return nodes.some((n) => badgeStale(n, perSink));
}

/** `nodes` with every stale sink badge restamped; untouched nodes keep their identity. */
export function stampSinkCosts(nodes: readonly AppNode[], perSink: ReadonlyMap<string, number>): AppNode[] {
  return nodes.map((n) =>
    badgeStale(n, perSink) ? { ...n, data: { ...n.data, cost: perSink.get(n.id)! } } : n,
  ) as AppNode[];
}
