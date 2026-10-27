/**
 * CPU-side graph evaluator for real-time values.
 * Walks the graph and computes each node's output using JS math equivalents.
 * Returns multi-channel arrays: [x] for scalar, [x,y] for vec2, [r,g,b] for vec3/color, etc.
 * Returns null for nodes that can't be evaluated (e.g. positionGeometry — depends on geometry,
 * or any node downstream of an unevaluable source like a procedural texture).
 *
 * Null propagation: if a port is connected to an upstream node that returns null, the
 * channelInput helper also returns null (it does NOT silently fall back to the inline value)
 * — otherwise downstream arithmetic would fabricate fake scalars and the visualization layer
 * would think a vec3 chain was actually a float.
 */
import type { AppNode, AppEdge, TSLDataType, NodeDefinition } from '@/types';
import { valueNum, valueStr } from '@/utils/valueCoerce';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY, effectiveInputs } from '@/registry/nodeRegistry';
import { perlin2D, fbm2D, cellNoise2D, voronoi2D } from '@/utils/noisePreview';
import { HEX6, hexToRgb01, srgbToLinear01 } from '@/utils/colorUtils';
import { decodeDataNode, type DecodedDataNode } from '@/utils/dataNode';
import { columnStats, isNormalizeMode, planNormalize, type ColumnStats, type NormalizePlan } from '@/utils/dataViz';
import { hasCustomFormula } from '@/utils/dataRangeFormula';
import { intLiteral, isIntSource, type IntGraph } from './intPromotion';
import { SOUND_CHANNELS, soundChannelForHandle } from '@/utils/soundAnalysis';
import { readSoundSettings } from '@/utils/soundSettings';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { hasNoiseRangeFlag, isUnsignedNoise } from '@/utils/noiseRange';
import { sameGraphSemantics } from '@/utils/graphSemantics';
import { buildTimeUpstreamSet, buildDownstreamClosure } from '@/utils/graphTraversal';
import { IMAGE_CHANNEL_INDEX } from '@/utils/imageChannels';
import { fresnelFacing } from '@/utils/fresnel';
import { readColorRamp, rampFetch, rampRangeOver } from '@/utils/colorRamp';
import { readRgbCurves, evalRgbCurves, rgbCurvesRange } from '@/utils/rgbCurves';

/** Multiplier applied to UV coordinates before sampling noise (matches GPU preview scale). */
const NOISE_UV_SCALE = 4;

/**
 * An append node's operand ports in socket order. Append grows past its base
 * a/b sockets, so both the shape inference and the fold below must iterate the
 * EFFECTIVE list — the same one graphToCode emits from — or the CPU preview
 * silently ignores every operand past `b`.
 */
function appendOperands(
  nodeId: string,
  nodeIndex: Map<string, AppNode>,
  edgeIndex: Map<string, AppEdge[]>,
) {
  const node = nodeIndex.get(nodeId);
  const def = NODE_REGISTRY.get(node?.data.registryType ?? '');
  if (!node || !def) return [];
  return effectiveInputs(def, connectedHandles(nodeId, edgeIndex), false, Object.keys(getNodeValues(node)));
}

/** The FULL edge index behind an `evalEdgeIndex` that dropped dead wires. */
const FULL_EDGE_INDEX = new WeakMap<Map<string, AppEdge[]>, Map<string, AppEdge[]>>();

/** One int-rule memo per eval index (so per graph version). */
const INT_NODE_MEMO = new WeakMap<Map<string, AppEdge[]>, Map<string, boolean>>();

/**
 * engine/intPromotion.ts's view of a graph — the ONE adapter graphToCode,
 * codeToGraph and the evaluator ask through — over a node index and the FULL
 * incoming-edge index (target → edges): a dead Split wire still counts as an
 * operand (codegen emits that socket's unwired value) but carries nothing.
 */
export function intGraphOver(nodeIndex: Map<string, AppNode>, incoming: Map<string, AppEdge[]>): IntGraph {
  return {
    typeOf: (id) => nodeIndex.get(id)?.data.registryType,
    wireInto: (id, port) => {
      const edge = (incoming.get(id) ?? []).find((e) => e.targetHandle === port);
      return edge && !deadSplitWire(edge, nodeIndex, incoming) ? edge : undefined;
    },
    operands: (id) => appendOperands(id, nodeIndex, incoming).map((p) => p.id),
    literal: (id) => intNodeLiteral(nodeIndex.get(id)),
  };
}

/** The literal an Int node emits (graphToCode's zero-input branch): the stored
 *  number when finite, else the registry default — rounded and clamped. */
export function intNodeLiteral(node: AppNode | undefined): number {
  const dflt = Number(NODE_REGISTRY.get('int')?.defaultValues?.value ?? 0);
  const n = node ? valueNum(getNodeValues(node).value ?? dflt) : dflt;
  return intLiteral(Number.isFinite(n) ? n : dflt);
}

/**
 * Is this node an INT in the shader? Every operation an int meets a float in
 * is FLOAT there (graphToCode wraps the int), which the float maths here
 * already is; only an all-int Divide or Mod stays integer.
 */
function isIntNode(nodeId: string, nidx: Map<string, AppNode>, idx: Map<string, AppEdge[]>): boolean {
  let memo = INT_NODE_MEMO.get(idx);
  if (!memo) {
    memo = new Map();
    INT_NODE_MEMO.set(idx, memo);
  }
  return isIntSource(intGraphOver(nidx, FULL_EDGE_INDEX.get(idx) ?? idx), nodeId, memo);
}

/**
 * Target handles of every edge INTO `nodeId`, dead wires included — what an
 * effective operand list counts, as resolveArguments and appendOperandChannels
 * do (a dangling Split into Append's `c` still makes `c` an operand, emitted
 * as its unwired value). Values are still read through the eval index.
 */
function connectedHandles(nodeId: string, idx: Map<string, AppEdge[]>): string[] {
  return ((FULL_EDGE_INDEX.get(idx) ?? idx).get(nodeId) ?? [])
    .map((e) => e.targetHandle)
    .filter((h): h is string => typeof h === 'string');
}

/** Result: array of channel values, or null if unevaluable. */
export type EvalResult = number[] | null;

/**
 * Shared per-graph evaluation context. Every public entry point routes
 * through it, so ALL consumers evaluating against the SAME (nodes, edges)
 * arrays — every ShaderNode card, every TypedEdge, EdgeInfoCard, codegen's
 * shape lookups (`getNodeOutputShape`/`portShapeForHandle`) — share ONE
 * collapsed-group unwrap, one pair of node/edge indexes, and one result
 * cache per graph version, instead of paying a full recursive re-walk per
 * consumer.
 *
 * Keyed by ARRAY IDENTITY via WeakMap: the zustand store replaces both
 * arrays on every mutation (never mutates in place), so identity IS the
 * graph version, and WeakMap keeps retired graphs collectable.
 *
 * Time-dependent results get buckets: `0` (the static reads all card /
 * edge labels use) stays cached for the graph's lifetime; non-zero times
 * (the rAF-animated preview/edge-info consumers) get a tiny insertion-order
 * LRU of buckets (see TIME_BUCKETS_MAX) — equivalent cost to the old
 * per-call cache, but shared within a frame.
 *
 * Known limit (deliberate): in a CYCLIC graph — already pathological, and
 * warned about by topologicalSort — a cached value can depend on which node
 * the walk entered from, and the persistent cache pins the first entry's
 * answer for the graph version's lifetime. Pre-context behavior was also
 * entry-order-dependent (per call instead of per version); acyclic graphs,
 * the only supported shape, are unaffected.
 */
interface EvalCtx {
  /** Unwrapped edges (collapsed-group boundary edges resolved to real endpoints). */
  edges: AppEdge[];
  nodeIndex: Map<string, AppNode>;
  edgeIndex: Map<string, AppEdge[]>;
  /** `edgeIndex` minus the wires codegen resolves to NOTHING (`deadSplitWire`),
   *  which the shader reads as unwired, and every wire after a socket's FIRST —
   *  what `evaluate`/`computeRange` walk. `getTargetEdges` keeps the full index:
   *  such a socket is still drawn wired. */
  evalEdgeIndex: Map<string, AppEdge[]>;
  /** The same edges as a list: what the time/field/live sets walk, so a wire
   *  codegen ignores neither animates a constant nor turns it into a range. */
  evalEdges: AppEdge[];
  evalCache0: Map<string, EvalResult>;
  evalCachesT: Map<number, Map<string, EvalResult>>;
  rangeCache0: Map<string, RangeResult | null>;
  rangeCachesT: Map<number, Map<string, RangeResult | null>>;
  shapeCache: Map<string, number>;
  /** Lazy unwrapped-edge-by-id lookup (getUnwrappedEdge). */
  edgeById: Map<string, AppEdge> | null;
  /** Lazy "is this node fed by a Time node" set (getTimeUpstreamSet). */
  timeUpstream: Set<string> | null;
  /** Lazy "is this node fed by a sampled FIELD" set (getFieldUpstreamSet). */
  fieldUpstream: Set<string> | null;
  /** Lazy "does this node vary over the SURFACE" set (getSurfaceFieldUpstreamSet). */
  surfaceFieldUpstream: Set<string> | null;
}

/**
 * How many distinct non-zero times keep a live cache bucket per graph
 * version. Animated consumers (PreviewNode, MathPreviewNode, EdgeInfoCard)
 * each run their own clock, so their per-frame times differ — a single
 * rolling bucket would thrash between them within one frame. A tiny
 * insertion-order LRU gives each concurrent clock its own bucket while stale
 * times still age out.
 */
const TIME_BUCKETS_MAX = 4;

function timeBucket<V>(buckets: Map<number, Map<string, V>>, time: number): Map<string, V> {
  let cache = buckets.get(time);
  if (!cache) {
    if (buckets.size >= TIME_BUCKETS_MAX) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    cache = new Map();
    buckets.set(time, cache);
  }
  return cache;
}

const ctxByNodes = new WeakMap<AppNode[], WeakMap<AppEdge[], EvalCtx>>();

/**
 * Every drag pointermove replaces the store's arrays, which would discard the
 * ctx (indexes + all eval/range/shape caches) 60×/s and force selectors to
 * re-evaluate the whole graph per frame. Before building anew, re-register the
 * previous ctx when the graphs are semantically equal — evaluation reads node
 * `data` and edge endpoints only, never canvas position or selection, so the
 * caches stay exactly valid (the stale node objects the indexes hold share
 * their `data` references with the new array by construction of the check).
 */
let lastCtx: { nodes: AppNode[]; edges: AppEdge[]; ctx: EvalCtx } | null = null;

function getCtx(nodes: AppNode[], edges: AppEdge[]): EvalCtx {
  let byEdges = ctxByNodes.get(nodes);
  if (!byEdges) {
    byEdges = new WeakMap();
    ctxByNodes.set(nodes, byEdges);
  }
  let ctx = byEdges.get(edges);
  if (
    !ctx &&
    lastCtx &&
    sameGraphSemantics(lastCtx.nodes, nodes, lastCtx.edges, edges)
  ) {
    ctx = lastCtx.ctx;
    byEdges.set(edges, ctx);
  }
  if (!ctx) {
    const unwrapped = unwrapCollapsedGroupEdges(nodes, edges);
    const nodeIndex = buildNodeIndex(nodes);
    const edgeIndex = buildEdgeIndex(unwrapped);
    // A socket reads its FIRST wire, as graphToCode's `inEdge` does — and when
    // that one is dead the socket is unwired, never the next wire in the array.
    const firstIntoSocket = new Set<string>();
    const live = unwrapped.filter((e) => {
      if (typeof e.targetHandle === 'string') {
        const socket = `${e.target}\u0000${e.targetHandle}`;
        if (firstIntoSocket.has(socket)) return false;
        firstIntoSocket.add(socket);
      }
      return !deadSplitWire(e, nodeIndex, edgeIndex);
    });
    const evalEdgeIndex = live.length === unwrapped.length ? edgeIndex : buildEdgeIndex(live);
    if (evalEdgeIndex !== edgeIndex) FULL_EDGE_INDEX.set(evalEdgeIndex, edgeIndex);
    ctx = {
      edges: unwrapped,
      nodeIndex,
      edgeIndex,
      evalEdgeIndex,
      evalEdges: live,
      evalCache0: new Map(),
      evalCachesT: new Map(),
      rangeCache0: new Map(),
      rangeCachesT: new Map(),
      shapeCache: new Map(),
      edgeById: null,
      timeUpstream: null,
      fieldUpstream: null,
      surfaceFieldUpstream: null,
    };
    byEdges.set(edges, ctx);
    // Internal recursion (e.g. computeRange → evaluateNodeOutput) re-enters
    // the public API with the UNWRAPPED array — register the ctx under that
    // key too so the re-entry lands on the same context. (No collapsed
    // groups → unwrap returns the input array and this is a no-op.)
    if (unwrapped !== edges) byEdges.set(unwrapped, ctx);
  }
  lastCtx = { nodes, edges, ctx };
  return ctx;
}

function evalCacheFor(ctx: EvalCtx, time: number): Map<string, EvalResult> {
  if (time === 0) return ctx.evalCache0;
  return timeBucket(ctx.evalCachesT, time);
}

function rangeCacheFor(ctx: EvalCtx, time: number): Map<string, RangeResult | null> {
  if (time === 0) return ctx.rangeCache0;
  return timeBucket(ctx.rangeCachesT, time);
}

/**
 * Resolve an edge id to its UNWRAPPED edge — the logical connection with
 * collapsed-group boundary endpoints translated to their real producers.
 * Lets edge-level consumers (TypedEdge, EdgeInfoCard) evaluate the REAL
 * source, agreeing with what ShaderNode's cards derive via getTargetEdges —
 * a group id itself has no registry def and would read as 1-channel '…'.
 */
export function getUnwrappedEdge(nodes: AppNode[], edges: AppEdge[], edgeId: string): AppEdge | undefined {
  const ctx = getCtx(nodes, edges);
  if (!ctx.edgeById) {
    ctx.edgeById = new Map();
    for (const e of ctx.edges) ctx.edgeById.set(e.id, e);
  }
  return ctx.edgeById.get(edgeId);
}

/**
 * Edges arriving at `nodeId`, resolved against the shared ctx — O(1) per call
 * once the ctx exists for this graph version. NB these are the UNWRAPPED
 * edges: a collapsed-group boundary edge reports its REAL producer, matching
 * what the evaluator itself sees. Exposed for render-layer consumers
 * (ShaderNode) so per-node derivations don't scan the full edge array per
 * component per store notify.
 */
export function getTargetEdges(nodes: AppNode[], edges: AppEdge[], nodeId: string): AppEdge[] {
  return getCtx(nodes, edges).edgeIndex.get(nodeId) ?? [];
}

/**
 * The full UNWRAPPED edge array the evaluator itself walks — collapsed-group
 * boundary edges resolved to their real child endpoints — through the same
 * shared ctx, so it is O(1) per call once the ctx exists for this graph
 * version. Treat the result as READ-ONLY: it is the ctx's own array.
 *
 * Render-layer helpers that do their own graph walk (`hasTimeUpstream`) must be
 * handed THIS array, never the raw store one. `getTargetEdges` already reports
 * the REAL producer inside a collapsed frame, so continuing the walk through
 * raw edges drops every wire that crosses the frame's boundary: a Time node
 * feeding INTO a collapsed group becomes invisible and the card silently falls
 * back to its static branch.
 */
export function getUnwrappedEdges(nodes: AppNode[], edges: AppEdge[]): AppEdge[] {
  return getCtx(nodes, edges).edges;
}

/**
 * Every node fed by a Time node (Time nodes included): ONE forward BFS over the
 * UNWRAPPED edges, memoized on the ctx. Use it instead of `hasTimeUpstream` in
 * anything that runs per notify or per frame (measurements: buildTimeUpstreamSet).
 */
export function getTimeUpstreamSet(nodes: AppNode[], edges: AppEdge[]): ReadonlySet<string> {
  const ctx = getCtx(nodes, edges);
  if (!ctx.timeUpstream) ctx.timeUpstream = buildTimeUpstreamSet(nodes, ctx.evalEdges);
  return ctx.timeUpstream;
}

/**
 * Every node fed by a value with no single CPU sample — a sampled FIELD, a live
 * uniform (Sound) or an unbounded source (world space, the camera) — fields
 * included, memoized on the ctx and seeded by `analyticalRange` so the two
 * cannot drift. Such a node's evaluated value is ONE sample, never a bound:
 * labels must take the interval path (docs/dev/codegen.md, "A SAMPLED FIELD's
 * value is not its range"). For "varies over the SURFACE" ask
 * getSurfaceFieldUpstreamSet.
 */
export function getFieldUpstreamSet(nodes: AppNode[], edges: AppEdge[]): ReadonlySet<string> {
  const ctx = getCtx(nodes, edges);
  if (!ctx.fieldUpstream) {
    ctx.fieldUpstream = buildDownstreamClosure(nodes, ctx.evalEdges, (n) => analyticalRange(n) !== null);
  }
  return ctx.fieldUpstream;
}

/** Field seeds that are ONE value per frame across the whole surface — uniforms
 *  — so a range on a label, never a coordinate on the surface. */
const UNIFORM_FIELD_TYPES: ReadonlySet<string> = new Set([
  'soundNode', 'cameraPosition', 'cameraNear', 'cameraFar',
]);

/**
 * getFieldUpstreamSet without the uniform seeds: every node whose value VARIES
 * OVER THE SURFACE. The question an Image's UV hand-off asks (imageUvHandoff) —
 * a vec2 built from Sound or camera values is one point, and sampling a picture
 * there painted the whole mesh one flickering colour.
 */
export function getSurfaceFieldUpstreamSet(nodes: AppNode[], edges: AppEdge[]): ReadonlySet<string> {
  const ctx = getCtx(nodes, edges);
  if (!ctx.surfaceFieldUpstream) {
    ctx.surfaceFieldUpstream = buildDownstreamClosure(nodes, ctx.evalEdges, (n) =>
      !UNIFORM_FIELD_TYPES.has(n.data.registryType) && analyticalRange(n) !== null);
  }
  return ctx.surfaceFieldUpstream;
}

