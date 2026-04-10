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
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getParamClassifications } from '@/registry/tslTexturesRegistry';
import { voronoi2D } from '@/utils/noisePreview';
import { hexToRgb01 } from '@/utils/colorUtils';

/** Multiplier applied to UV coordinates before sampling noise (matches GPU preview scale). */
const NOISE_UV_SCALE = 4;

/** Result: array of channel values, or null if unevaluable. */
export type EvalResult = number[] | null;

/** Evaluate the output of a specific node, given the current time. */
export function evaluateNodeOutput(
  nodeId: string,
  nodes: AppNode[],
  edges: AppEdge[],
  time: number,
): EvalResult {
  const cache = new Map<string, EvalResult>();
  return evaluate(nodeId, nodes, edges, time, cache);
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
): number {
  if (visited.has(nodeId)) return 1;
  visited.add(nodeId);

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return 1;
  const def = NODE_REGISTRY.get(node.data.registryType);
  if (!def) return 1;

  // 1. Concrete output port type wins immediately.
  const outPort = def.outputs.find((o) => o.id === 'out') ?? def.outputs[0];
  if (outPort) {
    const concrete = shapeOfDataType(outPort.dataType);
    if (concrete > 0) return concrete;
  }

  // 2. 'any' output — infer from inputs.
  // Append concatenates: total = sum of input shapes (clamped to [2, 4]).
  if (def.type === 'append') {
    let total = 0;
    for (const inputId of ['a', 'b'] as const) {
      const e = edges.find((edge) => edge.target === nodeId && edge.targetHandle === inputId);
      total += e ? getNodeOutputShape(e.source, nodes, edges, visited) : 1;
    }
    return Math.min(Math.max(total, 1), 4);
  }

  // 3. Default broadcast: output shape = max of all connected input shapes (vec3 + scalar = vec3).
  let maxShape = 1;
  for (const input of def.inputs) {
    const e = edges.find((edge) => edge.target === nodeId && edge.targetHandle === input.id);
    if (e) {
      const s = getNodeOutputShape(e.source, nodes, edges, visited);
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

function evaluate(
  nodeId: string,
  nodes: AppNode[],
  edges: AppEdge[],
  time: number,
  cache: Map<string, EvalResult>,
  edgeIndex?: Map<string, AppEdge[]>,
): EvalResult {
  if (cache.has(nodeId)) return cache.get(nodeId)!;

  const idx = edgeIndex ?? buildEdgeIndex(edges);

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) { cache.set(nodeId, null); return null; }

  const type = node.data.registryType;
  const values = getNodeValues(node);

  const nodeEdges = idx.get(nodeId) ?? [];

  // Resolve a single scalar input from edges or inline values
  const scalarInput = (portId: string, fallback: number): number => {
    const edge = nodeEdges.find((e) => e.targetHandle === portId);
    if (edge) {
      const upstream = evaluate(edge.source, nodes, edges, time, cache, idx);
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
      return evaluate(edge.source, nodes, edges, time, cache, idx);
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
    case 'color': {
      const hex = String(values.hex ?? '#ff0000');
      result = [...hexToRgb01(hex)];
      break;
    }

    // Arithmetic (component-wise, broadcast)
    case 'add': result = binaryOp('a', 0, 'b', 0, (a, b) => a + b); break;
    case 'sub': result = binaryOp('a', 0, 'b', 0, (a, b) => a - b); break;
    case 'mul': result = binaryOp('a', 1, 'b', 1, (a, b) => a * b); break;
    case 'div': result = binaryOp('a', 1, 'b', 1, (a, b) => b !== 0 ? a / b : 0); break;

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
    case 'min': result = binaryOp('a', 0, 'b', 0, Math.min); break;
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
      const a = channelInput('a', 0);
      const b = channelInput('b', 0);
      if (a && b) {
        result = [...a, ...b];
      }
      break;
    }

    // Noise (evaluate at a representative point — center of UV)
    case 'voronoi': {
      const posInput = channelInput('pos', 0);
      const scale = scalarInput('scale', 1);
      const px = (posInput ? posInput[0] : 0.5) * NOISE_UV_SCALE * scale;
      const py = (posInput ? (posInput[1] ?? 0.5) : 0.5) * NOISE_UV_SCALE * scale;
      result = [voronoi2D(px, py)];
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
    // RGB → HSL (passthrough — full implementation requires min/max/conditionals)
    case 'toHsl': {
      const rgb = channelInput('rgb', 0);
      result = rgb;
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
//   1. Special-casing nodes with known analytical ranges (textures derived from
//      their `color`/`background` palette params, UV/screenUV, voronoi, etc.)
//   2. Falling through to deterministic eval — when it succeeds, the range is
//      degenerate (`min === max === value`).
//   3. Propagating ranges through arithmetic operations using interval math.
//
// Why this is the right approach: most tsl-textures interpolate between palette
// colors based on a procedural pattern, so the per-channel output range is
// exactly the per-channel min/max of the palette colors. Editing the colors in
// the node settings updates the displayed range live. For chains downstream
// (e.g., `sub(perlinNoise, 0.5)`), interval arithmetic on the texture's range
// gives the correct downstream bounds.

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
  const cache = new Map<string, RangeResult | null>();
  return computeRange(nodeId, nodes, edges, time, cache);
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
): RangeResult | null {
  if (cache.has(nodeId)) return cache.get(nodeId)!;
  cache.set(nodeId, null); // cycle protection — overwritten below

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const def = NODE_REGISTRY.get(node.data.registryType);
  if (!def) return null;

  const type = node.data.registryType;
  const values = getNodeValues(node);
  const nodeEdges = edges.filter((e) => e.target === nodeId);

  // Resolve a port's range — uses upstream node range if connected, else inline value
  const portRange = (portId: string, fallback: number): RangeResult => {
    const edge = nodeEdges.find((e) => e.targetHandle === portId);
    if (edge) {
      const r = computeRange(edge.source, nodes, edges, time, cache);
      if (r) return r;
      // Upstream is unknown — assume normalized [0, 1] (typical shader range)
      return { min: [0], max: [1] };
    }
    const v = values[portId];
    const num = v !== undefined ? Number(v) : fallback;
    return { min: [num], max: [num] };
  };

  let result: RangeResult | null = null;

  // ─── Special-case nodes with analytical ranges ──────────────────────────
  // tsl-textures: derive per-channel min/max from all `color`-typed parameters.
  // Most procedural textures interpolate between palette colors based on a
  // pattern function, so the output is bounded by the palette extents.
  if (def.tslImportModule === 'tsl-textures') {
    const classifications = getParamClassifications(def.tslFunction);
    const colors: number[][] = [];
    for (const param of classifications) {
      if (param.kind === 'color') {
        const hex = String(values[param.key] ?? '#000000');
        colors.push([...hexToRgb01(hex)]);
      }
    }
    if (colors.length > 0) {
      const min = [colors[0][0], colors[0][1], colors[0][2]];
      const max = [colors[0][0], colors[0][1], colors[0][2]];
      for (let i = 1; i < colors.length; i++) {
        for (let c = 0; c < 3; c++) {
          if (colors[i][c] < min[c]) min[c] = colors[i][c];
          if (colors[i][c] > max[c]) max[c] = colors[i][c];
        }
      }
      result = { min, max };
    } else {
      // Texture with no color params — assume [0, 1] per channel
      result = { min: [0, 0, 0], max: [1, 1, 1] };
    }
    cache.set(nodeId, result);
    return result;
  }

  // UV/screenUV: span [0, 1] across the surface even though point-sampling
  // returns the centre (0.5, 0.5). Range is more useful here than the sample.
  if (type === 'uv' || type === 'screenUV') {
    result = { min: [0, 0], max: [1, 1] };
    cache.set(nodeId, result);
    return result;
  }

  // voronoi (mx_worley_noise_float) → [0, 1]
  if (type === 'voronoi') {
    result = { min: [0], max: [1] };
    cache.set(nodeId, result);
    return result;
  }

  // ─── Try deterministic eval ─────────────────────────────────────────────
  // For nodes without a special range, the actual evaluated value is the
  // tightest possible range. Eval handles all the simple cases (constants,
  // arithmetic on constants, time, etc.) and gives a degenerate range.
  const det = evaluateNodeOutput(nodeId, nodes, edges, time);
  if (det && det.length > 0) {
    result = rangeOfValue(det);
    cache.set(nodeId, result);
    return result;
  }

  // ─── Range propagation through operations ──────────────────────────────
  // Reached only when eval failed (= upstream contains a texture). We propagate
  // ranges through the most common ops using interval arithmetic.
  switch (type) {
    case 'add': {
      const a = portRange('a', 0);
      const b = portRange('b', 0);
      result = broadcastRange(a, b, (amin, amax, bmin, bmax) => [amin + bmin, amax + bmax]);
      break;
    }
    case 'sub': {
      const a = portRange('a', 0);
      const b = portRange('b', 0);
      result = broadcastRange(a, b, (amin, amax, bmin, bmax) => [amin - bmax, amax - bmin]);
      break;
    }
    case 'mul': {
      const a = portRange('a', 1);
      const b = portRange('b', 1);
      result = broadcastRange(a, b, (amin, amax, bmin, bmax) => {
        const corners = [amin * bmin, amin * bmax, amax * bmin, amax * bmax];
        return [Math.min(...corners), Math.max(...corners)];
      });
      break;
    }
    case 'div': {
      const a = portRange('a', 1);
      const b = portRange('b', 1);
      result = broadcastRange(a, b, (amin, amax, bmin, bmax) => {
        // If divisor spans 0 the result is unbounded — fall back to [0, 1]
        if (bmin <= 0 && bmax >= 0) return [0, 1];
        const corners = [amin / bmin, amin / bmax, amax / bmin, amax / bmax];
        return [Math.min(...corners), Math.max(...corners)];
      });
      break;
    }
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
      // Could be tighter when input range < 2π but [-1, 1] is safe and clear.
      const x = portRange('x', 0);
      result = { min: x.min.map(() => -1), max: x.min.map(() => 1) };
      break;
    }
    case 'fract': {
      const x = portRange('x', 0);
      result = { min: x.min.map(() => 0), max: x.min.map(() => 1) };
      break;
    }
    case 'smoothstep': {
      const x = portRange('x', 0);
      result = { min: x.min.map(() => 0), max: x.min.map(() => 1) };
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
      const a = portRange('a', 0);
      const b = portRange('b', 0);
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
    case 'vec2': {
      const x = portRange('x', 0);
      const y = portRange('y', 0);
      result = { min: [x.min[0], y.min[0]], max: [x.max[0], y.max[0]] };
      break;
    }
    case 'vec3': {
      const x = portRange('x', 0);
      const y = portRange('y', 0);
      const z = portRange('z', 0);
      result = {
        min: [x.min[0], y.min[0], z.min[0]],
        max: [x.max[0], y.max[0], z.max[0]],
      };
      break;
    }
    case 'vec4': {
      const x = portRange('x', 0);
      const y = portRange('y', 0);
      const z = portRange('z', 0);
      const w = portRange('w', 0);
      result = {
        min: [x.min[0], y.min[0], z.min[0], w.min[0]],
        max: [x.max[0], y.max[0], z.max[0], w.max[0]],
      };
      break;
    }
    case 'append': {
      const a = portRange('a', 0);
      const b = portRange('b', 0);
      result = {
        min: [...a.min, ...b.min].slice(0, 4),
        max: [...a.max, ...b.max].slice(0, 4),
      };
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
