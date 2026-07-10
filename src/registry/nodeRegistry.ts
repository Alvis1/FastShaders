import type { NodeDefinition, NodeCategory, PortDefinition } from '@/types';

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
    type: 'positionLocal',
    label: 'Position (local)',
    category: 'input',
    tslFunction: 'positionLocal',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Position', dataType: 'vec3' }],
    description:
      'Position in local space after displacement is applied — Position gives the raw, pre-displacement value. Also: positionLocal, varying',
  },
  {
    type: 'positionWorld',
    label: 'Position (world)',
    category: 'input',
    tslFunction: 'positionWorld',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Position', dataType: 'vec3' }],
    description: 'Fragment position in world space. Pair with cameraPosition + distance for camera-distance effects.',
  },
  {
    type: 'positionView',
    label: 'Position (view)',
    category: 'input',
    tslFunction: 'positionView',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Position', dataType: 'vec3' }],
    description: 'Fragment position in view (camera) space. The .z component is signed depth from the camera (negative in front).',
  },
  {
    type: 'positionWorldDirection',
    label: 'View Dir (world)',
    category: 'input',
    tslFunction: 'positionWorldDirection',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Direction', dataType: 'vec3' }],
    // NB: despite the "View Dir" label, three's positionWorldDirection is the
    // LOCAL POSITION rotated into world space — no camera term involved.
    description:
      'The local position rotated into world space as a unit direction — points from the object origin out through the surface (sky/equirect-style lookups).',
  },
  {
    type: 'positionViewDirection',
    label: 'View Dir (view)',
    category: 'input',
    tslFunction: 'positionViewDirection',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Direction', dataType: 'vec3' }],
    description:
      'Normalized view-space direction from the fragment toward the camera — the classic view vector for fresnel and rim effects.',
  },
  {
    type: 'cameraPosition',
    label: 'Camera Position',
    category: 'input',
    tslFunction: 'cameraPosition',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Position', dataType: 'vec3' }],
    description: 'World-space camera position. Use distance(positionWorld, cameraPosition) for camera-distance effects.',
  },
  {
    type: 'cameraNear',
    label: 'Camera Near',
    category: 'input',
    tslFunction: 'cameraNear',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Near', dataType: 'float' }],
    description: 'Active camera near-plane distance.',
  },
  {
    type: 'cameraFar',
    label: 'Camera Far',
    category: 'input',
    tslFunction: 'cameraFar',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Far', dataType: 'float' }],
    description: 'Active camera far-plane distance.',
  },
  {
    type: 'normalLocal',
    label: 'Normal',
    category: 'input',
    tslFunction: 'normalLocal',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Normal', dataType: 'vec3' }],
    description: 'Surface normal in local (object) space — the direction the surface faces.',
  },
  {
    type: 'tangentLocal',
    label: 'Tangent',
    category: 'input',
    tslFunction: 'tangentLocal',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Tangent', dataType: 'vec3' }],
    description:
      'The geometry\'s tangent attribute in local space — zero on meshes without tangent data (including the built-in preview shapes).',
  },
  {
    type: 'time',
    label: 'Time',
    category: 'input',
    tslFunction: 'time',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Time', dataType: 'float' }],
    description: 'Elapsed time in seconds — wire it in to animate values. Also: clock, animation',
  },
  {
    type: 'screenUV',
    label: 'Screen UV',
    category: 'input',
    tslFunction: 'screenUV',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'UV', dataType: 'vec2' }],
    description: 'Viewport coordinates (0–1 across the screen), independent of the geometry.',
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
    description:
      'Named float uniform — appears as an adjustable property slider in the preview and the exported shader. Also: uniform, parameter',
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
    description: 'Constant integer value. Also: whole number',
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
    description: 'Build a 2-component vector from X and Y.',
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
    description: 'Build a 3-component vector from X, Y and Z.',
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
    description: 'Build a 4-component vector from X, Y, Z and W.',
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
    description: 'Constant RGB color from a color picker. Also: rgb, swatch',
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
    chainIdentity: 0,
    description: 'Add inputs together, per channel — connecting more inputs grows extra sockets. Also: plus, sum',
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
    chainIdentity: 0,
    description: 'Subtract B from A, per channel. Also: minus, difference',
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
    chainIdentity: 1,
    description:
      'Multiply inputs together, per channel — the usual way to scale or mask a value. Also: times, product, scale',
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
    chainIdentity: 1,
    description: 'Divide A by B, per channel. Also: quotient, ratio',
  },

  // ===== MATH (unary) =====
  ...([
    ['sin', 'Sine', 'Sine wave of the input (radians) — oscillates between -1 and 1. Also: oscillate'],
    ['cos', 'Cosine', 'Cosine wave of the input (radians) — Sine shifted a quarter period, starts at 1.'],
    ['abs', 'Abs', 'Absolute value — flips negative values positive.'],
    ['sqrt', 'Sqrt', 'Square root of the input.'],
    ['exp', 'Exp', 'Natural exponential e^x — a rapid growth curve.'],
    ['log2', 'Log2', 'Base-2 logarithm of the input.'],
    ['floor', 'Floor', 'Round down to the nearest whole number — makes staircase steps.'],
    ['round', 'Round', 'Round to the nearest whole number.'],
    ['fract', 'Fract', 'Fractional part of the input — a repeating 0–1 ramp, the basis of tiling. Also: repeat'],
  ] as [string, string, string][]).map(([fn, label, description]) => ({
    type: fn,
    label,
    category: 'math' as NodeCategory,
    tslFunction: fn,
    tslImportModule: 'three/tsl',
    inputs: [{ id: 'x', label: 'X', dataType: 'any' as const }],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' as const }],
    description,
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
    // Unwired operands must be the IDENTITY, not 0: pow(0, exp) = 0 and
    // pow(base, 0) = 1 both discard the input. pow(base, 1) = base and
    // pow(1, exp) = 1 keep an unwired node inert. Matches the CPU evaluator.
    defaultValues: { base: 1, exp: 1 },
    description:
      'Raise Base to Exponent — bends a 0–1 ramp (exponent above 1 darkens, below 1 brightens). Also: gamma, curve',
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
    // y defaults to 1, never 0 — an unwired divisor would emit mod(x, 0) (NaN).
    // Matches the CPU evaluator's fallback.
    defaultValues: { x: 0, y: 1 },
    description: 'Remainder of X / Y — wraps X into the range [0, Y). Also: modulo, wrap',
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
    description: 'Limit a value to the Min–Max range. Also: constrain, saturate',
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
    // An unwired operand must be the IDENTITY, not the annihilator: min(a, 0) = 0
    // for every a ≥ 0 (i.e. almost all shader values), which silently zeroes the
    // input. 1 is the identity over the usual [0, 1] domain (min(a, 1) = a). BOTH
    // operands need it — codegen falls back to this for any unwired port, so an
    // 'a'-only default would emit min(0, b) and disagree with the CPU preview.
    defaultValues: { a: 1, b: 1 },
    description: 'The smaller of A and B, per channel. Also: minimum',
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
    // 0 is already sensible for max — max(a, 0) is a ReLU that passes non-negative
    // values through; made explicit so the default shows/seeds like min's.
    defaultValues: { b: 0 },
    description: 'The larger of A and B, per channel. Also: maximum',
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
    description: 'Blend from A to B by Factor (0 gives A, 1 gives B). Also: lerp, blend, interpolate',
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
    description: 'Smooth 0→1 transition as X moves from Edge 0 to Edge 1 — a soft, anti-aliased threshold.',
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
    description: 'Rescale a value from the In Low–In High range to Out Low–Out High. Also: map range',
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
    description:
      'Output the True or False input depending on Condition — a per-pixel if/else. Also: ternary, switch, branch',
  },

  // ===== LOGIC (comparisons feed select() / Output.discard) =====
  {
    type: 'greaterThan',
    label: 'Greater Than',
    category: 'logic',
    tslFunction: 'greaterThan',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any' },
      { id: 'b', label: 'B', dataType: 'any' },
    ],
    outputs: [{ id: 'out', label: 'A > B', dataType: 'any' }],
    description: 'Per-channel a > b. Feeds Select.condition or Output.discard.',
  },
  {
    type: 'lessThan',
    label: 'Less Than',
    category: 'logic',
    tslFunction: 'lessThan',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any' },
      { id: 'b', label: 'B', dataType: 'any' },
    ],
    outputs: [{ id: 'out', label: 'A < B', dataType: 'any' }],
    description: 'Per-channel a < b. Feeds Select.condition or Output.discard.',
  },
  {
    type: 'equal',
    label: 'Equal',
    category: 'logic',
    tslFunction: 'equal',
    tslImportModule: 'three/tsl',
    inputs: [
      { id: 'a', label: 'A', dataType: 'any' },
      { id: 'b', label: 'B', dataType: 'any' },
    ],
    outputs: [{ id: 'out', label: 'A == B', dataType: 'any' }],
    description: 'Per-channel a == b. Feeds Select.condition or Output.discard.',
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
    description: 'Rescale a vector to length 1, keeping its direction. Also: unit vector',
  },
  {
    type: 'length',
    label: 'Length',
    category: 'vector',
    tslFunction: 'length',
    tslImportModule: 'three/tsl',
    inputs: [{ id: 'v', label: 'Vector', dataType: 'vec3' }],
    outputs: [{ id: 'out', label: 'Result', dataType: 'float' }],
    description: 'Length (magnitude) of a vector. Also: magnitude',
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
    description: 'Straight-line distance between two points.',
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
    description: 'Dot product of A and B — how aligned two vectors are (the basis of lighting falloff).',
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
    description: 'Cross product — a vector perpendicular to both A and B.',
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
    description: 'Build an RGB color from Hue, Saturation and Lightness — easy rainbow ramps via Hue.',
  },
  {
    type: 'toHsl',
    label: 'RGB to HSL',
    category: 'color',
    tslFunction: 'toHsl',
    tslImportModule: '',
    inputs: [{ id: 'rgb', label: 'RGB', dataType: 'vec3' }],
    outputs: [{ id: 'out', label: 'HSL', dataType: 'vec3' }],
    description: 'Convert an RGB color into Hue/Saturation/Lightness components.',
  },

  // ===== DATA VISUALIZATION =====
  // Renders a 1-D data signal (wire a Data node column into `signal`) as
  // density-modulated stripes plus a sequential color ramp. The stripe density
  // is driven by a CPU-precomputed cumulative-phase texture (baked in
  // graphToCode from the upstream Data column), so the bars never tear; the
  // derivative-AA + moiré fade live in the emitted TSL. tslFunction is empty —
  // graphToCode emits this node specially (no `three/tsl` import by name).
  {
    type: 'stripes',
    label: 'Data Stripes',
    category: 'color',
    tslFunction: '',
    tslImportModule: '',
    inputs: [{ id: 'signal', label: 'Signal', dataType: 'float' }],
    outputs: [{ id: 'out', label: 'Color', dataType: 'vec3' }],
    defaultValues: {
      baseFrequency: 80,
      density: 1.5,
      lowColor: '#1b2a4a',
      highColor: '#ffd24d',
    },
    description:
      'Visualize a Data node column as density-modulated stripes + color ramp. Wire a Data output into Signal.',
  },
  // Data Viz: distributes a single Data column along one axis (or radially) as a
  // continuous colour ramp with a full tone curve — scale/offset, low/high input
  // cutoffs, midpoint (gamma) and contrast. No stripes: colour alone reads the
  // value. tslFunction is empty — graphToCode emits it specially (bakes a
  // HalfFloat value texture from the upstream Data column). The tone controls +
  // radial options live in the right-click DataVizSettingsMenu, not inline.
  {
    type: 'dataviz',
    label: 'Data Viz',
    category: 'color',
    tslFunction: '',
    tslImportModule: '',
    inputs: [{ id: 'signal', label: 'Signal', dataType: 'float' }],
    // Two outputs: the colour ramp (vec3) and the raw tone-mapped scalar
    // (float, 0–1). Wire Value → the Output node's Displacement so height is
    // driven by the DATA, independent of the colour choice.
    outputs: [
      { id: 'out', label: 'Color', dataType: 'vec3' },
      { id: 'value', label: 'Value', dataType: 'float' },
    ],
    defaultValues: {
      lowColor: '#1b2a4a',
      highColor: '#ffd24d',
    },
    description:
      'Map a Data node column to a colour ramp along one axis (or radially), with scale, offset, cutoffs, midpoint and contrast. Colour output for the surface; Value output (scalar height) for displacement. Wire a Data output into Signal; tone controls are in the right-click menu.',
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
      { id: 'discard', label: 'Discard', dataType: 'float' },
    ],
    outputs: [],
    description:
      'The material output — color, emissive, normal, displacement, opacity, roughness and discard channels.',
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