/** Evaluate the output of a specific node, given the current time. */
export function evaluateNodeOutput(
  nodeId: string,
  nodes: AppNode[],
  edges: AppEdge[],
  time: number,
): EvalResult {
  const ctx = getCtx(nodes, edges);
  const cache = evalCacheFor(ctx, time);
  try {
    return evaluate(nodeId, time, cache, ctx.evalEdgeIndex, ctx.nodeIndex);
  } catch (e) {
    // The cache is persistent per graph version — an exception mid-walk would
    // otherwise leave cycle-guard sentinels behind as poisoned nulls.
    cache.clear();
    throw e;
  }
}

/** Channel count for a concrete TSL data type (1=float/int, 2=vec2, 3=vec3/color, 4=vec4). */
export function shapeOfDataType(dt: TSLDataType): number {
  if (dt === 'vec4') return 4;
  if (dt === 'vec3' || dt === 'color') return 3;
  if (dt === 'vec2') return 2;
  if (dt === 'float' || dt === 'int') return 1;
  return 0; // 'any' — caller must infer from context
}

/**
 * Static channel-shape inference for a node's output (1–4). Used as a fallback when the
 * CPU evaluator can't produce a real value (e.g., procedural textures, positionGeometry,
 * or any chain downstream of one). Walks the graph following type-broadcast rules:
 *  - Concrete output port type → that type's channel count
 *  - 'any' output → for `append` sum input shapes; for everything else take max of input shapes
 *  - No connected inputs → 1 (scalar default)
 *
 * This is the visualization-layer counterpart to evaluateNodeOutput. The two should agree
 * on shape when both can produce a result; this function is the only authority when eval
 * returns null.
 */
export function getNodeOutputShape(
  nodeId: string,
  nodes: AppNode[],
  edges: AppEdge[],
): number {
  // Only this TOP-LEVEL answer is cached: computeShape recurses on itself, and
  // a shape computed under a cycle short-circuit depends on the entry point.
  const ctx = getCtx(nodes, edges);
  const hit = ctx.shapeCache.get(nodeId);
  if (hit !== undefined) return hit;
  const result = computeShape(nodeId, new Set(), ctx.nodeIndex, ctx.edgeIndex);
  ctx.shapeCache.set(nodeId, result);
  return result;
}

/**
 * A node's output width. The cycle guard is the CURRENT path, popped on return,
 * and a node met again on another path answers from `memo`: one walk-wide
 * `visited` read every node the second time it was met as a scalar — an Append
 * fed by a node reached first through a growth socket emitted the wrong width.
 */
function computeShape(
  nodeId: string,
  visited: Set<string>,
  nidx: Map<string, AppNode>,
  edgeIndex: Map<string, AppEdge[]>,
  memo: Map<string, number> = new Map(),
): number {
  const known = memo.get(nodeId);
  if (known !== undefined) return known;
  if (visited.has(nodeId)) return 1; // a cycle on the current path
  visited.add(nodeId);
  const shape = nodeShape(nodeId, visited, nidx, edgeIndex, memo);
  visited.delete(nodeId);
  memo.set(nodeId, shape);
  return shape;
}

/** The ports whose width is the result's — three types Mod by its FIRST operand
 *  (OperatorNode '%') and Select by its two branches (ConditionalNode); the
 *  divisor and the condition never widen it (a scalar Mod read as a vec3 skipped
 *  the Output's vec3() wrap and leaked into alpha). */
const WIDTH_PORTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['mod', new Set(['x'])],
  ['select', new Set(['a', 'b'])],
]);

function nodeShape(
  nodeId: string,
  visited: Set<string>,
  nidx: Map<string, AppNode>,
  edgeIndex: Map<string, AppEdge[]>,
  memo: Map<string, number>,
): number {
  const node = nidx.get(nodeId);
  if (!node) return 1;
  const def = NODE_REGISTRY.get(node.data.registryType);
  if (!def) return 1;

  // 1. Concrete output port type wins immediately.
  const outPort = def.outputs.find((o) => o.id === 'out') ?? def.outputs[0];
  if (outPort) {
    const concrete = shapeOfDataType(outPort.dataType);
    if (concrete > 0) return concrete;
  }

  const targetEdges = edgeIndex.get(nodeId) ?? [];

  // 2. 'any' output — infer from inputs.
  // Append concatenates: total = sum of ALL its operand shapes (it grows past
  // a/b), clamped to [2, 4] — the vec4 ceiling graphToCode also emits under.
  if (def.type === 'append') {
    let total = 0;
    for (const inp of appendOperands(nodeId, nidx, edgeIndex)) {
      const e = targetEdges.find((edge) => edge.targetHandle === inp.id);
      if (!e) {
        total += 1;
        continue;
      }
      // Width per SOURCE SOCKET (graphToCode's `appendOperandChannels` rule): a
      // node-level width overstates toHsl's h/s/l and dataviz's `value`.
      // 0 = an `any` port or unknown handle, so infer from the whole node.
      const src = nidx.get(e.source);
      const declared = src && e.sourceHandle ? portShapeForHandle(src, e.sourceHandle) : 0;
      total += declared > 0
        ? declared
        : computeShape(e.source, visited, nidx, edgeIndex, memo);
    }
    return Math.min(Math.max(total, 2), 4);
  }

  // 3. Default broadcast: output shape = max of all connected input shapes (vec3 + scalar = vec3),
  // over the EFFECTIVE operands — a chain's growth sockets (c, d, …) too, or a vector wired
  // there read as a scalar and an Append after it emitted a constructor too short.
  let maxShape = 1;
  const widthPorts = WIDTH_PORTS.get(def.type);
  for (const input of appendOperands(nodeId, nidx, edgeIndex)) {
    if (widthPorts && !widthPorts.has(input.id)) continue;
    const e = targetEdges.find((edge) => edge.targetHandle === input.id);
    if (e) {
      // Per SOURCE SOCKET, as in the append branch (pinned by socketWidthPins.test.ts).
      const src = nidx.get(e.source);
      const declared = src && e.sourceHandle ? portShapeForHandle(src, e.sourceHandle) : 0;
      const s = declared > 0
        ? declared
        : computeShape(e.source, visited, nidx, edgeIndex, memo);
      if (s > maxShape) maxShape = s;
    }
  }
  return maxShape;
}

// ── Per-SOURCE-HANDLE projection ─────────────────────────────────────────────
// `evaluate` is keyed by node id and returns the WHOLE vector; the socket is
// applied at the CONSUMER. A per-handle cache key would hand a cycle its own
// sentinel and recurse until the stack blows (docs/dev/codegen.md, "Edge VALUES
// are read per SOURCE SOCKET").

/** Which channel of the source node's vector this output handle carries, or
 *  null for "the whole vector" (`out`, an unknown handle, a tampered id).
 *  Internal projections go through `handleChannels`, which adds the Texture
 *  node's RUNS; this stays for single-channel callers. */
export function handleSlice(
  node: AppNode | undefined,
  handle: string | null | undefined,
): number | null {
  if (!node || !handle || handle === 'out') return null;
  const type = node.data.registryType;
  if (type === 'toHsl') {
    return TOHSL_HANDLE_INDEX.get(handle) ?? null;
  }
  if (type === 'split') {
    return SPLIT_HANDLE_INDEX.get(handle) ?? null;
  }
  return null;
}

/** h/s/l → 0/1/2. MUST agree with graphToCode's TOHSL_HANDLE_TO_COMPONENT
 *  (h→x, s→y, l→z) or the CPU preview and the shader disagree — pinned by a
 *  parity test, because swapping S and L here is invisible by inspection. */
const TOHSL_HANDLE_INDEX = new Map<string, number>([['h', 0], ['s', 1], ['l', 2]]);
const SPLIT_HANDLE_INDEX = new Map<string, number>([['x', 0], ['y', 1], ['z', 2], ['w', 3]]);

/** Sources whose output sockets are NOT the bare variable, so a Split fed by one
 *  must read per SOURCE SOCKET (resolveEdgeRef's split branch): members of ONE
 *  emitted call (Fresnel, Color Ramp, toHsl, the Texture node's channels in wide
 *  mode) or variables of their own (Sound's `sound1_bass`, Data Viz's `value`
 *  `_dataviz1_t`, the Data node's `data1_col0`). Without the entry the Split read
 *  the bare name: Image Alpha → Split.x was red, Data Viz Value → Split.x the
 *  ramp's red, and Sound/Data → Split named a variable nothing declares. A
 *  source whose socket IS the bare name (every `out`, a narrow image) still
 *  emits `<bare>.<comp>`, byte-identical. Lives HERE, beside the evaluator's
 *  twin of that branch (`splitReadsScalarSocket`), and graphToCode imports it. */
export const SPLIT_SOCKET_AWARE: ReadonlySet<string> = new Set([
  'fresnel', 'colorRamp', 'toHsl', 'imageNode', 'soundNode', 'dataviz', 'dataNode',
]);

/** Does a Split fed from this socket see ONE scalar socket rather than the
 *  source's bare variable? Then its .x is that socket and .y/.z/.w are null in
 *  codegen (the consumer reads them as unwired). */
function splitReadsScalarSocket(src: AppNode | undefined, handle: string | null | undefined): boolean {
  return !!src && SPLIT_SOCKET_AWARE.has(src.data.registryType) && portShapeForHandle(src, handle ?? 'out') === 1;
}

/** Nodes graphToCode gives NO variable (its declaration walks skip them), so a
 *  wire that names one resolves to nothing. */
function hasOwnVariable(node: AppNode): boolean {
  const type = node.data.registryType;
  return NODE_REGISTRY.has(type) && type !== 'output' && type !== 'split';
}

/**
 * Does codegen resolve this wire to NOTHING, so the consumer emits its own
 * unwired default? Only a wire leaving a Split can: Split has no variable of
 * its own and graphToCode inlines `<upstream>.<component>` (resolveEdgeRef), so
 * a Split with nothing in `v`, one fed by a node without a variable (another
 * Split), a non-swizzle socket, and .y/.z/.w of a scalar socket all resolve to
 * null. The evaluator reads such a socket as unwired too — otherwise a dangling
 * Split.y into Multiply showed a guess where the shader multiplies by 1.
 */
function deadSplitWire(
  e: Pick<AppEdge, 'source' | 'sourceHandle'>,
  nodeIndex: Map<string, AppNode>,
  edgeIndex: Map<string, AppEdge[]>,
): boolean {
  const split = nodeIndex.get(e.source);
  if (split?.data.registryType !== 'split') return false;
  const h = e.sourceHandle;
  if (!h || !SPLIT_HANDLE_INDEX.has(h)) return true;
  const input = (edgeIndex.get(split.id) ?? []).find((x) => x.targetHandle === 'v');
  const src = input ? nodeIndex.get(input.source) : undefined;
  if (!input || !src || !hasOwnVariable(src)) return true;
  return h !== 'x' && splitReadsScalarSocket(src, input.sourceHandle);
}

/** What one output socket carries out of its node's WHOLE vector: one
 *  channel (an index), a contiguous run [from, to), or null (all of it). A
 *  run exists for the Texture node, whose whole vector is the rgba SAMPLE
 *  while `out` is its first three; an index alone would leave EdgeInfoCard
 *  (count = max(rangeLen, shapeLen)) drawing four channel cards on a vec3 wire. */
export type HandleChannels = number | { readonly from: number; readonly to: number } | null;

const IMAGE_RGB_RUN = { from: 0, to: 3 } as const;

/** handleSlice, plus the Texture node's runs. The ONE projection every
 *  internal consumer uses; handleSlice stays for its single-channel callers.
 *  On an Image node `out`, null and every tampered id carry the RGB run — the
 *  socket table (`utils/imageChannels.ts`) is a Map, so `__proto__` /
 *  `constructor` resolve to nothing and fall through to the run. */
export function handleChannels(
  node: AppNode | undefined,
  handle: string | null | undefined,
): HandleChannels {
  if (node?.data.registryType === 'imageNode') {
    return (typeof handle === 'string' ? IMAGE_CHANNEL_INDEX.get(handle) : undefined) ?? IMAGE_RGB_RUN;
  }
  // Fresnel's whole vector is [Fresnel, Facing] (the helper's vec2); `out`,
  // null and every tampered id read Fresnel — graphToCode's `?? 'x'`.
  if (node?.data.registryType === 'fresnel') return handle === 'facing' ? 1 : 0;
  // Color Ramp's whole vector is the rgba sample; `out`, null and every
  // tampered id carry its RGB — graphToCode's `?? 'rgb'`.
  if (node?.data.registryType === 'colorRamp') return handle === 'alpha' ? 3 : IMAGE_RGB_RUN;
  // Data Viz's whole vector (its range) is [r, g, b, t]: `value` is the
  // tone-mapped t (resolveEdgeRef's `_<var>_t`), every other handle the colour.
  if (node?.data.registryType === 'dataviz') return handle === 'value' ? 3 : IMAGE_RGB_RUN;
  // The Data node's whole vector is one channel per COLUMN; `colN` is column N.
  // Any other handle names no declared variable: unknown, never the min…max of
  // every column at once.
  if (node?.data.registryType === 'dataNode') {
    const m = typeof handle === 'string' ? /^col(\d+)$/.exec(handle) : null;
    return m ? Number(m[1]) : NO_CHANNEL;
  }
  // Sound's whole vector is [level, bass, mid, treble]; a null or tampered
  // handle reads `level`, as the emitter's `soundChannelForHandle` does.
  if (node?.data.registryType === 'soundNode') return SOUND_CHANNELS.indexOf(soundChannelForHandle(handle));
  return handleSlice(node, handle);
}

/** A channel index past every vector: slices to null (unknown). */
const NO_CHANNEL = Number.POSITIVE_INFINITY;

/** Project one channel — or one run — out of an evaluated vector. A slice past
 *  the end yields null (unknown) rather than a fabricated 0. */
function sliceEval(res: EvalResult, s: HandleChannels): EvalResult {
  if (res === null || s === null) return res;
  if (typeof s === 'number') return s < res.length ? [res[s]] : null;
  return s.to <= res.length ? res.slice(s.from, s.to) : null;
}

/** Project one channel — or one run — out of an inferred range. Never
 *  re-derives the range — the signed-noise convention depends on the interval
 *  it was given. */
function sliceRange(r: RangeResult | null, s: HandleChannels): RangeResult | null {
  if (r === null || s === null) return r;
  if (typeof s === 'number') {
    if (s >= r.min.length || s >= r.max.length) return null;
    return { min: [r.min[s]], max: [r.max[s]] };
  }
  return s.to <= r.min.length && s.to <= r.max.length
    ? { min: r.min.slice(s.from, s.to), max: r.max.slice(s.from, s.to) }
    : null;
}

/** The value arriving along `edge` — the source node evaluated, then projected
 *  onto the socket the edge actually leaves from. */
export function evaluateEdgeSource(
  edge: Pick<AppEdge, 'source' | 'sourceHandle'>,
  nodes: AppNode[],
  edges: AppEdge[],
  time: number,
): EvalResult {
  // A wire codegen resolves to nothing carries nothing — a tampered Split
  // handle ('out', null) would otherwise read the whole padded vector.
  const ctx = getCtx(nodes, edges);
  if (deadSplitWire(edge, ctx.nodeIndex, ctx.edgeIndex)) return null;
  const res = evaluateNodeOutput(edge.source, nodes, edges, time);
  return sliceEval(res, handleChannels(ctx.nodeIndex.get(edge.source), edge.sourceHandle));
}

/** Inferred range for the value arriving along `edge` (same projection). */
export function evaluateEdgeRange(
  edge: Pick<AppEdge, 'source' | 'sourceHandle'>,
  nodes: AppNode[],
  edges: AppEdge[],
  time: number,
): RangeResult | null {
  const ctx = getCtx(nodes, edges);
  if (deadSplitWire(edge, ctx.nodeIndex, ctx.edgeIndex)) return null;
  const r = evaluateNodeRange(edge.source, nodes, edges, time);
  return sliceRange(r, handleChannels(ctx.nodeIndex.get(edge.source), edge.sourceHandle));
}

/**
 * Channel count carried by `edge` — the DECLARED port type of the socket it
 * leaves, falling back to whole-node inference. Necessary even though h/s/l are
 * declared `float`: `computeShape` resolves `outputs.find(id === 'out') ??
 * outputs[0]`, so every socket of a node that HAS an `out` port reports the
 * vec3 width (the live Data Viz `value` bug verbatim).
 */
export function getEdgeOutputShape(
  edge: Pick<AppEdge, 'source' | 'sourceHandle'>,
  nodes: AppNode[],
  edges: AppEdge[],
): number {
  const node = getCtx(nodes, edges).nodeIndex.get(edge.source);
  if (node && edge.sourceHandle) {
    const shape = portShapeForHandle(node, edge.sourceHandle);
    if (shape > 0) return shape;
  }
  return getNodeOutputShape(edge.source, nodes, edges);
}

/**
 * Declared channel width of one OUTPUT PORT — per-instance `dynamicOutputs`
 * (the Data node's CSV columns) first, then the registry port. 0 = unresolved,
 * so callers can fall back to whole-node inference. Shared with graphToCode's
 * `shapeOfEdgeSource` so codegen and the visual layer cannot drift.
 */
export function portShapeForHandle(
  node: AppNode,
  handle: string,
  registry: Map<string, NodeDefinition> = NODE_REGISTRY,
): number {
  const dyn = (node.data as { dynamicOutputs?: unknown }).dynamicOutputs;
  // The restore gate (graphShape `isUsableDataPort`) already refuses a
  // malformed list, and nothing in-session mints one — but this runs inside
  // TypedEdge's store selector on every render, where a throw unmounts the
  // whole app, so a path that ever skips the gate must not reach `.find` on a
  // non-array or `.id` on a null entry.
  const dynPort = Array.isArray(dyn)
    ? (dyn as ({ id?: unknown; dataType?: unknown } | null | undefined)[]).find(
        (o) => o != null && o.id === handle,
      )
    : undefined;
  if (dynPort) return shapeOfDataType(dynPort.dataType as TSLDataType);
  const def = registry.get(node.data.registryType);
  const port = def?.outputs.find((o) => o.id === handle);
  return port ? shapeOfDataType(port.dataType) : 0;
}

// Index edges by target node ID for O(1) lookup
function buildEdgeIndex(edges: AppEdge[]): Map<string, AppEdge[]> {
  const index = new Map<string, AppEdge[]>();
  for (const e of edges) {
    let list = index.get(e.target);
    if (!list) { list = []; index.set(e.target, list); }
    list.push(e);
  }
  return index;
}

