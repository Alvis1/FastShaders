/**
 * Converts the visual graph (nodes + edges) into actual Three.js TSL node objects.
 * This is the live compilation pipeline — the output is a TSL ShaderNodeObject
 * that can be assigned directly to material.colorNode.
 */
import {
  float,
  vec3,
  color as tslColor,
  add,
  sub,
  mul,
  div,
  sin,
  cos,
  abs,
  pow,
  sqrt,
  exp,
  log2,
  floor,
  round,
  fract,
  mod,
  clamp,
  min,
  max,
  mix,
  smoothstep,
  normalize,
  length,
  distance,
  dot,
  cross,
  positionGeometry,
  normalLocal,
  tangentLocal,
  time,
  screenUV,
  mx_noise_float,
  mx_fractal_noise_float,
  mx_worley_noise_float,
} from 'three/tsl';
import type { AppNode, AppEdge } from '@/types';
import { hexToRgb01 } from '@/utils/colorUtils';
import { topologicalSort } from './topologicalSort';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSLNode = any;

/**
 * Map of registry type -> function that creates a TSL node given resolved inputs.
 * Each factory receives an object mapping input port ids to their resolved TSL values.
 */
const TSL_FACTORIES: Record<string, (inputs: Record<string, TSLNode>, values: Record<string, string | number>) => TSLNode> = {
  // Inputs (no arguments, return a built-in node)
  positionGeometry: () => positionGeometry,
  normalLocal: () => normalLocal,
  tangentLocal: () => tangentLocal,
  time: () => time,
  screenUV: () => screenUV,
  uniform_float: (_inputs, values) => float(Number(values.value ?? 1)),

  // Type constructors
  float: (_inputs, values) => float(Number(values.value ?? 0)),
  int: (_inputs, values) => float(Number(values.value ?? 0)), // TSL int() might not exist in all builds
  vec2: (inputs) => {
    const x = inputs.x ?? float(0);
    const y = inputs.y ?? float(0);
    return vec3(x, y, float(0)); // Simplified: return vec3
  },
  vec3: (inputs) => {
    const x = inputs.x ?? float(0);
    const y = inputs.y ?? float(0);
    const z = inputs.z ?? float(0);
    return vec3(x, y, z);
  },
  vec4: (inputs) => {
    const x = inputs.x ?? float(0);
    const y = inputs.y ?? float(0);
    const z = inputs.z ?? float(0);
    return vec3(x, y, z); // Simplified for colorNode
  },
  color: (_inputs, values) => {
    const [r, g, b] = hexToRgb01(String(values.hex ?? '#ff0000'));
    return tslColor(r, g, b);
  },

  // Arithmetic
  add: (inputs) => add(inputs.a ?? float(0), inputs.b ?? float(0)),
  sub: (inputs) => sub(inputs.a ?? float(0), inputs.b ?? float(0)),
  mul: (inputs) => mul(inputs.a ?? float(1), inputs.b ?? float(1)),
  div: (inputs) => div(inputs.a ?? float(1), inputs.b ?? float(1)),

  // Math (unary)
  sin: (inputs) => sin(inputs.x ?? float(0)),
  cos: (inputs) => cos(inputs.x ?? float(0)),
  abs: (inputs) => abs(inputs.x ?? float(0)),
  sqrt: (inputs) => sqrt(inputs.x ?? float(0)),
  exp: (inputs) => exp(inputs.x ?? float(0)),
  log2: (inputs) => log2(inputs.x ?? float(1)),
  floor: (inputs) => floor(inputs.x ?? float(0)),
  round: (inputs) => round(inputs.x ?? float(0)),
  fract: (inputs) => fract(inputs.x ?? float(0)),

  // Math (binary)
  pow: (inputs) => pow(inputs.base ?? float(1), inputs.exp ?? float(1)),
  mod: (inputs) => mod(inputs.x ?? float(0), inputs.y ?? float(1)),
  clamp: (inputs) => clamp(inputs.x ?? float(0), inputs.min ?? float(0), inputs.max ?? float(1)),
  min: (inputs) => min(inputs.a ?? float(0), inputs.b ?? float(0)),
  max: (inputs) => max(inputs.a ?? float(0), inputs.b ?? float(0)),

  // Interpolation
  mix: (inputs) => mix(inputs.a ?? vec3(0, 0, 0), inputs.b ?? vec3(1, 1, 1), inputs.t ?? float(0.5)),
  smoothstep: (inputs) => smoothstep(inputs.edge0 ?? float(0), inputs.edge1 ?? float(1), inputs.x ?? float(0.5)),

  // Vector
  normalize: (inputs) => normalize(inputs.v ?? vec3(0, 1, 0)),
  length: (inputs) => length(inputs.v ?? vec3(0, 0, 0)),
  distance: (inputs) => distance(inputs.a ?? vec3(0, 0, 0), inputs.b ?? vec3(0, 0, 0)),
  dot: (inputs) => dot(inputs.a ?? vec3(0, 0, 0), inputs.b ?? vec3(0, 0, 0)),
  cross: (inputs) => cross(inputs.a ?? vec3(1, 0, 0), inputs.b ?? vec3(0, 1, 0)),

  // Noise
  noise: (inputs, values) => {
    const pos = inputs.pos ?? positionGeometry;
    const s = float(Number(values.scale ?? 1));
    return mx_noise_float(pos.mul(s));
  },
  fractal: (inputs, values) => {
    const pos = inputs.pos ?? positionGeometry;
    const s = float(Number(values.scale ?? 1));
    return mx_fractal_noise_float(
      pos.mul(s),
      inputs.octaves ?? float(Number(values.octaves ?? 4)),
      inputs.lacunarity ?? float(Number(values.lacunarity ?? 2)),
      inputs.diminish ?? float(Number(values.diminish ?? 0.5))
    );
  },
  voronoi: (inputs, values) => {
    const pos = inputs.pos ?? positionGeometry;
    const s = float(Number(values.scale ?? 1));
    return mx_worley_noise_float(pos.mul(s));
  },

  // Color
  hsl: (inputs) => {
    // Simplified HSL - just pass through as vec3 for now
    return vec3(inputs.h ?? float(0), inputs.s ?? float(1), inputs.l ?? float(0.5));
  },
  toHsl: (inputs) => inputs.rgb ?? vec3(0, 0, 0),
};