// Created exclusively by dropping a CSV onto the canvas — never dragged blank
// from the palette (it would carry no data), so it's excluded from
// allDefinitions like `unknown`. Its real outputs are per-instance
// `dynamicOutputs` (one float per CSV column); the single placeholder here is
// what graphToCode/shape-inference fall back to. Each output samples its
// column's DataTexture at uv.x.
const dataNodeDef: NodeDefinition = {
  type: 'dataNode',
  label: 'Data',
  category: 'input',
  tslFunction: '',
  tslImportModule: '',
  inputs: [],
  outputs: [{ id: 'col0', label: 'Column', dataType: 'float' }],
  description: 'A dropped CSV dataset; one float output per column, sampled at uv.x.',
};

// Created exclusively by dropping an image file onto the canvas — hidden from
// the palette like `unknown`/`dataNode`. The payload (a compressed data: URL)
// lives on `data.values.imageB64` (see `src/utils/imageNode.ts` for the
// validation/limit rules). Output is the texture sample's `.rgb` (vec3 — the
// out dataType drives edge shape inference); the optional `uv` input overrides
// the sampling coordinate, falling back to `uv()`. The tile/offset params are
// OPT-IN sockets: ShaderNode hides them unless their ids appear in the node's
// `exposedPorts` (toggled in Node Settings → "…as input sockets"); a wired
// edge overrides the stored value. `uv` has no defaultValues entry on purpose
// (an inline number would be a dead widget — codegen falls back to uv()).
const imageNodeDef: NodeDefinition = {
  type: 'imageNode',
  label: 'Image',
  category: 'texture',
  tslFunction: '',
  tslImportModule: '',
  inputs: [
    { id: 'uv', label: 'UV', dataType: 'vec2' },
    { id: 'tileX', label: 'Tile X', dataType: 'float' },
    { id: 'tileY', label: 'Tile Y', dataType: 'float' },
    { id: 'offsetX', label: 'Offset X', dataType: 'float' },
    { id: 'offsetY', label: 'Offset Y', dataType: 'float' },
  ],
  outputs: [{ id: 'out', label: 'Color', dataType: 'vec3' }],
  defaultValues: { tileX: 1, tileY: 1, offsetX: 0, offsetY: 0 },
  description: 'A dropped image sampled as a texture (RGB); optional UV/tile/offset inputs.',
};

