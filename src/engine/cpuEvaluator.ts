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
import type { AppNode, AppEdge, TSLDataType } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY, effectiveInputs } from '@/registry/nodeRegistry';
import { perlin2D, fbm2D, cellNoise2D, voronoi2D } from '@/utils/noisePreview';
import { hexToRgb01 } from '@/utils/colorUtils';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';

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
  nodes: AppNode[],
  edges: AppEdge[],
  nodeIndex?: Map<string, AppNode>,
  edgeIndex?: Map<string, AppEdge[]>,
) {
  const node = nodeIndex ? nodeIndex.get(nodeId) : nodes.find((n) => n.id === nodeId);
  const def = NODE_REGISTRY.get(node?.data.registryType ?? '');
  if (!node || !def) return [];
  const targetEdges = edgeIndex
    ? edgeIndex.get(nodeId) ?? []
    : edges.filter((e) => e.target === nodeId);
  const connected = targetEdges
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
 * getComponentCount calls — share ONE collapsed-group unwrap, one pair of
 * node/edge indexes, and one result cache per graph version, instead of
 * paying a full recursive re-walk per consumer.
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

function getCtx(nodes: AppNode[], edges: AppEdge[]): EvalCtx {
  let byEdges = ctxByNodes.get(nodes);
  if (!byEdges) {
    byEdges = new WeakMap();
    ctxByNodes.set(nodes, byEdges);
  }
  let ctx = byEdges.get(edges);
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
    };
    byEdges.set(edges, ctx);
    // Internal recursion (e.g. computeRange → evaluateNodeOutput) re-enters
    // the public API with the UNWRAPPED array — register the ctx under that
    // key too so the re-entry lands on the same context. (No collapsed
    // groups → unwrap returns the input array and this is a no-op.)
    if (unwrapped !== edges) byEdges.set(unwrapped, ctx);
  }
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
    return evaluate(nodeId, nodes, ctx.edges, time, cache, ctx.edgeIndex, ctx.nodeIndex);
  } catch (e) {
    // The cache is persistent per graph version — an exception mid-walk would
    // otherwise leave cycle-guard sentinels behind as poisoned nulls.
    cache.clear();
    throw e;
  }
}

/**
 * Get the number of channel components a node produces (1, 2, 3, or 4).
 * Used by codegen to pick the right vector constructor for shape-dependent
 * nodes like `append`. Falls back to static port-type inference when CPU eval
 * returns null (e.g., when an upstream node is a procedural texture).
 */
export function getComponentCount(
  nodeId: string,
  nodes: AppNode[],
  edges: AppEdge[],
): number {
  const result = evaluateNodeOutput(nodeId, nodes, edges, 0);
  if (result && result.length > 0) return Math.min(result.length, 4);
  return getNodeOutputShape(nodeId, nodes, edges);
}

/** Channel count for a concrete TSL data type (1=float/int, 2=vec2, 3=vec3/color, 4=vec4). */
function shapeOfDataType(dt: TSLDataType): number {
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
  visited: Set<string> = new Set(),
  nodeIndex?: Map<string, AppNode>,
): number {
  // Top-level calls (fresh visited set) route through the shared ctx: cached
  // result, pre-unwrapped edges, prebuilt indexes. Mid-recursion re-entries
  // (legacy callers passing their own visited/nodeIndex) skip the cache —
  // a shape computed under a cycle short-circuit is entry-point dependent
  // and must not be memoized as the node's canonical shape.
  if (visited.size === 0) {
    const ctx = getCtx(nodes, edges);
    const hit = ctx.shapeCache.get(nodeId);
    if (hit !== undefined) return hit;
    const result = computeShape(nodeId, nodes, ctx.edges, visited, ctx.nodeIndex, ctx.edgeIndex);
    ctx.shapeCache.set(nodeId, result);
    return result;
  }
  return computeShape(nodeId, nodes, edges, visited, nodeIndex ?? buildNodeIndex(nodes), undefined);
}