export interface CompileResult {
  colorNode: TSLNode | null;
  normalNode: TSLNode | null;
  positionNode: TSLNode | null;
  success: boolean;
  error?: string;
}

export function compileGraphToTSL(nodes: AppNode[], edges: AppEdge[]): CompileResult {
  try {
    if (nodes.length === 0) {
      return { colorNode: vec3(1, 0, 0), normalNode: null, positionNode: null, success: true };
    }

    const sorted = topologicalSort(nodes, edges);

    // Map node IDs to their TSL output values
    const nodeOutputs = new Map<string, TSLNode>();

    for (const node of sorted) {
      if (node.data.registryType === 'output') continue;

      const factory = TSL_FACTORIES[node.data.registryType];
      if (!factory) continue;

      // Resolve inputs from incoming edges
      const resolvedInputs: Record<string, TSLNode> = {};
      for (const edge of edges) {
        if (edge.target === node.id && edge.targetHandle) {
          const sourceOutput = nodeOutputs.get(edge.source);
          if (sourceOutput !== undefined) {
            resolvedInputs[edge.targetHandle] = sourceOutput;
          }
        }
      }

      // Get node values (defaults, user-set parameters)
      const values = (node.data as { values?: Record<string, string | number> }).values ?? {};

      // Create the TSL node
      const tslNode = factory(resolvedInputs, values);
      nodeOutputs.set(node.id, tslNode);
    }

    // Find the output node and resolve its connections
    const outputNode = sorted.find((n) => n.data.registryType === 'output');
    let colorNode: TSLNode | null = null;
    let normalNode: TSLNode | null = null;
    let positionNode: TSLNode | null = null;

    if (outputNode) {
      for (const edge of edges) {
        if (edge.target !== outputNode.id) continue;
        const sourceOutput = nodeOutputs.get(edge.source);
        if (!sourceOutput) continue;

        switch (edge.targetHandle) {
          case 'color':
            colorNode = sourceOutput;
            break;
          case 'normal':
            normalNode = sourceOutput;
            break;
          case 'position':
            positionNode = sourceOutput;
            break;
        }
      }
    }

    // Default: red if no color connected
    if (!colorNode) {
      colorNode = vec3(1, 0, 0);
    }

    return { colorNode, normalNode, positionNode, success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { colorNode: vec3(1, 0, 0), normalNode: null, positionNode: null, success: false, error: msg };
  }
}
