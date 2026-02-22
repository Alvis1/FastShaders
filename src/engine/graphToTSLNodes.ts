/**
 * Converts the visual graph (nodes + edges) into actual Three.js TSL node objects.
 * This is the live compilation pipeline — the output is a TSL ShaderNodeObject
 * that can be assigned directly to material.colorNode.
 */
import {
  float,
  vec2 as tslVec2,
  vec3,
  vec4 as tslVec4,
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
  remap,
  select,
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
import { Color, Vector2, Vector3 } from 'three';
import * as tslTextures from 'tsl-textures';
import type { AppNode, AppEdge } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getParamClassifications } from '@/registry/tslTexturesRegistry';
import { hexToRgb01 } from '@/utils/colorUtils';
import { topologicalSort } from './topologicalSort';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSLNode = any;

/** Valid swizzle component handles (consistent with graphToCode.ts). */
const VALID_SWIZZLE = new Set(['x', 'y', 'z', 'w']);

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
  property_float: (_inputs, values) => float(Number(values.value ?? 1)),

  // Type constructors
  float: (_inputs, values) => float(Number(values.value ?? 0)),
  int: (_inputs, values) => float(Number(values.value ?? 0)), // TSL int() might not exist in all builds
  vec2: (inputs) => {
    const x = inputs.x ?? float(0);
    const y = inputs.y ?? float(0);
    return tslVec2(x, y);
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
    const w = inputs.w ?? float(0);
    return tslVec4(x, y, z, w);
  },
  color: (_inputs, values) => {
    const [r, g, b] = hexToRgb01(String(values.hex ?? '#ff0000'));
    return tslColor(r, g, b);
  },

  // Arithmetic — fall back to manual values for unconnected inputs
  add: (inputs, v) => add(inputs.a ?? float(Number(v.a ?? 0)), inputs.b ?? float(Number(v.b ?? 0))),
  sub: (inputs, v) => sub(inputs.a ?? float(Number(v.a ?? 0)), inputs.b ?? float(Number(v.b ?? 0))),
  mul: (inputs, v) => mul(inputs.a ?? float(Number(v.a ?? 1)), inputs.b ?? float(Number(v.b ?? 1))),
  div: (inputs, v) => div(inputs.a ?? float(Number(v.a ?? 1)), inputs.b ?? float(Number(v.b ?? 1))),

  // Math (unary)
  sin: (inputs, v) => sin(inputs.x ?? float(Number(v.x ?? 0))),
  cos: (inputs, v) => cos(inputs.x ?? float(Number(v.x ?? 0))),
  abs: (inputs, v) => abs(inputs.x ?? float(Number(v.x ?? 0))),
  sqrt: (inputs, v) => sqrt(inputs.x ?? float(Number(v.x ?? 0))),
  exp: (inputs, v) => exp(inputs.x ?? float(Number(v.x ?? 0))),
  log2: (inputs, v) => log2(inputs.x ?? float(Number(v.x ?? 1))),
  floor: (inputs, v) => floor(inputs.x ?? float(Number(v.x ?? 0))),
  round: (inputs, v) => round(inputs.x ?? float(Number(v.x ?? 0))),
  fract: (inputs, v) => fract(inputs.x ?? float(Number(v.x ?? 0))),

  // Math (binary)
  pow: (inputs, v) => pow(inputs.base ?? float(Number(v.base ?? 1)), inputs.exp ?? float(Number(v.exp ?? 1))),
  mod: (inputs, v) => mod(inputs.x ?? float(Number(v.x ?? 0)), inputs.y ?? float(Number(v.y ?? 1))),
  clamp: (inputs, v) => clamp(inputs.x ?? float(Number(v.x ?? 0)), inputs.min ?? float(Number(v.min ?? 0)), inputs.max ?? float(Number(v.max ?? 1))),
  min: (inputs, v) => min(inputs.a ?? float(Number(v.a ?? 0)), inputs.b ?? float(Number(v.b ?? 0))),
  max: (inputs, v) => max(inputs.a ?? float(Number(v.a ?? 0)), inputs.b ?? float(Number(v.b ?? 0))),

  // Interpolation
  mix: (inputs) => mix(inputs.a ?? vec3(0, 0, 0), inputs.b ?? vec3(1, 1, 1), inputs.t ?? float(0.5)),
  smoothstep: (inputs) => smoothstep(inputs.edge0 ?? float(0), inputs.edge1 ?? float(1), inputs.x ?? float(0.5)),
  remap: (inputs) => remap(inputs.x ?? float(0), inputs.inLow ?? float(0), inputs.inHigh ?? float(1), inputs.outLow ?? float(0), inputs.outHigh ?? float(1)),
  select: (inputs) => select(inputs.condition ?? float(0), inputs.a ?? float(0), inputs.b ?? float(0)),

  // Vector
  split: (inputs) => inputs.v ?? vec3(0, 0, 0),
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

  // Color — GPU-friendly branchless HSL→RGB using the standard shader formula:
  // k(channel) = clamp(|mod(6h + offset, 6) - 3| - 1, 0, 1)
  // rgb = L + S*(1 - |2L-1|) * (k - 0.5)
  hsl: (inputs) => {
    const h = inputs.h ?? float(0);
    const s = inputs.s ?? float(1);
    const l = inputs.l ?? float(0.5);
    const h6 = mul(h, float(6));
    const rk = clamp(sub(abs(sub(mod(add(h6, float(0)), float(6)), float(3))), float(1)), float(0), float(1));
    const gk = clamp(sub(abs(sub(mod(add(h6, float(4)), float(6)), float(3))), float(1)), float(0), float(1));
    const bk = clamp(sub(abs(sub(mod(add(h6, float(2)), float(6)), float(3))), float(1)), float(0), float(1));
    const satFactor = mul(s, sub(float(1), abs(sub(mul(float(2), l), float(1)))));
    return vec3(
      add(l, mul(satFactor, sub(rk, float(0.5)))),
      add(l, mul(satFactor, sub(gk, float(0.5)))),
      add(l, mul(satFactor, sub(bk, float(0.5)))),
    );
  },
  // RGB → HSL: passthrough (inverse conversion requires min/max/conditionals not easily expressed in TSL)
  toHsl: (inputs) => inputs.rgb ?? vec3(0, 0, 0),
};