function computeShape(
  nodeId: string,
  nodes: AppNode[],
  edges: AppEdge[],
  visited: Set<string>,
  nidx: Map<string, AppNode>,
  edgeIndex: Map<string, AppEdge[]> | undefined,
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

  const targetEdges = edgeIndex
    ? edgeIndex.get(nodeId) ?? []
    : edges.filter((e) => e.target === nodeId);

  // 2. 'any' output — infer from inputs.
  // Append concatenates: total = sum of ALL its operand shapes (it grows past
  // a/b), clamped to [2, 4] — the vec4 ceiling graphToCode also emits under.
  if (def.type === 'append') {
    let total = 0;
    for (const inp of appendOperands(nodeId, nodes, edges, nidx, edgeIndex)) {
      const e = targetEdges.find((edge) => edge.targetHandle === inp.id);
      total += e ? computeShape(e.source, nodes, edges, visited, nidx, edgeIndex) : 1;
    }
    return Math.min(Math.max(total, 2), 4);
  }

  // 3. Default broadcast: output shape = max of all connected input shapes (vec3 + scalar = vec3).
  let maxShape = 1;
  for (const input of def.inputs) {
    const e = targetEdges.find((edge) => edge.targetHandle === input.id);
    if (e) {
      const s = computeShape(e.source, nodes, edges, visited, nidx, edgeIndex);
      if (s > maxShape) maxShape = s;
    }
  }
  return maxShape;
}