// Index nodes by ID — lets the recursive evaluator avoid O(N) scans per step.
function buildNodeIndex(nodes: AppNode[]): Map<string, AppNode> {
  const index = new Map<string, AppNode>();
  for (const n of nodes) index.set(n.id, n);
  return index;
}

/**
 * THE rule for an UNWIRED socket, read exactly as codegen's resolveArguments
 * emits it: the stored value when it is a finite number, else `fallback` (the
 * registry default codegen emits in its place) — so junk in a `.fastshader`
 * shows the card, the edge values and the range the shader actually runs. A
 * WIRED socket never reaches this: its upstream value or range is
 * authoritative, unknown included. Every unwired read goes through it —
 * `scalarInput`, `channelInput`, `finiteScalar`, `socketChannels` and the
 * range's `portRange`/`socketRange`; the bare `Number()` read they replaced
 * turned a junk entry into NaN where the shader runs the default.
 */
function unwiredValue(stored: unknown, fallback: number): number {
  const v = valueNum(stored);
  return Number.isFinite(v) ? v : fallback;
}

function evaluate(
  nodeId: string,
  time: number,
  cache: Map<string, EvalResult>,
  idx: Map<string, AppEdge[]>,
  nidx: Map<string, AppNode>,
): EvalResult {
  if (cache.has(nodeId)) return cache.get(nodeId)!;

  // Cycle guard: write a sentinel BEFORE recursing so any cyclic path back to
  // this node short-circuits to null instead of recursing forever. The real
  // result overwrites the sentinel at the end of this function.
  cache.set(nodeId, null);

  const node = nidx.get(nodeId);
  if (!node) return null;

  const type = node.data.registryType;
  const def = NODE_REGISTRY.get(type);
  const values = getNodeValues(node);

  const nodeEdges = idx.get(nodeId) ?? [];

  // Set when a WIRED socket's upstream has no finite value: the shader reads
  // that wire, never the stored number behind it, so the node's own value is
  // unknown too (null at the end, whatever the case computed). Reading the
  // stored value instead printed a live constant — Mix's inline t = 0.5 under
  // a Position (world) factor, HSL red under a Data column — that the shader
  // never uses.
  let wiredUnknown = false;

  // Resolve a single scalar input from edges or inline values
  const scalarInput = (portId: string, fallback: number): number => {
    const edge = nodeEdges.find((e) => e.targetHandle === portId);
    if (edge) {
      // Projected onto the socket the edge LEAVES (see handleChannels): a wire
      // from toHsl's Saturation must contribute S, not channel 0's Hue.
      const upstream = sliceEval(
        evaluate(edge.source, time, cache, idx, nidx),
        handleChannels(nidx.get(edge.source), edge.sourceHandle),
      );
      const u = upstream?.[0];
      if (u !== undefined && Number.isFinite(u)) return u;
      wiredUnknown = true;
      return NaN;
    }
    return unwiredValue(values[portId], fallback);
  };

  // A scalar input read exactly as codegen's resolveArguments reads it: wired →
  // the upstream channel when finite, else null (unknown); unwired → `unwiredValue`.
  const finiteScalar = (portId: string, fallback: number): number | null => {
    const edge = nodeEdges.find((e) => e.targetHandle === portId);
    if (edge) {
      const upstream = sliceEval(
        evaluate(edge.source, time, cache, idx, nidx),
        handleChannels(nidx.get(edge.source), edge.sourceHandle),
      );
      const u = upstream?.[0];
      return u !== undefined && Number.isFinite(u) ? u : null;
    }
    return unwiredValue(values[portId], fallback);
  };

  // Resolve a multi-channel input. If an edge exists, the upstream result is authoritative
  // (including null) — we do NOT fall back to the inline value, because that would mask the
  // upstream node and produce a fake scalar that the visualization layer would believe.
  const channelInput = (portId: string, fallback: number): EvalResult => {
    const edge = nodeEdges.find((e) => e.targetHandle === portId);
    if (edge) {
      return sliceEval(
        evaluate(edge.source, time, cache, idx, nidx),
        handleChannels(nidx.get(edge.source), edge.sourceHandle),
      );
    }
    return [unwiredValue(values[portId], fallback)];
  };

  // `channelInput` read exactly as codegen reads the socket: wired → the upstream
  // channels (authoritative, null included); unwired → `unwiredValue`.
  const socketChannels = (portId: string, fallback: number): EvalResult =>
    nodeEdges.some((e) => e.targetHandle === portId)
      ? channelInput(portId, fallback)
      : [unwiredValue(values[portId], fallback)];

  // A vec3 INPUT SOCKET, read as the emitted SDF helpers read one: `vec3(v)`
  // in the helper, so an unwired scalar default BROADCASTS (`vec3(0.5)` is a
  // box, not a flat sheet) and a short wired vector pads with 0 — three's
  // format() writes `vec3(v, 0.0)` (docs/dev/sdf-and-raymarch.md). A wired
  // socket with no finite value makes the node unknown, as in scalarInput.
  const vec3Input = (portId: string, fallback: number): [number, number, number] => {
    const v = channelInput(portId, fallback);
    if (!v || v.length === 0 || !v.every(Number.isFinite)) {
      if (nodeEdges.some((e) => e.targetHandle === portId)) wiredUnknown = true;
      return [fallback, fallback, fallback];
    }
    return toTslWidth(v, 3) as [number, number, number];
  };

  // The SDF Position socket as the helpers read it: every swizzle (`.x`, `.xz`)
  // and vec3 conversion splats a scalar and pads a vec2's z with 0 (three's
  // SplitNode / format). Reading a typed 0.5 as (0.5, 0, 0) put a Torus's label
  // inside where the shader drew outside. Null when a wired position has none.
  const position = (): [number, number, number] | null => {
    const p = channelInput('p', 0);
    return p && p.length > 0 ? (toTslWidth(p, 3) as [number, number, number]) : null;
  };

  // Apply a unary function component-wise
  const unaryOp = (portId: string, fallback: number, fn: (x: number) => number): EvalResult => {
    const inp = channelInput(portId, fallback);
    if (!inp) return null;
    return inp.map(fn);
  };

  // Apply a binary function component-wise at the WIDER operand's width, the
  // narrower one converted as TSL converts it (toTslWidth) — `width` overrides
  // that for the ops whose result takes the FIRST operand's type (mod).
  const binaryOp = (
    portA: string, fallA: number,
    portB: string, fallB: number,
    fn: (a: number, b: number) => number,
    width?: (a: number[], b: number[]) => number,
  ): EvalResult => {
    const a = channelInput(portA, fallA);
    const b = channelInput(portB, fallB);
    if (!a || !b || a.length === 0 || b.length === 0) return null;
    const len = width ? width(a, b) : Math.max(a.length, b.length);
    const aw = toTslWidth(a, len), bw = toTslWidth(b, len);
    return aw.map((av, i) => fn(av, bw[i]));
  };

  // Variadic fold over a chainable node's effective operands (add/sub/mul/div,
  // which grow past a/b). Unconnected operands contribute `identity`; each step
  // takes the wider width (OperatorNode) with the narrower operand converted by
  // toTslWidth; left-folds to match TSL's a op b op c … .
  const naryOp = (identity: number, fn: (a: number, b: number) => number): EvalResult => {
    const ports = def ? effectiveInputs(def, connectedHandles(nodeId, idx), false, Object.keys(values)) : [];
    let acc: number[] | null = null;
    for (const port of ports) {
      const inp = channelInput(port.id, identity);
      if (!inp || inp.length === 0) return null;
      if (acc === null) { acc = inp.slice(); continue; }
      const len = Math.max(acc.length, inp.length);
      const a = toTslWidth(acc, len), b = toTslWidth(inp, len);
      acc = a.map((av, i) => fn(av, b[i]));
    }
    return acc;
  };

  // The value a constant node EMITS (graphToCode's zero-input branch): the
  // stored number when finite, else the registry default — never the 0 or NaN
  // a bare Number() read gave a missing or junk `value`.
  const emittedConstant = (): number => {
    const dflt = Number(def?.defaultValues?.value ?? 0);
    const n = valueNum(values.value ?? dflt);
    return Number.isFinite(n) ? n : dflt;
  };

  // An UNWIRED socket exactly as resolveArguments emits it: the stored value
  // when finite, else the registry default, else the chain identity, else 0.
  const unwiredArg = (portId: string): number => {
    const stored = valueNum(values[portId]);
    if (Number.isFinite(stored)) return stored;
    const dflt = Number(def?.defaultValues?.[portId]);
    if (Number.isFinite(dflt)) return dflt;
    if (def?.chainable && def.chainIdentity !== undefined) return Number(def.chainIdentity);
    return 0;
  };

  const isWired = (portId: string): boolean => nodeEdges.some((e) => e.targetHandle === portId);

  // The width a socket's value has in the shader when it cannot be evaluated:
  // the declared width of the socket the wire leaves, else the source's
  // inferred shape; an unwired socket is a scalar.
  const staticWidth = (portId: string): number => {
    const edge = nodeEdges.find((e) => e.targetHandle === portId);
    if (!edge) return 1;
    const src = nidx.get(edge.source);
    const declared = src && edge.sourceHandle ? portShapeForHandle(src, edge.sourceHandle) : 0;
    return declared > 0 ? declared : computeShape(edge.source, new Set(), nidx, idx);
  };

  let result: EvalResult = null;

  switch (type) {
    // Inputs
    case 'time': {
      // `speed` is adversarial (untrusted .fastshader / tampered localStorage)
      // and absent on every graph saved before the field existed: a missing
      // key, a string, NaN and ±Infinity must all read as 1x. scalarInput
      // prefers a wired `speed` edge over the stored value, matching codegen.
      const s = scalarInput('speed', 1);
      result = [time * (Number.isFinite(s) ? s : 1)];
      break;
    }
    case 'soundNode':
      // Silence on every channel [level, bass, mid, treble] — the value until
      // a capture is armed (the 3D preview and a downloaded shader really are 0
      // until then). The node is a RANGE source (analyticalRange: 0…1 × gain),
      // so a label never shows this point as the wire's value.
      result = [0, 0, 0, 0];
      break;
    case 'float':
    case 'property_float':
    case 'slider':
      result = [emittedConstant()];
      break;
    case 'int':
      // graphToCode emits the Int WHOLE (`int(2)` for a stored 2.4), as
      // NodeBuilder.generateConst would round it, and within ±INT32_MAX; the
      // Int card commits whole numbers since 2026-10-27, so only an older or
      // hand-edited file differs.
      result = [intLiteral(emittedConstant())];
      break;
    case 'screenUV':
      result = [0.5, 0.5]; // center of screen as default
      break;
    case 'uv': {
      // Channel doesn't affect CPU evaluation (always UV center)
      let u = 0.5, v = 0.5;
      // Apply tiling
      u *= scalarInput('tilingU', 1);
      v *= scalarInput('tilingV', 1);
      // Apply rotation around (0.5, 0.5)
      const rot = scalarInput('rotation', 0);
      if (rot !== 0) {
        const cu = u - 0.5, cv = v - 0.5;
        const cosR = Math.cos(rot), sinR = Math.sin(rot);
        u = cu * cosR - cv * sinR + 0.5;
        v = cu * sinR + cv * cosR + 0.5;
      }
      result = [u, v];
      break;
    }

    // Type constructors — TSL's JoinNode, which the emitted `vecN(x, y, …)`
    // is: every argument contributes ALL its channels in order and the list is
    // cut at N (`vec3(uv, 0.25, 0.5)` holds (u, v, 0.25)). Reading each socket
    // as one scalar showed (u, 0.25, 0.5) — `append` already concatenates.
    case 'vec2':
    case 'vec3':
    case 'vec4': {
      const width = type === 'vec2' ? 2 : type === 'vec3' ? 3 : 4;
      const parts: number[] = [];
      for (const inp of def!.inputs) {
        if (parts.length >= width) break;
        const v = isWired(inp.id) ? channelInput(inp.id, 0) : [unwiredArg(inp.id)];
        if (!v || v.length === 0) {
          wiredUnknown = true;
          break;
        }
        parts.push(...v);
      }
      result = parts.length >= width ? parts.slice(0, width) : null;
      break;
    }
    case 'color':
    case 'property_color': {
      // LINEAR light, as the shader holds it: `color(0x…)` goes through
      // THREE.Color, which converts sRGB to linear while ColorManagement is on
      // (three's default since r152, and A-Frame's) — #808080 is 0.216, not
      // 0.5. Showing hex/255 put every Colour wire ~2× too bright in the mid
      // tones. A hex that is not `#rrggbb` emits black (hexLiteral); a missing
      // one is the registry default on Color and black on Property (colour).
      const stored = values.hex ?? (type === 'color' ? def?.defaultValues?.hex : undefined);
      const hex = valueStr(stored ?? '');
      result = HEX6.test(hex) ? hexToRgb01(hex).map(srgbToLinear01) : [0, 0, 0];
      break;
    }

    // Arithmetic (component-wise, broadcast, variadic — chainable operands)
    case 'add': result = naryOp(0, (a, b) => a + b); break;
    case 'sub': result = naryOp(0, (a, b) => a - b); break;
    case 'mul': result = naryOp(1, (a, b) => a * b); break;
    // IEEE, as the GPU divides: x/0 is ±∞ and 0/0 NaN, both '…' on a label —
    // the old safe-divide showed a confident 0 for a wire that is infinite. An
    // all-INT division stays integer in the shader (engine/intPromotion.ts):
    // truncated toward 0. By 0 it has no value: three inlines Int literals, so
    // WebGPU rejects the constant division and WebGL folds it to INT_MAX.
    case 'div':
      result = isIntNode(nodeId, nidx, idx)
        ? naryOp(1, (a, b) => (b === 0 ? NaN : Math.trunc(a / b)))
        : naryOp(1, (a, b) => a / b);
      break;

    // Unary math (component-wise). Outside its domain the GPU has no number
    // (NaN; GLSL undefined, WGSL indeterminate, log2(0) is −∞), so neither does
    // the card: sqrt(−1) is '…', never the clamped 0 or log2's floored −33.22.
    case 'sin': result = unaryOp('x', 0, Math.sin); break;
    case 'cos': result = unaryOp('x', 0, Math.cos); break;
    case 'abs': result = unaryOp('x', 0, Math.abs); break;
    case 'sqrt': result = unaryOp('x', 0, Math.sqrt); break;
    case 'exp': result = unaryOp('x', 0, Math.exp); break;
    case 'log2': result = unaryOp('x', 1, Math.log2); break;
    case 'floor': result = unaryOp('x', 0, Math.floor); break;
    case 'round': result = unaryOp('x', 0, roundHalfEven); break;
    case 'fract': result = unaryOp('x', 0, (v) => v - Math.floor(v)); break;
    case 'oneMinus': result = unaryOp('x', 0, (v) => 1 - v); break;

    // Binary math
    // WGSL defines pow through exp2(e·log2(b)): a negative base, or 0 to a power
    // ≤ 0, has no value (a shader-creation error when constant) — NaN, never
    // Math.pow's (−2)² = 4.
    case 'pow': result = binaryOp('base', 1, 'exp', 1, (b, e) => (b < 0 || (b === 0 && e <= 0) ? NaN : Math.pow(b, e))); break;
    // FLOORED, as three emits it on both backends (GLSL `mod`, WGSL's
    // tsl_mod polyfill: x − y·floor(x/y)): JS `%` truncates, so −0.3 mod 1 read
    // −0.3 where the shader holds 0.7. y = 0 is NaN there as here. The result
    // has the FIRST operand's width (OperatorNode '%' returns typeA).
    case 'mod':
      // An all-INT mod is the native `%` (OperatorNode). By 0, or with a
      // negative operand, it has no one value: WGSL truncates (the sign of x),
      // GLSL ES leaves it undefined and ANGLE folds it to 0.
      result = isIntNode(nodeId, nidx, idx)
        ? binaryOp('x', 0, 'y', 1, (a, b) => (b === 0 || a < 0 || b < 0 ? NaN : a % b), (a) => a.length)
        : binaryOp('x', 0, 'y', 1, (a, b) => a - b * Math.floor(a / b), (a) => a.length);
      break;
    // Unwired second operand falls back to the op's IDENTITY, not 0: min(a, 0)=0
    // would silently zero any non-negative input. 1 is min's identity over [0,1];
    // 0 is already max's (max(a,0)=ReLU). Matches the registry defaultValues.
    case 'min': result = binaryOp('a', 1, 'b', 1, Math.min); break;
    case 'max': result = binaryOp('a', 0, 'b', 0, Math.max); break;
    case 'clamp': {
      // MathNode: all three operands at the WIDEST width (toTslWidth), so a
      // vec2 Max bounds x and y by its own channels — reading channel 0 only
      // let y exceed a y-bound of 0.5. Low > high has no defined result (a WGSL
      // shader-creation error with constant bounds, undefined in GLSL): NaN.
      const x = channelInput('x', 0);
      const lo = isWired('min') ? channelInput('min', 0) : [unwiredArg('min')];
      const hi = isWired('max') ? channelInput('max', 1) : [unwiredArg('max')];
      if (!x?.length || !lo?.length || !hi?.length) break;
      const n = Math.max(x.length, lo.length, hi.length);
      const xs = toTslWidth(x, n), ls = toTslWidth(lo, n), hs = toTslWidth(hi, n);
      result = xs.map((v, i) => (ls[i] > hs[i] ? NaN : Math.min(Math.max(v, ls[i]), hs[i])));
      break;
    }

    // Interpolation
    case 'mix': {
      // a·(1 − t) + b·t per channel at the widest of a, b and t (MathNode) —
      // a vector Factor blends each channel by its OWN t; reading t.x alone
      // showed one blend for all three.
      const a = isWired('a') ? channelInput('a', 0) : [unwiredArg('a')];
      const b = isWired('b') ? channelInput('b', 1) : [unwiredArg('b')];
      const t = isWired('t') ? channelInput('t', 0.5) : [unwiredArg('t')];
      if (!a?.length || !b?.length || !t?.length) break;
      const n = Math.max(a.length, b.length, t.length);
      const as = toTslWidth(a, n), bs = toTslWidth(b, n), ts = toTslWidth(t, n);
      result = as.map((av, i) => av * (1 - ts[i]) + bs[i] * ts[i]);
      break;
    }
    case 'smoothstep': {
      // MathNode builds edge0, edge1 and x at the WIDEST width, so a vector
      // edge applies per channel. 0 for an unwired x: the registry declares no
      // default, so codegen emits a bare '0' for the signal and the card agrees.
      // Equal edges (in a channel) have no defined result — WebGPU refuses the
      // module (Tint: "low equal to high"), WebGL folds it however its compiler
      // likes — so NaN, not the width-1 ramp `|| 1` invented. Reversed edges are
      // the working inverted ramp the formula already gives.
      const e0 = isWired('edge0') ? channelInput('edge0', 0) : [unwiredArg('edge0')];
      const e1 = isWired('edge1') ? channelInput('edge1', 1) : [unwiredArg('edge1')];
      const x = channelInput('x', 0);
      if (!e0?.length || !e1?.length || !x?.length) break;
      const n = Math.max(e0.length, e1.length, x.length);
      const lo = toTslWidth(e0, n), hi = toTslWidth(e1, n);
      result = toTslWidth(x, n).map((v, i) => {
        if (lo[i] === hi[i]) return NaN;
        const t = Math.max(0, Math.min(1, (v - lo[i]) / (hi[i] - lo[i])));
        return t * t * (3 - 2 * t);
      });
      break;
    }
    case 'remap': {
      // TSL's remap is OperatorNode arithmetic, UNCLAMPED (`doClamp` false):
      // x.sub(inLow).div(inHigh.sub(inLow)).mul(outHigh.sub(outLow)).add(outLow),
      // each step at its wider operand's width (zipTsl), so a vector bound
      // applies per channel. In Low == In High divides by zero in the shader:
      // non-finite, never Out Low.
      const x = channelInput('x', 0);
      const [iL, iH, oL, oH] = [['inLow', 0], ['inHigh', 1], ['outLow', 0], ['outHigh', 1]].map(([id, fb]) =>
        isWired(id as string) ? channelInput(id as string, fb as number) : [unwiredArg(id as string)]);
      if (!x?.length || !iL?.length || !iH?.length || !oL?.length || !oH?.length) break;
      const sub = (a: number[], b: number[]) => zipTsl(a, b, (p, q) => p - q);
      result = zipTsl(zipTsl(zipTsl(sub(x, iL), sub(iH, iL), (p, q) => p / q), sub(oH, oL), (p, q) => p * q), oL, (p, q) => p + q);
      break;
    }
    case 'select': {
      // three builds the condition with bool(): a scalar by TRUTHINESS, not a
      // 0.5 threshold (0.2 takes the TRUE branch — docs/dev/codegen.md,
      // `select`), a comparison's bvecN by all() (true only where EVERY
      // channel is). Any other VECTOR condition emits all() of a float vector,
      // which neither GLSL nor WGSL compiles: no value.
      const cond = isWired('condition') ? channelInput('condition', 0) : [unwiredArg('condition')];
      const a = channelInput('a', 0);
      const b = channelInput('b', 0);
      if (!cond?.length || !cond.every(Number.isFinite)) break;
      if (cond.length > 1) {
        const src = nidx.get(nodeEdges.find((e) => e.targetHandle === 'condition')?.source ?? '');
        if (!COMPARISON_TYPES.has(src?.data.registryType ?? '')) break;
      }
      // ConditionalNode builds BOTH branches at the wider branch's type, so the
      // chosen one splats or pads like any conversion (a vec2 True beside a vec3
      // False holds (x, y, 0)). An unevaluable branch still has a static width.
      const chosen = cond.every((c) => c !== 0) ? a : b;
      if (!chosen?.length) break;
      const width = (v: number[] | null, port: string) => v?.length || staticWidth(port);
      result = toTslWidth(chosen, Math.max(width(a, 'a'), width(b, 'b')));
      break;
    }

    // Logic — per-channel comparisons emit 0/1 as a float so downstream
    // visualization sees the right shape without piping booleans around.
    case 'greaterThan': result = binaryOp('a', 0, 'b', 0, (a, b) => a > b ? 1 : 0); break;
    case 'lessThan': result = binaryOp('a', 0, 'b', 0, (a, b) => a < b ? 1 : 0); break;
    case 'equal': result = binaryOp('a', 0, 'b', 0, (a, b) => a === b ? 1 : 0); break;

    // Vector ops that return scalar
    case 'length': {
      const v = channelInput('v', 0);
      if (v) result = [Math.sqrt(v.reduce((s, c) => s + c * c, 0))];
      break;
    }
    // distance and dot convert both operands to the wider width (MathNode),
    // padding as TSL pads (toTslWidth): dot(vec2(1, 2), vec3(1, 1, 1)) is 3.
    case 'distance': {
      const a = channelInput('a', 0);
      const b = channelInput('b', 0);
      if (a?.length && b?.length) {
        const n = Math.max(a.length, b.length);
        const as = toTslWidth(a, n), bs = toTslWidth(b, n);
        result = [Math.hypot(...as.map((v, i) => v - bs[i]))];
      }
      break;
    }
    case 'dot': {
      const a = channelInput('a', 0);
      const b = channelInput('b', 0);
      if (a?.length && b?.length) {
        // Two scalars are emitted as vec3s (graphToCode, VECTOR_ONLY_FNS): WGSL has no scalar dot.
        const n = Math.max(a.length, b.length) === 1 ? 3 : Math.max(a.length, b.length);
        const as = toTslWidth(a, n), bs = toTslWidth(b, n);
        result = [as.reduce((s, v, i) => s + v * bs[i], 0)];
      }
      break;
    }
    case 'normalize': {
      // The zero vector has no direction: NaN on the GPU, never itself. A
      // scalar is emitted as a vec3 (VECTOR_ONLY_FNS): WGSL has no scalar normalize.
      const raw = channelInput('v', 1); // the registry's unwired default
      const v = raw?.length === 1 ? toTslWidth(raw, 3) : raw;
      if (v) {
        const len = Math.sqrt(v.reduce((s, c) => s + c * c, 0));
        result = v.map((c) => c / len);
      }
      break;
    }
    case 'cross': {
      // Both operands built as vec3 (MathNode CROSS): a vec2 pads z with 0.
      const a = channelInput('a', 0);
      const b = channelInput('b', 0);
      if (a?.length && b?.length) {
        const [ax, ay, az] = toTslWidth(a, 3), [bx, by, bz] = toTslWidth(b, 3);
        result = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
      }
      break;
    }
    case 'append': {
      // Concatenate every operand, truncated at 4 channels — mirrors
      // buildAppendConstructor in graphToCode, so the CPU preview shows exactly
      // what the emitted vecN holds rather than a longer phantom vector.
      const parts: number[] = [];
      let unevaluable = false;
      for (const inp of appendOperands(nodeId, nidx, idx)) {
        if (parts.length >= 4) break;
        const v = channelInput(inp.id, 0);
        // Null propagation: one unevaluable operand makes the whole append
        // unevaluable, as with the a/b pair before it.
        if (!v) {
          unevaluable = true;
          break;
        }
        parts.push(...v.slice(0, 4 - parts.length));
      }
      if (!unevaluable && parts.length > 0) result = parts;
      break;
    }
    case 'split': {
      // What graphToCode inlines for each socket — `<upstream>.<c>` on the
      // upstream's BARE variable — padded as TSL's SplitNode reads a short
      // vector: vec2.z is 0, vec3.w (and vec2.w) 1, and a scalar answers every
      // component. From a scalar socket of a SPLIT_SOCKET_AWARE source only .x
      // exists (.y/.z/.w are dead wires — `deadSplitWire`). The consumer then
      // projects x/y/z/w (handleSlice). Split had no case at all, so every
      // wire leaving one read '…' and the next node invented 0…1.
      const input = nodeEdges.find((e) => e.targetHandle === 'v');
      const src = input ? nidx.get(input.source) : undefined;
      if (!input || !src || !hasOwnVariable(src)) break;
      const upstream = evaluate(input.source, time, cache, idx, nidx);
      if (!upstream?.length) break;
      result = splitReadsScalarSocket(src, input.sourceHandle)
        ? sliceEval(upstream, handleChannels(src, input.sourceHandle))
        : toTslWidth(upstream, 4);
      break;
    }

    // Noise (evaluate at a representative point — center of UV).
    // Float-output variants return a single channel; vec2/vec3 variants
    // approximate the multi-channel output by replicating the same scalar
    // sample (good enough for the dataflow viz, the GPU side is exact).
    case 'perlin':
    case 'perlinVec3':
    case 'fbm':
    case 'fbmVec3':
    case 'cellNoise':
    case 'voronoi':
    case 'voronoiVec2':
    case 'voronoiVec3': {
      // `pos`/`scale` may hold a coordinate-source NAME (e.g. 'positionGeometry',
      // 'uv') rather than a number — Number() of those is NaN, which would poison
      // the sample and every downstream value (the multiply card showed '…').
      // Fall back to the centre/unit when a resolved coordinate isn't finite,
      // matching the unconnected-input default.
      const finiteOr = (n: number | undefined, fallback: number) =>
        n !== undefined && Number.isFinite(n) ? n : fallback;
      const posInput = channelInput('pos', 0);
      const scale = finiteOr(scalarInput('scale', 1), 1);
      const px = finiteOr(posInput?.[0], 0.5) * NOISE_UV_SCALE * scale;
      const py = finiteOr(posInput?.[1], 0.5) * NOISE_UV_SCALE * scale;
      let v: number;
      // The remap follows the node's own range flag, so the CPU value agrees
      // with the emitted shader instead of asserting 0-1 for both modes.
      const unsignedNoise = isUnsignedNoise(type, values);
      if (type === 'perlin' || type === 'perlinVec3') {
        v = perlin2D(px, py);
        if (unsignedNoise) v = (v + 1) * 0.5;
      } else if (type === 'fbm' || type === 'fbmVec3') {
        v = fbm2D(px, py);
        if (unsignedNoise) v = (v + 1) * 0.5;
      }
      else if (type === 'cellNoise') v = cellNoise2D(px, py);
      else v = voronoi2D(px, py);
      // Match the channel count of the registered output port for downstream
      // dataflow visualizations (single line vs ribbon). The case labels are
      // registry keys, so `def` is always present here.
      result = Array(shapeOfDataType(def!.outputs[0].dataType)).fill(v);
      break;
    }

    // HSL → RGB conversion (standard algorithm)
    case 'hsl': {
      // The hue WRAPS first — the helper's mod(h·6, 6) takes any hue, and
      // hue2rgb wraps only once, so Time → Hue read black from t = 2 on.
      const hRaw = scalarInput('h', 0);
      const h = hRaw - Math.floor(hRaw);
      const s = scalarInput('s', 1);
      const l = scalarInput('l', 0.5);
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      result = [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
      break;
    }
    // RGB → HSL — matches the branchless GPU/codegen implementations, its
    // `vec3(rgb)` included (a vec2 pads blue with 0).
    case 'toHsl': {
      const rgb = channelInput('rgb', 0);
      if (!rgb?.length) { result = null; break; }
      const [r, g, b] = toTslWidth(rgb, 3);
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const d = maxC - minC;
      const L = (maxC + minC) * 0.5;
      const satDenom = Math.max(1 - Math.abs(2 * L - 1), 1e-10);
      const S = d > 0 ? d / satDenom : 0;
      let H = 0;
      if (d > 0) {
        const dSafe = Math.max(d, 1e-10);
        if (maxC === r) H = ((g - b) / dSafe + (g < b ? 6 : 0)) / 6;
        else if (maxC === g) H = ((b - r) / dSafe + 2) / 6;
        else H = ((r - g) / dSafe + 4) / 6;
      }
      result = [H, S, L];
      break;
    }
    // Fresnel — the head-on sample (the centre of a sphere faces the camera):
    // [F0, 0], 0.04 at IOR 1.5. Its range is analytical (a sampled field).
    case 'fresnel': {
      const ior = finiteScalar('ior', 1.5);
      result = ior === null ? null : fresnelFacing(1, ior);
      break;
    }
    // Color Ramp — [r, g, b, a] in LINEAR light, fetched from the same half
    // table the shader samples (utils/colorRamp.ts). Unwired Factor is
    // Blender's constant 0.5; a non-finite wired one is unknown, as in codegen.
    case 'colorRamp': {
      const tt = finiteScalar('fac', 0.5);
      result = tt === null ? null : rampFetch(readColorRamp(values), tt);
      break;
    }
    // RGB Curves — the two-stage expression on the same half table the shader
    // samples (utils/rgbCurves.ts). Color is read as the helper's `vec3(col)`
    // reads it; an unwired non-finite colour is the registry's 1, as codegen
    // emits it, and a wired non-finite one is unknown.
    case 'rgbCurves': {
      const c = socketChannels('color', 1);
      const f = finiteScalar('fac', 1);
      result = !c || c.length === 0 || f === null ? null : evalRgbCurves(readRgbCurves(values), brightContrastRgb(c), f);
      break;
    }
    // Brightness/Contrast — Blender's formula, read exactly as the helper reads
    // it (engine/moduleHelpers.ts): `vec3(col)` broadcasts a scalar, pads a
    // vec2 with 0 and drops a fourth channel; only the bottom is clamped.
    case 'brightContrast': {
      const c = channelInput('color', 1);
      if (!c || c.length === 0) { result = null; break; }
      const contrast = scalarInput('contrast', 0);
      const a = 1 + contrast;
      const b = scalarInput('bright', 0) - contrast * 0.5;
      result = brightContrastRgb(c).map((v) => Math.max(a * v + b, 0));
      break;
    }

    // ===== DISTANCE FIELDS (engine/moduleHelpers.ts carries the GPU twin) =====
    case 'sdCircle': {
      const p = channelInput('p', 0);
      const r = scalarInput('r', 0.5);
      result = p ? [Math.hypot(...p) - r] : null;
      break;
    }
    case 'sdBox':
    case 'sdTorus':
    case 'sdCylinder':
    case 'sdCapsule':
    case 'sdCone':
    case 'sdPlane':
    case 'sdOctahedron':
    case 'sdStar': {
      const p = channelInput('p', 0);
      result = p ? [sdfPrimitiveAt(type, p, scalarInput, vec3Input)] : null;
      break;
    }
    case 'sdCombine': {
      // xor's helper takes no Smoothness (helperCallPorts): never read it there.
      const mode = sdCombineMode(node);
      const a = scalarInput('a', 0), b = scalarInput('b', 0), k = mode === 'xor' ? 0 : scalarInput('k', 0);
      result = [sdCombineValue(mode, a, b, k)];
      break;
    }
    case 'sdfTransform': {
      // Move / Turn / Scale are ONE vec3 socket each since 2026-09-09 (the
      // helper's `vec3(t)`, `vec3(r)`, `vec3(s)`); this twin had kept reading
      // the retired tx…rz float ids and Scale's x alone, so a wired Move or
      // Turn changed nothing on the card.
      const p = position();
      const [tx, ty, tz] = vec3Input('t', 0);
      const [rx, ry, rz] = vec3Input('r', 0);
      const sc = vec3Input('s', 1).map((v) => Math.max(v, 1e-6));
      if (p) {
        const rad = Math.PI / 180;
        let x = (p[0] - tx) / sc[0], y = (p[1] - ty) / sc[1], z = (p[2] - tz) / sc[2];
        let c = Math.cos(rz * rad), sn = Math.sin(rz * rad);
        [x, y] = [c * x + sn * y, c * y - sn * x];
        c = Math.cos(ry * rad); sn = Math.sin(ry * rad);
        [x, z] = [c * x - sn * z, c * z + sn * x];
        c = Math.cos(rx * rad); sn = Math.sin(rx * rad);
        [y, z] = [c * y + sn * z, c * z - sn * y];
        result = [x, y, z];
      } else result = null;
      break;
    }
    case 'sdfRepeat': {
      // Spacing and Limit are vec3 sockets (`vec3(s)`, `vec3(l)` in the
      // helper), not the retired sx…lz floats; `round` is WGSL's half-to-even.
      const p = position();
      const sp = vec3Input('s', 1);
      const lim = vec3Input('l', 0);
      if (p) {
        result = p.map((v, i) => {
          if (!(sp[i] > 0)) return v;
          let id = roundHalfEven(v / Math.max(sp[i], 1e-6));
          if (lim[i] > 0) id = Math.min(Math.max(id, -lim[i]), lim[i]);
          return v - sp[i] * id;
        });
      } else result = null;
      break;
    }
    case 'sdfRepeatPolar': {
      const p = position();
      const n = Math.max(scalarInput('n', 6), 1);
      if (p) {
        const sp = (2 * Math.PI) / n;
        const an = Math.atan2(p[2], p[0]);
        const a = an - sp * Math.floor(an / sp + 0.5);
        const r = Math.hypot(p[0], p[2]);
        result = [r * Math.cos(a), p[1], r * Math.sin(a)];
      } else result = null;
      break;
    }
    case 'sdfMirror': {
      const p = position();
      const w = vec3Input('m', 1);
      if (p) result = p.map((v, i) => v + (Math.abs(v) - v) * w[i]);
      else result = null;
      break;
    }
    case 'sdfModify': {
      const d = scalarInput('d', 0), a = scalarInput('amount', 0.05);
      const mode = values.mode;
      result = [mode === 'shell' ? Math.abs(d) - a : mode === 'scale' ? d * a : d - a];
      break;
    }
    case 'sdfDeform': {
      // Each mode reads only what its helper takes (helperCallPorts): an
      // unevaluable wire into Amount must not void Elongate, which ignores it.
      const p = position();
      const mode = values.mode;
      if (p) {
        const [x, y, z] = p;
        if (mode === 'elongate') {
          // p − clamp(p, −h, h): a negative half size is low > high, which the
          // GPU leaves undefined (a WGSL error when constant) — NaN, as Clamp.
          const hh = vec3Input('h', 0);
          result = p.map((v, i) => (hh[i] < 0 ? NaN : v - Math.min(Math.max(v, -hh[i]), hh[i])));
        } else {
          const k = scalarInput('amount', 1);
          if (mode === 'bend') {
            const c = Math.cos(k * x), sn = Math.sin(k * x);
            result = [c * x - sn * y, sn * x + c * y, z];
          } else {
            const c = Math.cos(k * y), sn = Math.sin(k * y);
            result = [c * x - sn * z, y, sn * x + c * z];
          }
        }
      } else result = null;
      break;
    }
    case 'sdfExtrude': {
      // `abs(p.z)` — a scalar position's .z is the scalar itself; a wired
      // position with no value leaves the node unknown like every other twin
      // (it used to read z = 0 and print a confident live constant).
      const d = scalarInput('d', 0), h = scalarInput('h', 0.2);
      const p = position();
      if (p) {
        const wz = Math.abs(p[2]) - h;
        result = [Math.min(Math.max(d, wz), 0) + Math.hypot(Math.max(d, 0), Math.max(wz, 0))];
      } else result = null;
      break;
    }
    case 'sdfRevolve': {
      const p = position();
      const o = scalarInput('o', 0.5);
      if (p) result = [Math.hypot(p[0], p[2]) - o, p[1]];
      else result = null;
      break;
    }
    case 'sdfMask': {
      const d = scalarInput('d', 0), w = Math.max(scalarInput('w', 0.02), 1e-6);
      result = [Math.min(Math.max(1 - d / w, 0), 1)];
      break;
    }

    default:
      result = null;
  }

  if (wiredUnknown) result = null;
  cache.set(nodeId, result);
  return result;
}

/** Three channels of `v` the way TSL's `vec3(v)` converts it: a scalar
 *  broadcasts, a vec2 pads with 0, a vec4 drops its fourth component. Shared by
 *  Brightness/Contrast's sample and its range, so the two read one shape. */
function brightContrastRgb(v: readonly number[]): [number, number, number] {
  return toTslWidth(v, 3) as [number, number, number];
}

/**
 * `v` converted to `n` channels the way three's NodeBuilder.format converts
 * between widths: a scalar splats, a narrower vector pads z with 0 and w with
 * 1 (vec2 → vec4 is (x, y, 0, 1)), a wider one truncates. THE width rule of
 * every mixed-width operation here, point and range alike — cycling the
 * shorter operand (`a[i % a.length]`) showed vec2(2, 3) × vec3(1, 1, 1) as
 * (2, 3, 2) where the shader holds (2, 3, 0).
 */
function toTslWidth(v: readonly number[], n: number): number[] {
  if (v.length === 1) return Array(n).fill(v[0]);
  const out = v.slice(0, n);
  while (out.length < n) out.push(out.length === 3 ? 1 : 0);
  return out;
}

/** One OperatorNode step: both operands at the wider width (toTslWidth), then
 *  element-wise. */
function zipTsl(a: readonly number[], b: readonly number[], fn: (x: number, y: number) => number): number[] {
  const n = Math.max(a.length, b.length);
  const bw = toTslWidth(b, n);
  return toTslWidth(a, n).map((v, i) => fn(v, bw[i]));
}

/** WGSL's `round`: a value halfway between two integers goes to the EVEN one
 *  (round(0.5) is 0, round(2.5) is 2); JS Math.round sends halves up. GLSL
 *  leaves the half direction to the implementation, so WebGPU is the target. */
function roundHalfEven(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  return d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f;
}

/** The comparison nodes, whose vector result three reads as a bvecN. */
const COMPARISON_TYPES: ReadonlySet<string> = new Set(['greaterThan', 'lessThan', 'equal']);

/** Reads a primitive's shape parameter: the evaluator's socket readers for a
 *  sample, constant-only ones for the range's Lipschitz bound. */
type ParamRead = (portId: string, fallback: number) => number;
type Vec3Read = (portId: string, fallback: number) => [number, number, number];

/** The SDF primitives whose CPU twin is `sdfPrimitiveAt` — each an EXACT
 *  distance, so 1-Lipschitz in p (the range's bound rests on it). */
const SDF_PRIMITIVES: ReadonlySet<string> = new Set([
  'sdBox', 'sdTorus', 'sdCylinder', 'sdCapsule', 'sdCone', 'sdPlane', 'sdOctahedron', 'sdStar',
]);

/**
 * One SDF primitive's distance at `p` — the CPU twin of its helper Fn in
 * engine/moduleHelpers.ts, maths restated operation for operation. ONE copy,
 * read by `evaluate` (a sample) and `computeRange` (the value at the centre of
 * the position box, which the Lipschitz bound widens).
 */
function sdfPrimitiveAt(type: string, p: readonly number[], num: ParamRead, vec: Vec3Read): number {
  // Swizzles read p as SplitNode does: a scalar answers every component, a
  // vec2's z is 0. (Only `length(pIn)` in sdStar reads p's own channels.)
  const [x, y, z] = toTslWidth(p, 3);
  switch (type) {
    case 'sdBox': {
      // 2D for a two-channel position, 3D otherwise — the width dispatch the
      // emitter makes (sdBox2 vs sdBox3). Rounding cancels in value except at
      // the corners, exactly as in the helper. Half-extents are ONE vec3
      // socket: wired, its channels; unwired, the scalar default broadcast —
      // the same `vec3()` fill the helper applies.
      const b = vec('b', 0.5), r = num('round', 0);
      const q = p.length === 2
        ? [Math.abs(x) - b[0] + r, Math.abs(y) - b[1] + r]
        : [Math.abs(x) - b[0] + r, Math.abs(y) - b[1] + r, Math.abs(z) - b[2] + r];
      return Math.hypot(...q.map((v) => Math.max(v, 0))) + Math.min(Math.max(...q), 0) - r;
    }
    case 'sdTorus': {
      const ringR = num('ringR', 0.5), tubeR = num('tubeR', 0.15);
      return Math.hypot(Math.hypot(x, z) - ringR, y) - tubeR;
    }
    case 'sdCylinder': {
      const r = num('r', 0.3), h = num('h', 0.5), rb = num('round', 0);
      const dx = Math.hypot(x, z) - (r - rb);
      const dy = Math.abs(y) - (h - rb);
      return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - rb;
    }
    case 'sdCapsule': {
      const r = num('r', 0.2), h = num('h', 0.3);
      return Math.hypot(x, y - Math.min(Math.max(y, -h), h), z) - r;
    }
    case 'sdCone': {
      const r1 = num('r1', 0.4), r2 = num('r2', 0.1), h = num('h', 0.4);
      const qx = Math.hypot(x, z), qy = y;
      const k1 = [r2, h], k2 = [r2 - r1, 2 * h];
      const ca = [qx - Math.min(qx, qy < 0 ? r1 : r2), Math.abs(qy) - h];
      const t = Math.min(Math.max(((k1[0] - qx) * k2[0] + (k1[1] - qy) * k2[1]) / (k2[0] * k2[0] + k2[1] * k2[1] || 1e-9), 0), 1);
      const cb = [qx - k1[0] + k2[0] * t, qy - k1[1] + k2[1] * t];
      const sgn = cb[0] < 0 && ca[1] < 0 ? -1 : 1;
      return sgn * Math.sqrt(Math.min(ca[0] * ca[0] + ca[1] * ca[1], cb[0] * cb[0] + cb[1] * cb[1]));
    }
    case 'sdPlane': {
      // Mirrors the helper exactly, degenerate case included: a zero-length
      // normal reads as "up", which is what carries the old (0,1,0) default
      // through a socket whose unwired value can only be a broadcast scalar.
      const n0 = vec('n', 0), h = num('h', 0);
      const n = Math.hypot(n0[0], n0[1], n0[2]) > 1e-6 ? n0 : [0, 1, 0];
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      return (x * n[0] + y * n[1] + z * n[2]) / len + h;
    }
    case 'sdOctahedron': {
      const sz = num('s', 0.5);
      const a = [Math.abs(x), Math.abs(y), Math.abs(z)];
      const m = a[0] + a[1] + a[2] - sz;
      let q: number[] | null = null;
      if (3 * a[0] < m) q = [a[0], a[1], a[2]];
      else if (3 * a[1] < m) q = [a[1], a[2], a[0]];
      else if (3 * a[2] < m) q = [a[2], a[0], a[1]];
      if (!q) return m * 0.57735027;
      const k = Math.min(Math.max(0.5 * (q[2] - q[1] + sz), 0), sz);
      return Math.hypot(q[0], q[1] - sz + k, q[2] - k);
    }
    case 'sdStar': {
      const r = num('r', 0.4), n = Math.max(num('n', 5), 1), m = Math.max(num('m', 3), 1);
      const an = Math.PI / n, en = Math.PI / m;
      const acs = [Math.cos(an), Math.sin(an)], ecs = [Math.cos(en), Math.sin(en)];
      const a = Math.atan2(x, y);
      const twoAn = 2 * an;
      const bn = (((a % twoAn) + twoAn) % twoAn) - an;
      const len = Math.hypot(...p); // `length(pIn)` — every channel p has
      let px = len * Math.cos(bn) - r * acs[0];
      let py = len * Math.abs(Math.sin(bn)) - r * acs[1];
      const t = Math.min(Math.max(-(px * ecs[0] + py * ecs[1]), 0), (r * acs[1]) / ecs[1]);
      px += ecs[0] * t;
      py += ecs[1] * t;
      return Math.hypot(px, py) * Math.sign(px || 1);
    }
  }
  return NaN;
}

/**
 * A primitive's interval by the Lipschitz bound: an exact distance changes no
 * faster than its point moves, so over the position box — centre c, half
 * diagonal R — it lies in f(c) ± R, one call of the twin. Sound, and as tight
 * as the box is small. The shape parameters must be constants (a swept radius
 * moves the bound itself): otherwise, or for an unbounded position, null.
 * Before this the primitives had no rule, and their consumers read the
 * invented 0…1 that hid every inside value.
 */
function sdfLipschitzRange(
  type: string,
  p: RangeResult,
  param: (portId: string, fallback: number) => RangeResult,
): RangeResult | null {
  if (!SDF_PRIMITIVES.has(type)) return null;
  // A primitive is a true distance only inside its parameter domain: a Star
  // with fewer than 2 points or a Sharpness ≤ 1, or a negative Octahedron size,
  // is discontinuous (measured |Δf|/|Δp| up to 800), so f(c) ± R would lie.
  const fixedParam = (id: string, fb: number) => {
    const r = param(id, fb);
    return r.min[0] === r.max[0] ? r.min[0] : NaN;
  };
  if (type === 'sdStar' && !(Math.max(fixedParam('n', 5), 1) >= 2 && Math.max(fixedParam('m', 3), 1) > 1)) return null;
  if (type === 'sdOctahedron' && !(fixedParam('s', 0.5) >= 0)) return null;
  // The box in the coordinates the twin READS: sdBox's 2D form and sdStar read
  // p's own channels (a Star is a distance over a 2D or scalar position only —
  // its angle is (x, y)'s while its radius is |p|), every other primitive the
  // vec3 SplitNode gives, so a scalar half-width h moves that point by √3·h.
  if (type === 'sdStar' && p.min.length > 2) return null;
  const box = (type === 'sdBox' && p.min.length === 2) || type === 'sdStar' ? p : rangeAtWidth(p, 3);
  const c = box.min.map((lo, i) => (lo + box.max[i]) / 2);
  // + 1e-6 relative: the helpers' own constants are rounded (the octahedron's
  // 0.57735027 is a hair above 1/√3, so it is 1.0000000014-Lipschitz).
  const R = Math.hypot(...box.min.map((lo, i) => (box.max[i] - lo) / 2)) * (1 + 1e-6);
  if (!c.every(Number.isFinite) || !Number.isFinite(R)) return null;
  let fixed = true;
  const num: ParamRead = (id, fb) => {
    const r = param(id, fb);
    if (r.min[0] !== r.max[0]) fixed = false;
    return r.min[0];
  };
  const vec: Vec3Read = (id, fb) => {
    const r = rangeAtWidth(param(id, fb), 3);
    if (r.min.some((v, i) => v !== r.max[i])) fixed = false;
    return [r.min[0], r.min[1], r.min[2]];
  };
  const d = sdfPrimitiveAt(type, c, num, vec);
  return fixed && Number.isFinite(d) ? { min: [d - R], max: [d + R] } : null;
}

/** Standard HSL hue-to-RGB channel helper. */
function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

// ── Range evaluation ─────────────────────────────────────────────────────────
// Per-channel min/max bounds for the value labels, in this order:
//   1. a sampled FIELD returns its analytical range (`analyticalRange`);
//   2. a field-FREE chain returns its evaluated value as a degenerate range;
//   3. everything else propagates its inputs' ranges by interval arithmetic.

export interface RangeResult {
  min: number[];
  max: number[];
}

/**
 * Compute per-channel value bounds for a node. Returns null when bounds can't
 * be determined (e.g., positionGeometry, or chains through unsupported ops).
 *
 * The `time` argument is forwarded to the underlying deterministic evaluator
 * so time-driven inputs (a slider connected to time, etc.) update live.
 */
export function evaluateNodeRange(
  nodeId: string,
  nodes: AppNode[],
  edges: AppEdge[],
  time: number = 0,
): RangeResult | null {
  const ctx = getCtx(nodes, edges);
  const cache = rangeCacheFor(ctx, time);
  try {
    return computeRange(nodeId, nodes, ctx.edges, time, cache, ctx.nodeIndex, ctx.evalEdgeIndex);
  } catch (e) {
    // Persistent cache — don't leave cycle-guard sentinels behind on a throw.
    cache.clear();
    throw e;
  }
}

function rangeOfValue(v: number[]): RangeResult {
  return { min: [...v], max: [...v] };
}

/** Sources whose every value is a unit vector. `normalWorld` is unit by
 *  construction (three's transformDirection ends in normalize()), and so is
 *  `rayDirection` in all three places it is emitted (the flat helper's
 *  normalize(), the splat scope's `.normalize()`, the march Background's
 *  transformDirection). */
const UNIT_VECTOR_TYPES: ReadonlySet<string> = new Set([
  'normalLocal', 'tangentLocal', 'normalWorld', 'positionWorldDirection', 'positionViewDirection',
  'rayDirection',
]);

/** Real values the editor cannot bound: world units, the orbit camera, and an
 *  exported page's own camera. Listed as UNBOUNDED fields rather than left out,
 *  because a missing entry kept them out of the field set and every consumer
 *  silently assumed 0…1. */
const UNBOUNDED_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'positionWorld', 'positionView', 'cameraPosition', 'cameraNear', 'cameraFar',
]);

