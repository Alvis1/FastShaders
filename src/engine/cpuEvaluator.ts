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
import { hexToRgb01 } from '@/utils/colorUtils';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { hasNoiseRangeFlag, isUnsignedNoise } from '@/utils/noiseRange';
import { sameGraphSemantics } from '@/utils/graphSemantics';
import { buildTimeUpstreamSet, buildDownstreamClosure } from '@/utils/graphTraversal';
import { IMAGE_CHANNEL_INDEX } from '@/utils/imageChannels';
import { fresnelFacing } from '@/utils/fresnel';
import { readColorRamp, rampFetch, rampRangeOver } from '@/utils/colorRamp';

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
  const connected = (edgeIndex.get(nodeId) ?? [])
    .filter((e) => typeof e.targetHandle === 'string')
    .map((e) => e.targetHandle as string);
  return effectiveInputs(def, connected, false, Object.keys(getNodeValues(node)));
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
    ctx = {
      edges: unwrapped,
      nodeIndex: buildNodeIndex(nodes),
      edgeIndex: buildEdgeIndex(unwrapped),
      evalCache0: new Map(),
      evalCachesT: new Map(),
      rangeCache0: new Map(),
      rangeCachesT: new Map(),
      shapeCache: new Map(),
      edgeById: null,
      timeUpstream: null,
      fieldUpstream: null,
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
  if (!ctx.timeUpstream) ctx.timeUpstream = buildTimeUpstreamSet(nodes, ctx.edges);
  return ctx.timeUpstream;
}

/**
 * Every node fed by a sampled FIELD (fields included), memoized on the ctx and
 * seeded by `analyticalRange` so the two cannot drift. A field's evaluated
 * value is ONE sample, never a bound: consumers must take the interval path
 * (docs/dev/codegen.md, "A SAMPLED FIELD's value is not its range").
 */
export function getFieldUpstreamSet(nodes: AppNode[], edges: AppEdge[]): ReadonlySet<string> {
  const ctx = getCtx(nodes, edges);
  if (!ctx.fieldUpstream) {
    ctx.fieldUpstream = buildDownstreamClosure(nodes, ctx.edges, (n) => analyticalRange(n) !== null);
  }
  return ctx.fieldUpstream;
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
    return evaluate(nodeId, time, cache, ctx.edgeIndex, ctx.nodeIndex);
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

function computeShape(
  nodeId: string,
  visited: Set<string>,
  nidx: Map<string, AppNode>,
  edgeIndex: Map<string, AppEdge[]>,
): number {
  if (visited.has(nodeId)) return 1;
  visited.add(nodeId);

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
        : computeShape(e.source, visited, nidx, edgeIndex);
    }
    return Math.min(Math.max(total, 2), 4);
  }

  // 3. Default broadcast: output shape = max of all connected input shapes (vec3 + scalar = vec3).
  let maxShape = 1;
  for (const input of def.inputs) {
    const e = targetEdges.find((edge) => edge.targetHandle === input.id);
    if (e) {
      // Per SOURCE SOCKET, as in the append branch (pinned by socketWidthPins.test.ts).
      const src = nidx.get(e.source);
      const declared = src && e.sourceHandle ? portShapeForHandle(src, e.sourceHandle) : 0;
      const s = declared > 0
        ? declared
        : computeShape(e.source, visited, nidx, edgeIndex);
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
  return handleSlice(node, handle);
}

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
  const res = evaluateNodeOutput(edge.source, nodes, edges, time);
  const node = getCtx(nodes, edges).nodeIndex.get(edge.source);
  return sliceEval(res, handleChannels(node, edge.sourceHandle));
}