const allDefinitions: NodeDefinition[] = [...definitions];

export const NODE_REGISTRY = new Map<string, NodeDefinition>(
  [...allDefinitions, unknownNodeDef, dataNodeDef, imageNodeDef].map(d => [d.type, d])
);

export const TSL_FUNCTION_TO_DEF = new Map<string, NodeDefinition>(
  allDefinitions.filter(d => d.tslFunction && d.type !== 'slider').map(d => [d.tslFunction, d])
);

/** Positional operand-port id for a chainable node: 0→'a' … 25→'z', then 'arg26'+. */
export function chainPortId(i: number): string {
  return i < 26 ? String.fromCharCode(97 + i) : `arg${i}`;
}

/** Inverse of chainPortId; returns -1 for handles that aren't operand ports. */
export function chainPortIndex(handle: string): number {
  if (handle.length === 1 && handle >= 'a' && handle <= 'z') return handle.charCodeAt(0) - 97;
  const m = /^arg(\d+)$/.exec(handle);
  return m ? Number(m[1]) : -1;
}

/**
 * Hard cap on a chainable node's operand sockets. Generous for any real shader,
 * but bounds allocation/iteration against adversarial `.fastshader` input (a
 * hand-edited edge like `targetHandle: "arg99999999"` must not blow up the
 * operand list, the emitted call string, or the per-frame CPU fold).
 */
