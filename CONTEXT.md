# FastShaders — Project Context

## Overview

Bi-directional TSL (Three.js Shading Language) visual shader editor. Users build shaders either by connecting nodes in a graph or by writing TSL code — changes in one view sync to the other.

**Live**: https://Alvis1.github.io/FastShaders/

**Stack**: React 18 + TypeScript + Vite | `@xyflow/react` v12 (node graph) | `@monaco-editor/react` (code editor) | `zustand` v5 (state) | `three` 0.183 (WebGPU + TSL) | `tsl-textures` 3.0 | `@dagrejs/dagre` (auto-layout) | `@babel/parser` + `traverse` + `types` (code parsing)

**A-Frame integration**: Exports use the [a-frame-shaderloader](https://github.com/Alvis1/a-frame-shaderloader) IIFE bundle which bundles with a custom A-Frame 1.7 + Three.js WebGPU + tsl-textures with matching compatible versions bundled in aframe-171-a-0.1.min.js. The shaderloader detects Object API (multi-channel) vs Simple API (single node) by checking for any `*Node` property (`colorNode`, `positionNode`, `normalNode`, `opacityNode`, `roughnessNode`, `metalnessNode`, `emissiveNode`). It also manages **property uniforms**: reads `export const schema` from modules (or auto-detects `params.XXX`/`const NAME = uniform(VALUE)` patterns), creates TSL uniforms, passes them to the shader function, and exposes `updateProperty(name, value)` for runtime updates.

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
│   ├── codeToGraph.ts                 # TSL code → nodes + edges (Babel AST parsing, incl. object literals)
│   ├── graphToTSLNodes.ts             # Graph → live Three.js TSL node objects (all 5 output channels)
│   ├── tslCodeProcessor.ts            # Shared TSL processing: import extraction, TDZ fix, body parsing
│   ├── tslToAFrame.ts                 # TSL code → A-Frame HTML (uses tslCodeProcessor, materialSettings, properties)
│   ├── tslToShaderModule.ts           # TSL code → shaderloader-compatible ES script (materialSettings, properties)
│   ├── tslToPreviewHTML.ts            # TSL code → Three.js WebGPU HTML (uses tslCodeProcessor)
│   ├── layoutEngine.ts                # Dagre auto-layout (LR, nodesep=25, ranksep=60)
│   ├── cpuEvaluator.ts                # CPU-side graph evaluator for real-time values (multi-channel)
│   ├── topologicalSort.ts             # Kahn's algorithm for execution order
│   └── evaluateTSLScript.ts           # tsl-textures script evaluator (new Function)
├── hooks/
│   └── useSyncEngine.ts               # Bidirectional sync hook (watches graph/code changes)
├── registry/
│   ├── nodeRegistry.ts                # ~90+ TSL node definitions (core + auto-registered tsl-textures)
│   ├── tslTexturesRegistry.ts         # Auto-registers ~49 tsl-textures functions as nodes from .defaults
│   ├── nodeCategories.ts              # Category metadata (id + label)
│   └── complexity.json                # GPU cost per operation
├── store/
│   └── useAppStore.ts                 # Zustand store (nodes, edges, code, sync, history, UI)
├── types/
│   ├── index.ts                       # Re-exports all types
│   ├── node.types.ts                  # AppNode union, ShaderNodeData, OutputNodeData
│   ├── sync.types.ts                  # SyncSource type
│   └── tsl.types.ts                   # ParseError, GeneratedCode
├── utils/
│   ├── colorUtils.ts                  # Cost color gradient, type→color mapping, category colors
│   ├── idGenerator.ts                 # generateId(), generateEdgeId()
│   ├── mathPreview.ts                 # Sin/math waveform canvas renderer (scrolling curve + dot)
│   ├── noisePreview.ts               # CPU noise (Perlin, fBm, Voronoi) + animated render
│   └── texturePreviewRenderer.ts     # Shared off-screen WebGPU renderer for texture node previews
└── styles/
    ├── tokens.css                     # CSS custom properties (colors, spacing, shadows, fonts)
    └── reset.css
```

---

## Architecture

### Two Code Modes

**Graph Mode (default)** — User builds nodes visually. Graph compiles to TSL code in real-time.

```typescript
// Generated output format:
import { Fn, positionGeometry, mx_noise_float } from "three/tsl";
const shader = Fn(() => {
  const pos = positionGeometry;
  const noise = mx_noise_float(pos);
  return noise;
});
export default shader;
```

**Script Mode** — User pastes tsl-textures code with `model.material` assignments. Detected by `isTSLTexturesCode()` (matches `model.material.XNode =` pattern only). Evaluated via `evaluateTSLScript()` using `new Function()` with THREE + tsl-textures in scope. Bypasses graph sync.

```typescript
// Script mode input format:
import { polkaDots } from "tsl-textures";
model.material.colorNode = polkaDots({ count: 4, size: 0.34 });
```

### Code Editor Tabs

The code editor has three tabs:

- **TSL** — Editable TSL code with Save button and error display (default)
- **A-Frame** — Read-only self-contained HTML using the [a-frame-shaderloader](https://github.com/Alvis1/a-frame-shaderloader) IIFE bundle (`tslToAFrame.ts`):
  - Loads `aframe-171-a-0.1.min.js` and `a-frame-shaderloader-0.2.js` from jsDelivr CDN
  - IIFE bundle includes A-Frame 1.7 + Three.js WebGPU + tsl-textures with matching compatible versions
  - Uses a regular `<script>` that destructures TSL functions from `THREE.TSL` and tsl-textures from `window.tslTextures`
  - TDZ fixes applied: self-ref removal, variable rename for shadowing imports, tsl-textures aliases
  - Receives `materialSettings` from output node (displacement mode, transparent, side)
  - Download as `.html`
- **Script** — Read-only shaderloader-compatible ES module (`tslToShaderModule.ts`):
  - Converts `Fn(() => { ... })` wrapper to `export default function(params) { ... }` (when properties exist) or `export default function() { ... }` (no properties)
  - Standard bare imports (`'three/tsl'`, `'tsl-textures'`)
  - Multi-channel returns converted to shaderloader Object API (`color` → `colorNode`, etc.)
  - Position channel wrapped with displacement logic: `positionLocal.add(normalLocal.mul(val))` (normal mode) or `positionLocal.add(val)` (offset mode from `materialSettings`)
  - **Property support**: Replaces `const NAME = uniform(VALUE)` with `const NAME = params.NAME`; removes `uniform` from imports when all uniform calls are replaced by params references
  - The shaderloader handles TDZ fixes and missing import injection at runtime
  - Download as `.js` for use with `<a-entity shader="src: myshader.js">`

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
- **Code → Graph**: Debounced auto-sync (600ms) + manual via Save button / Ctrl+S (`codeToGraph()` with Babel parser, `errorRecovery: true`)
- **Stable node matching**: Two-pass matching (registryType+label, then registryType only) preserves node positions and IDs across syncs
- **Complexity**: Traverses backward from Output node, sums costs from `complexity.json`

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

Common processing logic used by both `tslToAFrame.ts` and `tslToPreviewHTML.ts`:

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

Generates a self-contained `.html` using the a-frame-shaderloader IIFE bundle:

1. Uses `tslCodeProcessor` to extract imports, body, fix TDZ, and parse channels
2. Accepts `materialSettings` and `properties` (PropertyInfo[]) via `AFrameOptions` — applies displacement wrapping, transparent, side
3. **Displacement**: When position channel is used, wraps as `positionLocal.add(normalLocal.mul(ref))` (normal mode) or `positionLocal.add(ref)` (offset mode), injects `positionLocal`/`normalLocal` imports
4. **Property support**: When properties exist, emits component `schema` with property definitions, creates `this._uniforms.NAME = uniform(this.data.NAME)` in init, replaces property uniform declarations with `this._uniforms.NAME` refs, adds `update()` method for reactive A-Frame attribute changes
5. Generates HTML with:
   - `<script src="...aframe-171-a-0.1.min.js">` from jsDelivr CDN (IIFE bundle)
   - `<script src="...a-frame-shaderloader-0.2.js">` from jsDelivr CDN (shaderloader component)
   - Inline `<script>` registering an A-Frame component
   - TSL functions destructured from `THREE.TSL`, tsl-textures from `window.tslTextures`
   - Material creation + channel assignment + mesh

### Shader Script Export (`tslToShaderModule.ts`)

Generates a `.js` ES module compatible with the a-frame-shaderloader component:

1. Strips `Fn` from three/tsl imports
2. Converts `const shader = Fn(() => {` to `export default function(params) {` (when properties exist) or `export default function() {` (no properties)
3. Converts multi-channel return keys to shaderloader Object API names (`color` → `colorNode`, `position` → `positionNode`, etc.)
4. Accepts optional `materialSettings` and `properties` (PropertyInfo[]) — wraps position channel with displacement logic (same normal/offset modes as tslToAFrame), injects `positionLocal`/`normalLocal` into the `three/tsl` import line when needed
5. **Property support**: Replaces `const NAME = uniform(VALUE)` with `const NAME = params.NAME`; removes `uniform` from imports when all uniform calls are replaced by params references
6. Removes `export default shader;`
7. The shaderloader handles TDZ fixes, missing import injection, and specifier resolution at runtime

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
| **Input**         | positionGeometry, normalLocal, tangentLocal, time, screenUV, property_float               |
| **Type**          | float, int, vec2, vec3, vec4, color                                                       |
| **Arithmetic**    | add, sub, mul, div                                                                        |
| **Math (unary)**  | sin, cos, abs, sqrt, exp, log2, floor, round, fract                                       |
| **Math (binary)** | pow, mod, clamp, min, max                                                                 |
| **Interpolation** | mix, smoothstep, remap, select                                                            |
| **Vector**        | normalize, length, distance, dot, cross, split                                            |
| **Noise**         | noise (mx_noise_float), fractal (mx_fractal_noise_float), voronoi (mx_worley_noise_float) |
| **Color**         | hsl, toHsl                                                                                |
| **Texture**       | ~49 auto-registered tsl-textures functions (bricks, camouflage, polkaDots, marble, etc.)  |
| **Output**        | output (color, normal, displacement, opacity, roughness, emissive inputs + materialSettings) |

### tsl-textures Auto-Registration (tslTexturesRegistry.ts)

All ~49 tsl-textures functions are auto-registered as nodes by introspecting `.defaults` at runtime:

- **Parameter classification** (`classifyParam`): Each default param is classified as `number`, `color` (THREE.Color), `vec3` (THREE.Vector3), `vec2` (THREE.Vector2), `tslRef` (.isNode), or `meta` ($-prefixed)
- **NodeDefinition generation** (`buildTSLTextureDefinitions`):
  - Numbers → connectable input ports + editable default values
  - Colors → hex string in defaultValues (e.g., `#ff0000`)
  - Vector3 → flattened keys: `key_x`, `key_y`, `key_z` in defaultValues
  - Vector2 → flattened keys: `key_x`, `key_y`
  - TSL refs (position, time) → input ports only (library uses own defaults if unconnected)
- **Node type prefix**: `tslTex_` to avoid collisions (e.g., `tslTex_bricks`)
- **Code generation**: Object parameter syntax — `bricks({ scale: 2, color: new THREE.Color(0xFF4000) })`
- **Live compilation**: Dynamic factory builds params object, calls `tslTextures[funcName](params)`
- **Code parsing**: `processObjectCall()` parses ObjectExpression properties; `extractConstructor()` handles `new THREE.Color/Vector3/Vector2` AST patterns

### Split Node

The split node decomposes vectors into individual float components:

- **Input**: one `Vector` port (any type)
- **Outputs**: four float ports — X, Y, Z, W
- **TSL compilation**: Factory passes through the input vector; edge resolution applies `.x`/`.y`/`.z`/`.w` swizzle when sourceHandle isn't `'out'`
- **Code generation**: Split nodes are not emitted as variables; references through them are inlined as `sourceVar.x`, `sourceVar.y`, etc.
- **Searchable**: by "split" or "separate"

### Property Nodes (`property_float`)

Configurable uniform properties that become component attributes in A-Frame exports:

- **Registry**: `tslFunction: 'uniform'`, `defaultValues: { value: 1.0, name: 'property1' }` — value first for positional key lookup in graphToCode/codeToGraph
- **Auto-naming**: New property nodes are named `property1`, `property2`, etc. (counts existing property_float nodes)
- **Node header**: Shows the user-defined name (e.g., "brightness") instead of the generic label
- **Code generation** (`graphToCode.ts`): Uses the sanitized property name as the variable name (e.g., `const brightness = uniform(1.5)`)
- **Code parsing** (`codeToGraph.ts`): Sets `values.name = varName` from the code's variable name
- **TSL function map**: `uniform` → `property_float` via `TSL_FUNCTION_TO_DEF` (so code→graph correctly identifies `uniform()` calls as property nodes)
- **Script export**: Replaces `uniform(VALUE)` with `params.NAME` references; `function(params)` signature
- **A-Frame export**: Emits component schema + `this._uniforms.NAME` + `update()` method
- **Migration**: `loadGraph()` in useAppStore migrates old `uniform_float` → `property_float`

### React Flow Node Types

- **`shader`** — Generic node for most TSL operations (ShaderNode.tsx)
- **`color`** — Color picker with hex input (ColorNode.tsx)
- **`preview`** — Noise/procedural nodes with animated canvas thumbnail (PreviewNode.tsx)
- **`mathPreview`** — Math function nodes with scrolling waveform visualization (MathPreviewNode.tsx)
- **`texturePreview`** — Texture nodes with GPU-rendered 96x96 canvas preview (TexturePreviewNode.tsx)
- **`output`** — Output sink with two sections: Pixel Shader (color, roughness, emissive, normal, opacity) and Vertex Shader (displacement), plus `materialSettings` for export config (OutputNode.tsx)

### ShaderNode Vector Display

ShaderNode handles Vector3/Vector2 parameters with grouped inputs:

- Detects `_x`/`_y`/`_z` suffixed keys in defaultValues and groups them into `vec3` or `vec2` rows
- Each vector row shows: base key label + 2-3 compact `DragNumberInput` controls
- Non-port settings (colors, vec3, vec2) are collected and appended as extra rows after input ports

### Preview Nodes (Noise/Procedural)

Noise category nodes render a 96x96 canvas showing their generated pattern:

- **CPU noise**: Perlin 2D, fBm (fractal), Voronoi — evaluated in `noisePreview.ts`
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

- **GPU rendering**: Uses a shared off-screen `WebGPURenderer` singleton (`texturePreviewRenderer.ts`)
- **Shared renderer**: One hidden canvas + renderer + `OrthographicCamera` + `PlaneGeometry(2,2)` with per-node `MeshBasicNodeMaterial` cache (avoids shader recompilation during animation)
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
- **Supported nodes**: time, float/int/property_float, screenUV, vec2/vec3/vec4/color constructors, all arithmetic (add/sub/mul/div), all unary math (sin/cos/abs/sqrt/exp/log2/floor/round/fract), binary math (pow/mod/min/max/clamp), interpolation (mix/smoothstep), vector ops (length/distance/dot/normalize/cross), noise (perlin/fractal/voronoi — sampled at UV center)
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
- Editable parameters (color inputs for hex, DragNumberInput for numbers)
- **Property name editing**: For `property_float` nodes, the `name` field is a text input (kept as string, not parsed as number)
- Duplicate Node button (structuredClone + offset)
- Delete Node button

### ShaderSettingsMenu

Right-click menu for the output node with sections:

- **Shader Settings**: Total cost display with headset budget reference
- **Output Ports**: Checkboxes to toggle optional ports (emissive, normal, opacity)
- **Displacement** (shown when position port is exposed):
  - "Along Normal" checkbox — controls `materialSettings.displacementMode` (`'normal'` | `'offset'`)
  - Normal mode (default): `positionLocal.add(normalLocal.mul(displacement))` — pushes vertices outward along surface normals
  - Offset mode: `positionLocal.add(displacement)` — raw vec3 offset
- **Material**: Transparent checkbox, Side selector (front/back/double), Depth Write (when transparent)

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
- **Cost visualization**: Nodes scale (up to 1.35x) and blend color based on GPU cost (green→amber→red)
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

### Three.js TSL Imports Used

**Code generation** (`graphToCode.ts`): Fn, float, int, vec2, vec3, vec4, color, uniform, add, sub, mul, div, sin, cos, abs, pow, sqrt, exp, log2, floor, round, fract, mod, clamp, min, max, mix, smoothstep, normalize, length, distance, dot, cross, positionGeometry, normalLocal, tangentLocal, time, screenUV, mx_noise_float, mx_fractal_noise_float, mx_worley_noise_float, hsl, toHsl, remap, select + all tsl-textures functions (via dynamic import)

**Live compilation** (`graphToTSLNodes.ts`): float, vec2, vec3, vec4, color, add, sub, mul, div, sin, cos, abs, pow, sqrt, exp, log2, floor, round, fract, mod, clamp, min, max, mix, smoothstep, remap, select, normalize, length, distance, dot, cross, positionGeometry, normalLocal, tangentLocal, time, screenUV, mx_noise_float, mx_fractal_noise_float, mx_worley_noise_float + dynamic tsl-textures factories (auto-resolved from registry)

### Persistence (localStorage)

- `fs:graph` — nodes + edges (auto-save every 300ms)
- `fs:splitRatio` — left/right panel ratio
- `fs:rightSplitRatio` — code/preview ratio
- `fs:previewGeometry` — selected preview geometry type
- `fs:shaderName` — shader name
- `fs:headsetId` — selected VR headset

### History System

- 50-entry undo/redo stack
- `pushHistory()` called before: node drag, connection, paste, duplicate, delete, edge drag-to-disconnect
- `isUndoRedo` flag prevents sync during undo/redo operations

### Deployment

- **GitHub Pages**: `npm run build && npx gh-pages -d dist`
- **Vite base path**: `/FastShaders/` (configured in `vite.config.ts`)