/** Inferred range for the value arriving along `edge` (same projection). */
export function evaluateEdgeRange(
  edge: Pick<AppEdge, 'source' | 'sourceHandle'>,
  nodes: AppNode[],
  edges: AppEdge[],
  time: number,
): RangeResult | null {
  const r = evaluateNodeRange(edge.source, nodes, edges, time);
  const node = getCtx(nodes, edges).nodeIndex.get(edge.source);
  return sliceRange(r, handleChannels(node, edge.sourceHandle));
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
  const dyn = (node.data as { dynamicOutputs?: { id: string; dataType: string }[] }).dynamicOutputs;
  const dynPort = dyn?.find((o) => o.id === handle);
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
      if (upstream !== null && upstream.length > 0) return upstream[0];
    }
    const v = values[portId];
    return v !== undefined ? Number(v) : fallback;
  };

  // A scalar input read exactly as codegen's resolveArguments reads it: wired →
  // the upstream channel when finite, else null (unknown); unwired → the stored
  // value when finite, else `fallback` (the registry default codegen emits).
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
    const v = valueNum(values[portId]);
    return Number.isFinite(v) ? v : fallback;
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
    const v = values[portId];
    return [v !== undefined ? Number(v) : fallback];
  };

  // A vec3 INPUT SOCKET, read as the emitted SDF helpers read one: an unwired
  // scalar default BROADCASTS (`vec3(0.5)` is a box, not a flat sheet) and a
  // short wired vector fills from its LAST component, matching TSL
  // (docs/dev/sdf-and-raymarch.md).
  const vec3Input = (portId: string, fallback: number): [number, number, number] => {
    const v = channelInput(portId, fallback);
    if (!v || v.length === 0) return [fallback, fallback, fallback];
    const x = v[0] ?? fallback;
    return [x, v[1] ?? x, v[2] ?? v[1] ?? x];
  };

  // Apply a unary function component-wise
  const unaryOp = (portId: string, fallback: number, fn: (x: number) => number): EvalResult => {
    const inp = channelInput(portId, fallback);
    if (!inp) return null;
    return inp.map(fn);
  };

  // Apply a binary function component-wise (broadcast shorter to longer)
  const binaryOp = (
    portA: string, fallA: number,
    portB: string, fallB: number,
    fn: (a: number, b: number) => number,
  ): EvalResult => {
    const a = channelInput(portA, fallA);
    const b = channelInput(portB, fallB);
    if (!a || !b) return null;
    const len = Math.max(a.length, b.length);
    const result: number[] = [];
    for (let i = 0; i < len; i++) {
      result.push(fn(a[i % a.length], b[i % b.length]));
    }
    return result;
  };

  // Variadic fold over a chainable node's effective operands (add/sub/mul/div,
  // which grow past a/b). Unconnected operands contribute `identity`; channel
  // vectors broadcast shorter→longer; left-folds to match TSL's a op b op c … .
  const naryOp = (identity: number, fn: (a: number, b: number) => number): EvalResult => {
    const connected = nodeEdges
      .map((e) => e.targetHandle)
      .filter((h): h is string => typeof h === 'string');
    const ports = def ? effectiveInputs(def, connected, false, Object.keys(values)) : [];
    let acc: number[] | null = null;
    for (const port of ports) {
      const inp = channelInput(port.id, identity);
      if (!inp) return null;
      if (acc === null) { acc = inp.slice(); continue; }
      const len = Math.max(acc.length, inp.length);
      const next: number[] = [];
      for (let i = 0; i < len; i++) next.push(fn(acc[i % acc.length], inp[i % inp.length]));
      acc = next;
    }
    return acc;
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
      // Constant silence, never live, and 0 rather than a mid-scale guess: the
      // 3D preview and a downloaded shader really are 0 until capture is armed,
      // and node-editor.html has no capture at all.
      result = [0];
      break;
    case 'float':
    case 'int':
    case 'property_float':
    case 'slider':
      result = [valueNum(values.value ?? 0)];
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

    // Type constructors
    case 'vec2':
      result = [scalarInput('x', 0), scalarInput('y', 0)];
      break;
    case 'vec3':
      result = [scalarInput('x', 0), scalarInput('y', 0), scalarInput('z', 0)];
      break;
    case 'vec4':
      result = [scalarInput('x', 0), scalarInput('y', 0), scalarInput('z', 0), scalarInput('w', 0)];
      break;
    case 'color':
    case 'property_color': {
      const hex = valueStr(values.hex ?? '#ff0000');
      result = [...hexToRgb01(hex)];
      break;
    }

    // Arithmetic (component-wise, broadcast, variadic — chainable operands)
    case 'add': result = naryOp(0, (a, b) => a + b); break;
    case 'sub': result = naryOp(0, (a, b) => a - b); break;
    case 'mul': result = naryOp(1, (a, b) => a * b); break;
    case 'div': result = naryOp(1, (a, b) => b !== 0 ? a / b : 0); break;

    // Unary math (component-wise)
    case 'sin': result = unaryOp('x', 0, Math.sin); break;
    case 'cos': result = unaryOp('x', 0, Math.cos); break;
    case 'abs': result = unaryOp('x', 0, Math.abs); break;
    case 'sqrt': result = unaryOp('x', 0, (v) => Math.sqrt(Math.max(0, v))); break;
    case 'exp': result = unaryOp('x', 0, Math.exp); break;
    case 'log2': result = unaryOp('x', 1, (v) => Math.log2(Math.max(1e-10, v))); break;
    case 'floor': result = unaryOp('x', 0, Math.floor); break;
    case 'round': result = unaryOp('x', 0, Math.round); break;
    case 'fract': result = unaryOp('x', 0, (v) => v - Math.floor(v)); break;
    case 'oneMinus': result = unaryOp('x', 0, (v) => 1 - v); break;

    // Binary math
    case 'pow': result = binaryOp('base', 1, 'exp', 1, Math.pow); break;
    case 'mod': result = binaryOp('x', 0, 'y', 1, (a, b) => b !== 0 ? a % b : 0); break;
    // Unwired second operand falls back to the op's IDENTITY, not 0: min(a, 0)=0
    // would silently zero any non-negative input. 1 is min's identity over [0,1];
    // 0 is already max's (max(a,0)=ReLU). Matches the registry defaultValues.
    case 'min': result = binaryOp('a', 1, 'b', 1, Math.min); break;
    case 'max': result = binaryOp('a', 0, 'b', 0, Math.max); break;
    case 'clamp': {
      const x = channelInput('x', 0);
      const lo = scalarInput('min', 0);
      const hi = scalarInput('max', 1);
      result = x ? x.map((v) => Math.min(Math.max(v, lo), hi)) : null;
      break;
    }

    // Interpolation
    case 'mix': {
      const a = channelInput('a', 0);
      const b = channelInput('b', 1);
      const t = scalarInput('t', 0.5);
      if (a && b) {
        const len = Math.max(a.length, b.length);
        result = [];
        for (let i = 0; i < len; i++) {
          const av = a[i % a.length], bv = b[i % b.length];
          result.push(av * (1 - t) + bv * t);
        }
      }
      break;
    }
    case 'smoothstep': {
      const e0 = scalarInput('edge0', 0), e1 = scalarInput('edge1', 1);
      // 0, not 0.5: the registry deliberately declares no default for `x`, so
      // codegen emits a bare '0' for the unwired signal and the card must agree.
      const x = channelInput('x', 0);
      result = x ? x.map((v) => {
        const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0 || 1)));
        return t * t * (3 - 2 * t);
      }) : null;
      break;
    }
    case 'remap': {
      const x = channelInput('x', 0);
      const inLow = scalarInput('inLow', 0);
      const inHigh = scalarInput('inHigh', 1);
      const outLow = scalarInput('outLow', 0);
      const outHigh = scalarInput('outHigh', 1);
      result = x ? x.map((v) => {
        const t = (inHigh - inLow) !== 0 ? (v - inLow) / (inHigh - inLow) : 0;
        return outLow + t * (outHigh - outLow);
      }) : null;
      break;
    }
    case 'select': {
      const cond = scalarInput('condition', 0);
      const a = channelInput('a', 0);
      const b = channelInput('b', 0);
      // TRUTHINESS, not a 0.5 threshold: three builds `bool(cond)`, so 0.2 takes
      // the TRUE branch on the GPU (docs/dev/codegen.md, `select`).
      result = cond !== 0 ? a : b;
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
    case 'distance': {
      const a = channelInput('a', 0);
      const b = channelInput('b', 0);
      if (a && b) {
        const len = Math.max(a.length, b.length);
        let sum = 0;
        for (let i = 0; i < len; i++) {
          const d = (a[i % a.length] ?? 0) - (b[i % b.length] ?? 0);
          sum += d * d;
        }
        result = [Math.sqrt(sum)];
      }
      break;
    }
    case 'dot': {
      const a = channelInput('a', 0);
      const b = channelInput('b', 0);
      if (a && b) {
        const len = Math.max(a.length, b.length);
        let sum = 0;
        for (let i = 0; i < len; i++) sum += (a[i % a.length] ?? 0) * (b[i % b.length] ?? 0);
        result = [sum];
      }
      break;
    }
    case 'normalize': {
      const v = channelInput('v', 0);
      if (v) {
        const len = Math.sqrt(v.reduce((s, c) => s + c * c, 0)) || 1;
        result = v.map((c) => c / len);
      }
      break;
    }
    case 'cross': {
      const a = channelInput('a', 0);
      const b = channelInput('b', 0);
      if (a && b && a.length >= 3 && b.length >= 3) {
        result = [
          a[1] * b[2] - a[2] * b[1],
          a[2] * b[0] - a[0] * b[2],
          a[0] * b[1] - a[1] * b[0],
        ];
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
      const h = scalarInput('h', 0);
      const s = scalarInput('s', 1);
      const l = scalarInput('l', 0.5);
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      result = [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
      break;
    }
    // RGB → HSL — matches the branchless GPU/codegen implementations.
    case 'toHsl': {
      const rgb = channelInput('rgb', 0);
      if (!rgb) { result = null; break; }
      const r = rgb[0] ?? 0;
      const g = rgb[1] ?? r;
      const b = rgb[2] ?? r;
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
    case 'sdBox': {
      // 2D for a two-channel position, 3D otherwise — the width dispatch the
      // emitter makes (sdBox2 vs sdBox3). Rounding cancels in value except at
      // the corners, exactly as in the helper.
      const p = channelInput('p', 0);
      // Half-extents are ONE vec3 socket: wired, its channels; unwired, the
      // scalar default broadcast — the same `vec3()` fill the helper applies,
      // restated here because this evaluator carries its own copy of the maths.
      const b = vec3Input('b', 0.5), r = scalarInput('round', 0);
      if (p) {
        const q = p.length === 2
          ? [Math.abs(p[0] ?? 0) - b[0] + r, Math.abs(p[1] ?? 0) - b[1] + r]
          : [Math.abs(p[0] ?? 0) - b[0] + r, Math.abs(p[1] ?? 0) - b[1] + r, Math.abs(p[2] ?? 0) - b[2] + r];
        const outside = Math.hypot(...q.map((v) => Math.max(v, 0)));
        const inside = Math.min(Math.max(...q), 0);
        result = [outside + inside - r];
      } else result = null;
      break;
    }
    case 'sdTorus': {
      const p = channelInput('p', 0);
      const ringR = scalarInput('ringR', 0.5), tubeR = scalarInput('tubeR', 0.15);
      if (p) {
        const qx = Math.hypot(p[0] ?? 0, p[2] ?? 0) - ringR;
        result = [Math.hypot(qx, p[1] ?? 0) - tubeR];
      } else result = null;
      break;
    }
    case 'sdCombine': {
      const a = scalarInput('a', 0), b = scalarInput('b', 0), k = scalarInput('k', 0);
      result = [sdCombineValue(sdCombineMode(node), a, b, k)];
      break;
    }
    case 'sdCylinder': {
      const p = channelInput('p', 0);
      const r = scalarInput('r', 0.3), h = scalarInput('h', 0.5), rb = scalarInput('round', 0);
      if (p) {
        const dx = Math.hypot(p[0] ?? 0, p[2] ?? 0) - (r - rb);
        const dy = Math.abs(p[1] ?? 0) - (h - rb);
        result = [Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - rb];
      } else result = null;
      break;
    }
    case 'sdCapsule': {
      const p = channelInput('p', 0);
      const r = scalarInput('r', 0.2), h = scalarInput('h', 0.3);
      if (p) {
        const py = p[1] ?? 0;
        result = [Math.hypot(p[0] ?? 0, py - Math.min(Math.max(py, -h), h), p[2] ?? 0) - r];
      } else result = null;
      break;
    }
    case 'sdCone': {
      const p = channelInput('p', 0);
      const r1 = scalarInput('r1', 0.4), r2 = scalarInput('r2', 0.1), h = scalarInput('h', 0.4);
      if (p) {
        const qx = Math.hypot(p[0] ?? 0, p[2] ?? 0), qy = p[1] ?? 0;
        const k1 = [r2, h], k2 = [r2 - r1, 2 * h];
        const ca = [qx - Math.min(qx, qy < 0 ? r1 : r2), Math.abs(qy) - h];
        const t = Math.min(Math.max(((k1[0] - qx) * k2[0] + (k1[1] - qy) * k2[1]) / (k2[0] * k2[0] + k2[1] * k2[1] || 1e-9), 0), 1);
        const cb = [qx - k1[0] + k2[0] * t, qy - k1[1] + k2[1] * t];
        const sgn = cb[0] < 0 && ca[1] < 0 ? -1 : 1;
        result = [sgn * Math.sqrt(Math.min(ca[0] * ca[0] + ca[1] * ca[1], cb[0] * cb[0] + cb[1] * cb[1]))];
      } else result = null;
      break;
    }
    case 'sdPlane': {
      const p = channelInput('p', 0);
      // Mirrors the helper exactly, degenerate case included: a zero-length
      // normal reads as "up", which is what carries the old (0,1,0) default
      // through a socket whose unwired value can only be a broadcast scalar.
      const n0 = vec3Input('n', 0), h = scalarInput('h', 0);
      const nlen = Math.hypot(n0[0], n0[1], n0[2]);
      const n = nlen > 1e-6 ? n0 : [0, 1, 0];
      if (p) {
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        result = [((p[0] ?? 0) * n[0] + (p[1] ?? 0) * n[1] + (p[2] ?? 0) * n[2]) / len + h];
      } else result = null;
      break;
    }
    case 'sdOctahedron': {
      const pIn = channelInput('p', 0);
      const sz = scalarInput('s', 0.5);
      if (pIn) {
        const p = [Math.abs(pIn[0] ?? 0), Math.abs(pIn[1] ?? 0), Math.abs(pIn[2] ?? 0)];
        const m = p[0] + p[1] + p[2] - sz;
        let q: number[] | null = null;
        if (3 * p[0] < m) q = [p[0], p[1], p[2]];
        else if (3 * p[1] < m) q = [p[1], p[2], p[0]];
        else if (3 * p[2] < m) q = [p[2], p[0], p[1]];
        if (!q) result = [m * 0.57735027];
        else {
          const k = Math.min(Math.max(0.5 * (q[2] - q[1] + sz), 0), sz);
          result = [Math.hypot(q[0], q[1] - sz + k, q[2] - k)];
        }
      } else result = null;
      break;
    }
    case 'sdStar': {
      const pIn = channelInput('p', 0);
      const r = scalarInput('r', 0.4), n = Math.max(scalarInput('n', 5), 1), m = Math.max(scalarInput('m', 3), 1);
      if (pIn) {
        const an = Math.PI / n, en = Math.PI / m;
        const acs = [Math.cos(an), Math.sin(an)], ecs = [Math.cos(en), Math.sin(en)];
        const x = pIn[0] ?? 0, y = pIn[1] ?? 0;
        const a = Math.atan2(x, y);
        const twoAn = 2 * an;
        const bn = (((a % twoAn) + twoAn) % twoAn) - an;
        const len = Math.hypot(x, y);
        let px = len * Math.cos(bn) - r * acs[0];
        let py = len * Math.abs(Math.sin(bn)) - r * acs[1];
        const t = Math.min(Math.max(-(px * ecs[0] + py * ecs[1]), 0), (r * acs[1]) / ecs[1]);
        px += ecs[0] * t;
        py += ecs[1] * t;
        result = [Math.hypot(px, py) * Math.sign(px || 1)];
      } else result = null;
      break;
    }
    case 'sdfTransform': {
      const p = channelInput('p', 0);
      const tx = scalarInput('tx', 0), ty = scalarInput('ty', 0), tz = scalarInput('tz', 0);
      const rx = scalarInput('rx', 0), ry = scalarInput('ry', 0), rz = scalarInput('rz', 0);
      const sc = Math.max(scalarInput('s', 1), 1e-6);
      if (p) {
        const rad = Math.PI / 180;
        let x = ((p[0] ?? 0) - tx) / sc, y = ((p[1] ?? 0) - ty) / sc, z = ((p[2] ?? 0) - tz) / sc;
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
      const p = channelInput('p', 0);
      const sp = [scalarInput('sx', 1), scalarInput('sy', 1), scalarInput('sz', 1)];
      const lim = [scalarInput('lx', 0), scalarInput('ly', 0), scalarInput('lz', 0)];
      if (p) {
        result = [0, 1, 2].map((i) => {
          const v = p[i] ?? 0;
          if (!(sp[i] > 0)) return v;
          let id = Math.round(v / sp[i]);
          if (lim[i] > 0) id = Math.min(Math.max(id, -lim[i]), lim[i]);
          return v - sp[i] * id;
        });
      } else result = null;
      break;
    }
    case 'sdfRepeatPolar': {
      const p = channelInput('p', 0);
      const n = Math.max(scalarInput('n', 6), 1);
      if (p) {
        const sp = (2 * Math.PI) / n;
        const an = Math.atan2(p[2] ?? 0, p[0] ?? 0);
        const a = an - sp * Math.floor(an / sp + 0.5);
        const r = Math.hypot(p[0] ?? 0, p[2] ?? 0);
        result = [r * Math.cos(a), p[1] ?? 0, r * Math.sin(a)];
      } else result = null;
      break;
    }
    case 'sdfMirror': {
      const p = channelInput('p', 0);
      const w = vec3Input('m', 1);
      if (p) result = [0, 1, 2].map((i) => { const v = p[i] ?? 0; return v + (Math.abs(v) - v) * w[i]; });
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
      const p = channelInput('p', 0);
      const k = scalarInput('amount', 1);
      const mode = values.mode;
      if (p) {
        const x = p[0] ?? 0, y = p[1] ?? 0, z = p[2] ?? 0;
        if (mode === 'bend') {
          const c = Math.cos(k * x), sn = Math.sin(k * x);
          result = [c * x - sn * y, sn * x + c * y, z];
        } else if (mode === 'elongate') {
          const hh = vec3Input('h', 0);
          result = [x, y, z].map((v, i) => v - Math.min(Math.max(v, -hh[i]), hh[i]));
        } else {
          const c = Math.cos(k * y), sn = Math.sin(k * y);
          result = [c * x - sn * z, y, sn * x + c * z];
        }
      } else result = null;
      break;
    }
    case 'sdfExtrude': {
      const d = scalarInput('d', 0), h = scalarInput('h', 0.2);
      const p = channelInput('p', 0);
      const wz = Math.abs(p?.[2] ?? 0) - h;
      result = [Math.min(Math.max(d, wz), 0) + Math.hypot(Math.max(d, 0), Math.max(wz, 0))];
      break;
    }
    case 'sdfRevolve': {
      const p = channelInput('p', 0);
      const o = scalarInput('o', 0.5);
      if (p) result = [Math.hypot(p[0] ?? 0, p[2] ?? 0) - o, p[1] ?? 0];
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

  cache.set(nodeId, result);
  return result;
}

/** Three channels of `v` the way TSL's `vec3(v)` converts it: a scalar
 *  broadcasts, a vec2 pads with 0, a vec4 drops its fourth component. Shared by
 *  Brightness/Contrast's sample and its range, so the two read one shape. */
function brightContrastRgb(v: readonly number[]): [number, number, number] {
  return v.length === 1 ? [v[0], v[0], v[0]] : [v[0], v[1] ?? 0, v[2] ?? 0];
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
    return computeRange(nodeId, nodes, ctx.edges, time, cache, ctx.nodeIndex, ctx.edgeIndex);
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
 *  construction (three's transformDirection ends in normalize()). */
const UNIT_VECTOR_TYPES: ReadonlySet<string> = new Set([
  'normalLocal', 'tangentLocal', 'normalWorld', 'positionWorldDirection', 'positionViewDirection',
]);

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
  if (type === 'uv' || type === 'screenUV') return { min: [0, 0], max: [1, 1] };

  // Unit vectors: every channel lies in [-1, 1]. `normalWorld` is unit by
  // construction (three's transformDirection ends in normalize()). The box is
  // per-channel, so it cannot express |v| = 1: the tightest axis-aligned bound.
  if (UNIT_VECTOR_TYPES.has(type)) {
    return { min: [-1, -1, -1], max: [1, 1, 1] };
  }

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

  // Model-space positions: fit-bounds rescales geometry so the longest axis
  // spans 1.6, so each channel sits within roughly [-0.8, 0.8].
  if (type === 'positionGeometry' || type === 'positionLocal') {
    return { min: [-0.8, -0.8, -0.8], max: [0.8, 0.8, 0.8] };
  }

  // MaterialX noise: perlin/fBm follow their per-node range flag (absent =
  // signed), cellNoise/voronoi are always [0, 1]; same bound on every channel.
  if (def.category === 'noise') {
    const n = shapeOfDataType(def.outputs[0].dataType);
    const signedNoise = hasNoiseRangeFlag(type) && !isUnsignedNoise(type, getNodeValues(node));
    return signedNoise
      ? { min: Array(n).fill(-1), max: Array(n).fill(1) }
      : { min: Array(n).fill(0), max: Array(n).fill(1) };
  }

  return null;
}

/** Element-wise broadcast binary op on ranges (broadcasts shorter to longer). */
function broadcastRange(
  a: RangeResult,
  b: RangeResult,
  fn: (amin: number, amax: number, bmin: number, bmax: number) => [number, number],
): RangeResult {
  const len = Math.max(a.min.length, b.min.length);
  const min: number[] = [];
  const max: number[] = [];
  for (let i = 0; i < len; i++) {
    const ai = i % a.min.length;
    const bi = i % b.min.length;
    const [lo, hi] = fn(a.min[ai], a.max[ai], b.min[bi], b.max[bi]);
    min.push(lo);
    max.push(hi);
  }
  return { min, max };
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

  // Resolve a port's range — uses upstream node range if connected, else inline value
  const portRange = (portId: string, fallback: number): RangeResult => {
    const edge = nodeEdges.find((e) => e.targetHandle === portId);
    if (edge) {
      const r = sliceRange(
        computeRange(edge.source, nodes, edges, time, cache, nodeIndex, edgeIndex),
        handleChannels(nodeIndex.get(edge.source), edge.sourceHandle),
      );
      if (r) return r;
      // Upstream is unknown — assume normalized [0, 1] (typical shader range)
      return { min: [0], max: [1] };
    }
    const v = values[portId];
    const num = v !== undefined ? Number(v) : fallback;
    return { min: [num], max: [num] };
  };

  // Interval fold over a chainable node's effective operands (variadic
  // arithmetic). Mirrors naryOp in evaluate(): unconnected operands contribute
  // `identity`, left-folded through the per-op interval rule.
  const naryRange = (
    identity: number,
    fn: (amin: number, amax: number, bmin: number, bmax: number) => [number, number],
  ): RangeResult => {
    const connected = nodeEdges
      .map((e) => e.targetHandle)
      .filter((h): h is string => typeof h === 'string');
    const ports = effectiveInputs(def, connected, false, Object.keys(values));
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
      result = naryRange(1, (amin, amax, bmin, bmax) => {
        // If divisor spans 0 the result is unbounded — fall back to [0, 1]
        if (bmin <= 0 && bmax >= 0) return [0, 1];
        const corners = [amin / bmin, amin / bmax, amax / bmin, amax / bmax];
        return [Math.min(...corners), Math.max(...corners)];
      });
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
    case 'cos':
    case 'fract':
    case 'smoothstep': {
      // sin/cos span [-1, 1] (could be tighter when input range < 2π but this
      // is safe and clear); fract/smoothstep span [0, 1]. Shape follows input.
      const lo = type === 'sin' || type === 'cos' ? -1 : 0;
      const x = portRange('x', 0);
      result = { min: x.min.map(() => lo), max: x.min.map(() => 1) };
      break;
    }
    case 'sqrt': {
      const x = portRange('x', 0);
      result = unaryRange(x, (lo, hi) => [Math.sqrt(Math.max(0, lo)), Math.sqrt(Math.max(0, hi))]);
      break;
    }
    case 'exp': {
      const x = portRange('x', 0);
      result = unaryRange(x, (lo, hi) => [Math.exp(lo), Math.exp(hi)]);
      break;
    }
    case 'log2': {
      // Floored at 1e-10 exactly as `evaluate` floors it, so the interval and
      // the sample agree about a non-positive input instead of one reporting
      // -Infinity and the other -33.2.
      const x = portRange('x', 1);
      const safeLog = (v: number) => Math.log2(Math.max(1e-10, v));
      result = unaryRange(x, (lo, hi) => [safeLog(lo), safeLog(hi)]);
      break;
    }
    case 'pow': {
      const base = portRange('base', 1);
      const exp = portRange('exp', 1);
      result = broadcastRange(base, exp, (blo, bhi, elo, ehi) => {
        const corners = [
          Math.pow(blo, elo), Math.pow(blo, ehi),
          Math.pow(bhi, elo), Math.pow(bhi, ehi),
        ];
        // pow is monotone in each argument separately, so the corners bound it
        // — EXCEPT when the base straddles 0, where the extremum sits AT 0 and
        // no corner sees it (base [-1, 1] squared gives 1, 1, 1, 1 while the
        // true minimum is 0).
        if (blo < 0 && bhi > 0) corners.push(Math.pow(0, elo), Math.pow(0, ehi));
        // A negative base with a fractional exponent is NaN — there is no real
        // bound to report, so hand the caller an unbounded interval (which both
        // surfaces render as '…') rather than a confident wrong one.
        if (!corners.every(Number.isFinite)) return [-Infinity, Infinity];
        return [Math.min(...corners), Math.max(...corners)];
      });
      break;
    }
    case 'mod': {
      const x = portRange('x', 0);
      const y = portRange('y', 1);
      result = broadcastRange(x, y, (xlo, _xhi, ylo, yhi) => {
        // Only a strictly positive divisor is bounded usefully; one spanning 0
        // is the div case (evaluate returns 0 there, which is not a bound).
        if (!(ylo > 0)) return [-Infinity, Infinity];
        // JS `%` is TRUNCATED, matching evaluate — so the result keeps the
        // dividend's sign and a non-negative dividend cannot go below 0.
        return [xlo >= 0 ? 0 : -yhi, yhi];
      });
      break;
    }
    case 'dot': {
      // Interval sum of the per-channel interval products, broadcasting the
      // shorter operand exactly as evaluate's `i % length` does.
      const a = portRange('a', 0);
      const b = portRange('b', 0);
      const len = Math.max(a.min.length, b.min.length);
      let lo = 0, hi = 0;
      for (let i = 0; i < len; i++) {
        const ai = i % a.min.length, bi = i % b.min.length;
        const corners = [
          a.min[ai] * b.min[bi], a.min[ai] * b.max[bi],
          a.max[ai] * b.min[bi], a.max[ai] * b.max[bi],
        ];
        lo += Math.min(...corners);
        hi += Math.max(...corners);
      }
      result = { min: [lo], max: [hi] };
      break;
    }
    case 'hsl':
    case 'toHsl':
      // Both conversions are closed over the unit cube whatever the input —
      // hsl() builds an RGB triple, toHsl() a normalized (h, s, l).
      result = { min: [0, 0, 0], max: [1, 1, 1] };
      break;
    case 'colorRamp': {
      // Exact over the half table: both ends plus every texel centre between
      // them (rangeHalf), so a ramp that dips between its stops is not
      // reported by its endpoints alone. ±Infinity bounds go through as they
      // are — ClampToEdge holds the end colours, so `−∞…1` is the whole ramp,
      // not the colour at 0.5 — and rangeHalf reads a NaN bound as unknown.
      const r = portRange('fac', 0.5);
      result = rampRangeOver(readColorRamp(values), r.min[0] ?? 0.5, r.max[0] ?? 0.5);
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
      const fn = type === 'floor' ? Math.floor : Math.round;
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
      const x = portRange('x', 0);
      const lo = portRange('min', 0);
      const hi = portRange('max', 1);
      result = unaryRange(x, (xlo, xhi) => [
        Math.max(xlo, lo.min[0]),
        Math.min(xhi, hi.max[0]),
      ]);
      break;
    }
    case 'mix': {
      // Conservative: result is bounded by union of a and b (for t ∈ [0, 1]).
      const a = portRange('a', 0);
      const b = portRange('b', 1);
      result = broadcastRange(a, b, (amin, amax, bmin, bmax) => [
        Math.min(amin, bmin),
        Math.max(amax, bmax),
      ]);
      break;
    }
    case 'remap': {
      // Conservative: full output range from outLow to outHigh
      const outLow = portRange('outLow', 0);
      const outHigh = portRange('outHigh', 1);
      result = {
        min: [Math.min(outLow.min[0], outHigh.min[0])],
        max: [Math.max(outLow.max[0], outHigh.max[0])],
      };
      break;
    }
    case 'select': {
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
      // Result is 0/1 per input channel.
      const a = portRange('a', 0);
      const b = portRange('b', 0);
      const len = Math.max(a.min.length, b.min.length);
      result = { min: Array(len).fill(0), max: Array(len).fill(1) };
      break;
    }
    case 'vec2':
    case 'vec3':
    case 'vec4': {
      const min: number[] = [];
      const max: number[] = [];
      for (const input of def.inputs) {
        const r = portRange(input.id, 0);
        min.push(r.min[0]);
        max.push(r.max[0]);
      }
      result = { min, max };
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
      // Components of a unit vector are in [-1, 1] per axis
      const v = portRange('v', 0);
      result = { min: v.min.map(() => -1), max: v.min.map(() => 1) };
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
    // sdBox2 / sdBox3 / sdTorus: no cheap honest interval — they fall through to
    // the `…` label rather than reporting a bound that is wrong.
  }

  cache.set(nodeId, result);
  return result;
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
