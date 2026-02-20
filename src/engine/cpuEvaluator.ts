/**
 * CPU-side graph evaluator for real-time values.
 * Walks the graph and computes each node's output using JS math equivalents.
 * Returns multi-channel arrays: [x] for scalar, [x,y] for vec2, [r,g,b] for vec3/color, etc.
 * Returns null for nodes that can't be evaluated (e.g. positionGeometry — depends on geometry).
 */
import type { AppNode, AppEdge } from '@/types';
import { perlin2D, fbm2D, voronoi2D } from '@/utils/noisePreview';

type NodeValues = Record<string, string | number>;

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

function evaluate(
  nodeId: string,
  nodes: AppNode[],
  edges: AppEdge[],
  time: number,
  cache: Map<string, EvalResult>,
): EvalResult {
  if (cache.has(nodeId)) return cache.get(nodeId)!;

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) { cache.set(nodeId, null); return null; }

  const type = node.data.registryType;
  const values = (node.data as { values?: NodeValues }).values ?? {};

  // Resolve a single scalar input from edges or inline values
  const scalarInput = (portId: string, fallback: number): number => {
    const edge = edges.find((e) => e.target === nodeId && e.targetHandle === portId);
    if (edge) {
      const upstream = evaluate(edge.source, nodes, edges, time, cache);
      if (upstream !== null && upstream.length > 0) return upstream[0];
    }
    const v = values[portId];
    return v !== undefined ? Number(v) : fallback;
  };

  // Resolve a multi-channel input (returns upstream result or fallback scalar)
  const channelInput = (portId: string, fallback: number): EvalResult => {
    const edge = edges.find((e) => e.target === nodeId && e.targetHandle === portId);
    if (edge) {
      const upstream = evaluate(edge.source, nodes, edges, time, cache);
      if (upstream !== null) return upstream;
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
    case 'uniform_float':
      result = [Number(values.value ?? 0)];
      break;
    case 'screenUV':
      result = [0.5, 0.5]; // center of screen as default
      break;

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
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      result = [r, g, b];
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

    // Noise (evaluate at a representative point — center of UV)
    case 'noise': {
      const posInput = channelInput('pos', 0);
      const scale = scalarInput('scale', 1);
      const px = (posInput ? posInput[0] : 0.5) * 4 * scale;
      const py = (posInput ? (posInput[1] ?? 0.5) : 0.5) * 4 * scale;
      result = [(perlin2D(px, py) + 1) * 0.5];
      break;
    }
    case 'fractal': {
      const posInput = channelInput('pos', 0);
      const scale = scalarInput('scale', 1);
      const oct = scalarInput('octaves', 4);
      const lac = scalarInput('lacunarity', 2);
      const dim = scalarInput('diminish', 0.5);
      const px = (posInput ? posInput[0] : 0.5) * 4 * scale;
      const py = (posInput ? (posInput[1] ?? 0.5) : 0.5) * 4 * scale;
      result = [(fbm2D(px, py, Math.round(oct), lac, dim) + 1) * 0.5];
      break;
    }
    case 'voronoi': {
      const posInput = channelInput('pos', 0);
      const scale = scalarInput('scale', 1);
      const px = (posInput ? posInput[0] : 0.5) * 4 * scale;
      const py = (posInput ? (posInput[1] ?? 0.5) : 0.5) * 4 * scale;
      result = [voronoi2D(px, py)];
      break;
    }

    default:
      result = null;
  }

  cache.set(nodeId, result);
  return result;
}
