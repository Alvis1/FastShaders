import type { NodeDefinition, NodeCategory } from '@/types';

const definitions: NodeDefinition[] = [
  // ===== INPUT NODES =====
  {
    type: 'positionGeometry',
    label: 'Position',
    category: 'input',
    tslFunction: 'positionGeometry',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Position', dataType: 'vec3' }],
    description: 'Geometry position in local space',
  },
  {
    type: 'normalLocal',
    label: 'Normal',
    category: 'input',
    tslFunction: 'normalLocal',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Normal', dataType: 'vec3' }],
  },
  {
    type: 'tangentLocal',
    label: 'Tangent',
    category: 'input',
    tslFunction: 'tangentLocal',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Tangent', dataType: 'vec3' }],
  },
  {
    type: 'time',
    label: 'Time',
    category: 'input',
    tslFunction: 'time',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Time', dataType: 'float' }],
  },
  {
    type: 'screenUV',
    label: 'Screen UV',
    category: 'input',
    tslFunction: 'screenUV',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'UV', dataType: 'vec2' }],
  },
  {
    type: 'uv',
    label: 'UV',
    category: 'input',
    tslFunction: 'uv',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'channel', label: 'Channel', dataType: 'int' },
      { id: 'tilingU', label: 'U', dataType: 'float' },
      { id: 'tilingV', label: 'V', dataType: 'float' },
      { id: 'rotation', label: 'Rotation', dataType: 'float' },
    ],
    outputs: [{ id: 'out', label: 'UV', dataType: 'vec2' }],
    defaultValues: { channel: 0, tilingU: 1.0, tilingV: 1.0, rotation: 0.0 },
    description: 'Texture coordinates with tiling and rotation. Defaults to geometry UV. Also: texcoord, texture coordinate',
  },
  {
    type: 'property_float',
    label: 'Property (float)',
    category: 'input',
    tslFunction: 'uniform',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Value', dataType: 'float' }],
    defaultValues: { value: 1.0, name: 'property1' },
  },
  {
    type: 'slider',
    label: 'Slider',
    category: 'input',
    tslFunction: 'float',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Value', dataType: 'float' }],
    defaultValues: { value: 0.5, min: 0.0, max: 1.0 },
    description: 'Adjustable float slider with configurable range. Also: range',
  },

  // ===== TYPE CONSTRUCTORS =====
  {
    type: 'float',
    label: 'Float',
    category: 'type',
    tslFunction: 'float',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Value', dataType: 'float' }],
    defaultValues: { value: 0.0 },
    description: 'Constant float value. Also: number, value',
  },
  {
    type: 'int',
    label: 'Int',
    category: 'type',
    tslFunction: 'int',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Value', dataType: 'int' }],
    defaultValues: { value: 0 },
  },
  {
    type: 'vec2',
    label: 'Vec2',
    category: 'type',
    tslFunction: 'vec2',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'x', label: 'X', dataType: 'float' },
      { id: 'y', label: 'Y', dataType: 'float' },
    ],
    outputs: [{ id: 'out', label: 'Output', dataType: 'vec2' }],
  },
  {
    type: 'vec3',
    label: 'Vec3',
    category: 'type',
    tslFunction: 'vec3',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'x', label: 'X', dataType: 'float' },
      { id: 'y', label: 'Y', dataType: 'float' },
      { id: 'z', label: 'Z', dataType: 'float' },
    ],
    outputs: [{ id: 'out', label: 'Output', dataType: 'vec3' }],
  },
  {
    type: 'vec4',
    label: 'Vec4',
    category: 'type',
    tslFunction: 'vec4',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'x', label: 'X', dataType: 'float' },
      { id: 'y', label: 'Y', dataType: 'float' },
      { id: 'z', label: 'Z', dataType: 'float' },
      { id: 'w', label: 'W', dataType: 'float' },
    ],
    outputs: [{ id: 'out', label: 'Output', dataType: 'vec4' }],
  },
  {
    type: 'color',
    label: 'Color',
    category: 'type',
    tslFunction: 'color',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Color', dataType: 'color' }],
    defaultValues: { hex: '#ff0000' },
  },

  // ===== ARITHMETIC =====
  {
    type: 'add',
    label: 'Add',
    category: 'arithmetic',
    tslFunction: 'add',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any' },
      { id: 'b', label: 'B', dataType: 'any' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' }],
    chainable: true,
  },
  {
    type: 'sub',
    label: 'Subtract',
    category: 'arithmetic',
    tslFunction: 'sub',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any' },
      { id: 'b', label: 'B', dataType: 'any' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' }],
    chainable: true,
  },
  {
    type: 'mul',
    label: 'Multiply',
    category: 'arithmetic',
    tslFunction: 'mul',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any' },
      { id: 'b', label: 'B', dataType: 'any' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' }],
    chainable: true,
  },
  {
    type: 'div',
    label: 'Divide',
    category: 'arithmetic',
    tslFunction: 'div',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any' },
      { id: 'b', label: 'B', dataType: 'any' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' }],
    chainable: true,
  },

  // ===== MATH (unary) =====
  ...([
    ['sin', 'Sine'], ['cos', 'Cosine'], ['abs', 'Abs'], ['sqrt', 'Sqrt'],
    ['exp', 'Exp'], ['log2', 'Log2'], ['floor', 'Floor'], ['round', 'Round'], ['fract', 'Fract'],
  ] as [string, string][]).map(([fn, label]) => ({
    type: fn,
    label,
    category: 'math' as NodeCategory,
    tslFunction: fn,
    tslImportModule: 'three/tsl',
    inputs: [{ id: 'x', label: 'X', dataType: 'any' as const }],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' as const }],
  })),
  {
    type: 'oneMinus',
    label: 'Invert (oneMinus)',
    category: 'math',
    tslFunction: 'oneMinus',
    tslImportModule: 'three/tsl',
    inputs: [{ id: 'x', label: 'X', dataType: 'any' }],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' }],
    description: 'Invert a 0–1 value: returns 1 - x. Also: invert, complement, negate',
  },

  // ===== MATH (binary/ternary) =====
  {
    type: 'pow',
    label: 'Power',
    category: 'math',
    tslFunction: 'pow',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'base', label: 'Base', dataType: 'any' },
      { id: 'exp', label: 'Exponent', dataType: 'float' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' }],
  },
  {
    type: 'mod',
    label: 'Mod',
    category: 'math',
    tslFunction: 'mod',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'x', label: 'X', dataType: 'any' },
      { id: 'y', label: 'Y', dataType: 'any' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' }],
  },
  {
    type: 'clamp',
    label: 'Clamp',
    category: 'math',
    tslFunction: 'clamp',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'x', label: 'Value', dataType: 'any' },
      { id: 'min', label: 'Min', dataType: 'any' },
      { id: 'max', label: 'Max', dataType: 'any' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' }],
  },
  {
    type: 'min',
    label: 'Min',
    category: 'math',
    tslFunction: 'min',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any' },
      { id: 'b', label: 'B', dataType: 'any' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' }],
  },
  {
    type: 'max',
    label: 'Max',
    category: 'math',
    tslFunction: 'max',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any' },
      { id: 'b', label: 'B', dataType: 'any' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' }],
  },

  // ===== INTERPOLATION =====
  {
    type: 'mix',
    label: 'Mix',
    category: 'interpolation',
    tslFunction: 'mix',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any' },
      { id: 'b', label: 'B', dataType: 'any' },
      { id: 't', label: 'Factor', dataType: 'float' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' }],
  },
  {
    type: 'smoothstep',
    label: 'Smoothstep',
    category: 'interpolation',
    tslFunction: 'smoothstep',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'edge0', label: 'Edge 0', dataType: 'float' },
      { id: 'edge1', label: 'Edge 1', dataType: 'float' },
      { id: 'x', label: 'X', dataType: 'float' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'float' }],
  },
  {
    type: 'remap',
    label: 'Remap',
    category: 'interpolation',
    tslFunction: 'remap',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'x', label: 'Value', dataType: 'float' },
      { id: 'inLow', label: 'In Low', dataType: 'float' },
      { id: 'inHigh', label: 'In High', dataType: 'float' },
      { id: 'outLow', label: 'Out Low', dataType: 'float' },
      { id: 'outHigh', label: 'Out High', dataType: 'float' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'float' }],
  },
  {
    type: 'select',
    label: 'Select',
    category: 'interpolation',
    tslFunction: 'select',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'condition', label: 'Condition', dataType: 'float' },
      { id: 'a', label: 'True', dataType: 'any' },
      { id: 'b', label: 'False', dataType: 'any' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' }],
  },

  // ===== VECTOR OPERATIONS =====
  {
    type: 'normalize',
    label: 'Normalize',
    category: 'vector',
    tslFunction: 'normalize',
    tslImportModule: 'three/tsl',
    inputs: [{ id: 'v', label: 'Vector', dataType: 'vec3' }],
    outputs: [{ id: 'out', label: 'Result', dataType: 'vec3' }],
  },
  {
    type: 'length',
    label: 'Length',
    category: 'vector',
    tslFunction: 'length',
    tslImportModule: 'three/tsl',
    inputs: [{ id: 'v', label: 'Vector', dataType: 'vec3' }],
    outputs: [{ id: 'out', label: 'Result', dataType: 'float' }],
  },
  {
    type: 'distance',
    label: 'Distance',
    category: 'vector',
    tslFunction: 'distance',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'a', label: 'A', dataType: 'vec3' },
      { id: 'b', label: 'B', dataType: 'vec3' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'float' }],
  },
  {
    type: 'dot',
    label: 'Dot Product',
    category: 'vector',
    tslFunction: 'dot',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'a', label: 'A', dataType: 'vec3' },
      { id: 'b', label: 'B', dataType: 'vec3' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'float' }],
  },
  {
    type: 'cross',
    label: 'Cross Product',
    category: 'vector',
    tslFunction: 'cross',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'a', label: 'A', dataType: 'vec3' },
      { id: 'b', label: 'B', dataType: 'vec3' },
    ],
    outputs: [{ id: 'out', label: 'Result', dataType: 'vec3' }],
  },

  // ===== SPLIT =====
  {
    type: 'split',
    label: 'Split',
    category: 'vector',
    tslFunction: 'split',
    tslImportModule: '',
    inputs: [{ id: 'v', label: 'Vector', dataType: 'any' }],
    outputs: [
      { id: 'x', label: 'X', dataType: 'float' },
      { id: 'y', label: 'Y', dataType: 'float' },
      { id: 'z', label: 'Z', dataType: 'float' },
      { id: 'w', label: 'W', dataType: 'float' },
    ],
    description: 'Split vector into components. Also: Separate',
  },

  // ===== APPEND =====
  {
    type: 'append',
    label: 'Append',
    category: 'vector',
    tslFunction: 'append',
    tslImportModule: '',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any' },
      { id: 'b', label: 'B', dataType: 'any' },
    ],
    outputs: [{ id: 'out', label: 'Output', dataType: 'any' }],
    description: 'Combine values into a vector. Also: Combine, Join',
  },

  // ===== NOISE =====
  // All noise nodes share the same `pos` (defaults to positionGeometry) +
  // `scale` (uniform multiplier applied to pos) parameter convention; the
  // graphToCode emitter handles them via `def.category === 'noise'`.
  {
    type: 'perlin',
    label: 'Perlin Noise',
    category: 'noise',
    tslFunction: 'mx_noise_float',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Value', dataType: 'float' }],
    defaultValues: { pos: 'positionGeometry', scale: 1.0 },
    description: 'MaterialX Perlin-style noise (scalar, range ~[-1, 1])',
  },
  {
    type: 'perlinVec3',
    label: 'Perlin Noise (vec3)',
    category: 'noise',
    tslFunction: 'mx_noise_vec3',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Value', dataType: 'vec3' }],
    defaultValues: { pos: 'positionGeometry', scale: 1.0 },
    description: 'MaterialX Perlin-style noise (3-channel, range ~[-1, 1] per channel)',
  },
  {
    type: 'fbm',
    label: 'fBm',
    category: 'noise',
    tslFunction: 'mx_fractal_noise_float',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Value', dataType: 'float' }],
    defaultValues: { pos: 'positionGeometry', scale: 1.0 },
    description: 'Fractal Brownian motion (multi-octave Perlin)',
  },
  {
    type: 'fbmVec3',
    label: 'fBm (vec3)',
    category: 'noise',
    tslFunction: 'mx_fractal_noise_vec3',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Value', dataType: 'vec3' }],
    defaultValues: { pos: 'positionGeometry', scale: 1.0 },
    description: 'Fractal Brownian motion (3-channel)',
  },
  {
    type: 'cellNoise',
    label: 'Cell Noise',
    category: 'noise',
    tslFunction: 'mx_cell_noise_float',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Value', dataType: 'float' }],
    defaultValues: { pos: 'positionGeometry', scale: 1.0 },
    description: 'Flat per-cell random value (scalar, range [0, 1])',
  },
  {
    type: 'voronoi',
    label: 'Voronoi',
    category: 'noise',
    tslFunction: 'mx_worley_noise_float',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Value', dataType: 'float' }],
    defaultValues: { pos: 'positionGeometry', scale: 1.0 },
    description: 'Worley/Voronoi cellular noise (F1 distance, scalar)',
  },
  {
    type: 'voronoiVec2',
    label: 'Voronoi (F1/F2)',
    category: 'noise',
    tslFunction: 'mx_worley_noise_vec2',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'F1/F2', dataType: 'vec2' }],
    defaultValues: { pos: 'positionGeometry', scale: 1.0 },
    description: 'Worley/Voronoi cellular noise (first two distances)',
  },
  {
    type: 'voronoiVec3',
    label: 'Voronoi (F1/F2/F3)',
    category: 'noise',
    tslFunction: 'mx_worley_noise_vec3',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'F1/F2/F3', dataType: 'vec3' }],
    defaultValues: { pos: 'positionGeometry', scale: 1.0 },
    description: 'Worley/Voronoi cellular noise (first three distances)',
  },

  // ===== COLOR =====
  {
    type: 'hsl',
    label: 'HSL to RGB',
    category: 'color',
    tslFunction: 'hsl',
    tslImportModule: '',
    inputs: [
      { id: 'h', label: 'Hue', dataType: 'float' },
      { id: 's', label: 'Saturation', dataType: 'float' },
      { id: 'l', label: 'Lightness', dataType: 'float' },
    ],
    outputs: [{ id: 'out', label: 'Color', dataType: 'vec3' }],
  },
  {
    type: 'toHsl',
    label: 'RGB to HSL',
    category: 'color',
    tslFunction: 'toHsl',
    tslImportModule: '',
    inputs: [{ id: 'rgb', label: 'RGB', dataType: 'vec3' }],
    outputs: [{ id: 'out', label: 'HSL', dataType: 'vec3' }],
  },

  // ===== OUTPUT =====
  {
    type: 'output',
    label: 'Output',
    category: 'output',
    tslFunction: 'output',
    tslImportModule: '',
    inputs: [
      { id: 'color', label: 'Color', dataType: 'color' },
      { id: 'emissive', label: 'Emissive', dataType: 'color' },
      { id: 'normal', label: 'Normal', dataType: 'vec3' },
      { id: 'position', label: 'Displacement', dataType: 'vec3' },
      { id: 'opacity', label: 'Opacity', dataType: 'float' },
      { id: 'roughness', label: 'Roughness', dataType: 'float' },
    ],
    outputs: [],
  },
];