/** Get the first channel as a scalar (for backward compat). */
export function evaluateNodeScalar(
  nodeId: string,
  nodes: AppNode[],
  edges: AppEdge[],
  time: number,
): number | null {
  const result = evaluateNodeOutput(nodeId, nodes, edges, time);
  return result !== null && result.length > 0 ? result[0] : null;
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
  nodes: AppNode[],
  edges: AppEdge[],
  time: number,
  cache: Map<string, EvalResult>,
  edgeIndex?: Map<string, AppEdge[]>,
  nodeIndex?: Map<string, AppNode>,
): EvalResult {
  if (cache.has(nodeId)) return cache.get(nodeId)!;

  // Cycle guard: write a sentinel BEFORE recursing so any cyclic path back to
  // this node short-circuits to null instead of recursing forever. The real
  // result overwrites the sentinel at the end of this function.
  cache.set(nodeId, null);

  const idx = edgeIndex ?? buildEdgeIndex(edges);
  const nidx = nodeIndex ?? buildNodeIndex(nodes);

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
      const upstream = evaluate(edge.source, nodes, edges, time, cache, idx, nidx);
      if (upstream !== null && upstream.length > 0) return upstream[0];
    }
    const v = values[portId];
    return v !== undefined ? Number(v) : fallback;
  };

  // Resolve a multi-channel input. If an edge exists, the upstream result is authoritative
  // (including null) — we do NOT fall back to the inline value, because that would mask the
  // upstream node and produce a fake scalar that the visualization layer would believe.
  const channelInput = (portId: string, fallback: number): EvalResult => {
    const edge = nodeEdges.find((e) => e.targetHandle === portId);
    if (edge) {
      return evaluate(edge.source, nodes, edges, time, cache, idx, nidx);
    }
    const v = values[portId];
    return [v !== undefined ? Number(v) : fallback];
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
    case 'time':
      result = [time];
      break;
    case 'float':
    case 'int':
    case 'property_float':
    case 'slider':
      result = [Number(values.value ?? 0)];
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
      const hex = String(values.hex ?? '#ff0000');
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
      const x = channelInput('x', 0.5);
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
      result = cond >= 0.5 ? a : b;
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
      for (const inp of appendOperands(nodeId, nodes, edges, nidx, idx)) {
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
      if (type === 'perlin' || type === 'perlinVec3') v = (perlin2D(px, py) + 1) * 0.5;
      else if (type === 'fbm' || type === 'fbmVec3') v = (fbm2D(px, py) + 1) * 0.5;
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

    default:
      result = null;
  }

  cache.set(nodeId, result);
  return result;
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

// ─────────────────────────────────────────────────────────────────────────────
// Range evaluation
// ─────────────────────────────────────────────────────────────────────────────
//
// For nodes the deterministic evaluator can't handle (procedural textures and
// anything downstream of them), we still want to show *something* useful in the
// EdgeInfoCard. Range evaluation produces per-channel min/max bounds by:
//   1. Special-casing nodes with known analytical ranges (UV/screenUV in
//      [0, 1], MaterialX noise variants in [0, 1] per channel).
//   2. Falling through to deterministic eval — when it succeeds, the range is
//      degenerate (`min === max === value`).
//   3. Propagating ranges through arithmetic operations using interval math.
//
// For chains downstream of a noise node (e.g., `sub(perlinNoise, 0.5)`),
// interval arithmetic on the noise's [0, 1] range gives the correct downstream
// bounds without needing to evaluate the GPU function on the CPU.

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
  nodeIndex?: Map<string, AppNode>,
  edgeIndex?: Map<string, AppEdge[]>,
): RangeResult | null {
  if (cache.has(nodeId)) return cache.get(nodeId)!;
  cache.set(nodeId, null); // cycle protection — overwritten below

  const node = nodeIndex ? nodeIndex.get(nodeId) : nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const def = NODE_REGISTRY.get(node.data.registryType);
  if (!def) return null;

  const type = node.data.registryType;
  const values = getNodeValues(node);
  const nodeEdges = edgeIndex
    ? edgeIndex.get(nodeId) ?? []
    : edges.filter((e) => e.target === nodeId);

  // Resolve a port's range — uses upstream node range if connected, else inline value
  const portRange = (portId: string, fallback: number): RangeResult => {
    const edge = nodeEdges.find((e) => e.targetHandle === portId);
    if (edge) {
      const r = computeRange(edge.source, nodes, edges, time, cache, nodeIndex, edgeIndex);
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

  // ─── Special-case nodes with analytical ranges ──────────────────────────
  // UV/screenUV: span [0, 1] across the surface even though point-sampling
  // returns the centre (0.5, 0.5). Range is more useful here than the sample.
  if (type === 'uv' || type === 'screenUV') {
    result = { min: [0, 0], max: [1, 1] };
    cache.set(nodeId, result);
    return result;
  }

  // Geometry attributes with well-defined bounds. Normals, tangents, and view
  // directions are unit vectors → every channel lies in [-1, 1].
  if (
    type === 'normalLocal' || type === 'tangentLocal' ||
    type === 'positionWorldDirection' || type === 'positionViewDirection'
  ) {
    result = { min: [-1, -1, -1], max: [1, 1, 1] };
    cache.set(nodeId, result);
    return result;
  }

  // Model-space positions follow the preview convention: fit-bounds rescales
  // geometry so the longest axis spans 1.6 (matching primitive framing), so
  // each channel sits within roughly [-0.8, 0.8].
  if (type === 'positionGeometry' || type === 'positionLocal') {
    result = { min: [-0.8, -0.8, -0.8], max: [0.8, 0.8, 0.8] };
    cache.set(nodeId, result);
    return result;
  }

  // MaterialX noise: scalar variants are bounded in [0, 1] (after the perlin
  // remap to display range). vec2/vec3 variants share the same per-channel
  // bound, just with more channels. The visualization layer just needs the
  // overall extent — exact analytical ranges per noise function aren't worth
  // the complexity.
  if (def.category === 'noise') {
    const n = shapeOfDataType(def.outputs[0].dataType);
    result = { min: Array(n).fill(0), max: Array(n).fill(1) };
    cache.set(nodeId, result);
    return result;
  }

  // ─── Try deterministic eval ─────────────────────────────────────────────
  // For nodes without a special range, the actual evaluated value is the
  // tightest possible range. Eval handles all the simple cases (constants,
  // arithmetic on constants, time, etc.) and gives a degenerate range.
  // Only accept a deterministic value as the range when every channel is finite.
  // A non-finite eval (NaN/Infinity from a poisoned input) must fall through to
  // interval arithmetic below — otherwise the range collapses to a NaN range and
  // the EdgeInfoCard renders '…' instead of the real bounds.
  const det = evaluateNodeOutput(nodeId, nodes, edges, time);
  if (det && det.length > 0 && det.every(Number.isFinite)) {
    result = rangeOfValue(det);
    cache.set(nodeId, result);
    return result;
  }

  // ─── Range propagation through operations ──────────────────────────────
  // Reached only when eval failed (= upstream contains a texture). We propagate
  // ranges through the most common ops using interval arithmetic.
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
      for (const inp of appendOperands(nodeId, nodes, edges, nodeIndex, edgeIndex)) {
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
      // Non-negative scalar; without per-component bounds we can't tighten further
      result = { min: [0], max: [Infinity] };
      break;
    }
  }

  cache.set(nodeId, result);
  return result;
}
