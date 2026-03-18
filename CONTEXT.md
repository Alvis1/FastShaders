# FastShaders — Project Context

## Overview

Bi-directional TSL (Three.js Shading Language) visual shader editor. Users build shaders either by connecting nodes in a graph or by writing TSL code — changes in one view sync to the other.

**Live**: https://Alvis1.github.io/FastShaders/

**Stack**: React 18 + TypeScript + Vite | `@xyflow/react` v12 (node graph) | `@monaco-editor/react` (code editor) | `zustand` v5 (state) | `three` 0.183 (WebGPU + TSL) | `tsl-textures` 3.0.1 (with `patch-package` fixes) | `@dagrejs/dagre` (auto-layout) | `@babel/parser` + `traverse` + `types` (code parsing)

**A-Frame integration**: Exports use the [a-frame-shaderloader](https://github.com/Alvis1/a-frame-shaderloader) IIFE bundle which bundles a custom A-Frame 1.7 + Three.js r173 WebGPU + tsl-textures with matching compatible versions in `aframe-171-a-0.1.min.js`. The shaderloader (`a-frame-shaderloader-0.2.js`) resolves bare import specifiers (`'three/tsl'` → `three-tsl-shim.js`, `'tsl-textures'` → `tsl-textures-shim.js`) so blob-loaded modules work. It detects Object API (multi-channel) vs Simple API (single node) by checking for any `*Node` property (`colorNode`, `positionNode`, `normalNode`, `opacityNode`, `roughnessNode`, `metalnessNode`, `emissiveNode`). It also manages **property uniforms**: reads `export const schema` from modules (or auto-detects `params.XXX`/`const NAME = uniform(VALUE)` patterns), creates TSL uniforms, passes them to the shader function, and exposes `updateProperty(name, value)` for runtime updates. The `three-tsl-shim.js` spreads `THREE.TSL` into a mutable copy and falls back to `tsl-textures` for `hsl`/`toHsl` (which may not exist in the r173 bundle's frozen `THREE.TSL`).

---

## Project Structure

```
src/
├── App.tsx                            # Root + SyncController (graph↔code sync orchestration)
├── main.tsx                           # Entry point
├── vite-env.d.ts                      # Type declarations (tsl-textures module)
├── components/
│   ├── CodeEditor/
│   │   ├── CodeEditor.tsx             # Monaco editor with TSL/A-Frame/Script tabs, Save + Download
│   │   ├── CodeEditor.css
│   │   └── tslLanguage.ts             # TSL language definition, completions, color picker
│   ├── Layout/
│   │   ├── AppLayout.tsx              # Two nested SplitPanes (left: graph | right: code/preview)
│   │   ├── AppLayout.css
│   │   ├── SplitPane.tsx              # Draggable divider (horizontal or vertical)
│   │   ├── Toolbar.tsx                # Top bar: brand, shader name input, VR headset selector
│   │   ├── Toolbar.css
│   │   ├── CostBar.tsx                # GPU complexity bar (totalCost vs headset budget)
│   │   └── CostBar.css
│   ├── NodeEditor/
│   │   ├── NodeEditor.tsx             # React Flow canvas + keyboard shortcuts + interaction handlers
│   │   ├── NodeEditor.css
│   │   ├── nodes/
│   │   │   ├── ShaderNode.tsx         # Generic node for all TSL types (dynamic from registry, vec3/vec2 grouped display)
│   │   │   ├── ShaderNode.css
│   │   │   ├── ColorNode.tsx          # Color picker node
│   │   │   ├── PreviewNode.tsx        # Noise preview with animated canvas (noise, fractal, voronoi)
│   │   │   ├── PreviewNode.css
│   │   │   ├── MathPreviewNode.tsx    # Math function preview with scrolling waveform (sin, cos)
│   │   │   ├── MathPreviewNode.css
│   │   │   ├── TexturePreviewNode.tsx  # Texture preview with GPU-rendered canvas (tsl-textures)
│   │   │   ├── TexturePreviewNode.css
│   │   │   ├── OutputNode.tsx         # Output sink (color, normal, position, opacity, roughness)
│   │   │   └── OutputNode.css
│   │   ├── handles/
│   │   │   └── TypedHandle.tsx        # Color-coded handles per data type
│   │   ├── edges/
│   │   │   ├── TypedEdge.tsx          # Multi-channel colored edges, drag-to-disconnect, info card
│   │   │   ├── EdgeInfoCard.tsx       # Live value display on edges (per-channel, animated)
│   │   │   └── EdgeInfoCard.css
│   │   ├── inputs/
│   │   │   └── DragNumberInput.tsx    # Drag-to-adjust number input with acceleration
│   │   ├── ContentBrowser.tsx         # Category-tabbed asset drawer with horizontal scroll
│   │   ├── ContentBrowser.css
│   │   ├── NodePreviewCard.tsx        # Type-dispatching preview card (7 visual variants matching editor nodes)
│   │   ├── NodePreviewCard.css
│   │   └── menus/
│   │       ├── ContextMenu.tsx        # Menu dispatcher (canvas/node/shader/edge)
│   │       ├── ContextMenu.css
│   │       ├── AddNodeMenu.tsx        # Searchable node palette, grouped by category
│   │       ├── NodeSettingsMenu.tsx   # Node properties, duplicate, delete
│   │       ├── ShaderSettingsMenu.tsx # Output node settings (ports, displacement, material)
│   │       └── EdgeContextMenu.tsx    # Edge delete menu
│   └── Preview/
│       ├── ShaderPreview.tsx          # WebGPU iframe preview with geometry selector and rotation toggle
│       └── ShaderPreview.css
├── engine/
│   ├── graphToCode.ts                 # Graph → TSL code string (import statements + Fn() wrapper)
│   ├── codeToGraph.ts                 # TSL code → nodes + edges (Babel AST, multi-channel returns, noise/UV/texture patterns)
│   ├── graphToTSLNodes.ts             # Graph → live Three.js TSL node objects (all 5 output channels)
│   ├── tslCodeProcessor.ts            # Shared TSL processing: import extraction, TDZ fix, body parsing
│   ├── tslToAFrame.ts                 # TSL code → A-Frame HTML (uses tslToShaderModule + shaderloader blob URL)
│   ├── tslToShaderModule.ts           # TSL code → shaderloader-compatible ES script (materialSettings, properties)
│   ├── tslToPreviewHTML.ts            # TSL code → Three.js WebGPU HTML (uses tslCodeProcessor)
│   ├── layoutEngine.ts                # Dagre auto-layout (LR, nodesep=25, ranksep=60)
│   ├── cpuEvaluator.ts                # CPU-side graph evaluator for real-time values (multi-channel, uses hexToRgb01 from colorUtils)
│   ├── topologicalSort.ts             # Kahn's algorithm for execution order
│   └── evaluateTSLScript.ts           # isTSLTexturesCode() detection helper
├── hooks/
│   └── useSyncEngine.ts               # Bidirectional sync hook (watches graph/code changes)
├── registry/
│   ├── nodeRegistry.ts                # ~90+ TSL node definitions (core + auto-registered tsl-textures)
│   ├── tslTexturesRegistry.ts         # Auto-registers ~49 tsl-textures functions as nodes from .defaults (duck-typed param detection)
│   ├── nodeCategories.ts              # Category metadata (id + label)
│   └── complexity.json                # GPU cost per operation (~110 entries incl. all 50 tsl-textures functions)
├── store/
│   └── useAppStore.ts                 # Zustand store (nodes, edges, code, sync, history, UI)
├── types/
│   ├── index.ts                       # Re-exports all types
│   ├── node.types.ts                  # AppNode union, ShaderNodeData, OutputNodeData
│   ├── sync.types.ts                  # SyncSource type
│   └── tsl.types.ts                   # ParseError, GeneratedCode
├── utils/
│   ├── colorUtils.ts                  # Cost color gradient, type→color mapping, CATEGORY_COLORS, hexToRgb01 (centralized)
│   ├── edgeUtils.ts                   # removeEdgesForPort() — cleans up edges when hiding input ports
│   ├── graphTraversal.ts             # hasTimeUpstream() — BFS time-node detection with O(1) Map lookup
│   ├── idGenerator.ts                 # generateId(), generateEdgeId()
│   ├── mathPreview.ts                 # Sin/math waveform canvas renderer (scrolling curve + dot)
│   ├── noisePreview.ts               # CPU noise (Perlin, fBm, Voronoi) + animated render
│   └── texturePreviewRenderer.ts     # Shared off-screen WebGPU renderer for texture node previews (skips position/normal textures)
└── styles/
    ├── tokens.css                     # CSS custom properties (colors, spacing, shadows, fonts)
    └── reset.css
patches/
└── tsl-textures+3.0.1.patch          # patch-package: int→float Fn.setLayout + protozoa scale immutability
public/
└── js/
    ├── three-tsl-shim.js             # Re-exports THREE.TSL as ESM; falls back to tsl-textures for hsl/toHsl
    └── a-frame-shaderloader-0.2.js   # A-Frame shader component (TDZ fix + auto-import)
```

---

## Architecture

### Two Code Modes

**Graph Mode (default)** — User builds nodes visually. Graph compiles to TSL code in real-time.

```typescript
// Generated output format:
import { Fn, positionGeometry, mx_fractal_noise_float } from "three/tsl";
const shader = Fn(() => {
  const pos = positionGeometry;
  const noise = mx_fractal_noise_float(pos);
  return noise;
});
export default shader;
```

**Script Mode** — User pastes tsl-textures code with `model.material` assignments. Detected by `isTSLTexturesCode()` (matches `model.material.XNode =` pattern only). Bypasses graph sync.

```typescript
// Script mode input format:
import { polkaDots } from "tsl-textures";
model.material.colorNode = polkaDots({ count: 4, size: 0.34 });
```

### Code Editor Tabs

The code editor has three tabs:

- **TSL** — Editable TSL code with Save button and error display (default)
- **A-Frame** — Read-only self-contained HTML using the shaderloader (`tslToAFrame.ts`):
  - Loads `aframe-171-a-0.1.min.js` and `a-frame-shaderloader-0.2.js` from jsDelivr CDN
  - Generates the shader module via `tslToShaderModule()` (same code as Script tab) and embeds it as a blob URL
  - Applies the shader via `<a-entity shader="src: blobUrl">` — the shaderloader handles TDZ fixes, import resolution, and property uniforms at runtime
  - Copy-paste ready: just save as `.html` and open
  - Download as `.html`
- **Script** — Read-only shaderloader-compatible ES module (`tslToShaderModule.ts`):
  - Header comments with HTML setup, property attribute examples, and runtime update instructions
  - Converts `Fn(() => { ... })` wrapper to `export default function(params) { ... }` (when properties exist) or `export default function() { ... }` (no properties)
  - Standard bare imports (`'three/tsl'`, `'tsl-textures'`) — also usable directly with Three.js
  - Multi-channel returns converted to shaderloader Object API (`color` → `colorNode`, etc.)
  - Material settings injected into return object: `transparent`, `side`, `alphaTest`
  - Position channel wrapped with displacement logic: `positionLocal.add(normalLocal.mul(val))` (normal mode) or `positionLocal.add(val)` (offset mode from `materialSettings`)
  - **Property support**: Emits `export const schema` with property defaults; replaces `const NAME = uniform(VALUE)` with `const NAME = params.NAME`; removes `uniform` from imports when all uniform calls are replaced by params references
  - The shaderloader handles TDZ fixes and missing import injection at runtime
  - Download as `.js` for use with `<a-entity shader="src: myshader.js; propName: value">`

Both A-Frame and Script tabs read `materialSettings` and `properties` (from `property_float` nodes) in `CodeEditor.tsx` and thread them to their respective generators.

The TSL editor stays mounted (hidden) when switching tabs to avoid Monaco re-initialization freezes.

### Preview (ShaderPreview.tsx)

- **Rendered in iframe** via blob URL from `tslToPreviewHTML.ts`
- **Renderer**: A-Frame scene with `a-frame-shaderloader` (loads local IIFE bundle via Vite public dir)
- **Camera**: FOV 20 with orbit controls (zoom 2–80, rotate 0.5 speed)
- **Geometry**: Selector dropdown (sphere/cube/torus/plane), persisted to localStorage
- **Material**: `materialSettings` from output node (displacement mode, transparent, side)
- **Lighting**: 2 point lights on camera + directional + ambient
- **Animation**: Play/pause toggle for mesh rotation
- **Debounced**: 500ms debounce on code changes to avoid iframe thrashing
- **Background**: Dark (#1a1a2e) for contrast with light UI theme

### Sync Engine (prevents infinite loops)

- **`syncSource`** field: `'graph' | 'code' | 'initial'` — tracks who initiated the change
- **`syncInProgress`** flag — blocks nested syncs
- **Graph → Code**: Real-time on every node/edge change (`graphToCode()`)
- **Code → Graph**: Manual via Save button / Ctrl+S (`codeToGraph()` with Babel parser, `errorRecovery: true`)
- **Stable node matching**: Two-pass matching (registryType+label, then registryType only) preserves node positions, IDs, `exposedPorts`, and `materialSettings` across syncs
- **Auto-expose ports**: After code→graph sync, any port with an incoming edge is automatically added to `exposedPorts` (texture, noise, output nodes)
- **Complexity**: Traverses backward from Output node, sums costs from `complexity.json`. Uses `lastCostRef` guard to prevent double BFS runs (updating output node cost triggers nodes change → would re-run the effect)

### Code → Graph Parsing (codeToGraph.ts)

The Babel-based parser handles these patterns:

- **Multi-channel returns**: `return { color: x, position: y }` → wires each property to the corresponding output port. Also handles member expressions (`someVar.x`) and inline call expressions (`someFunc(a, b)`) as return values.
- **Single-value returns**: `return x` or `return someFunc(a, b)` or `return someVar.x` → wires to output.color (inline calls create intermediate nodes, member expressions create split nodes)
- **Split node reconstruction**: Member expressions like `someVar.x`, `someVar.y`, etc. in function arguments or return values automatically create split nodes. One split node is reused per source variable (tracked via `splitNodes` map). Wires `source → split.v` and `split.{x,y,z,w} → target`.
- **Append node detection**: `vec2(ref1, ref2)` where at least one argument is a variable reference or member expression creates an `append` node (not a `vec2` type constructor). This matches the `graphToCode` output for append nodes.
- **Noise functions**: `mx_fractal_noise_float(posOrMul, octaves, lacunarity, diminish)` — detects `mul(pos, scale)` pattern for the first arg, maps remaining args to fractal-specific keys
- **UV tiling**: `mul(uv(), vec2(x, y))` pattern detected and converted to a single UV node with tiling values
- **tsl-textures**: Single object argument `bricks({ scale: 2, color: color(0xFF0000) })` — wires variable refs as edges, extracts literals/constructors as values. Handles both `new` expression constructors (`new THREE.Color(...)`) and TSL function call constructors (`color(0xFF)`, `vec3(1,2,3)`, `vec2(1,2)`) via `extractConstructor()` + `extractTSLConstructorCall()`.
- **Property nodes**: `uniform(value)` calls → `property_float` nodes with variable name as property name

### Zustand Store Shape

```typescript
{
  nodes: AppNode[], edges: AppEdge[]           // Graph data
  code: string, codeErrors: ParseError[]       // Generated code + errors
  totalCost: number                            // Connected node cost sum
  syncSource: 'graph'|'code'|'initial'         // Loop prevention
  syncInProgress: boolean, codeSyncRequested: boolean
  activeScript: string | null                  // Script mode (tsl-textures)
  history: HistoryEntry[], historyIndex: number, isUndoRedo: boolean  // 50-entry undo/redo
  splitRatio: number, rightSplitRatio: number  // Panel sizes (localStorage)
  shaderName: string, selectedHeadsetId: string // Toolbar state
  contextMenu: {
    open: boolean, x: number, y: number,
    type: 'canvas' | 'node' | 'shader' | 'edge',
    nodeId?: string, edgeId?: string
  }
}
```

---

## Export Pipeline

### Shared TSL Code Processor (`tslCodeProcessor.ts`)

Common processing logic used by `tslToPreviewHTML.ts` (and indirectly by the other pipelines):

- **`collectImports(code, excludeFn?)`** — extracts `three/tsl` and `tsl-textures` import names
- **`extractFnBody(code, tslNames)`** — extracts the body inside `Fn(() => { ... })`
- **`fixTDZ(body, tslNames, texNames)`** — fixes Temporal Dead Zone issues:
  1. Removes self-referencing bare declarations (`const X = X;`)
  2. Renames locals that shadow imported function names (`const color = color(...)` → `const _color = color(...)`) — regex uses `(?!\s*[:(])` to preserve object property keys in return statements
  3. Fixes bare numeric first-arg in MaterialX noise calls (`mx_noise_float(0)` → `mx_noise_float()`)
  4. Aliases tsl-textures imports (`camouflage(` → `_tex_camouflage(`)
- **`parseBody(body, tslNames)`** — splits into definition lines and output channels (simple or multi-channel return)
- **`GEOMETRY_MAP`** / **`CHANNEL_TO_PROP`** — shared constants

### A-Frame HTML Export (`tslToAFrame.ts`)

Generates a self-contained copy-paste `.html` using the shaderloader:

1. Calls `tslToShaderModule()` to generate the shader module code (same as Script tab)
2. Strips header comments and embeds the module as an inline blob URL
3. Loads both CDN scripts: `aframe-171-a-0.1.min.js` (IIFE bundle) + `a-frame-shaderloader-0.2.js`
4. Applies shader via `<a-entity shader="src: blobUrl">` — the shaderloader handles all processing (TDZ fixes, import resolution, property uniforms) at runtime
5. A-Frame scene with geometry, lights, and optional rotation animation
6. Properties and material settings are handled by the shaderloader from the embedded module's `export const schema` and Object API return

### Shader Script Export (`tslToShaderModule.ts`)

Generates a `.js` ES module compatible with the a-frame-shaderloader component. Also reused by `tslToAFrame.ts` for the A-Frame HTML export.

1. Header comments with HTML setup instructions, property attribute examples, and runtime update docs
2. Strips `Fn` from three/tsl imports; bare imports (`'three/tsl'`, `'tsl-textures'`) — also usable directly with Three.js
3. Converts `const shader = Fn(() => {` to `export default function(params) {` (when properties exist) or `export default function() {` (no properties)
4. Converts multi-channel return keys to shaderloader Object API names (`color` → `colorNode`, `position` → `positionNode`, etc.)
5. Accepts optional `materialSettings` and `properties` (PropertyInfo[]) — wraps position channel with displacement logic (same normal/offset modes), injects `positionLocal`/`normalLocal` into the `three/tsl` import line when needed
6. **Property support**: Emits `export const schema = { name: { type: 'number', default: value } }` so the shaderloader reads proper defaults; replaces `const NAME = uniform(VALUE)` with `const NAME = params.NAME`; removes `uniform` from imports when all uniform calls are replaced by params references
7. Removes `export default shader;`
8. The shaderloader handles TDZ fixes, missing import injection, and specifier resolution at runtime

### Preview HTML (`tslToPreviewHTML.ts`)

Generates HTML for the in-app preview iframe:

1. Uses `tslCodeProcessor` to extract imports, body, fix TDZ, and parse channels
2. Accepts `materialSettings` via `PreviewOptions` — applies displacement wrapping (same normal/offset logic) + transparent/side settings
3. Uses A-Frame IIFE bundle with `a-frame-shaderloader` for rendering
4. Camera with orbit controls, two point lights, directional + ambient light
5. Error display div for runtime errors

---

## Node System

### Node Registry (~90+ nodes in 10 categories)

| Category          | Nodes                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| **Input**         | positionGeometry, normalLocal, tangentLocal, time, screenUV, uv, property_float, slider    |
| **Type**          | float, int, vec2, vec3, vec4, color                                                       |
| **Arithmetic**    | add, sub, mul, div                                                                        |
| **Math (unary)**  | sin, cos, abs, sqrt, exp, log2, floor, round, fract                                       |
| **Math (binary)** | pow, mod, clamp, min, max                                                                 |
| **Interpolation** | mix, smoothstep, remap, select                                                            |
| **Vector**        | normalize, length, distance, dot, cross, split, append                                     |
| **Noise**         | fractal (mx_fractal_noise_float), voronoi (mx_worley_noise_float)                         |
| **Color**         | hsl, toHsl                                                                                |
| **Texture**       | ~49 auto-registered tsl-textures functions (bricks, camouflage, polkaDots, marble, etc.)  |
| **Output**        | output (color, normal, displacement, opacity, roughness, emissive inputs + materialSettings) |

### tsl-textures Auto-Registration (tslTexturesRegistry.ts)

All ~49 tsl-textures functions are auto-registered as nodes by introspecting `.defaults` at runtime:

- **Parameter classification** (`classifyParam`): Each default param is classified as `number`, `color` (duck-typed `.isColor`), `vec3` (`.isVector3`), `vec2` (`.isVector2`), `tslRef` (`.isNode` or known ref like position/time/matcap), `boolean` (→ number 0/1), or `meta` ($-prefixed)
- **NodeDefinition generation** (`buildTSLTextureDefinitions`):
  - Numbers → connectable input ports + editable default values
  - Colors → hex string in defaultValues (e.g., `#ff0000`)
  - Vector3 → flattened keys: `key_x`, `key_y`, `key_z` in defaultValues
  - Vector2 → flattened keys: `key_x`, `key_y`
  - TSL refs (position, time) → input ports only (library uses own defaults if unconnected)
- **Node type prefix**: `tslTex_` to avoid collisions (e.g., `tslTex_bricks`)
- **`$normalNode` detection**: Textures with `$normalNode` in defaults get output type `vec3` (label "Normal") instead of `color`
- **Code generation**: Object parameter syntax using TSL-native constructors — `bricks({ scale: 2, color: color(0xFF4000) })`; imports `color`/`vec3`/`vec2` from `three/tsl` as needed (no `import * as THREE`)
- **Live compilation**: Dynamic factory builds params object, calls `tslTextures[funcName](params)`
- **Code parsing**: `processObjectCall()` parses ObjectExpression properties; `extractConstructor()` handles `new THREE.Color/Vector3/Vector2` expressions, `extractTSLConstructorCall()` handles TSL function call syntax `color(0xFF)`/`vec3(1,2,3)`/`vec2(1,2)` — both are tried via fallback chain

### Split Node

The split node decomposes vectors into individual float components:

- **Input**: one `Vector` port (any type)
- **Outputs**: four float ports — X, Y, Z, W
- **TSL compilation**: Factory passes through the input vector; edge resolution applies `.x`/`.y`/`.z`/`.w` swizzle when sourceHandle isn't `'out'`
- **Code generation**: Split nodes are not emitted as variables; references through them are inlined as `sourceVar.x`, `sourceVar.y`, etc.
- **Code parsing**: `resolveMemberExpr()` detects `someVar.x/y/z/w` member expressions and creates split nodes on demand. One split node is reused per source variable (tracked via `splitNodes` map). Used in function arguments, single-value returns, and multi-channel return properties.
- **Searchable**: by "split" or "separate"

### UV Node

Texture coordinate node with tiling and rotation controls:

- **Inputs**: 4 ports — `channel` (int, UV map index), `tilingU` (float), `tilingV` (float), `rotation` (float)
- **Output**: one `vec2` port
- **Default values**: `channel: 0, tilingU: 1.0, tilingV: 1.0, rotation: 0.0`
- **Code generation**: 3 cases depending on parameters:
  - No tiling/rotation → `uv()` (or `uv(channel)` for non-zero channel)
  - Tiling only → `mul(uv(), vec2(tilingU, tilingV))`
  - Rotation → 2D rotation around center (0.5, 0.5) using cos/sin matrix with intermediate variable `_varName`
- **TSL compilation**: Builds UV base from channel, applies `mul` for tiling, then centered rotation via `sub`/`add`/`cos`/`sin`
- **CPU evaluation**: Starts at [0.5, 0.5], applies tiling multiplication, applies 2D rotation if non-zero
- **Channel input** uses `int` dataType: `DragNumberInput` with `step={1}` and `Math.round()` in onChange
- **Searchable**: by "uv", "texcoord", or "texture coordinate"

### Append Node

Combines two values into a higher-dimensional vector:

- **Inputs**: two `any` ports — A and B
- **Output**: one `any` port
- **Code generation**: Emits `vec2(a, b)` with `vec2` import from `three/tsl`
- **Code parsing**: `vec2(ref1, ref2)` where at least one arg is a variable reference or member expression creates an `append` node (not a `vec2` type constructor). Literal-only `vec2(1, 2)` still creates a `vec2` type node.
- **TSL compilation**: `vec2(inputs.a ?? float(0), inputs.b ?? float(0))`
- **CPU evaluation**: Concatenates channel arrays (`[...a, ...b]`) — e.g., float+float→vec2, vec2+float→vec3
- **Use case**: Convert UV (vec2) to vec3 for tsl-textures position input by appending a Z component
- **Searchable**: by "append", "combine", or "join"

### Property Nodes (`property_float`)

Configurable uniform properties that become component attributes in A-Frame exports:

- **Registry**: `tslFunction: 'uniform'`, `defaultValues: { value: 1.0, name: 'property1' }` — value first for positional key lookup in graphToCode/codeToGraph
- **Auto-naming**: New property nodes are named `property1`, `property2`, etc. (counts existing property_float nodes)
- **Node header**: Shows the user-defined name (e.g., "brightness") instead of the generic label
- **Code generation** (`graphToCode.ts`): Uses the sanitized property name as the variable name (e.g., `const brightness = uniform(1.5)`)
- **Code parsing** (`codeToGraph.ts`): Sets `values.name = varName` from the code's variable name
- **TSL function map**: `uniform` → `property_float` via `TSL_FUNCTION_TO_DEF` (so code→graph correctly identifies `uniform()` calls as property nodes)
- **Script export**: Emits `export const schema` with defaults; replaces `uniform(VALUE)` with `params.NAME` references; `function(params)` signature
- **A-Frame export**: Embeds the script module as blob URL; shaderloader reads schema and manages property uniforms automatically
- **Migration**: `loadGraph()` in useAppStore migrates old `uniform_float` → `property_float`

### Slider Node

Adjustable float value with a visual range slider and configurable min/max bounds:

- **Registry**: `tslFunction: 'float'`, `defaultValues: { value: 0.5, min: 0.0, max: 1.0 }` — value is first key for positional lookup in graphToCode
- **Node body**: Shows an `<input type="range">` slider constrained between min and max; min/max are hidden from the node body (only editable via right-click settings menu)
- **Code generation**: Emits `float(value)` — identical to the Float node in generated code
- **TSL compilation**: `float(value)` — same as Float
- **CPU evaluation**: Returns `[value]` — same as float/int/property_float
- **Code→Graph**: `float()` calls in code always map to the `float` node definition (slider is excluded from `TSL_FUNCTION_TO_DEF` since it shares `tslFunction: 'float'`)
- **Asset browser**: Dedicated `SliderCardContent` with a visual track, fill bar, thumb dot, and min/value/max labels
- **Searchable**: by "slider" or "range"

### React Flow Node Types

- **`shader`** — Generic node for most TSL operations (ShaderNode.tsx)
- **`color`** — Color picker with hex input (ColorNode.tsx)
- **`preview`** — Noise/procedural nodes with animated canvas thumbnail (PreviewNode.tsx)
- **`mathPreview`** — Math function nodes with scrolling waveform visualization (MathPreviewNode.tsx)
- **`texturePreview`** — Texture nodes with GPU-rendered 96x96 canvas preview (TexturePreviewNode.tsx)
- **`output`** — Output sink with two sections: Pixel Shader (color, roughness, emissive, normal, opacity) and Vertex Shader (displacement), plus `materialSettings` for export config (OutputNode.tsx)

### Asset Browser (ContentBrowser + NodePreviewCard)

The asset browser is a horizontal scrollable drawer at the bottom of the node editor, showing all available nodes grouped by category tabs. The Noise category tab is hidden; fractal and voronoi nodes are pinned at the start of the Texture tab (with a spacer), followed by tsl-textures nodes sorted by GPU cost ascending.

**NodePreviewCard** dispatches to 7 visual variants based on `getFlowNodeType(def)` and `def.type`, matching the editor node appearance:

| Flow Type | Renderer | Visual |
|-----------|----------|--------|
| `'shader'` | ShaderCardContent | Header + port rows + fake handle dots (generic) |
| `'texturePreview'` | TextureCardContent | Header + 96x96 GPU canvas + output dot |
| `'mathPreview'` | MathCardContent | Header + 72x72 waveform canvas + input/output dots |
| `'preview'` (noise) | NoiseCardContent | Header + 96x96 pixelated CPU noise canvas + output dot |
| `'clock'` | ClockCardContent | Header + 56x56 circular clock face + output dot |
| `def.type === 'slider'` | SliderCardContent | Header + track/fill/thumb slider + min/value/max labels + output dot |
| `'color'` | ColorCardContent | 28x28 color circle + contrast-aware label + output dot |

- **Cost coloring**: NodePreviewCard reads `costColorLow`/`costColorHigh` from the zustand store and passes them to `getCostColor()`/`getCostTextColor()`, ensuring consistent cost-based coloring across editor nodes, MiniMap, and content browser. Texture nodes without explicit costs in `complexity.json` fall back to cost 50.
- **Texture GPU previews**: Lazy-rendered via `IntersectionObserver` (rootMargin `0px 300px`) using the shared `texturePreviewRenderer.ts`. Cache key `card_${def.type}` avoids collision with editor node IDs. Static only (no animation). Disposed on unmount.
- **Math/noise/clock previews**: CPU-rendered once on mount using existing `renderMathPreview()`, `renderNoisePreview()`, and ClockNode drawing code (frozen at mount time).
- **All sub-renderers** are proper React components (not called as functions) so hooks work correctly.
- **Drag-to-create**: All cards are draggable; dropping on the canvas creates the corresponding node.

### ShaderNode Vector Display

ShaderNode handles Vector3/Vector2 parameters with grouped inputs:

- Detects `_x`/`_y`/`_z` suffixed keys in defaultValues and groups them into `vec3` or `vec2` rows
- Each vector row shows: base key label + 2-3 compact `DragNumberInput` controls
- Non-port settings (colors, vec3, vec2) are collected and appended as extra rows after input ports

### Preview Nodes (Noise/Procedural)

Noise category nodes render a 96x96 canvas showing their generated pattern:

- **CPU noise**: fBm (fractal), Voronoi — evaluated in `noisePreview.ts`
- **Upstream-aware inputs**: Uses `evaluateNodeScalar()` from `cpuEvaluator.ts` to resolve connected input values (e.g., a `float(3)` node connected to `scale` updates the preview)
- **Time-conditional animation**: Only animates when a Time node is connected upstream
- **Per-port animation**: BFS traversal detects which input ports receive time signal
  - `pos` port → scrolling coordinate offset
  - `octaves`/`lacunarity`/`diminish` → sine oscillation around base value
- Static render when no Time node is upstream

### Math Preview Nodes (MathPreviewNode.tsx)

Math function nodes (`sin`, `cos`) render a 72x72 canvas showing a scrolling waveform:

- **Waveform renderer** (`mathPreview.ts`): Draws function curve over one cycle (x ∈ [-π, π]), with grid, axes, dot marker, and value label pill
- **Curve shifts on X, dot moves on Y**: When input changes, the curve scrolls horizontally (phase = inputValue) while the dot stays at horizontal center and moves only vertically to show f(inputValue)
- **Output handle**: Vertically centered on the node (direct child, not inside port row)
- **CPU evaluation**: Uses `evaluateNodeScalar()` from `cpuEvaluator.ts` to compute the actual upstream value (e.g., Time→Mul(0.5)→Sin animates at half speed)
- **Three modes**:
  - **Time upstream** → rAF loop evaluates upstream graph each frame, scrolls curve
  - **Connected, no Time** → static curve render
  - **Unconnected** → static curve with inline `DragNumberInput` for X value

### Texture Preview Nodes (TexturePreviewNode.tsx)

Texture category nodes (~49 tsl-textures) render a 96x96 canvas showing their GPU-rendered output:

- **GPU rendering**: Uses a shared off-screen `WebGPURenderer` singleton (`texturePreviewRenderer.ts`), sync `render()` (not deprecated `renderAsync`)
- **Shared renderer**: One hidden canvas + renderer + `OrthographicCamera` + `PlaneGeometry(2,2)` with per-node `MeshBasicNodeMaterial` cache (avoids shader recompilation during animation)
- **Skipped textures**: `$positionNode` and `$normalNode` textures return null from `buildColorNode()` (require geometry/render context unavailable in off-screen preview)
- **Parameter building**: Calls tsl-textures functions directly with current node values using `getParamClassifications()` — numbers, Colors, Vector3/Vector2 are reconstructed from stored values
- **Debounced updates**: 500ms debounce on parameter changes (shader recompile on each change)
- **Time animation**: When a Time node is connected upstream, the TSL `time` node is passed as parameter; a shared rAF loop re-renders all animated texture nodes each frame (no recompile — GPU auto-updates)
- **Exposed ports**: Input handles are hidden by default; users toggle them via right-click NodeSettingsMenu checkboxes (`data.exposedPorts`). Handles are rendered as a tight vertically-centered group (18px spacing), ordered to match the settings menu (tslRef inputs first, then defaultValues keys)
- **Graceful fallback**: Shows "Loading..." during async WebGPU init, "No WebGPU" if unavailable
- **localStorage migration**: `loadGraph()` migrates `type: 'shader'` nodes with `tslTex_` prefix to `type: 'texturePreview'`

### CPU Graph Evaluator (cpuEvaluator.ts)

CPU-side evaluator that walks the node graph and computes values using JS math equivalents. Used by both `MathPreviewNode` and `EdgeInfoCard` for real-time value display.

- **`evaluateNodeOutput(nodeId, nodes, edges, time)`** → `EvalResult` (multi-channel `number[]` or `null`)
- **`evaluateNodeScalar(nodeId, nodes, edges, time)`** → first channel as `number | null`
- **Multi-channel**: Returns `[x]` for scalar, `[x,y]` for vec2, `[r,g,b]` for vec3/color, `[x,y,z,w]` for vec4
- **Component-wise broadcasting**: Operations like scalar × vec3 broadcast shorter to longer
- **Supported nodes**: time, float/int/property_float/slider, screenUV, uv (with tiling/rotation), vec2/vec3/vec4/color constructors, all arithmetic (add/sub/mul/div), all unary math (sin/cos/abs/sqrt/exp/log2/floor/round/fract), binary math (pow/mod/min/max/clamp), interpolation (mix/smoothstep), vector ops (length/distance/dot/normalize/cross/append), noise (perlin/fractal/voronoi — sampled at UV center)
- Returns `null` for unevaluable nodes (e.g., positionGeometry — depends on GPU geometry)

---

## Type System

**Data types**: `float | int | vec2 | vec3 | vec4 | color | any`

Each type has a distinct color for handles and edges:

- float: `#3366CC` (blue), int: `#20B2AA` (teal), vec2: `#4A90E2` (sky), vec3: `#E040FB` (magenta), vec4: `#AB47BC` (purple), color: `#E8A317` (gold), any: `#607D8B` (slate)

**AppNode union**: `ShaderFlowNode | ColorFlowNode | PreviewFlowNode | MathPreviewFlowNode | ClockFlowNode | TexturePreviewFlowNode | OutputFlowNode`

---

## Edge System (TypedEdge.tsx)

### Visual Style

- **Multi-channel rendering**: vec2=2 lines (R,G), vec3/color=3 lines (R,G,B), vec4=4 lines (R,G,B,A)
- **Channel colors**: R=#ff4444, G=#44dd44, B=#4488ff, A=#dddddd
- **Scalar types** (float/int/any): Single line in the type's color
- **Dashed lines** for multi-channel (strokeDasharray `4 1`), solid for single
- **Selected state**: Glow effect via `drop-shadow` filter
- **Type resolution**: Resolves `'any'` to concrete type by checking source output → target input ports

### EdgeInfoCard (Live Value Display)

When an edge is selected, an info card appears at the midpoint showing:

- **Data type label** (e.g., `FLOAT`, `VEC3`, `COLOR`) with type-colored background
- **Per-channel live values**: Each channel displayed with colored label (X/Y/Z/W or R/G/B) and numeric value
- **Animated values**: When a Time node is upstream, values update via `requestAnimationFrame` loop using `evaluateNodeOutput()` from `cpuEvaluator.ts`
- **Channel colors**: R=#ff6666, G=#66dd66, B=#6699ff, A=#dddddd
- **Type resolution**: Resolves `'any'` ports by checking source output → target input concrete types

### Interaction

- **Click** → Selects edge, shows EdgeInfoCard (live value badge at edge midpoint)
- **Drag** (>5px threshold) → Disconnects edge from target, starts new connection from source handle
  - Uses pointer capture + synthetic mousedown dispatch on source handle via `requestAnimationFrame`
- **Right-click** → Opens EdgeContextMenu (delete option)
- **Invisible hit area**: 20px wide transparent stroke path for easy interaction

---

## Canvas Interactions (NodeEditor.tsx)

### Keyboard Shortcuts

- **Ctrl+S**: Save / sync code→graph
- **Ctrl+Z**: Undo
- **Ctrl+Shift+Z**: Redo
- **Ctrl+C**: Copy selected nodes (deep clone to clipboard ref)
- **Ctrl+V**: Paste copied nodes (shared `pasteNodes()` helper — offset +30px, clone edges between copied nodes)
- **Ctrl+D**: Duplicate selected (reuses `pasteNodes()` helper)
- **Delete/Backspace**: Remove selected nodes and their connected edges

### Mouse Interactions

- **Left-drag on canvas**: Box selection (partial overlap mode — `SelectionMode.Partial`)
- **Middle/right-drag on canvas**: Pan
- **Scroll**: Zoom (0.1x – 3x range)
- **Right-click canvas**: Opens AddNodeMenu (searchable node palette)
- **Right-click node**: Opens NodeSettingsMenu (edit values, duplicate, delete)
- **Right-click output node**: Opens ShaderSettingsMenu (cost, ports, displacement, material)
- **Right-click edge**: Opens EdgeContextMenu (delete)
- **Drag from handle → release on empty space**: Opens AddNodeMenu at drop position
- **Drop node on edge**: Inserts node between source and target (bezier curve proximity detection, 40px threshold)

### Drop-on-Edge Insertion

When a node is dragged and dropped near an existing edge:

1. Samples 20 points along the cubic bezier curve between source/target
2. Finds minimum distance from dragged node center to curve
3. If within 40px threshold: removes original edge, creates two new edges through the dropped node
4. Uses first input and first output ports of the dropped node's registry definition

### Anti-Overlap

After dropping a node, `onNodeDragStop` checks for AABB overlap with all other nodes. If overlapping, computes the minimum push-out direction (right/left/down/up) and nudges the node with a 10px gap.

### Connection Rules

- **Single-input enforcement**: Connecting to an already-occupied input replaces the existing edge
- **Reconnect by drag**: Dragging an edge endpoint to a new handle reconnects it
- **Failed reconnect**: Dropping a reconnected edge on empty space deletes it
- **Connection radius**: 40px snap distance

### Selection

- **Partial overlap**: Nodes are selected when the selection box partially overlaps them
- **Selection rectangle**: Subtle blue tint (`rgba(99, 130, 255, 0.08)`) with light blue border

---

## Context Menus

### Menu Dispatch (ContextMenu.tsx)

Routes to specific menu based on `contextMenu.type`:

- `'canvas'` → AddNodeMenu
- `'node'` → NodeSettingsMenu
- `'shader'` → ShaderSettingsMenu
- `'edge'` → EdgeContextMenu

### AddNodeMenu

- Auto-focused search input
- Grouped by category when not searching, flat list when searching
- Maps node to React Flow type: output→`'output'`, noise category→`'preview'`, texture category→`'texturePreview'`, color→`'color'`, sin/cos→`'mathPreview'`, time→`'clock'`, else→`'shader'`
- Places node at context menu screen position via `screenToFlowPosition()`
- Prevents adding multiple output nodes

### NodeSettingsMenu

- Displays node label and registry type
- Checkbox per parameter to expose/hide as input handle on the node (`exposedPorts`)
- Checkboxes also shown for input-only ports not in defaultValues (tslRef params like Position, Time)
- **Edge cleanup**: Hiding a port removes all edges connected to it via `removeEdgesForPort()` from `edgeUtils.ts`
- Editable parameters (color inputs for hex, DragNumberInput for numbers)
- **Property name editing**: For `property_float` nodes, the `name` field is a text input (kept as string, not parsed as number)
- Duplicate Node button (structuredClone + offset)
- Delete Node button

### ShaderSettingsMenu

Right-click menu for the output node with sections:

- **Shader Settings**: Total cost display with headset budget reference
- **Output Ports**: Checkboxes to toggle optional ports (emissive, normal); hiding a port removes connected edges via `removeEdgesForPort()`. Opacity port is auto-managed by Transparent/Alpha Clip toggles.
- **Displacement** (shown when position port is exposed):
  - "Along Normal" checkbox — controls `materialSettings.displacementMode` (`'normal'` | `'offset'`)
  - Normal mode (default): `positionLocal.add(normalLocal.mul(displacement))` — pushes vertices outward along surface normals
  - Offset mode: `positionLocal.add(displacement)` — raw vec3 offset
- **Material**: Transparent checkbox, Alpha Clip checkbox + threshold slider (0.01–1.0), Side selector (front/back/double), Depth Write (when transparent)
  - Transparent: enables smooth alpha blending, shows opacity port
  - Alpha Clip: enables `material.alphaTest` (hard cutout — fragments below threshold are discarded), shows opacity port
  - When both Transparent and Alpha Clip are off, the opacity port is hidden and edges removed

All settings stored in `OutputNodeData.materialSettings` and threaded through to all 3 export pipelines (preview, A-Frame, script).

### DragNumberInput

- **Drag mode**: Hold + drag left/right to change value (BASE_SPEED=0.005, acceleration factor 0.002)
- **Edit mode**: Click to enter text editing, Enter/Escape/blur to commit
- **Arrow buttons**: ◂/▸ with configurable step (default 0.1)
- **Rounding**: 4 decimals internal, 2 decimals display

---

## Design System (tokens.css)

- **Theme**: Light, flat design with subtle shadows
- **Font**: Inter (sans), JetBrains Mono (mono)
- **Spacing**: 4px base scale (--space-1 through --space-8)
- **Shadows**: 4 levels (sm, md, lg, node) + selected state with blue ring
- **Cost visualization**: Nodes scale (up to 1.35x) and blend color based on GPU cost (green→amber→red). All ~50 tsl-textures functions have individual GPU costs in `complexity.json` across 5 tiers: utility (10–20), simple patterns (25–38), medium (45–62), heavy (78–100), very heavy (115–165). Costs calibrated against mobile GPU SFU quarter-rate (add=1, sin/cos=4, pow=12). Budgets assume 3–5 concurrent shaders in scene.
- **Category colors**: Each node category has a distinct accent color for the header strip
  - input (#4CAF50), type (#2196F3), arithmetic (#FF9800), math (#9C27B0), interpolation (#00BCD4), vector (#E91E63), noise (#795548), color (#FF5722), texture (#8D6E63), output (#f44336)

---

## Key Technical Details

### TypeScript Gotchas

- `@babel/traverse` CJS/ESM interop: `const traverse = (typeof _traverse.default === 'function' ? _traverse.default : _traverse)`
- `AppNode` union: use `getNodeValues(node)` from `@/types` to safely access `.values` (not direct `as` cast)
- React Flow `applyNodeChanges`/`applyEdgeChanges` return base types → need `as AppNode[]` cast
- React Flow `onPaneContextMenu` expects `(event: MouseEvent | React.MouseEvent)`, not just `React.MouseEvent`
- React Flow `onNodeDragStop` expects `React.MouseEvent` (not native `MouseEvent`) for the event parameter

### tsl-textures Patches (patch-package)

Applied via `postinstall` script using `patch-package`:

- **int→float in `Fn.setLayout`**: WGSL doesn't auto-coerce between `i32` and `f32`; 11 params across 9 functions had `type: 'int'` which caused compilation errors. Patched in all 4 dist bundles (ESM, ESM min, CJS, CJS min)
- **Protozoa `scale` immutability**: WGSL function parameters are immutable; `scale.mulAssign(0.9)` fails. Patched to create `scaleVar = scale.toVar()` mutable copy

### VALID_SWIZZLE

Shared constant exported from `graphToCode.ts`, imported by `graphToTSLNodes.ts`. Contains `{'x', 'y', 'z', 'w'}` for split node swizzle validation.

### Three.js TSL Imports Used

**Code generation** (`graphToCode.ts`): Fn, float, int, vec2, vec3, vec4, color, uniform, uv, add, sub, mul, div, sin, cos, abs, pow, sqrt, exp, log2, floor, round, fract, mod, clamp, min, max, mix, smoothstep, normalize, length, distance, dot, cross, positionGeometry, normalLocal, tangentLocal, time, screenUV, mx_fractal_noise_float, mx_worley_noise_float, hsl, toHsl, remap, select + all tsl-textures functions (via dynamic import)

**Live compilation** (`graphToTSLNodes.ts`): float, vec2, vec3, vec4, color, uv, add, sub, mul, div, sin, cos, abs, pow, sqrt, exp, log2, floor, round, fract, mod, clamp, min, max, mix, smoothstep, remap, select, normalize, length, distance, dot, cross, positionGeometry, normalLocal, tangentLocal, time, screenUV, mx_fractal_noise_float, mx_worley_noise_float + dynamic tsl-textures factories (auto-resolved from registry)

### Persistence (localStorage)

- `fs:graph` — nodes + edges (auto-save every 300ms)
- `fs:splitRatio` — left/right panel ratio
- `fs:rightSplitRatio` — code/preview ratio
- `fs:previewGeometry` — selected preview geometry type
- `fs:shaderName` — shader name (via `loadString()` helper)
- `fs:headsetId` — selected VR headset (via `loadString()` helper)
- `fs:costColorLow` — cost gradient low color
- `fs:costColorHigh` — cost gradient high color

### History System

- 50-entry undo/redo stack
- `pushHistory()` called before: node drag, connection, paste, duplicate, delete, edge drag-to-disconnect
- `isUndoRedo` flag prevents sync during undo/redo operations

### Deployment

- **GitHub Pages**: `npm run build && npx gh-pages -d dist`
- **Vite base path**: `/FastShaders/` (configured in `vite.config.ts`)
