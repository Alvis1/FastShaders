import type { NodeDefinition, NodeCategory, PortDefinition } from '@/types';
import { nodeSearchLV, nodeLabelLV } from '@/i18n';
import { MIC_DEFAULT_VALUES } from '@/utils/micNode';
import { HIDDEN_NODE_TYPES } from './editorVisibility';

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
      'Position in local space. Also: positionLocal, varying',
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
    label: 'Outward Dir (world)',
    category: 'input',
    tslFunction: 'positionWorldDirection',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Direction', dataType: 'vec3' }],
    // NB: three's positionWorldDirection is the LOCAL POSITION rotated into
    // world space — no camera term involved. It was labelled "View Dir (world)"
    // and sat beside the GENUINE view vector below, so the pair read as one
    // concept in two spaces; the Latvian label ("Pasaules virziens") never
    // agreed with the English one. Old queries survive via the Also: tail.
    description:
      'The local position rotated into world space as a unit direction — points from the object origin out through the surface (sky/equirect-style lookups). Also: view dir, world direction, outward, equirect',
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
    description: 'Direction the surface faces.',
  },
  {
    // The world-space counterpart of normalLocal. Needed because the preview
    // entity carries a resting tilt AND an animated spin, so an object-space
    // normal dotted against a world-space direction (a view vector, world up)
    // measures against a rotated frame: the result turns with the model. Every
    // fresnel preset was wrong for exactly that reason.
    //
    // In the fragment stage this resolves through the material's SHADED normal
    // (three's normalView → builder.context.setupNormal()), so it reflects any
    // normal map wired into the Output node — desirable for a fresnel, but a
    // coupling normalLocal does not have. For DISPLACEMENT stay on normalLocal,
    // which matches object-space Position.
    type: 'normalWorld',
    label: 'Normal (world)',
    category: 'input',
    tslFunction: 'normalWorld',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Normal', dataType: 'vec3' }],
    description:
      'Surface normal in world space — where the face points after the model\'s own rotation is applied. Compare against world-space directions such as a view vector; the plain Normal node is object space and turns with the model.',
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
    // `speed` is a MODIFIER, not a constructor argument: graphToCode has a
    // dedicated `def.type === 'time'` branch (the generic defaultValues branch
    // would emit the invalid `time(1)` — `time` is a uniform node object, not
    // a callable), and codeToGraph collapses `time.mul(k)` back into it.
    defaultValues: { speed: 1 },
    // Keep UI-instruction wording out of the prose: `description` doubles as the
    // search corpus, and "speed multiplier" made every `mul`/`multip` query
    // surface this node. Search aliases belong in the `Also:` tail.
    description:
      'Elapsed time in seconds — wire it in to animate values; right-click to set its speed, or expose speed as an input socket. Also: clock, animation, speed',
  },
  {
    type: 'micNode',
    label: 'Microphone',
    category: 'input',
    // Emitted BY HAND (four `uniform(0)` lines, one per channel), so the
    // tslFunction is empty. Like `dataNode` — and UNLIKE the dataviz family —
    // it claims its variable base through a dedicated branch with ALIASES
    // rather than a CUSTOM_EMISSION_BASENAMES entry, because it emits
    // `<var>_<channel>` identifiers rather than a single `<var>`; see the
    // alias claim in graphToCode. An empty tslFunction also self-excludes it
    // from TSL_FUNCTION_TO_DEF, which is what keeps it one-way through
    // codeToGraph.
    tslFunction: '',
    tslImportModule: '',
    // Declared as REAL inputs, not just defaultValues keys: ShaderNode builds
    // sockets from `def.inputs`, so a param that lives only in defaultValues
    // can be ticked "expose as input socket" and still render nothing. That is
    // the imageNode pattern (uv/tileX/…); the noise nodes and Time get away
    // with defaultValues-only because they render through PreviewNode/ClockNode,
    // which have their own socket handling. Both keep a defaultValues entry too,
    // so an UNexposed param still shows its inline number widget.
    inputs: [
      { id: 'smoothing', label: 'Smoothing', dataType: 'float' },
      { id: 'gain', label: 'Gain', dataType: 'float' },
    ],
    outputs: [
      { id: 'level', label: 'Level', dataType: 'float' },
      { id: 'bass', label: 'Bass', dataType: 'float' },
      { id: 'mid', label: 'Mid', dataType: 'float' },
      { id: 'treble', label: 'Treble', dataType: 'float' },
    ],
    // Analyser settings. Both follow the opt-in exposedPorts rules (hidden
    // until ticked, auto-exposed when an edge lands, wired edge overrides the
    // stored number). They resolve very differently though: `gain` is applied
    // SHADER-side by codegen, while `smoothing` configures an AnalyserNode on
    // the CPU and so is resolved by evaluating its upstream chain on the CPU —
    // see the mic convention in CLAUDE.md.
    defaultValues: MIC_DEFAULT_VALUES,
    description:
      'Live microphone loudness and three frequency bands, 0–1 each. The values only move while capture is armed in the preview; a downloaded shader holds them at 0 unless the embedding page drives them. Also: audio, sound, music, reactive, spectrum, fft',
  },
  {
    type: 'audioInput',
    label: 'Audio Input',
    category: 'input',
    // Same hand-emitted shape as micNode — four `uniform(0)` lines, one per
    // CONSUMED channel — sharing its alias-claiming branch in graphToCode. It
    // needs its own variable base (`aud`, see AUDIO_VAR_BASE) because the pump
    // routes each uniform back to its own capture session by that prefix: a
    // graph may hold both nodes, and a shared base would drive one node's
    // uniforms from the other node's sound.
    tslFunction: '',
    tslImportModule: '',
    // Real def.inputs for the same reason micNode declares them — see above.
    inputs: [
      { id: 'smoothing', label: 'Smoothing', dataType: 'float' },
      { id: 'gain', label: 'Gain', dataType: 'float' },
    ],
    outputs: [
      { id: 'level', label: 'Level', dataType: 'float' },
      { id: 'bass', label: 'Bass', dataType: 'float' },
      { id: 'mid', label: 'Mid', dataType: 'float' },
      { id: 'treble', label: 'Treble', dataType: 'float' },
    ],
    defaultValues: MIC_DEFAULT_VALUES,
    // NB the SOURCE (share a tab / pick a device) is deliberately absent from
    // defaultValues and from `values`: it is session-only, like the Mic node's
    // device choice. See utils/audioSource.ts for why.
    description:
      'Reacts to sound already playing — a media player, a browser tab, or any audio input including a loopback device. Loudness plus three frequency bands, 0–1 each. Pick the source on the node; values only move while capture is armed, and a downloaded shader holds them at 0 unless the embedding page drives them. Also: system audio, music, speaker, tab, desktop, loopback, spectrum, fft',
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
    // The Colour node's uniform counterpart — what a Color converts INTO.
    // The Colour node's uniform counterpart — what a Color converts INTO.
    // Renders as a ColorNode too (rectangular variant), with its `name` drawn
    // inside the swatch; the type stays distinct because codegen emits
    // `uniform(color(...))` for it and a plain `color(...)` for the constant.
    type: 'property_color',
    label: 'Property (color)',
    category: 'input',
    tslFunction: 'uniform',
    tslImportModule: 'three/tsl',
    inputs: [],
    outputs: [{ id: 'out', label: 'Color', dataType: 'color' }],
    defaultValues: { hex: '#ff0000', name: 'color1' },
    description:
      'Named colour uniform (a vec3) — appears as an adjustable property in the preview and the exported shader. Also: uniform, parameter, swatch, rgb',
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
    description: 'Sum inputs. Also: plus, sum',
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
    description: 'Subtract B from A. Also: minus, difference',
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
      'Multiply inputs. Also: times, product, scale',
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
    description: 'Divide A by B. Also: quotient, ratio',
  },

  // ===== MATH (unary) =====
  ...([
    ['sin', 'Sine', 'Sine wave of the input (radians) — oscillates between -1 and 1. Also: oscillate'],
    ['cos', 'Cosine', 'Cosine wave of the input (radians) — Sine shifted a quarter period, starts at 1.'],
    ['abs', 'Abs', 'Absolute value — flips negative values positive.'],
    ['sqrt', 'Sqrt', 'Square root of the input.'],
    ['exp', 'Exp', 'Natural exponential e^x — a rapid growth curve.'],
    // log2(0) is -Infinity, and a HARD compile error under WGSL/Tint — so an
    // unwired Log2 killed the whole shader on the WebGPU path. cpuEvaluator has
    // always used 1 here (log2(1) = 0); the registry simply never matched it.
    ['log2', 'Log2', 'Base-2 logarithm of the input.', { x: 1 }],
    ['floor', 'Floor', 'Round down to the nearest whole number — makes staircase steps.'],
    ['round', 'Round', 'Round to the nearest whole number.'],
    ['fract', 'Fract', 'Fractional part of the input — a repeating 0–1 ramp, the basis of tiling. Also: repeat'],
    // The optional 4th element is defaultValues. It exists so a unary whose
    // domain excludes 0 can declare its identity WITHOUT being lifted out into
    // its own def — registry ORDER is the documented tie-break for add-menu
    // result ranking, so moving one would reorder search results.
  ] as [string, string, string, Record<string, number>?][]).map(([fn, label, description, defaultValues]) => ({
    type: fn,
    label,
    category: 'math' as NodeCategory,
    tslFunction: fn,
    tslImportModule: 'three/tsl',
    inputs: [{ id: 'x', label: 'X', dataType: 'any' as const }],
    outputs: [{ id: 'out', label: 'Result', dataType: 'any' as const }],
    ...(defaultValues ? { defaultValues } : {}),
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
    // An unwired bound must be the IDENTITY, not 0 — the same rule min/max/pow/
    // mod already carry. Without these, codegen's unwired-port fallback emitted
    // `clamp(x, 0, 0)`: the output is CONSTANT 0, so a freshly dropped Clamp
    // silently destroyed the signal, while the CPU evaluator previewed max = 1
    // (cpuEvaluator's `case 'clamp'`) — node and shader disagreed. 0…1 is also
    // the saturate range the description promises. `x` needs no entry: its
    // unwired fallback is already 0 on both sides.
    defaultValues: { min: 0, max: 1 },
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
    description: 'Compares two values and returns the smaller one. Also: minimum, less',
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
    description: 'Compares two values and returns the larger one. Also: maximum, larger',
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
    // Unwired this emitted `mix(0, 0, 0)` — a constant 0 — while the node's own
    // card reported 0.5. Worse, with only B wired it emitted `mix(0, B, 0)`,
    // which DISCARDS the wired signal. Unlike min/pow/mod there is no single
    // identity here (t=0 is A's, t=1 is B's), so one operand has to lose: 0/1
    // at t=0.5 is the assignment under which every socket does something when
    // wired alone (t alone → mix(0,1,t) = t, the canonical factor→value idiom).
    // It also matches cpuEvaluator's own fallbacks exactly, so card and shader
    // agree by construction. Consequence to accept: an A-only Mix now renders
    // (A+1)/2 rather than A — but that is not a regression from a correct
    // state, because the card was ALREADY reporting (A+1)/2 while the shader
    // rendered A.
    defaultValues: { a: 0, b: 1, t: 0.5 },
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
    // `smoothstep(0, 0, x)` — what the unwired edges used to emit — is a HARD
    // compile error under WGSL/Tint ("low equal to high"), so the whole module
    // failed to build on the WebGPU preview path; GLSL merely leaves it
    // undefined, which measured as a hard binary step, i.e. the antialiased
    // ramp this node exists for is destroyed either way. 0→1 is the canonical
    // soft threshold and is what cpuEvaluator already assumes for the edges.
    // `x` deliberately gets NO entry (clamp's rule): the signal port is the one
    // you always wire, and its unwired fallback is 0 on both sides.
    defaultValues: { edge0: 0, edge1: 1 },
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
    // Unwired ports must describe a USABLE range, not fall through codegen's
    // bare '0' placeholder — that emitted `remap(x, 0, 0, 0, 0)`, whose
    // `(x - inLow) / (inHigh - inLow)` divides by zero, so a freshly dropped
    // Remap output NaN rather than merely being wrong. 0…1 → 0…1 makes it the
    // IDENTITY when nothing is set (the rule min/max/pow/mod/clamp follow), and
    // matches cpuEvaluator's own fallbacks exactly, so the node's on-card value
    // agrees with what renders. Every existing graph passes its bounds
    // explicitly (the Tests/ corpus and both presets do), so their emission is
    // unchanged.
    defaultValues: { x: 0, inLow: 0, inHigh: 1, outLow: 0, outHigh: 1 },
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
    // Grows sockets like the arithmetic ops, but `variadic` NOT `chainable`:
    // append builds a vector, it doesn't fold. (chainable would price it as
    // N−1 operations and fold absent operands through an identity — neither
    // applies to a constructor.)
    //
    // Capped at 4 operands because there is no vec5. Note the real limit is on
    // CHANNELS, not sockets — 4 floats fill a vec4, but so do 2 vec2s — so the
    // emitter, not this count, guarantees the constructor never overflows.
    // See buildAppendConstructor in graphToCode.
    variadic: true,
    maxOperands: 4,
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
    description: 'MaterialX Perlin-style noise (scalar). New nodes output 0…1; Node Settings switches to the raw signed range.',
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
    description: 'MaterialX Perlin-style noise (3-channel). New nodes output 0…1 per channel; Node Settings switches to the raw signed range.',
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
    description: 'Fractal Brownian motion (multi-octave Perlin). New nodes output approximately 0…1; Node Settings switches to the raw signed range.',
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
    description: 'Fractal Brownian motion (3-channel). New nodes output approximately 0…1 per channel; Node Settings switches to the raw signed range.',
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

  // ===== COLOR CONVERSIONS (category: type) =====
  // Representation converters — they live in the Types category beside the
  // `color` constructor (the old standalone `color` category was retired).
  {
    type: 'hsl',
    label: 'HSL to RGB',
    category: 'type',
    tslFunction: 'hsl',
    tslImportModule: '',
    inputs: [
      { id: 'h', label: 'Hue', dataType: 'float' },
      { id: 's', label: 'Saturation', dataType: 'float' },
      { id: 'l', label: 'Lightness', dataType: 'float' },
    ],
    outputs: [{ id: 'out', label: 'Color', dataType: 'vec3' }],
    // The worst annihilator in the registry: unwired it emitted `hsl(0, 0, 0)`
    // = BLACK while its own card showed pure RED (the evaluator's [1, 0, 0]).
    // Saturation 0 and Lightness 0 each force black independently, so wiring a
    // ramp into Hue — literally what this node's description promises — still
    // rendered black at every hue. These are the evaluator's own numbers, so
    // card and shader now agree by construction.
    defaultValues: { h: 0, s: 1, l: 0.5 },
    description: 'Build an RGB color from Hue, Saturation and Lightness — easy rainbow ramps via Hue.',
  },
  {
    type: 'toHsl',
    label: 'RGB to HSL',
    category: 'type',
    tslFunction: 'toHsl',
    tslImportModule: '',
    inputs: [{ id: 'rgb', label: 'RGB', dataType: 'vec3' }],
    // The three components are addressable individually — the usual reason to
    // reach for this node is one of them (hue-shift, desaturate, read
    // lightness). They are SWIZZLES of one emitted call, never three calls:
    // `resolveEdgeRef` maps h/s/l → `.x/.y/.z` of the node's own var and
    // `resolveMemberExpr` maps them back, so the cost stays one conversion
    // (three separate calls measured ~2.5× the GLSL — three inlines the Fn).
    //
    // `out` STAYS outputs[0] and is deliberately not replaced. It is the
    // defensive default the whole codebase assumes (`?? 'out'`,
    // `outputs.find(id === 'out') ?? outputs[0]`, the designer's socket key,
    // drop-on-edge splice), and there is no migration path for a removed
    // handle: `applyProjectToStore` runs none of loadGraph's migrations, and
    // codeToGraph re-creates `'out'` on every Apply — so a shared `.js` would
    // keep a dead handle forever. React Flow renders such an edge as NOTHING
    // while keeping it in the store, i.e. it fails silently.
    //
    // float (not `any`) is load-bearing: it makes the Output-channel
    // scalar→vec3 widening fire, so h → Color emits `vec3(toHsl1.x)` instead
    // of splatting hue into alpha. The English labels are exact — `portLabel`
    // keys Latvian off them and lv.json already carries all three from the
    // sibling `hsl` node's inputs.
    outputs: [
      { id: 'out', label: 'HSL', dataType: 'vec3' },
      { id: 'h', label: 'Hue', dataType: 'float' },
      { id: 's', label: 'Saturation', dataType: 'float' },
      { id: 'l', label: 'Lightness', dataType: 'float' },
    ],
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
    category: 'dataviz',
    tslFunction: '',
    tslImportModule: '',
    // The two ramp ends are REAL inputs, not just defaultValues keys, so they
    // can be wired: ShaderNode builds sockets from `def.inputs`, so a param
    // living only in defaultValues can be ticked "expose as input socket" and
    // still render nothing (the documented micNode/imageNode trap). They KEEP
    // their defaultValues entries too, so an unexposed node still shows its
    // inline swatch and emits byte-identically.
    inputs: [
      { id: 'signal', label: 'Signal', dataType: 'float' },
      { id: 'lowColor', label: 'Low Color', dataType: 'color' },
      { id: 'highColor', label: 'High Color', dataType: 'color' },
    ],
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
    category: 'dataviz',
    tslFunction: '',
    tslImportModule: '',
    // Ramp ends are wireable, exactly as on Data Stripes — same two swatches,
    // same emission — see that node's comment for why they must be real inputs.
    inputs: [
      { id: 'signal', label: 'Signal', dataType: 'float' },
      { id: 'lowColor', label: 'Low Color', dataType: 'color' },
      { id: 'highColor', label: 'High Color', dataType: 'color' },
    ],
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
    // The Also: tail keeps the node findable by its own socket's name and its
    // displacement use — the trimmed prose used to carry both words, and input
    // socket labels are never part of the search corpus.
    description:
      'Map a Data node column to a colour ramp along one axis (or radially), with scale, offset, cutoffs, midpoint and contrast. Also: signal, displacement, height.',
  },
  // Colormap: scalar → colour through a scientific lookup table (viridis and
  // friends). The map choice, reverse flag and discrete-level count live in
  // `values` + the ColormapSettingsMenu, NOT in defaultValues — a non-hex string
  // there is read as a tslRef PORT by both the generic settings menu and the
  // card's row builder. tslFunction is empty: graphToCode bakes a 256-texel LUT
  // and emits the fetch, like the other dataviz nodes (and, like them, this node
  // is one-way through codeToGraph).
  {
    type: 'colormap',
    label: 'Colormap',
    category: 'dataviz',
    tslFunction: '',
    tslImportModule: '',
    inputs: [{ id: 'value', label: 'Value', dataType: 'float' }],
    outputs: [{ id: 'out', label: 'Color', dataType: 'vec3' }],
    description:
      'Colour a 0–1 value through a perceptually uniform scientific colormap (viridis, cividis, batlow, cool-warm, isoluminant…). Also: colourmap colour map palette ramp lut heatmap viridis magma inferno plasma turbo.',
  },
  // Data Range: raw data units → 0–1, honestly. Wired straight from a Data
  // column it reads that column's statistics at code-gen (min/max, percentiles,
  // mean/σ) and bakes them as literals; anywhere else it falls back to the
  // manual domain. Emitted specially (a mode-dependent ALU chain), so no
  // tslFunction.
  //
  // NOT called `normalize` — the vector category already owns that type (unit
  // vector), and NODE_REGISTRY is keyed by type, so the duplicate silently
  // replaced it.
  {
    type: 'dataRange',
    label: 'Data Range',
    category: 'dataviz',
    tslFunction: '',
    tslImportModule: '',
    inputs: [{ id: 'value', label: 'Value', dataType: 'float' }],
    outputs: [{ id: 'out', label: '0…1', dataType: 'float' }],
    description:
      'Map and filter raw data values using formulas. Also: normalize normalise rescale remap domain scaling percentile logarithmic zscore.',
  },
  // Isolines: antialiased contour lines at regular value intervals. Same
  // continuous-phase + derivative-AA construction as Data Stripes (never take a
  // derivative of fract()), including the sub-pixel fade so dense contours grey
  // out instead of shimmering. Parameters ARE numeric defaultValues, so they get
  // inline widgets, the generic settings menu and opt-in exposed sockets.
  {
    type: 'isolines',
    label: 'Isolines',
    category: 'dataviz',
    tslFunction: '',
    tslImportModule: '',
    inputs: [{ id: 'value', label: 'Value', dataType: 'float' }],
    outputs: [{ id: 'out', label: 'Lines', dataType: 'float' }],
    defaultValues: {
      levels: 10,
      width: 1.5,
      offset: 0,
    },
    description:
      'Draw antialiased contour lines wherever a value crosses a regular interval — the way a reader gets exact numbers off a curved 3D surface. Also: isoline contour contours iso level lines topographic.',
  },

  // ===== OUTPUT =====
  {
    type: 'output',
    label: 'Output',
    category: 'output',
    tslFunction: 'output',
    tslImportModule: '',
    // Socket order IS the on-node arrangement (the Output node renders
    // def.inputs in order, sectioned by PIXEL_PORTS/VERTEX_PORTS), and the
    // ShaderSettingsMenu toggle list follows the same sequence — keep all
    // three aligned. `position` (Displacement) sits last because it renders
    // in its own Vertex Shader section.
    inputs: [
      { id: 'color', label: 'Color', dataType: 'color' },
      { id: 'emissive', label: 'Emissive', dataType: 'color' },
      { id: 'roughness', label: 'Roughness', dataType: 'float' },
      { id: 'metalness', label: 'Metalness', dataType: 'float' },
      { id: 'opacity', label: 'Opacity', dataType: 'float' },
      {
        id: 'discard',
        label: 'Discard',
        dataType: 'float',
        description:
          'Culls the pixel wherever this is non-zero — a truthiness test, not a 0/1 switch, so 0.2 discards too. Feed it a Greater Than / Less Than node for a clean threshold.',
      },
      { id: 'normal', label: 'Normal', dataType: 'vec3' },
      { id: 'env', label: 'Environment', dataType: 'color' },
      { id: 'position', label: 'Displacement', dataType: 'vec3' },
    ],
    outputs: [],
    description:
      'The material output — color, emissive, roughness, metalness, opacity, discard, normal, environment and displacement channels. Wire an Image node into Environment to light the material with an equirectangular environment map (image-based lighting: reflections follow Roughness/Metalness).',
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

/**
 * TSL call name → the def that parses it. Last writer wins, so any def sharing
 * a tslFunction with an earlier one must be excluded here:
 *  - `slider` shares `float` with the Float node.
 *  - `property_color` shares `uniform` with `property_float`. property_float
 *    OWNS the bare `uniform(N)` form; a colour uniform is `uniform(color(...))`
 *    and codeToGraph detects it from the ARGUMENT, not this map. Without the
 *    exclusion every existing `uniform(1.0)` parsed back as a colour node.
 */
export const TSL_FUNCTION_TO_DEF = new Map<string, NodeDefinition>(
  allDefinitions
    .filter((d) => d.tslFunction && d.type !== 'slider' && d.type !== 'property_color')
    .map((d) => [d.tslFunction, d]),
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
 * Does this node grow operand sockets as they're wired?
 *
 * True for the arithmetic folds (`chainable`) AND for `append`, which grows
 * sockets without folding. Use this for socket/layout questions; test
 * `chainable` directly for fold semantics (identity fallback, N−1 pricing).
 */
export function growsOperands(def: NodeDefinition | undefined): boolean {
  return !!def && (def.chainable === true || def.variadic === true);
}

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
  if (!growsOperands(def)) return def.inputs;
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
    def.maxOperands ?? MAX_CHAIN_OPERANDS,
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

/** No-match sentinel for `nodeMatchRank` — anything below this ranks as a hit. */
export const NO_MATCH = Number.POSITIVE_INFINITY;

/**
 * How well `def` matches a lowercased search query — LOWER IS BETTER,
 * `NO_MATCH` for no match at all.
 *
 * A node's NAME must always outrank its prose. Without this, results came out
 * in raw registry order, so a node that merely *mentions* the query in its
 * description could sit above the node actually called that: searching
 * "multip" put Time (whose description mentions a speed multiplier) above
 * Multiply, and "color" put Property (color) above Color.
 *
 * The `Also:` tail of a description is a deliberate alias list (see
 * `displayDescription`, which strips it from the UI), so it ranks above prose
 * but below a real name.
 */
export function nodeMatchRank(def: NodeDefinition, q: string): number {
  const names = [def.label.toLowerCase(), def.type.toLowerCase(), def.tslFunction.toLowerCase()];
  // The Latvian label is a name too — a Latvian user typing it deserves the
  // same rank an English user gets for the English label.
  const lvLabel = nodeLabelLV(def.type).toLowerCase();
  if (lvLabel) names.push(lvLabel);

  if (names.some((n) => n === q)) return 0;
  if (names.some((n) => n.startsWith(q))) return 1;
  if (names.some((n) => n.includes(q))) return 2;

  const [prose = '', aliases = ''] = (def.description?.toLowerCase() ?? '').split(/\s*also:/);
  if (aliases.includes(q)) return 3;
  if (prose.includes(q)) return 4;
  // Latvian description last, mirroring the English prose tier.
  if (nodeSearchLV(def.type).includes(q)) return 5;
  return NO_MATCH;
}

/**
 * Search + rank in one pass. Ties keep registry order (Array#sort is stable),
 * so equally-good matches stay in their curated sequence.
 *
 * Searches the EDITOR set, so a node hidden by `editorVisibility.json` cannot be
 * typed back into existence from the Add-node menu's search box.
 */
export function searchNodes(query: string): NodeDefinition[] {
  const defs = getEditorDefinitions();
  const q = query.trim().toLowerCase();
  if (!q) return defs;
  return defs
    .map((d) => ({ d, rank: nodeMatchRank(d, q) }))
    .filter((e) => e.rank !== NO_MATCH)
    .sort((a, b) => a.rank - b.rank)
    .map((e) => e.d);
}

/**
 * EVERY definition the app knows — including ones hidden from the editor.
 *
 * This is the documentation/tooling view: node-editor.html (which is where a
 * hidden node is switched back on), the Node Designer's designable set, and the
 * drift tests all need the complete list. Anything that offers the user a node
 * to ADD must call {@link getEditorDefinitions} instead.
 */
export function getAllDefinitions(): NodeDefinition[] {
  return allDefinitions;
}

/**
 * `getAllDefinitions()` minus whatever `editorVisibility.json` hides. Computed
 * ONCE, not per call: the hidden set is fixed at module init (it comes from a
 * source file), and every consumer memoizes on this array's identity, so a
 * fresh `filter()` per call would quietly make those `useMemo`s recompute — and
 * would give the accessor two different identities within one render.
 * `allDefinitions` itself is reused when nothing is hidden.
 */
const editorDefinitions: NodeDefinition[] =
  HIDDEN_NODE_TYPES.size === 0
    ? allDefinitions
    : allDefinitions.filter((d) => !HIDDEN_NODE_TYPES.has(d.type));

/**
 * The definitions the editor offers as things to add (see `editorVisibility.ts`
 * for why hiding is an add-surface filter and never a registry one).
 */
export function getEditorDefinitions(): NodeDefinition[] {
  return editorDefinitions;
}

/**
 * True when `category` had addable nodes and every one of them is now hidden —
 * i.e. a content-browser tab for it would open to "Nothing here yet.".
 *
 * The "had any" half is what keeps this off the ASSET tabs: Presets and Textures
 * render built-in graphs rather than registry defs, so "no visible defs" is
 * their normal state, not an emptied one. `output` is excluded because the
 * palette never offers it in the first place.
 */
export function categoryEmptiedByHiding(category: NodeCategory): boolean {
  if (HIDDEN_NODE_TYPES.size === 0) return false;
  const addable = (d: NodeDefinition) => d.category === category && d.type !== 'output';
  return allDefinitions.some(addable) && !editorDefinitions.some(addable);
}

/** Map a registry definition to its React Flow node type string. */
export type FlowNodeType = 'shader' | 'color' | 'preview' | 'mathPreview' | 'clock' | 'mic' | 'audio' | 'output';

export function getFlowNodeType(def: NodeDefinition): FlowNodeType {
  if (def.type === 'output') return 'output';
  if (def.type === 'time') return 'clock';
  // Places every socket itself (see MicNode.tsx) — ShaderNode's row layout
  // cannot express its arrangement.
  if (def.type === 'micNode') return 'mic';
  // Same reason, plus a source <select> on the card that no row layout offers.
  if (def.type === 'audioInput') return 'audio';
  // Both swatch nodes render as ColorNode: the constant is a circle, the named
  // uniform a rounded rectangle (ColorNode branches on registryType). The
  // uniform's `name` goes INSIDE the swatch, the way the constant already
  // shows its varName — which is what made the standard card unnecessary.
  if (def.type === 'color' || def.type === 'property_color') return 'color';
  if (def.category === 'noise') return 'preview';
  if (def.type === 'sin' || def.type === 'cos') return 'mathPreview';
  return 'shader';
}