/** Model-space position bound: the built-in shapes are NOT fitted (the sphere
 *  has radius 1, the plane is 2 × 2, the cube ±0.7) and fit-bounds puts a
 *  dropped model, the teapot and a splat within ±0.8 — ±1 holds for all of
 *  them. Not for a skinned or animated model (fit-bounds scales its root, so
 *  its positions stay in authored units), nor positionLocal under a
 *  displacement or inside a raymarch scope (docs/dev/codegen.md). */
const MODEL_POSITION_BOUND = 1;

/** MaterialX Worley as three r184 calls it: metric int(1), the SQUARED
 *  distance, over a 3×3(×3) cell window with jitter 1 — so F1², F2², F3² are
 *  bounded by the window's geometry (3D numbers, which cover the 2D overload),
 *  not by 1: F3² passes 1 on a tenth of the default sphere. */
const VORONOI_SQ_BOUNDS = [3, 3, 3.5];

/** fBm sums three octaves of Perlin at amplitudes 1, ½, ¼ (three's
 *  mx_fractal_noise defaults), so one octave's ±1 becomes ±1.75. */
const FBM_BOUND = 1.75;

/** Per-column [min, max] of a decoded Data payload — the samples the shader
 *  bakes (decode refuses more rows than one texture holds, so capToWidth is a
 *  copy), memoised per decode. A non-finite sample leaves that end unknown. */