// Dynamic factory for tsl-textures nodes (auto-registered)
const tslTexFactoryCache = new Map<string, ((inputs: Record<string, TSLNode>, values: Record<string, string | number>) => TSLNode) | null>();

function getTSLTextureFactory(registryType: string): ((inputs: Record<string, TSLNode>, values: Record<string, string | number>) => TSLNode) | null {
  if (tslTexFactoryCache.has(registryType)) return tslTexFactoryCache.get(registryType)!;

  const def = NODE_REGISTRY.get(registryType);
  if (!def || def.tslImportModule !== 'tsl-textures') {
    tslTexFactoryCache.set(registryType, null);
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const texFn = (tslTextures as Record<string, any>)[def.tslFunction];
  if (typeof texFn !== 'function') {
    tslTexFactoryCache.set(registryType, null);
    return null;
  }

  const classifications = getParamClassifications(def.tslFunction);

  const factory = (resolvedInputs: Record<string, TSLNode>, values: Record<string, string | number>): TSLNode => {
    const params: Record<string, unknown> = {};

    for (const param of classifications) {
      if (param.kind === 'meta') continue;

      if (param.kind === 'tslRef') {
        if (resolvedInputs[param.key] !== undefined) {
          params[param.key] = resolvedInputs[param.key];
        }
        // Omit → library uses its own default (positionGeometry, time, etc.)
      } else if (param.kind === 'number') {
        if (resolvedInputs[param.key] !== undefined) {
          params[param.key] = resolvedInputs[param.key];
        } else {
          params[param.key] = Number(values[param.key] ?? param.defaultValue ?? 0);
        }
      } else if (param.kind === 'color') {
        const hex = String(values[param.key] ?? '#000000');
        const [r, g, b] = hexToRgb01(hex);
        params[param.key] = new Color(r, g, b);
      } else if (param.kind === 'vec3') {
        params[param.key] = new Vector3(
          Number(values[`${param.key}_x`] ?? 0),
          Number(values[`${param.key}_y`] ?? 0),
          Number(values[`${param.key}_z`] ?? 0),
        );
      } else if (param.kind === 'vec2') {
        params[param.key] = new Vector2(
          Number(values[`${param.key}_x`] ?? 0),
          Number(values[`${param.key}_y`] ?? 0),
        );
      }
    }

    return texFn(params);
  };

  tslTexFactoryCache.set(registryType, factory);
  return factory;
}

export interface CompileResult {
  colorNode: TSLNode | null;
  emissiveNode: TSLNode | null;
  normalNode: TSLNode | null;
  positionNode: TSLNode | null;
  opacityNode: TSLNode | null;
  roughnessNode: TSLNode | null;
  success: boolean;
  error?: string;
}

export function compileGraphToTSL(nodes: AppNode[], edges: AppEdge[]): CompileResult {
  try {
    if (nodes.length === 0) {
      return { colorNode: vec3(1, 0, 0), emissiveNode: null, normalNode: null, positionNode: null, opacityNode: null, roughnessNode: null, success: true };
    }

    const sorted = topologicalSort(nodes, edges);

    // Map node IDs to their TSL output values
    const nodeOutputs = new Map<string, TSLNode>();

    for (const node of sorted) {
      if (node.data.registryType === 'output') continue;

      const factory = TSL_FACTORIES[node.data.registryType] ?? getTSLTextureFactory(node.data.registryType);
      if (!factory) continue;

      // Resolve inputs from incoming edges
      const resolvedInputs: Record<string, TSLNode> = {};
      for (const edge of edges) {
        if (edge.target === node.id && edge.targetHandle) {
          const sourceOutput = nodeOutputs.get(edge.source);
          if (sourceOutput !== undefined) {
            const sh = edge.sourceHandle;
            if (sh && sh !== 'out' && VALID_SWIZZLE.has(sh)) {
              resolvedInputs[edge.targetHandle] = sourceOutput[sh];
            } else {
              resolvedInputs[edge.targetHandle] = sourceOutput;
            }
          }
        }
      }

      // Get node values (defaults, user-set parameters)
      const values = getNodeValues(node);

      // Create the TSL node
      const tslNode = factory(resolvedInputs, values);
      nodeOutputs.set(node.id, tslNode);
    }

    // Find the output node and resolve its connections
    const outputNode = sorted.find((n) => n.data.registryType === 'output');
    let colorNode: TSLNode | null = null;
    let emissiveNode: TSLNode | null = null;
    let normalNode: TSLNode | null = null;
    let positionNode: TSLNode | null = null;
    let opacityNode: TSLNode | null = null;
    let roughnessNode: TSLNode | null = null;

    if (outputNode) {
      for (const edge of edges) {
        if (edge.target !== outputNode.id) continue;
        let sourceOutput = nodeOutputs.get(edge.source);
        if (!sourceOutput) continue;

        // Handle swizzle from split-like nodes
        const sh = edge.sourceHandle;
        if (sh && sh !== 'out' && VALID_SWIZZLE.has(sh)) {
          sourceOutput = sourceOutput[sh];
        }

        switch (edge.targetHandle) {
          case 'color':
            colorNode = sourceOutput;
            break;
          case 'emissive':
            emissiveNode = sourceOutput;
            break;
          case 'normal':
            normalNode = sourceOutput;
            break;
          case 'position':
            positionNode = sourceOutput;
            break;
          case 'opacity':
            opacityNode = sourceOutput;
            break;
          case 'roughness':
            roughnessNode = sourceOutput;
            break;
        }
      }
    }

    // Default: red if no color connected
    if (!colorNode) {
      colorNode = vec3(1, 0, 0);
    }

    return { colorNode, emissiveNode, normalNode, positionNode, opacityNode, roughnessNode, success: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { colorNode: vec3(1, 0, 0), emissiveNode: null, normalNode: null, positionNode: null, opacityNode: null, roughnessNode: null, success: false, error: msg };
  }
}