// Internal-only node for preserving unrecognized TSL functions during round-tripping.
// Not included in allDefinitions (hidden from content browser / search).
const unknownNodeDef: NodeDefinition = {
  type: 'unknown',
  label: 'Unknown',
  category: 'unknown',
  tslFunction: '',
  tslImportModule: '',
  inputs: [],
  outputs: [{ id: 'out', label: 'Output', dataType: 'any' }],
  description: 'Unknown/unsupported TSL function (preserved for round-tripping)',
};

const allDefinitions: NodeDefinition[] = [...definitions];

export const NODE_REGISTRY = new Map<string, NodeDefinition>(
  [...allDefinitions, unknownNodeDef].map(d => [d.type, d])
);

export const TSL_FUNCTION_TO_DEF = new Map<string, NodeDefinition>(
  allDefinitions.filter(d => d.tslFunction && d.type !== 'slider').map(d => [d.tslFunction, d])
);

export function searchNodes(query: string): NodeDefinition[] {
  const q = query.toLowerCase();
  return allDefinitions.filter(d =>
    d.label.toLowerCase().includes(q) ||
    d.type.toLowerCase().includes(q) ||
    d.tslFunction.toLowerCase().includes(q) ||
    d.description?.toLowerCase().includes(q)
  );
}

export function getAllDefinitions(): NodeDefinition[] {
  return allDefinitions;
}

/** Map a registry definition to its React Flow node type string. */
export type FlowNodeType = 'shader' | 'color' | 'preview' | 'mathPreview' | 'clock' | 'output';

export function getFlowNodeType(def: NodeDefinition): FlowNodeType {
  if (def.type === 'output') return 'output';
  if (def.type === 'time') return 'clock';
  if (def.type === 'color') return 'color';
  if (def.category === 'noise') return 'preview';
  if (def.type === 'sin' || def.type === 'cos') return 'mathPreview';
  return 'shader';
}