const DATA_RANGE_MEMO = new WeakMap<DecodedDataNode, RangeResult>();
function dataColumnRanges(decoded: DecodedDataNode): RangeResult {
  let hit = DATA_RANGE_MEMO.get(decoded);
  if (!hit) {
    const min: number[] = [], max: number[] = [];
    for (const col of decoded.columns) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < col.length; i++) {
        const v = col[i];
        if (!Number.isFinite(v)) { lo = -Infinity; hi = Infinity; break; }
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (lo > hi) { lo = 0; hi = 0; } // an empty column emits float(0.0)
      min.push(lo);
      max.push(hi);
    }
    hit = { min, max };
    DATA_RANGE_MEMO.set(decoded, hit);
  }
  return hit;
}

/** A unit-vector source, or a Normalize node: |v| = 1, which the per-channel
 *  box ([−1, 1]³, corner length √3) cannot express. */
function isUnitVectorSource(node: AppNode | undefined): boolean {
  const type = node?.data.registryType;
  return type !== undefined && (UNIT_VECTOR_TYPES.has(type) || type === 'normalize');
}

/**
 * The analytically-known range of a SAMPLED FIELD (a value that varies across
 * the surface), null for every other node. ONE table with two jobs:
 * `computeRange` returns it, and `getFieldUpstreamSet` seeds its BFS from
 * `!== null`, so a field added here is a seed by construction.
 */
