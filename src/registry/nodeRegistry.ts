import type { NodeDefinition, NodeCategory } from '@/types';
import { buildTSLTextureDefinitions } from './tslTexturesRegistry';

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
    type: 'uniform_float',
    label: 'Uniform (float)',
    category: 'input',
    tslFunction: 'uniform',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Value', dataType: 'float' }],
    defaultValues: { value: 1.0 },
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

  // ===== NOISE =====
  {
    type: 'noise',
    label: 'Noise',
    category: 'noise',
    tslFunction: 'mx_noise_float',
    tslImportModule: 'three/tsl',
    inputs: [{ id: 'pos', label: 'Position', dataType: 'vec3' }],
    outputs: [{ id: 'out', label: 'Value', dataType: 'float' }],
    defaultValues: { scale: 1.0 },
  },
  {
    type: 'fractal',
    label: 'Fractal (fBm)',
    category: 'noise',
    tslFunction: 'mx_fractal_noise_float',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'pos', label: 'Position', dataType: 'vec3' },
      { id: 'octaves', label: 'Octaves', dataType: 'int' },
      { id: 'lacunarity', label: 'Lacunarity', dataType: 'float' },
      { id: 'diminish', label: 'Diminish', dataType: 'float' },
    ],
    outputs: [{ id: 'out', label: 'Value', dataType: 'float' }],
    defaultValues: { scale: 1.0, octaves: 4, lacunarity: 2.0, diminish: 0.5 },
  },
  {
    type: 'voronoi',
    label: 'Voronoi',
    category: 'noise',
    tslFunction: 'mx_worley_noise_float',
    tslImportModule: 'three/tsl',
    inputs: [{ id: 'pos', label: 'Position', dataType: 'vec3' }],
    outputs: [{ id: 'out', label: 'Value', dataType: 'float' }],
    defaultValues: { scale: 1.0 },
  },

  // ===== COLOR =====
  {
    type: 'hsl',
    label: 'HSL to RGB',
    category: 'color',
    tslFunction: 'hsl',
    tslImportModule: 'three/tsl',
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
    tslImportModule: 'three/tsl',
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
      { id: 'position', label: 'Position', dataType: 'vec3' },
      { id: 'opacity', label: 'Opacity', dataType: 'float' },
      { id: 'roughness', label: 'Roughness', dataType: 'float' },
    ],
    outputs: [],
  },
];

const allDefinitions: NodeDefinition[] = [...definitions, ...buildTSLTextureDefinitions()];

export const NODE_REGISTRY = new Map<string, NodeDefinition>(
  allDefinitions.map(d => [d.type, d])
);

export const TSL_FUNCTION_TO_DEF = new Map<string, NodeDefinition>(
  allDefinitions.filter(d => d.tslFunction).map(d => [d.tslFunction, d])
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