export const MAX_CHAIN_OPERANDS = 64;

/**
 * Effective input ports for a node instance. `chainable` (variadic arithmetic)
 * nodes grow past their two registry ports: as each trailing operand is wired,
 * one more socket is exposed below it. `connectedHandles` is the set of this
 * node's connected target-handle ids.
 *
 * With `includeTrailingEmpty` (default) one extra *empty* socket is exposed
 * below the last WIRED operand — the grow affordance used for rendering. A new
 * row therefore appears only when a socket gets an actual edge: typing a value
 * into the trailing box keeps its row but never spawns the next one. Pass
 * `false` for codegen/eval, which only want operands that carry a value (no
 * dangling empty socket). Non-chainable nodes always return their static ports.
 *
 * `valuedHandles` are keys that carry a stored inline value. An *extension*
 * operand (c, d, … — never the base a/b) that holds a value keeps its row and
 * is emitted, so imported code with literal operands like `add(x, 2, 3)`
 * round-trips instead of dropping the extras — but it earns no trailing slot
 * of its own. The count is clamped to MAX_CHAIN_OPERANDS.
 */
export function effectiveInputs(
  def: NodeDefinition,
  connectedHandles: Iterable<string>,
  includeTrailingEmpty = true,
  valuedHandles: Iterable<string> = [],
): PortDefinition[] {
  if (!def.chainable) return def.inputs;
  let connectedMax = -1;
  for (const h of connectedHandles) {
    const i = chainPortIndex(h);
    if (i > connectedMax) connectedMax = i;
  }
  let valuedMax = -1;
  for (const h of valuedHandles) {
    const i = chainPortIndex(h);
    // Only extension operands count — a stored value on the base a/b ports
    // (edited inline) must not sprout another socket.
    if (i >= def.inputs.length && i > valuedMax) valuedMax = i;
  }
  // The trailing empty slot follows the last CONNECTED operand only; valued
  // operands keep their own row but never open a new one.
  const count = Math.min(
    MAX_CHAIN_OPERANDS,
    Math.max(
      def.inputs.length,
      connectedMax + 1 + (includeTrailingEmpty ? 1 : 0),
      valuedMax + 1,
    ),
  );
  const ports: PortDefinition[] = [];
  for (let i = 0; i < count; i++) {
    ports.push(
      def.inputs[i] ??
        { id: chainPortId(i), label: chainPortId(i).toUpperCase(), dataType: 'any' },
    );
  }
  return ports;
}

/**
 * Human-facing description for tooltips: the registry text minus the trailing
 * "Also: …" list, which exists only to feed search with aliases.
 */
export function displayDescription(def: NodeDefinition): string | undefined {
  const text = def.description?.split(/\s*Also:/)[0].trim();
  return text || undefined;
}

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