function analyticalRange(node: AppNode): RangeResult | null {
  const type = node.data.registryType;
  const def = NODE_REGISTRY.get(type);
  if (!def) return null;

  // UV/screenUV span [0, 1] across the surface (the sample is only the centre).
  // A graph-level assumption: the built-in shapes' UVs are [0, 1], but the
  // Bunny's generated spherical UVs reach just under 1.5 at the seam and a
  // model's own TEXCOORD is unbounded (docs/dev/codegen.md). UV's tiling and
  // turn are applied in computeRange.
  if (type === 'uv' || type === 'screenUV') return { min: [0, 0], max: [1, 1] };

  // Unit vectors: every channel lies in [-1, 1]. `normalWorld` is unit by
  // construction (three's transformDirection ends in normalize()). The box is
  // per-channel, so it cannot express |v| = 1: the tightest axis-aligned bound.
  if (UNIT_VECTOR_TYPES.has(type)) {
    return { min: [-1, -1, -1], max: [1, 1, 1] };
  }

  if (UNBOUNDED_SOURCE_TYPES.has(type)) return unboundedRange(shapeOfDataType(def.outputs[0].dataType));

  // A Data column is sampled along uv.x: a field, bounded by its own samples.
  // An undecodable payload emits float(0.0) per column — a constant, no field.
  if (type === 'dataNode') {
    const decoded = decodeDataNode(getNodeValues(node));
    return decoded ? dataColumnRanges(decoded) : null;
  }

  // Sound's four channels move with the audio: 0…1 here, the seed of the field
  // set; computeRange multiplies in the gain before it ever reads this entry.
  if (type === 'soundNode') return { min: [0, 0, 0, 0], max: [1, 1, 1, 1] };

  // Fresnel/Facing: both in [0, 1] for a unit normal — the analytical seed.
  // A WIRED non-unit normal widens it, which computeRange decides first.
  if (type === 'fresnel') return { min: [0, 0], max: [1, 1] };

  // Wireframe coverage is 0…1 per pixel and depends on screen-space
  // derivatives, which the CPU has no equivalent of: a range, never a sample.
  if (type === 'wireframe') return { min: [0], max: [1] };

  // Vertex colours are a normalized attribute, vec4 whatever the file's
  // itemSize. A RANGE, not an `evaluate` case: white is only what the
  // MISSING-attribute fallback emits.
  if (type === 'vertexColor') return { min: [0, 0, 0, 0], max: [1, 1, 1, 1] };

  // A sampled image: four channels because the WHOLE vector is the rgba sample
  // (`out` projects the first three, handleChannels). Never an `evaluate` case:
  // the pixels decode asynchronously from an adversarial payload.
  if (type === 'imageNode') return { min: [0, 0, 0, 0], max: [1, 1, 1, 1] };

  // Model-space positions (MODEL_POSITION_BOUND says which shapes this holds for).
  if (type === 'positionGeometry' || type === 'positionLocal') {
    const b = MODEL_POSITION_BOUND;
    return { min: [-b, -b, -b], max: [b, b, b] };
  }

  // MaterialX noise: perlin/fBm follow their per-node range flag (absent =
  // signed; fBm's three octaves reach ±1.75), cellNoise is exactly [0, 1], and
  // the Voronoi family is a SQUARED distance (VORONOI_SQ_BOUNDS).
  if (def.category === 'noise') {
    const n = shapeOfDataType(def.outputs[0].dataType);
    if (type === 'voronoi' || type === 'voronoiVec2' || type === 'voronoiVec3') {
      return { min: Array(n).fill(0), max: VORONOI_SQ_BOUNDS.slice(0, n) };
    }
    const amp = type === 'fbm' || type === 'fbmVec3' ? FBM_BOUND : 1;
    if (!hasNoiseRangeFlag(type)) return { min: Array(n).fill(0), max: Array(n).fill(1) };
    return isUnsignedNoise(type, getNodeValues(node))
      ? { min: Array(n).fill(0.5 - amp / 2), max: Array(n).fill(0.5 + amp / 2) }
      : { min: Array(n).fill(-amp), max: Array(n).fill(amp) };
  }

  return null;
}

/** Element-wise binary op on ranges at the WIDER operand's width (or `width`),
 *  each converted as TSL converts it (toTslWidth: a padded channel is the
 *  point interval [0, 0] or, for w, [1, 1]). */
function broadcastRange(
  a: RangeResult,
  b: RangeResult,
  fn: (amin: number, amax: number, bmin: number, bmax: number) => [number, number],
  width?: number,
): RangeResult {
  const len = width ?? Math.max(a.min.length, b.min.length);
  const [aMin, aMax, bMin, bMax] = [toTslWidth(a.min, len), toTslWidth(a.max, len), toTslWidth(b.min, len), toTslWidth(b.max, len)];
  const min: number[] = [];
  const max: number[] = [];
  for (let i = 0; i < len; i++) {
    const [lo, hi] = fn(aMin[i], aMax[i], bMin[i], bMax[i]);
    min.push(lo);
    max.push(hi);
  }
  return { min, max };
}

/** A range converted to `n` channels by TSL's rule (toTslWidth). */
function rangeAtWidth(r: RangeResult, n: number): RangeResult {
  return { min: toTslWidth(r.min, n), max: toTslWidth(r.max, n) };
}

/**
 * The Euclidean norm of a per-channel interval: `[lo, hi]` of |v|.
 *
 * Shared by `length`/`distance` and by `sdCircle` (whose field IS |p| minus a
 * radius) because the subtle half is easy to write twice and get wrong once:
 * |x| over an interval is 0 when the interval STRADDLES zero, not
 * `min(|lo|, |hi|)` — a channel crossing the origin contributes nothing to the
 * lower bound.
 */
function normRange(d: RangeResult): [number, number] {
  let lo2 = 0, hi2 = 0;
  for (let i = 0; i < d.min.length; i++) {
    const lo = d.min[i], hi = d.max[i];
    const amin = lo <= 0 && hi >= 0 ? 0 : Math.min(Math.abs(lo), Math.abs(hi));
    const amax = Math.max(Math.abs(lo), Math.abs(hi));
    lo2 += amin * amin;
    hi2 += amax * amax;
  }
  return [Math.sqrt(lo2), Math.sqrt(hi2)];
}

/** Element-wise unary op on ranges. */
function unaryRange(r: RangeResult, fn: (lo: number, hi: number) => [number, number]): RangeResult {
  const min: number[] = [];
  const max: number[] = [];
  for (let i = 0; i < r.min.length; i++) {
    const [lo, hi] = fn(r.min[i], r.max[i]);
    min.push(lo);
    max.push(hi);
  }
  return { min, max };
}

function computeRange(
  nodeId: string,
  nodes: AppNode[],
  edges: AppEdge[],
  time: number,
  cache: Map<string, RangeResult | null>,
  nodeIndex: Map<string, AppNode>,
  edgeIndex: Map<string, AppEdge[]>,
): RangeResult | null {
  if (cache.has(nodeId)) return cache.get(nodeId)!;
  cache.set(nodeId, null); // cycle protection — overwritten below

  const node = nodeIndex.get(nodeId);
  if (!node) return null;
  const def = NODE_REGISTRY.get(node.data.registryType);
  if (!def) return null;

  const type = node.data.registryType;
  const values = getNodeValues(node);
  const nodeEdges = edgeIndex.get(nodeId) ?? [];

  // Resolve a port's range — the upstream's range when wired, else the inline
  // value (`unwiredValue`, as codegen emits it). A wired upstream with no range
  // is UNKNOWN — ±∞ on each of its channels, which a label prints as '…' and a
  // self-bounding rule (clamp, sin, fract, smoothstep…) still bounds. It used
  // to be an invented [0, 1]: distance(Position (world), Camera) read 0…1 for
  // a wire that is 7…9 on the default view, and an SDF's inside vanished.
  const portRange = (portId: string, fallback: number): RangeResult => {
    const edge = nodeEdges.find((e) => e.targetHandle === portId);
    if (edge) {
      const src = nodeIndex.get(edge.source);
      const r = sliceRange(
        computeRange(edge.source, nodes, edges, time, cache, nodeIndex, edgeIndex),
        handleChannels(src, edge.sourceHandle),
      );
      if (r && r.min.length > 0) return r;
      const declared = src && edge.sourceHandle ? portShapeForHandle(src, edge.sourceHandle) : 0;
      return unboundedRange(declared > 0 ? declared : computeShape(edge.source, new Set(), nodeIndex, edgeIndex));
    }
    const num = unwiredValue(values[portId], fallback);
    return { min: [num], max: [num] };
  };

  // `portRange`, kept as the name the newer rules read sockets through (it
  // once differed from portRange's unwired `Number()` read).
  const socketRange = portRange;

  // A socket codegen reads through resolveExposedParam (UV tiling/turn): wired
  // → the upstream range; unwired → the stored number, the registry default
  // when absent, and a junk entry reads 1 — that function's one fallback.
  const exposedParamRange = (key: string): RangeResult => {
    if (nodeEdges.some((e) => e.targetHandle === key)) return portRange(key, 1);
    const n = valueNum(values[key] ?? def.defaultValues?.[key] ?? 1);
    const v = Number.isFinite(n) ? n : 1;
    return { min: [v], max: [v] };
  };

  // A ramp end (Stripes / Data Viz `lowColor`, `highColor`) as colorRefOf emits
  // it: a wire widened by `vec3()`, else `color(<stored or default hex>)` in
  // linear light — and black for a hex that is not #rrggbb (hexLiteral).
  const rampEndRange = (port: string): RangeResult => {
    if (nodeEdges.some((e) => e.targetHandle === port)) return rangeAtWidth(portRange(port, 0), 3);
    const hex = valueStr(values[port] ?? def.defaultValues?.[port] ?? '');
    const rgb = HEX6.test(hex) ? hexToRgb01(hex).map(srgbToLinear01) : [0, 0, 0];
    return { min: rgb, max: rgb };
  };

  // Interval fold over a chainable node's effective operands (variadic
  // arithmetic). Mirrors naryOp in evaluate(): unconnected operands contribute
  // `identity`, left-folded through the per-op interval rule.
  const naryRange = (
    identity: number,
    fn: (amin: number, amax: number, bmin: number, bmax: number) => [number, number],
  ): RangeResult => {
    const ports = effectiveInputs(def, connectedHandles(nodeId, edgeIndex), false, Object.keys(values));
    let acc: RangeResult | null = null;
    for (const port of ports) {
      const r = portRange(port.id, identity);
      acc = acc === null ? r : broadcastRange(acc, r, fn);
    }
    return acc ?? { min: [identity], max: [identity] };
  };

  let result: RangeResult | null = null;

  // Fresnel with a WIRED normal: [0,1] holds only for |N| ≤ 1 (no normalize — Cycles). A unit-vector source keeps
  // it; otherwise bound |N| by the box corner L: Facing = 1 − c ∈ [1 − L, 1]; Fresnel ≥ 0 always, ≤ 1 while L ≤ 1.
  if (type === 'fresnel') {
    const nEdge = nodeEdges.find((e) => e.targetHandle === 'normal');
    if (nEdge && !isUnitVectorSource(nodeIndex.get(nEdge.source))) {
      const r = portRange('normal', 0);
      const L = Math.hypot(...[0, 1, 2].map((i) => Math.max(Math.abs(r.min[i] ?? r.min[0]), Math.abs(r.max[i] ?? r.max[0]))));
      const res: RangeResult = !Number.isFinite(L) ? { min: [0, -Infinity], max: [Infinity, 1] }
        : L <= 1 ? { min: [0, 0], max: [1, 1] } : { min: [0, 1 - L], max: [Infinity, 1] };
      cache.set(nodeId, res);
      return res;
    }
  }

  // UV carries its own tiling and turn (graphToCode: `mul(uv(), vec2(U, V))`,
  // then a rotation about (½, ½)), so its interval is analyticalRange's [0, 1]²
  // pushed through that same map, each parameter read as a RANGE (a wired
  // Slider or Time sweeps it). The table entry alone read "0…1" for U = 10
  // while the preview tiled ten times. Here, not in the table: the table sees
  // the node only, and stays the field-seed predicate.
  if (type === 'uv') {
    const res = sanitizeRange(uvRange(exposedParamRange('tilingU'), exposedParamRange('tilingV'), exposedParamRange('rotation')));
    cache.set(nodeId, res);
    return res;
  }

  // Sound: 0…1 on each channel while a capture is armed (the pump posts the
  // analyser's levels), 0 while it is not — a range either way, never the
  // constant 0 a static read showed under a moving uniform — times the gain the
  // module applies to every channel (micGainExpr: the wired socket, else the
  // validated stored gain).
  if (type === 'soundNode') {
    const g = nodeEdges.some((e) => e.targetHandle === 'gain')
      ? portRange('gain', 1)
      : { min: [readSoundSettings(values).gain], max: [readSoundSettings(values).gain] };
    const lo = Math.min(0, g.min[0]), hi = Math.max(0, g.max[0]);
    const res = sanitizeRange({ min: [lo, lo, lo, lo], max: [hi, hi, hi, hi] });
    cache.set(nodeId, res);
    return res;
  }

  // ─── Special-case nodes with analytical ranges ──────────────────────────
  const analytical = analyticalRange(node);
  if (analytical) {
    cache.set(nodeId, analytical);
    return analytical;
  }

  // ─── Try deterministic eval ─────────────────────────────────────────────
  // The evaluated value is the tightest range ONLY for a field-free chain;
  // below a field it is one arbitrary sample (docs/dev/codegen.md, "A SAMPLED
  // FIELD's value is not its range"). A non-finite value falls through to
  // interval arithmetic rather than collapsing to a NaN range.
  if (!getFieldUpstreamSet(nodes, edges).has(nodeId)) {
    const det = evaluateNodeOutput(nodeId, nodes, edges, time);
    if (det && det.length > 0 && det.every(Number.isFinite)) {
      result = rangeOfValue(det);
      cache.set(nodeId, result);
      return result;
    }
  }

  // ─── Range propagation through operations (interval arithmetic) ────────
  switch (type) {
    case 'add':
      result = naryRange(0, (amin, amax, bmin, bmax) => [amin + bmin, amax + bmax]);
      break;
    case 'sub':
      result = naryRange(0, (amin, amax, bmin, bmax) => [amin - bmax, amax - bmin]);
      break;
    case 'mul':
      result = naryRange(1, (amin, amax, bmin, bmax) => {
        const corners = [amin * bmin, amin * bmax, amax * bmin, amax * bmax];
        return [Math.min(...corners), Math.max(...corners)];
      });
      break;
    case 'div':
      // An all-int division truncates — monotone, so the ends truncate — and
      // by a divisor that can be 0 it has no value (see `evaluate`).
      result = isIntNode(nodeId, nodeIndex, edgeIndex)
        ? naryRange(1, (amin, amax, bmin, bmax) => {
          if (!(bmin > 0 || bmax < 0)) return [-Infinity, Infinity];
          const [lo, hi] = divRange(amin, amax, bmin, bmax);
          return [Math.trunc(lo), Math.trunc(hi)];
        })
        : naryRange(1, divRange);
      break;
    case 'oneMinus': {
      const x = portRange('x', 0);
      result = unaryRange(x, (lo, hi) => [1 - hi, 1 - lo]);
      break;
    }
    case 'abs': {
      const x = portRange('x', 0);
      result = unaryRange(x, (lo, hi) => {
        if (lo >= 0) return [lo, hi];
        if (hi <= 0) return [-hi, -lo];
        return [0, Math.max(-lo, hi)];
      });
      break;
    }
    case 'sin':
    case 'cos': {
      // Exact per channel (sinInterval): sin(uv·π) is the 0…1 arch it draws,
      // not the signed −1…1 a fixed bound read.
      const x = portRange('x', 0);
      result = unaryRange(x, (lo, hi) => (type === 'sin' ? sinInterval(lo, hi) : cosInterval(lo, hi)));
      break;
    }
    case 'fract': {
      // Inside one integer step fract is x − floor(x), increasing: its two ends.
      const x = portRange('x', 0);
      result = unaryRange(x, (lo, hi) =>
        Number.isFinite(lo) && Number.isFinite(hi) && Math.floor(lo) === Math.floor(hi)
          ? [lo - Math.floor(lo), hi - Math.floor(hi)]
          : [0, 1]);
      break;
    }
    case 'smoothstep': {
      // Per channel at the widest of edge0, edge1 and x (MathNode). Between
      // constant edges it is monotone in x (rising, or falling for reversed
      // edges — the working inverted ramp), so its two ends; equal constant
      // edges have no defined result (WebGPU rejects the module). Edges that
      // vary keep the curve's own 0…1.
      const x = portRange('x', 0), e0 = portRange('edge0', 0), e1 = portRange('edge1', 1);
      const n = Math.max(x.min.length, e0.min.length, e1.min.length);
      const X = rangeAtWidth(x, n), E0 = rangeAtWidth(e0, n), E1 = rangeAtWidth(e1, n);
      const min: number[] = [], max: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = E0.min[i], b = E1.min[i];
        const fixedEdges = a === E0.max[i] && b === E1.max[i];
        if (fixedEdges && a === b) { min.push(-Infinity); max.push(Infinity); continue; }
        if (!fixedEdges) { min.push(0); max.push(1); continue; }
        const ss = (v: number) => {
          const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
          return t * t * (3 - 2 * t);
        };
        min.push(Math.min(ss(X.min[i]), ss(X.max[i])));
        max.push(Math.max(ss(X.min[i]), ss(X.max[i])));
      }
      result = { min, max };
      break;
    }
    case 'sqrt': {
      // NaN below 0: an input wholly negative has no value; one reaching below
      // 0 is bounded on its in-domain part.
      const x = portRange('x', 0);
      result = unaryRange(x, (lo, hi) => (hi < 0 ? [NaN, NaN] : [Math.sqrt(Math.max(0, lo)), Math.sqrt(hi)]));
      break;
    }
    case 'exp': {
      const x = portRange('x', 0);
      result = unaryRange(x, (lo, hi) => [Math.exp(lo), Math.exp(hi)]);
      break;
    }
    case 'log2': {
      // −∞ at 0 and NaN below, as `evaluate` and the GPU have it — the old
      // 1e-10 floor printed −33.22 for a wire with no finite value.
      const x = portRange('x', 1);
      result = unaryRange(x, (lo, hi) => (hi <= 0 ? [NaN, NaN] : [lo > 0 ? Math.log2(lo) : -Infinity, Math.log2(hi)]));
      break;
    }
    case 'pow': {
      const base = portRange('base', 1);
      const exp = portRange('exp', 1);
      result = broadcastRange(base, exp, (blo, bhi, elo, ehi) => {
        // Only a base ≥ 0 has a value (`evaluate`'s pow rule), so the bound is
        // over that part; a base wholly below 0 has none. On it pow is
        // monotone in each argument separately, so the corners bound it — the
        // part's low end, 0 for a base straddling 0, is a corner itself.
        if (!(bhi >= 0)) return [NaN, NaN];
        const b0 = Math.max(blo, 0);
        const corners = [Math.pow(b0, elo), Math.pow(b0, ehi), Math.pow(bhi, elo), Math.pow(bhi, ehi)];
        // 0 to a negative power is +∞: unbounded, '…' on both surfaces.
        if (!corners.every(Number.isFinite)) return [-Infinity, Infinity];
        return [Math.min(...corners), Math.max(...corners)];
      });
      break;
    }
    case 'mod': {
      // FLOORED, as `evaluate` and both backends compute it: a positive
      // divisor lands in [0, y), a negative one in (y, 0], one reaching 0 is
      // unknown — and inside one period of a constant divisor it is x shifted,
      // so exactly its two ends. x's width (OperatorNode '%' returns typeA).
      const x = portRange('x', 0);
      const y = portRange('y', 1);
      if (isIntNode(nodeId, nodeIndex, edgeIndex)) {
        // All-int `%`: x ≥ 0 by y > 0 lands in [0, min(x, y − 1)]; anything
        // else has no one value (see `evaluate`).
        result = broadcastRange(x, y, (xlo, xhi, ylo, yhi) =>
          (xlo < 0 || !(ylo > 0) ? [-Infinity, Infinity] : [0, Math.min(xhi, yhi - 1)]), x.min.length);
        break;
      }
      result = broadcastRange(x, y, (xlo, xhi, ylo, yhi) => {
        if (ylo === yhi && ylo !== 0 && Number.isFinite(xlo) && Number.isFinite(xhi)
          && Math.floor(xlo / ylo) === Math.floor(xhi / ylo)) {
          const lo = xlo - ylo * Math.floor(xlo / ylo), hi = xhi - ylo * Math.floor(xhi / ylo);
          return [Math.min(lo, hi), Math.max(lo, hi)];
        }
        if (ylo > 0) return [0, yhi];
        if (yhi < 0) return [ylo, 0];
        return [-Infinity, Infinity];
      }, x.min.length);
      break;
    }
    case 'dot': {
      // Interval sum of the per-channel interval products at the wider width,
      // the narrower operand padded as TSL pads it.
      const a = portRange('a', 0);
      const b = portRange('b', 0);
      const wider = Math.max(a.min.length, b.min.length);
      const n = wider === 1 ? 3 : wider; // two scalars are emitted as vec3s
      const A = rangeAtWidth(a, n), B = rangeAtWidth(b, n);
      let lo = 0, hi = 0;
      for (let i = 0; i < n; i++) {
        const [l, h] = mulInterval([A.min[i], A.max[i]], [B.min[i], B.max[i]]);
        lo += l;
        hi += h;
      }
      result = { min: [lo], max: [hi] };
      break;
    }
    case 'hsl': {
      // Every channel is l + sat·(k − ½) with sat = s·(1 − |2l − 1|) and the hue
      // term k in [0, 1], so it lies in l ∓ ½·|s|·|1 − |2l − 1||: piecewise
      // linear in l (kinks at 0, ½, 1) at the largest |s|, so its extremes sit
      // at L's ends or a kink inside. Exact for any hue, [0, 1] for in-gamut S
      // and L — the unit cube it always claimed broke at Saturation 3 (−1…2)
      // or a Lightness above 1.
      const s = portRange('s', 1), l = portRange('l', 0.5);
      const sAbs = Math.max(Math.abs(s.min[0]), Math.abs(s.max[0]));
      const half = (v: number) => 0.5 * sAbs * Math.abs(1 - Math.abs(2 * v - 1));
      let lo = Infinity, hi = -Infinity;
      for (const v of [l.min[0], l.max[0], 0, 0.5, 1]) {
        if (!(v >= l.min[0] && v <= l.max[0])) continue;
        lo = Math.min(lo, v - half(v));
        hi = Math.max(hi, v + half(v));
      }
      result = { min: [lo, lo, lo], max: [hi, hi, hi] };
      break;
    }
    case 'toHsl': {
      // H is in [0, 1] for any input (|g − b| ≤ max − min), L = (max + min)/2
      // follows the input box, and S ≥ 0 is at most 1 only for an in-gamut box —
      // out of gamut it divides by a vanishing 1 − |2L − 1| (up to 1e10).
      const c = rangeAtWidth(portRange('rgb', 0), 3);
      const inGamut = c.min.every((v) => v >= 0) && c.max.every((v) => v <= 1);
      result = {
        min: [0, 0, (Math.max(...c.min) + Math.min(...c.min)) / 2],
        max: [1, inGamut ? 1 : Infinity, (Math.max(...c.max) + Math.min(...c.max)) / 2],
      };
      break;
    }
    case 'colorRamp': {
      // Exact over the half table: both ends plus every texel centre between
      // them (rangeHalf), so a ramp that dips between its stops is not
      // reported by its endpoints alone. ±Infinity bounds go through as they
      // are — ClampToEdge holds the end colours, so `−∞…1` is the whole ramp,
      // not the colour at 0.5 — and rangeHalf reads a NaN bound of a WIRED
      // Factor as unknown. An unwired one is `socketRange`'s finite value.
      const r = socketRange('fac', 0.5);
      result = rampRangeOver(readColorRamp(values), r.min[0] ?? 0.5, r.max[0] ?? 0.5);
      break;
    }
    case 'rgbCurves': {
      // Stage by stage over the half table (rgbCurvesRange): each curve is
      // piecewise linear with linear extensions, so ends + texel centres are
      // exact; the Factor mix is bounded on its corners. An unwired non-finite
      // stored value is the registry default codegen emits (`socketRange`);
      // anything unbounded with a non-zero end slope is unknown (null).
      const c = socketRange('color', 1);
      const f = socketRange('fac', 1);
      result = rgbCurvesRange(readRgbCurves(values), brightContrastRgb(c.min), brightContrastRgb(c.max), f.min[0] ?? 1, f.max[0] ?? 1);
      break;
    }
    case 'brightContrast': {
      // Per channel out = c + k·(c − 0.5) + bright: bilinear in (c, k) and
      // linear in bright, so the extremes sit on the box's corners; then the
      // helper's bottom clamp. An unbounded or NaN corner reports `0…∞`.
      const c = portRange('color', 1);
      const k = portRange('contrast', 0);
      const br = portRange('bright', 0);
      const lo = brightContrastRgb(c.min), hi = brightContrastRgb(c.max);
      const min: number[] = [], max: number[] = [];
      for (let i = 0; i < 3; i++) {
        const corners = [lo[i], hi[i]].flatMap((cv) => [k.min[0], k.max[0]].map((kv) => (1 + kv) * cv - kv * 0.5));
        const finite = corners.every(Number.isFinite);
        min.push(finite ? Math.max(Math.min(...corners) + br.min[0], 0) : 0);
        max.push(finite ? Math.max(Math.max(...corners) + br.max[0], 0) : Infinity);
      }
      result = { min, max };
      break;
    }
    case 'floor':
    case 'round': {
      const x = portRange('x', 0);
      const fn = type === 'floor' ? Math.floor : roundHalfEven;
      result = unaryRange(x, (lo, hi) => [fn(lo), fn(hi)]);
      break;
    }
    case 'min': {
      // Identity fallback (1), matching the evaluator and registry defaults —
      // an unwired operand is min's identity over [0,1], not the annihilator 0.
      const a = portRange('a', 1);
      const b = portRange('b', 1);
      result = broadcastRange(a, b, (amin, amax, bmin, bmax) => [
        Math.min(amin, bmin),
        Math.min(amax, bmax),
      ]);
      break;
    }
    case 'max': {
      const a = portRange('a', 0);
      const b = portRange('b', 0);
      result = broadcastRange(a, b, (amin, amax, bmin, bmax) => [
        Math.max(amin, bmin),
        Math.max(amax, bmax),
      ]);
      break;
    }
    case 'clamp': {
      // min(max(x, low), high) never decreases as any argument grows, so per
      // channel (at the widest width, MathNode) its ends are the formula at the
      // low corner and at the high corner — it can never come out inverted, as
      // the old [max(xlo, low), min(xhi, high)] did for an x wholly outside
      // (clamp(uv, 1.5, 2) read "2…1"). Low certainly above high has no defined
      // result (a WGSL error with constant bounds): unknown.
      const x = portRange('x', 0), lo = portRange('min', 0), hi = portRange('max', 1);
      const n = Math.max(x.min.length, lo.min.length, hi.min.length);
      const X = rangeAtWidth(x, n), L = rangeAtWidth(lo, n), H = rangeAtWidth(hi, n);
      const min: number[] = [], max: number[] = [];
      for (let i = 0; i < n; i++) {
        const undefinedOrder = L.min[i] > H.max[i];
        min.push(undefinedOrder ? -Infinity : Math.min(Math.max(X.min[i], L.min[i]), H.min[i]));
        max.push(undefinedOrder ? Infinity : Math.min(Math.max(X.max[i], L.max[i]), H.max[i]));
      }
      result = { min, max };
      break;
    }
    case 'mix': {
      // a + (b − a)·t is multilinear in (a, b, t), so per channel (widest width)
      // its extremes sit on the 8 corners of the box — exact, and a Factor
      // outside 0…1 extrapolates past both ends as the unclamped shader does.
      // The union of A and B assumed t in [0, 1]: signed Perlin into t read
      // 0.2…0.8 for a wire reaching −0.4.
      const a = portRange('a', 0), b = portRange('b', 1), t = portRange('t', 0.5);
      const n = Math.max(a.min.length, b.min.length, t.min.length);
      const A = rangeAtWidth(a, n), B = rangeAtWidth(b, n), T = rangeAtWidth(t, n);
      const min: number[] = [], max: number[] = [];
      for (let i = 0; i < n; i++) {
        const c: number[] = [];
        for (const av of [A.min[i], A.max[i]]) {
          for (const bv of [B.min[i], B.max[i]]) {
            for (const tv of [T.min[i], T.max[i]]) c.push(av + (bv - av) * tv);
          }
        }
        const bad = c.some(Number.isNaN);
        min.push(bad ? NaN : Math.min(...c));
        max.push(bad ? NaN : Math.max(...c));
      }
      result = { min, max };
      break;
    }
    case 'remap': {
      // The same OperatorNode steps `evaluate` takes, UNCLAMPED (TSL's remap
      // leaves doClamp off), each by interval arithmetic at its wider operand's
      // width — exact when the four bounds are constants, the usual case (the
      // map is then affine). An In range that can collapse (In High − In Low
      // reaching 0) is unknown. It was [Out Low, Out High] whatever x did.
      const x = portRange('x', 0);
      const iL = portRange('inLow', 0), iH = portRange('inHigh', 1);
      const oL = portRange('outLow', 0), oH = portRange('outHigh', 1);
      const sub = (a: RangeResult, b: RangeResult) => broadcastRange(a, b, (al, ah, bl, bh) => [al - bh, ah - bl]);
      const t = broadcastRange(sub(x, iL), sub(iH, iL), divRange);
      const scaled = broadcastRange(t, sub(oH, oL), (al, ah, bl, bh) => mulInterval([al, ah], [bl, bh]));
      result = broadcastRange(scaled, oL, (al, ah, bl, bh) => [al + bl, ah + bh]);
      break;
    }
    case 'select': {
      // Either branch: their union, at the wider width.
      const a = portRange('a', 0);
      const b = portRange('b', 0);
      result = broadcastRange(a, b, (amin, amax, bmin, bmax) => [
        Math.min(amin, bmin),
        Math.max(amax, bmax),
      ]);
      break;
    }
    case 'greaterThan':
    case 'lessThan':
    case 'equal': {
      // 0/1 per channel at the wider width — a definite 1 or 0 where the two
      // intervals cannot overlap the other way.
      const a = portRange('a', 0);
      const b = portRange('b', 0);
      result = broadcastRange(a, b, (amin, amax, bmin, bmax) => {
        if (type === 'greaterThan') return amin > bmax ? [1, 1] : amax <= bmin ? [0, 0] : [0, 1];
        if (type === 'lessThan') return amax < bmin ? [1, 1] : amin >= bmax ? [0, 0] : [0, 1];
        return amax < bmin || amin > bmax ? [0, 0] : [0, 1];
      });
      break;
    }
    case 'vec2':
    case 'vec3':
    case 'vec4': {
      // JoinNode, as in `evaluate`: every socket's channels in order, cut at N.
      const width = type === 'vec2' ? 2 : type === 'vec3' ? 3 : 4;
      const min: number[] = [];
      const max: number[] = [];
      for (const input of def.inputs) {
        if (min.length >= width) break;
        const r = portRange(input.id, 0);
        min.push(...r.min);
        max.push(...r.max);
      }
      result = { min: min.slice(0, width), max: max.slice(0, width) };
      break;
    }
    case 'cross': {
      // Per component by interval products, both operands built as vec3.
      const a = rangeAtWidth(portRange('a', 0), 3), b = rangeAtWidth(portRange('b', 0), 3);
      const term = (i: number, j: number): [number, number] => {
        const p = mulInterval([a.min[i], a.max[i]], [b.min[j], b.max[j]]);
        const q = mulInterval([a.min[j], a.max[j]], [b.min[i], b.max[i]]);
        return [p[0] - q[1], p[1] - q[0]];
      };
      const cx = term(1, 2), cy = term(2, 0), cz = term(0, 1);
      result = { min: [cx[0], cy[0], cz[0]], max: [cx[1], cy[1], cz[1]] };
      break;
    }
    case 'split': {
      // `evaluate`'s rule on ranges: the upstream's whole (bare) interval padded
      // as SplitNode pads it, or a scalar socket's own interval in .x alone. The
      // consumer slices x/y/z/w (handleSlice).
      const input = nodeEdges.find((e) => e.targetHandle === 'v');
      const src = input ? nodeIndex.get(input.source) : undefined;
      if (!input || !src || !hasOwnVariable(src)) break;
      const whole = computeRange(input.source, nodes, edges, time, cache, nodeIndex, edgeIndex);
      result = splitReadsScalarSocket(src, input.sourceHandle)
        ? sliceRange(whole, handleChannels(src, input.sourceHandle)) ?? unboundedRange(1)
        : whole && whole.min.length > 0 ? rangeAtWidth(whole, 4) : unboundedRange(4);
      break;
    }
    case 'time': {
      // t·speed with the speed read as a range — a field-fed speed varies per
      // pixel, so the deterministic shortcut cannot answer.
      const s = portRange('speed', 1);
      const a = time * s.min[0], b = time * s.max[0];
      result = { min: [Math.min(a, b)], max: [Math.max(a, b)] };
      break;
    }
    // ===== DATA VIZ (graphToCode's hand emission) — no CPU sample, but a bound:
    // without one, every wire below them read '…' (once it read a guessed 0…1).
    case 'colormap':
      // A ClampToEdge LUT of linear-light colours: 0…1 per channel, any input.
      result = { min: [0, 0, 0], max: [1, 1, 1] };
      break;
    case 'isolines':
      // Line coverage, mixed toward its own average where contours crowd.
      result = { min: [0], max: [1] };
      break;
    case 'stripes':
    case 'dataviz': {
      // mix(low, high, t) with t clamped to 0…1 (or the 0…1 ramp coordinate),
      // so per channel the hull of the two ramp ends — Stripes then darkens by
      // its lines, × [1 − Line Strength, 1]. Data Viz's whole vector also
      // carries t as a fourth channel, its `value` socket (handleChannels).
      const lo = rampEndRange('lowColor'), hi = rampEndRange('highColor');
      const strength = type === 'stripes' ? valueNum(values.lineStrength ?? 0.75) : 0;
      const s = Number.isFinite(strength) ? Math.min(Math.max(strength, 0), 1) : 0.75;
      const min: number[] = [], max: number[] = [];
      for (let i = 0; i < 3; i++) {
        const hull: [number, number] = [Math.min(lo.min[i], hi.min[i]), Math.max(lo.max[i], hi.max[i])];
        const [l, h] = mulInterval(hull, [1 - s, 1]);
        min.push(l);
        max.push(h);
      }
      if (type === 'dataviz') { min.push(0); max.push(1); }
      result = { min, max };
      break;
    }
    case 'dataRange': {
      // Raw units → 0…1 through the plan codegen bakes (planNormalize over the
      // same one-hop column statistics, traceSignalColumn's rule); every plan
      // is increasing, so the map of an interval is its two ends. `clamp` (on by
      // default) holds it in 0…1; a custom formula has no interval rule here.
      const doClamp = valueNum(values.clamp ?? 1) >= 0.5;
      if (hasCustomFormula(values.formula)) {
        result = doClamp ? { min: [0], max: [1] } : unboundedRange(1);
        break;
      }
      const edge = nodeEdges.find((e) => e.targetHandle === 'value');
      const x = edge ? portRange('value', 0) : { min: [0], max: [1] }; // unwired: uv().x
      const stats = edge ? dataColumnStats(nodeIndex.get(edge.source), edge.sourceHandle) : null;
      const mode = isNormalizeMode(values.mode) ? values.mode : 'minmax';
      const f = normalizeFn(planNormalize(mode, stats, {
        lo: valueNum(values.domainMin ?? 0),
        hi: valueNum(values.domainMax ?? 1),
      }));
      const ends = [f(x.min[0]), f(x.max[0])].map((v) => (doClamp ? Math.min(Math.max(v, 0), 1) : v));
      result = { min: [ends[0]], max: [ends[1]] };
      break;
    }
    case 'append': {
      // Concatenate every operand's range, truncated at 4 channels — the same
      // effective-operand walk evaluate() does, so grown operands past `b`
      // keep their bounds instead of silently dropping out of the interval.
      const min: number[] = [];
      const max: number[] = [];
      for (const inp of appendOperands(nodeId, nodeIndex, edgeIndex)) {
        if (min.length >= 4) break;
        const r = portRange(inp.id, 0);
        min.push(...r.min.slice(0, 4 - min.length));
        max.push(...r.max.slice(0, 4 - max.length));
      }
      result = { min, max };
      break;
    }
    case 'normalize': {
      // Components of a unit vector are in [-1, 1] per axis (a scalar is emitted as a vec3)
      const v = portRange('v', 1);
      const width = v.min.length === 1 ? 3 : v.min.length;
      result = { min: Array<number>(width).fill(-1), max: Array<number>(width).fill(1) };
      break;
    }
    case 'length':
    case 'distance': {
      // Euclidean norm of the per-channel intervals: of `v` itself, or of the
      // element-wise difference for `distance`.
      const d =
        type === 'length'
          ? portRange('v', 0)
          : broadcastRange(portRange('a', 0), portRange('b', 0), (amin, amax, bmin, bmax) => [
              amin - bmax,
              amax - bmin,
            ]);
      const [dLo, dHi] = normRange(d);
      result = { min: [dLo], max: [dHi] };
      break;
    }
    // ===== DISTANCE FIELDS =====
    case 'sdCircle': {
      // |p| over the per-channel intervals (the `length` rule), minus the radius.
      const p = portRange('p', 0);
      const r = portRange('r', 0.5);
      const [pLo, pHi] = normRange(p);
      result = { min: [pLo - r.max[0]], max: [pHi - r.min[0]] };
      break;
    }
    case 'sdCombine': {
      // The fillet moves the seam by at most k/4 outward (union) or inward
      // (intersect/subtract); xor has no cheap honest bound — `…`.
      const mode = sdCombineMode(node);
      const a = portRange('a', 0), b = portRange('b', 0), k = portRange('k', 0);
      const slack = Math.max(0, k.max[0]) / 4;
      if (mode === 'union') result = { min: [Math.min(a.min[0], b.min[0]) - slack], max: [Math.min(a.max[0], b.max[0])] };
      else if (mode === 'intersect') result = { min: [Math.max(a.min[0], b.min[0])], max: [Math.max(a.max[0], b.max[0]) + slack] };
      else if (mode === 'subtract') result = { min: [Math.max(a.min[0], -b.max[0])], max: [Math.max(a.max[0], -b.min[0]) + slack] };
      else result = null;
      break;
    }
    case 'sdfMask': {
      result = { min: [0], max: [1] };
      break;
    }
    case 'sdfModify': {
      const d = portRange('d', 0), a = portRange('amount', 0.05);
      const mode = values.mode;
      if (mode === 'scale') {
        const c = [d.min[0] * a.min[0], d.min[0] * a.max[0], d.max[0] * a.min[0], d.max[0] * a.max[0]];
        result = { min: [Math.min(...c)], max: [Math.max(...c)] };
      } else if (mode === 'shell') {
        result = { min: [-a.max[0]], max: [Math.max(Math.abs(d.min[0]), Math.abs(d.max[0])) - a.min[0]] };
      } else result = { min: [d.min[0] - a.max[0]], max: [d.max[0] - a.min[0]] };
      break;
    }
    case 'sdBox':
    case 'sdTorus':
    case 'sdCylinder':
    case 'sdCapsule':
    case 'sdCone':
    case 'sdPlane':
    case 'sdOctahedron':
    case 'sdStar':
      // The Lipschitz bound (sdfLipschitzRange); unknown when a shape
      // parameter varies.
      result = sdfLipschitzRange(type, portRange('p', 0), portRange);
      break;
    // ===== SDF DOMAIN OPERATORS — positions in, positions out (vec3) =====
    case 'sdfTransform': {
      // q0 = (p − t)/max(s, 1e-6) per channel; a Turn then rotates about the
      // origin, which keeps |q0| — so a turned box is bounded by its farthest
      // point on every channel.
      const p = rangeAtWidth(portRange('p', 0), 3);
      const t = rangeAtWidth(portRange('t', 0), 3), r = rangeAtWidth(portRange('r', 0), 3), s = rangeAtWidth(portRange('s', 1), 3);
      const q = [0, 1, 2].map((i) =>
        divRange(p.min[i] - t.max[i], p.max[i] - t.min[i], Math.max(s.min[i], 1e-6), Math.max(s.max[i], 1e-6)));
      if (r.min.every((v) => v === 0) && r.max.every((v) => v === 0)) {
        result = { min: q.map((c) => c[0]), max: q.map((c) => c[1]) };
      } else {
        const R = Math.hypot(...q.map(([lo, hi]) => Math.max(Math.abs(lo), Math.abs(hi))));
        result = { min: [-R, -R, -R], max: [R, R, R] };
      }
      break;
    }
    case 'sdfMirror': {
      // v + (|v| − v)·w per axis: linear in w, piecewise linear in v (kink at
      // 0), so its extremes sit on those corners.
      const p = rangeAtWidth(portRange('p', 0), 3), w = rangeAtWidth(portRange('m', 1), 3);
      const min: number[] = [], max: number[] = [];
      for (let i = 0; i < 3; i++) {
        const vs = [p.min[i], p.max[i]];
        if (p.min[i] < 0 && p.max[i] > 0) vs.push(0);
        const c = vs.flatMap((v) => [w.min[i], w.max[i]].map((wv) => v + (Math.abs(v) - v) * wv));
        min.push(Math.min(...c));
        max.push(Math.max(...c));
      }
      result = { min, max };
      break;
    }
    case 'sdfRevolve': {
      // (|p.xz| − o, p.y): the profile's 2D position.
      const p = rangeAtWidth(portRange('p', 0), 3), o = portRange('o', 0.5);
      const [lo, hi] = normRange({ min: [p.min[0], p.min[2]], max: [p.max[0], p.max[2]] });
      result = { min: [lo - o.max[0], p.min[1]], max: [hi - o.min[0], p.max[1]] };
      break;
    }
    case 'sdfRepeatPolar': {
      // x, z = r·cos/sin of the folded angle, r the xz radius; y unchanged.
      const p = rangeAtWidth(portRange('p', 0), 3);
      const rho = normRange({ min: [p.min[0], p.min[2]], max: [p.max[0], p.max[2]] })[1];
      result = { min: [-rho, p.min[1], -rho], max: [rho, p.max[1], rho] };
      break;
    }
    case 'sdfRepeat': {
      // Per axis v − s·k, k = round(v/s) clamped to ±Limit: one cell (or the
      // clamped outer cells) is v shifted; across cells it is within ±s/2, plus
      // what lies past a Limit. Spacing 0 leaves the axis alone (the helper's
      // select). A swept Spacing or Limit is unknown.
      const p = rangeAtWidth(portRange('p', 0), 3);
      const s = rangeAtWidth(portRange('s', 1), 3), l = rangeAtWidth(portRange('l', 0), 3);
      const min: number[] = [], max: number[] = [];
      for (let i = 0; i < 3; i++) {
        const lo = p.min[i], hi = p.max[i], sp = s.min[i], lim = l.min[i];
        let r: [number, number];
        if (sp !== s.max[i] || lim !== l.max[i]) r = [-Infinity, Infinity];
        else if (!(sp > 0)) r = [lo, hi];
        // Below the helper's 1e-6 floor it divides by 1e-6 but subtracts s·k:
        // the residue is no longer within ±s/2.
        else if (sp < 1e-6) r = [-Infinity, Infinity];
        else {
          const cell = (v: number) => {
            const k = roundHalfEven(v / Math.max(sp, 1e-6));
            return lim > 0 ? Math.min(Math.max(k, -lim), lim) : k;
          };
          if (Number.isFinite(lo) && Number.isFinite(hi) && cell(lo) === cell(hi)) r = [lo - sp * cell(lo), hi - sp * cell(lo)];
          else if (!(lim > 0)) r = [-sp / 2, sp / 2];
          else r = [Math.min(-sp / 2, lo + sp * lim), Math.max(sp / 2, hi - sp * lim)];
        }
        min.push(r[0]);
        max.push(r[1]);
      }
      result = { min, max };
      break;
    }
    case 'sdfDeform': {
      // Twist and Bend rotate within a plane, keeping that plane's radius;
      // Elongate is v − clamp(v, −h, h): for h ≥ 0 monotone in v and in h
      // separately, so its corners bound it. A half size that can go below 0 is
      // low > high in that clamp — undefined on the GPU — so unknown.
      const p = rangeAtWidth(portRange('p', 0), 3);
      if (values.mode === 'elongate') {
        const h = rangeAtWidth(portRange('h', 0), 3);
        const min: number[] = [], max: number[] = [];
        for (let i = 0; i < 3; i++) {
          if (!(h.min[i] >= 0)) { min.push(-Infinity); max.push(Infinity); continue; }
          const c = [p.min[i], p.max[i]].flatMap((v) => [h.min[i], h.max[i]].map((hv) => v - Math.min(Math.max(v, -hv), hv)));
          min.push(Math.min(...c));
          max.push(Math.max(...c));
        }
        result = { min, max };
      } else if (values.mode === 'bend') {
        const rho = normRange({ min: [p.min[0], p.min[1]], max: [p.max[0], p.max[1]] })[1];
        result = { min: [-rho, -rho, p.min[2]], max: [rho, rho, p.max[2]] };
      } else {
        const rho = normRange({ min: [p.min[0], p.min[2]], max: [p.max[0], p.max[2]] })[1];
        result = { min: [-rho, p.min[1], -rho], max: [rho, p.max[1], rho] };
      }
      break;
    }
    case 'sdfExtrude': {
      // min(max(d, w), 0) + |(max(d, 0), max(w, 0))| with w = |p.z| − h never
      // decreases as d or w grows: its ends are the low and the high corner.
      const d = portRange('d', 0), h = portRange('h', 0.2), p = rangeAtWidth(portRange('p', 0), 3);
      const zlo = p.min[2], zhi = p.max[2];
      const absLo = zlo <= 0 && zhi >= 0 ? 0 : Math.min(Math.abs(zlo), Math.abs(zhi));
      const absHi = Math.max(Math.abs(zlo), Math.abs(zhi));
      const g = (dv: number, wv: number) => Math.min(Math.max(dv, wv), 0) + Math.hypot(Math.max(dv, 0), Math.max(wv, 0));
      result = { min: [g(d.min[0], absLo - h.max[0])], max: [g(d.max[0], absHi - h.min[0])] };
      break;
    }
  }

  if (result) result = sanitizeRange(result);
  cache.set(nodeId, result);
  return result;
}

/** Unknown on each of `n` channels. */
function unboundedRange(n: number): RangeResult {
  return { min: Array(Math.max(n, 1)).fill(-Infinity), max: Array(Math.max(n, 1)).fill(Infinity) };
}

/**
 * No interval leaves computeRange holding NaN or upside down: a NaN low end is
 * −∞ and a NaN high end +∞ (a 0·∞ corner, ∞ − ∞), and an inverted channel is
 * unknown. So a later self-bounding rule (clamp, sin, fract) still reports its
 * own bound instead of inheriting NaN, and no label prints an interval that
 * excludes every value. Returns `r` itself when nothing needed fixing.
 */
function sanitizeRange(r: RangeResult): RangeResult {
  const n = Math.min(r.min.length, r.max.length);
  let clean = r.min.length === r.max.length;
  for (let i = 0; clean && i < n; i++) {
    if (Number.isNaN(r.min[i]) || Number.isNaN(r.max[i]) || r.min[i] > r.max[i]) clean = false;
  }
  if (clean) return r;
  const min: number[] = [], max: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Number.isNaN(r.min[i]) ? -Infinity : r.min[i];
    const hi = Number.isNaN(r.max[i]) ? Infinity : r.max[i];
    if (lo > hi) { min.push(-Infinity); max.push(Infinity); } else { min.push(lo); max.push(hi); }
  }
  return { min, max };
}

/** [lo, hi] of a product of two intervals: its four corners (a 0·∞ corner is
 *  NaN, which sanitizeRange turns into an unknown end). */
function mulInterval(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  const c = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return c.some(Number.isNaN) ? [NaN, NaN] : [Math.min(...c), Math.max(...c)];
}

/**
 * [lo, hi] of a/b over two intervals. A divisor away from 0 is the four corners.
 * One that REACHES 0 makes the quotient unbounded there: touching 0 from one
 * side with a numerator of known sign keeps the other end (0.05 / length(uv − ½)
 * is 0.07…∞, which a later clamp still bounds), anything else is unknown. It
 * used to be an invented [0, 1] — the glow read 0…1 for a wire reaching 36.
 */
function divRange(amin: number, amax: number, bmin: number, bmax: number): [number, number] {
  if (bmin > 0 || bmax < 0) {
    const c = [amin / bmin, amin / bmax, amax / bmin, amax / bmax];
    return c.some(Number.isNaN) ? [NaN, NaN] : [Math.min(...c), Math.max(...c)];
  }
  if (bmin === 0 && bmax > 0) {
    if (amin >= 0) return [amin / bmax, Infinity];
    if (amax <= 0) return [-Infinity, amax / bmax];
  }
  if (bmax === 0 && bmin < 0) {
    if (amin >= 0) return [-Infinity, amin / bmin];
    if (amax <= 0) return [amax / bmin, Infinity];
  }
  return [-Infinity, Infinity];
}

/**
 * The statistics graphToCode's Data Range plans over (traceSignalColumn →
 * columnForHandle → columnStats: one hop to a Data column of more than one
 * row), memoised per decoded column — the views are stable through
 * decodeDataNode's memo, and a sort of up to 8192 samples per range pass
 * re-ran on every edit and every tick (~1–2 ms each). decodeDataNode refuses
 * more rows than one texture holds, so the column IS what capToWidth bakes.
 */
const COLUMN_STATS_MEMO = new WeakMap<Float32Array, ColumnStats>();
function dataColumnStats(src: AppNode | undefined, handle: string | null | undefined): ColumnStats | null {
  if (src?.data.registryType !== 'dataNode' || typeof handle !== 'string') return null;
  const m = /^col(\d+)$/.exec(handle);
  const col = m ? decodeDataNode(getNodeValues(src))?.columns[Number(m[1])] : undefined;
  if (!col || col.length <= 1) return null;
  let stats = COLUMN_STATS_MEMO.get(col);
  if (!stats) {
    stats = columnStats(col);
    COLUMN_STATS_MEMO.set(col, stats);
  }
  return stats;
}

/** Data Range's plan as the per-fragment map graphToCode emits for it — each
 *  increasing in v (affine over a positive span, log over its floored domain,
 *  the odd symlog), so an interval maps to its two ends. */
function normalizeFn(plan: NormalizePlan): (v: number) => number {
  if (plan.kind === 'affine') {
    const inv = 1 / (plan.hi - plan.lo);
    return (v) => (v - plan.lo) * inv;
  }
  if (plan.kind === 'log') {
    const l0 = Math.log2(plan.lo);
    const inv = 1 / (Math.log2(plan.hi) - l0);
    return (v) => (Math.log2(Math.max(v, plan.lo)) - l0) * inv;
  }
  const invT = 1 / plan.thresh;
  const invY = 1 / Math.log2(1 + plan.m / plan.thresh);
  return (v) => Math.sign(v) * Math.log2(Math.abs(v) * invT + 1) * invY * 0.5 + 0.5;
}

const TWO_PI = 2 * Math.PI;

/** Does `phase + 2πk` fall inside [a, b] for some integer k? */
function hitsPhase(a: number, b: number, phase: number): boolean {
  return Math.ceil((a - phase) / TWO_PI) <= Math.floor((b - phase) / TWO_PI);
}

/** sin over [a, b], exact: the end values, widened to ±1 wherever a crest
 *  (π/2 + 2πk) or a trough (−π/2 + 2πk) lies inside. */
function sinInterval(a: number, b: number): [number, number] {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b - a >= TWO_PI) return [-1, 1];
  const sa = Math.sin(a), sb = Math.sin(b);
  return [
    hitsPhase(a, b, -Math.PI / 2) ? -1 : Math.min(sa, sb),
    hitsPhase(a, b, Math.PI / 2) ? 1 : Math.max(sa, sb),
  ];
}

/** cos over [a, b] — cos x = sin(x + π/2). */
function cosInterval(a: number, b: number): [number, number] {
  return sinInterval(a + Math.PI / 2, b + Math.PI / 2);
}

/**
 * The UV node's interval, through the emitted map: s = uv·(U, V) with uv in
 * [0, 1]² — so u·U spans the corners 0·U and 1·U — and, with a turn θ, the
 * centred box (s − ½) rotated, + ½. The turn is linear in that box, so interval
 * products give the exact axis-aligned bound for a constant θ (45° on the unit
 * square: −0.207…1.207) and a sound one for a swept θ. Rotation 0 skips the turn,
 * as codegen does, so an untouched UV stays exactly 0…1.
 */
function uvRange(tu: RangeResult, tv: RangeResult, rot: RangeResult): RangeResult {
  const su: [number, number] = [Math.min(0, tu.min[0]), Math.max(0, tu.max[0])];
  const sv: [number, number] = [Math.min(0, tv.min[0]), Math.max(0, tv.max[0])];
  if (rot.min[0] === 0 && rot.max[0] === 0) return { min: [su[0], sv[0]], max: [su[1], sv[1]] };
  const cu: [number, number] = [su[0] - 0.5, su[1] - 0.5];
  const cv: [number, number] = [sv[0] - 0.5, sv[1] - 0.5];
  const c = cosInterval(rot.min[0], rot.max[0]), s = sinInterval(rot.min[0], rot.max[0]);
  const ucos = mulInterval(cu, c), vsin = mulInterval(cv, s), usin = mulInterval(cu, s), vcos = mulInterval(cv, c);
  return {
    min: [ucos[0] - vsin[1] + 0.5, usin[0] + vcos[0] + 0.5],
    max: [ucos[1] - vsin[0] + 0.5, usin[1] + vcos[1] + 0.5],
  };
}


/** Combine's mode, validated (utils-free twin of moduleHelpers.modeOf). */
function sdCombineMode(node: AppNode): string {
  const v = getNodeValues(node).mode;
  return v === 'subtract' || v === 'intersect' || v === 'xor' ? v : 'union';
}

/** IQ's k-normalised quadratic smooth-min family — the GPU helper's twin. */
function sdCombineValue(mode: string, a: number, b: number, k: number): number {
  const kk = Math.max(k, 1e-6);
  const smin = (x: number, y: number) => {
    const h = Math.max(kk - Math.abs(x - y), 0);
    return Math.min(x, y) - (h * h) / (4 * kk);
  };
  if (mode === 'xor') return Math.max(Math.min(a, b), -Math.max(a, b));
  if (mode === 'intersect') return -smin(-a, -b);
  if (mode === 'subtract') return -smin(-a, b);
  return smin(a, b);
}

/** getLiveUpstreamSet's memo, one set per shared ctx (so per graph version). */
const liveUpstreamByCtx = new WeakMap<EvalCtx, ReadonlySet<string>>();

/**
 * Every node whose value CHANGES ON ITS OWN (nodes included): fed by a Time
 * node, or by the Sound node. The canvas's "this wire is live" question — a
 * live wire marches, a still one is drawn solid with direction chevrons
 * (TypedEdge, PreviewLink). One forward BFS over the UNWRAPPED edges, memoized
 * on the same ctx as getTimeUpstreamSet, so a per-edge selector pays a Set
 * lookup per notify. Sound is seeded whether or not a capture is armed: the
 * armed state lives in soundSession, outside the store, and a graph does not
 * change when the microphone does.
 */
export function getLiveUpstreamSet(nodes: AppNode[], edges: AppEdge[]): ReadonlySet<string> {
  const ctx = getCtx(nodes, edges);
  let live = liveUpstreamByCtx.get(ctx);
  if (!live) {
    live = buildDownstreamClosure(nodes, ctx.evalEdges, (n) =>
      n.data.registryType === 'time' || n.data.registryType === 'soundNode');
    liveUpstreamByCtx.set(ctx, live);
  }
  return live;
}
