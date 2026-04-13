# FastShaders — Project Context

## Overview

Bi-directional TSL (Three.js Shading Language) visual shader editor. Users build shaders either by connecting nodes in a graph or by writing TSL code — changes in one view sync to the other.

**Live**: https://Alvis1.github.io/FastShaders/

**Stack**: React 18 + TypeScript + Vite | `@xyflow/react` v12 (node graph) | `@monaco-editor/react` (code editor) | `zustand` v5 (state) | `three` 0.183 (WebGPU + TSL — exclusively `three/tsl` built-ins, including the MaterialX noise family) | `@dagrejs/dagre` (auto-layout) | `@babel/parser` + `traverse` + `types` (code parsing)

**A-Frame integration**: Exports use the [a-frame-shaderloader](https://github.com/Alvis1/a-frame-shaderloader) IIFE bundle which bundles a custom A-Frame 1.7 + Three.js r173 WebGPU in `aframe-171-a-0.1.min.js`. The shaderloader (`a-frame-shaderloader-0.3.js`) resolves the bare `'three/tsl'` import specifier via `tsl-shim.js` so blob-loaded modules work. It detects Object API (multi-channel) vs Simple API (single node) by checking for any `*Node` property (`colorNode`, `positionNode`, `normalNode`, `opacityNode`, `roughnessNode`, `metalnessNode`, `emissiveNode`). It also manages **property uniforms**: reads `export const schema` from modules (or auto-detects `params.XXX`/`const NAME = uniform(VALUE)` patterns), creates TSL uniforms, passes them to the shader function, and exposes `updateProperty(name, value)` for runtime updates. `tsl-shim.js` re-exports `window.THREE` + `THREE.TSL` as ESM — no fallback library is needed since the r173 bundle exposes `hsl`/`toHsl` natively.

---

## Project Structure

```
src/
├── App.tsx                            # Root + SyncController (graph↔code sync orchestration)
├── main.tsx                           # Entry point
├── vite-env.d.ts                      # Type declarations (Vite env + __APP_VERSION__)
├── components/
│   ├── CodeEditor/
│   │   ├── CodeEditor.tsx             # Monaco editor with TSL/Script folder tabs, Save, Load Script, Download Script
│   │   ├── CodeEditor.css
│   │   └── tslLanguage.ts             # TSL language definition, completions, color picker
│   ├── Layout/
│   │   ├── AppLayout.tsx              # Two nested SplitPanes (left: graph | right: code/preview)
│   │   ├── AppLayout.css
│   │   ├── SplitPane.tsx              # Draggable divider (pointer-captured, horizontal or vertical)
│   │   ├── Toolbar.tsx                # Top bar: clickable brand → contact popover, version, shader name input
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
│   │   │   ├── PreviewNode.tsx        # Noise preview with animated CPU canvas (all 8 MaterialX noise variants)
│   │   │   ├── PreviewNode.css
│   │   │   ├── MathPreviewNode.tsx    # Math function preview with scrolling waveform (sin, cos)
│   │   │   ├── MathPreviewNode.css
│   │   │   ├── ClockNode.tsx          # Time node with animated analog clock face
│   │   │   ├── ClockNode.css
│   │   │   ├── OutputNode.tsx         # Output sink (color, normal, position, opacity, roughness)
│   │   │   ├── OutputNode.css
│   │   │   ├── GroupNode.tsx          # Selection group container — collapsible, recolorable, savable
│   │   │   └── GroupNode.css
│   │   ├── handles/
│   │   │   └── TypedHandle.tsx        # Color-coded handles per data type
│   │   ├── edges/
│   │   │   ├── TypedEdge.tsx          # Multi-channel colored edges, drag-to-disconnect, info card
│   │   │   ├── EdgeInfoCard.tsx       # Live value display on edges (per-channel, animated)
│   │   │   └── EdgeInfoCard.css
│   │   ├── inputs/
│   │   │   └── DragNumberInput.tsx    # Drag-to-adjust number input with acceleration
│   │   ├── ContentBrowser.tsx         # Category-tabbed asset drawer with search, folder tabs, horizontal scroll + Textures + Saved Groups tabs
│   │   ├── ContentBrowser.css
│   │   ├── NodePreviewCard.tsx        # Type-dispatching preview card (7 visual variants matching editor nodes)
│   │   ├── NodePreviewCard.css
│   │   ├── SavedGroupCard.tsx         # Draggable tile for a user-saved group (Saved Groups tab)
│   │   ├── TextureCard.tsx            # Draggable tile for a built-in texture (Textures tab, CPU canvas preview)
│   │   └── menus/
│   │       ├── ContextMenu.tsx        # Menu dispatcher (canvas/node/shader/edge/group)
│   │       ├── ContextMenu.css
│   │       ├── AddNodeMenu.tsx        # Searchable node palette, grouped by category, "Group Selection" entry
│   │       ├── NodeSettingsMenu.tsx   # Node properties, duplicate, delete
│   │       ├── ShaderSettingsMenu.tsx # Output node settings (ports, displacement, material, uniforms)
│   │       ├── GroupSettingsMenu.tsx  # Rename + recolor + Save to Library + Ungroup
│   │       └── EdgeContextMenu.tsx    # Edge delete menu
│   └── Preview/
│       ├── ShaderPreview.tsx          # WebGPU iframe preview with geometry selector and rotation toggle
│       └── ShaderPreview.css
├── engine/
│   ├── graphToCode.ts                 # Graph → TSL code string (import statements + Fn() wrapper)
│   ├── codeToGraph.ts                 # TSL code → nodes + edges (Babel AST, multi-channel returns, noise/UV patterns, three.js editor compat)
│   ├── graphToTSLNodes.ts             # Graph → live Three.js TSL node objects (all 5 output channels)
│   ├── tslCodeProcessor.ts            # Shared TSL processing: import extraction, TDZ fix, body parsing
│   ├── tslToAFrame.ts                 # TSL code → A-Frame HTML (uses tslToShaderModule + shaderloader blob URL)
│   ├── tslToShaderModule.ts           # TSL code → shaderloader-compatible ES script (materialSettings, properties)
│   ├── tslToPreviewHTML.ts            # TSL code → Three.js WebGPU HTML (uses tslCodeProcessor)
│   ├── layoutEngine.ts                # Dagre auto-layout (LR, nodesep=25, ranksep=60)
│   ├── cpuEvaluator.ts                # CPU-side graph evaluator for real-time values (multi-channel, cycle guard, uses hexToRgb01 from colorUtils)
│   ├── topologicalSort.ts             # Kahn's algorithm for execution order
│   ├── evaluateTSLScript.ts           # isDirectAssignmentCode() — detects `model.material.*Node = …` style scripts
│   └── scriptToTSL.ts                # Reverse of tslToShaderModule — converts .js script back to Fn-wrapped TSL
├── hooks/
│   └── useSyncEngine.ts               # Bidirectional sync hook (watches graph/code changes)
├── registry/
│   ├── nodeRegistry.ts                # ~55 hardcoded TSL node definitions (incl. 8 MaterialX noise nodes) + hidden `unknown` def
│   ├── nodeCategories.ts              # Category metadata (id + label) — 11 categories (incl. texture, unknown)
│   ├── builtinTextures.ts             # Built-in texture groups (wood, etc.) — TSL code parsed to node graphs at startup
│   └── complexity.json                # GPU cost per operation
├── store/
│   └── useAppStore.ts                 # Zustand store (nodes, edges, code, sync, history, UI)
├── types/
│   ├── index.ts                       # Re-exports all types
│   ├── node.types.ts                  # AppNode union, ShaderNodeData, OutputNodeData, GroupNodeData, BoundarySocket
│   ├── sync.types.ts                  # SyncSource type
│   └── tsl.types.ts                   # ParseError, GeneratedCode
├── utils/
│   ├── colorUtils.ts                  # Cost color gradient, type→color mapping, CATEGORY_COLORS, hexToRgb01, getContrastColor (auto-flip text against bg)
│   ├── edgeUtils.ts                   # removeEdgesForPort() — cleans up edges when hiding input ports
│   ├── graphTraversal.ts             # hasTimeUpstream() — BFS time-node detection with O(1) Map lookup
│   ├── idGenerator.ts                 # generateId(), generateEdgeId()
│   ├── mathPreview.ts                 # Sin/math waveform canvas renderer (scrolling curve + dot)
│   ├── noisePreview.ts               # CPU noise (perlin2D, fbm2D, cellNoise2D, voronoi2D) — all 8 noise variants
│   ├── nameUtils.ts                   # toKebabCase() for export filenames
│   └── edgeDisconnectFlag.ts          # Transient flag for edge disconnect suppression
└── styles/
    ├── tokens.css                     # CSS custom properties (colors, spacing, shadows, fonts)
    └── reset.css
public/
└── js/
    ├── tsl-shim.js                   # Re-exports window.THREE + THREE.TSL as ESM (consumed by preview iframes)
    ├── a-frame-shaderloader-0.3.js   # A-Frame shader component (TDZ fix + auto-import + property schema)
    ├── a-frame-shaderloader-0.2.js   # Legacy shaderloader version
    ├── aframe-171-a-0.1.min.js       # A-Frame 1.7 IIFE bundle (WebGPU)
    └── aframe-orbit-controls.min.js  # Orbit controls for preview
```

---

## Architecture

### Two Code Modes

**Graph Mode (default)** — User builds nodes visually. Graph compiles to TSL code in real-time.

```typescript
// Generated output format:
import { Fn, mx_fractal_noise_float, positionGeometry } from "three/tsl";
const shader = Fn(() => {
  const fbm1 = mx_fractal_noise_float(positionGeometry.mul(2.5));
  return fbm1;
});
export default shader;
```

**Direct-Assignment Mode** — User pastes shader code with `model.material.XNode = …` assignments. Detected by `isDirectAssignmentCode()` in [evaluateTSLScript.ts](src/engine/evaluateTSLScript.ts). Bypasses graph sync.

```typescript
// Direct-assignment input format:
import { mx_noise_vec3, positionGeometry } from "three/tsl";
model.material.colorNode = mx_noise_vec3(positionGeometry.mul(3));
```

**Three.js TSL Editor Compatibility** — `codeToGraph` also accepts the [three.js webgpu_tsl_editor](https://threejs.org/examples/webgpu_tsl_editor) flat snippet form (`output = X;` at top level, with `.toVar()` / `.toConst()` chains on bare identifiers). The `AssignmentExpression` visitor recognises `output = …` as the implicit return, and `processCall` short-circuits `.toVar()`/`.toConst()` so they don't create wrapper nodes. `ensureBareInputNode()` materialises bare references to known input identifiers (positionGeometry, time, …) on demand.

### Code Editor Tabs

The code editor has two tabs styled as folder tabs (active tab visually connects to the page below):

- **TSL** — Editable TSL code with Save button, Load Script button, and error display (default)
- **Script** — Read-only shaderloader-compatible ES module (`tslToShaderModule.ts`):
  - Header comments with HTML setup, property attribute examples, and runtime update instructions
  - Converts `Fn(() => { ... })` wrapper to `export default function(params) { ... }` (when properties exist) or `export default function() { ... }` (no properties)
  - Standard bare import (`'three/tsl'`) — also usable directly with Three.js
  - Multi-channel returns converted to shaderloader Object API (`color` → `colorNode`, etc.)
  - Material settings injected into return object: `transparent`, `side`, `alphaTest`
  - Position channel wrapped with displacement logic: `positionLocal.add(normalLocal.mul(val))` (normal mode) or `positionLocal.add(val)` (offset mode from `materialSettings`)
  - **Property support**: Emits `export const schema` with property defaults; replaces `const NAME = uniform(VALUE)` with `const NAME = params.NAME`; removes `uniform` from imports when all uniform calls are replaced by params references
  - The shaderloader handles TDZ fixes and missing import injection at runtime
  - Download Script button for `.js` export (for use with `<a-entity shader="src: myshader.js; propName: value">`)

The Script tab reads `materialSettings` and `properties` (from `property_float` nodes) in `CodeEditor.tsx` and threads them to the generator.

The TSL editor stays mounted (hidden) when switching tabs to avoid Monaco re-initialization freezes.

**Load Script**: On the TSL tab, a "Load Script" button opens a file picker for `.js` files. The selected file is read and converted back to TSL code via `scriptToTSL()` ([scriptToTSL.ts](src/engine/scriptToTSL.ts)), which reverses the `tslToShaderModule` transforms: `export default function(params)` → `Fn(() => {`, `params.NAME` → `uniform(default)` (defaults read from `export const schema`), `colorNode` → `color`, strips nested `Fn()` artifacts from unknown-node round-tripping, and re-adds `Fn`/`uniform` to the import line. The converted TSL is written into the editor and a code→graph sync is triggered.

**No panel headers**: The "Node View" and "TSL Code View" panel labels have been removed. The code editor uses a tab bar with folder-style tabs at the top. The toolbar shows a "Script name:" label before the shader name input. The preview panel has a compact top bar with controls (play/pause, reset, bg color, lighting, geometry, subdivision).

**SplitPane** ([SplitPane.tsx](src/components/Layout/SplitPane.tsx)): Uses `setPointerCapture()` on the divider so dragging never loses grip — even when the cursor flies over iframes or other elements that would swallow regular mouse events. Ratio clamped to `[0.05, 0.95]`. `touchAction: none` prevents browser scroll hijack on touch devices.

### Preview (ShaderPreview.tsx)

- **Rendered in iframe** via blob URL from `tslToPreviewHTML.ts`
- **Renderer**: A-Frame scene with `a-frame-shaderloader` (loads local IIFE bundle via Vite public dir)
- **Camera**: FOV 20 with orbit controls (zoom 2–80, rotate 0.5 speed). Initial position `0 0 8`.
- **Geometry**: Selector dropdown with five options, persisted to localStorage:
  - **Primitives** — `sphere`, `cube`, `plane`. Plane is rendered un-rotated (faces the camera); sphere and cube use a 45/45 tilt so multiple faces are visible.
  - **OBJ models** — `teapot` (Utah teapot, 15/35/0 tilt) and `bunny` (Stanford bunny, 0/25/0 tilt — silhouette reads better head-on). Backed by static files in `public/models/` (`teapot.obj`, `stanford-bunny.obj`), loaded via A-Frame's `obj-model` component. The custom `fit-bounds` component (registered inline in the iframe) recomputes vertex normals when the source file lacks them, generates spherical UVs from each vertex's direction so TSL shaders that read `uv()` get meaningful values, and recenters/rescales the mesh so the longest axis equals `1.6` (matching primitive framing).
  - `isObjGeometry(geometry)` in [tslToPreviewHTML.ts](src/engine/tslToPreviewHTML.ts) is the single source of truth for primitive vs OBJ branching.
- **Subdivision slider**: Symmetrically applied to per-primitive segment fields (`segmentsWidth/Height` for sphere/plane, all three for cube). Range `[1, 256]`, default 64. Built into the geometry attribute by `buildGeoAttr()` in `tslToPreviewHTML.ts`. **Hidden when an OBJ model is selected** — the slider has no meaning for static meshes.
- **Lighting modes** (dropdown, persisted):
  - **light: Studio** (default) — three-point rig (warm key + cool rim + neutral fill + low ambient).
  - **light: Moon** — single cool directional from `-4 1.5 2` at intensity 4.0 (terminator ~65° off camera axis, ~2/3 of the visible hemisphere lit) + a faint dark-blue ambient floor.
  - **light: Laboratory** — pure white ambient at intensity 1.0, no shadows.
- **Material**: `materialSettings` from output node (displacement mode, transparent, side)
- **Animation**: Play/pause toggle for mesh rotation. Y-axis turntable spin for sphere/cube/teapot/bunny; planes spin on Z (in-plane, like a record).
- **Background**: User-picked color via `<input type="color">` in the header, persisted to `fs:previewBgColor`. Defaults to `#808080`.
- **Reset button** (red, left side of header): clears the saved camera, restores **studio** lighting, **subdivision 64**, and every property uniform back to its shader-defined default. Min/max bounds, geometry, and bg color are user preferences and intentionally **not** reset.

#### Property uniform overlay

- Floating top-right panel listing every property uniform with `[min] [slider] [max]` per row plus a live numeric readout.
- Uniforms are extracted on the parent side via the same regex the shaderloader uses (`const NAME = uniform(VALUE)`), so the names always line up regardless of any sanitization `graphToCode` does.
- Sliders are **overlay-local** state — they never write back to the graph, so dragging doesn't trigger a graph re-sync that would tear the iframe down. Per-uniform `{min, max}` is persisted under `fs:previewUniformBounds`.
- When `previewCode` changes, slider values are **preserved** for names that still exist and **seeded from the code default** for new names; stale entries are dropped.
- **`BoundInput` subcomponent** ([ShaderPreview.tsx](src/components/Preview/ShaderPreview.tsx)) wraps each min/max number field. It buffers the in-progress text in **local string state** (`draft`) and only commits to the parent's numeric state on a successful `parseFloat`, so partial inputs like `-`, `1.`, or `1e` survive controlled-input re-renders. Without this buffer, typing `-` parses to `NaN`, the controlled input snaps back to the previous numeric value, and you can never get past the first character — i.e. negatives were untypeable. An `editingRef` blocks external prop sync while the field is focused so resets/persistence don't clobber typing; on blur, an unparseable draft snaps back to the canonical value.

#### Iframe ↔ parent bridge

The generated iframe HTML carries an inline bridge script that talks to the parent over `postMessage`:

- **Property uniforms**: To make sliders actually move the GPU uniforms, `convertToShaderModule` rewrites every `const N = uniform(V)` to `const N = params.N`, exports an explicit `schema`, and changes the function signature to `function(params)`. The shaderloader then creates the uniforms up-front, passes them in as `params`, and the function uses *those* uniforms — so writing to `_propertyUniforms[name].value` from the bridge actually reaches the material.
- **Outbound messages** (iframe → parent):
  - `fs:preview-ready` — sent once after the shaderloader's `_propertyUniforms` populates. Parent responds by pushing all current slider values via `fs:uniform`, so a freshly rebuilt iframe immediately reflects user tweaks.
  - `fs:camera` — sent whenever the camera position changes (200ms polling, only posted on actual change).
- **Inbound messages** (parent → iframe):
  - `fs:uniform` — `{name, value}`; bridge writes directly into `_propertyUniforms[name].value` (no setAttribute round-trip).
  - `fs:reset-camera` — bridge calls `oc.controls.reset()`.
- **Camera persistence**: The parent stores the latest position in a `cameraPosRef` (a ref, not state — putting it in state would create an infinite rebuild loop). When `useMemo` rebuilds the iframe (lighting/subdivision/etc. changed), it reads `cameraPosRef.current` and embeds it as `window.__savedCameraPos = {x,y,z}`. The bridge applies that position **after** orbit-controls finishes initializing — critically, **not** by setting `initialPosition`, because that would also overwrite the controls' internal `position0` snapshot and break `controls.reset()`. So the user's view survives setting changes, and Reset still snaps home.

### Sync Engine (prevents infinite loops)

- **`syncSource`** field: `'graph' | 'code' | 'initial'` — tracks who initiated the change
- **`syncInProgress`** flag — blocks nested syncs
- **Graph → Code**: Real-time on every node/edge change (`graphToCode()`)
- **Code → Graph**: Manual via Save button / Ctrl+S (`codeToGraph()` with Babel parser, `errorRecovery: true`)
- **Stable node matching**: Two-pass matching (registryType+label, then registryType only) preserves node positions, IDs, `exposedPorts`, and `materialSettings` across syncs
- **Auto-expose ports**: After code→graph sync, any port with an incoming edge is automatically added to `exposedPorts` (texture, noise, output nodes)
- **Complexity**: Traverses backward from Output node, sums costs from `complexity.json`. Uses `lastCostRef` guard to prevent double BFS runs (updating output node cost triggers nodes change → would re-run the effect). Collapsed groups are opaque to the BFS (no edges lead from the group node into its members), so the summation loop uses the group's cached `data.cost` instead of the (zero) registry cost — this keeps the total stable across collapse/expand.

### Code → Graph Parsing (codeToGraph.ts)

The Babel-based parser handles these patterns:

- **Multi-channel returns**: `return { color: x, position: y }` → wires each property to the corresponding output port. Also handles member expressions (`someVar.x`) and inline call expressions (`someFunc(a, b)`) as return values.
- **Single-value returns**: `return x` or `return someFunc(a, b)` or `return someVar.x` → wires to output.color (inline calls create intermediate nodes, member expressions create split nodes)
- **Split node reconstruction**: Member expressions like `someVar.x`, `someVar.y`, etc. in function arguments or return values automatically create split nodes. One split node is reused per source variable (tracked via `splitNodes` map). Wires `source → split.v` and `split.{x,y,z,w} → target`.
- **Append node detection**: `vec2(ref1, ref2)` where at least one argument is a variable reference or member expression creates an `append` node (not a `vec2` type constructor). This matches the `graphToCode` output for append nodes.
- **Noise functions**: All 8 MaterialX noise variants (`mx_noise_float`, `mx_noise_vec3`, `mx_fractal_noise_float`, `mx_fractal_noise_vec3`, `mx_cell_noise_float`, `mx_worley_noise_float`, `mx_worley_noise_vec2`, `mx_worley_noise_vec3`) — accept either a bare position node or a `pos.mul(scale)` / `mul(pos, scale)` expression as the first arg. The parser unwraps the `.mul(scale)` chain into the `scale` value (round-trip with `graphToCode`'s `${posExpr}.mul(${scaleExpr})` emit).
- **UV tiling**: `mul(uv(), vec2(x, y))` pattern detected and converted to a single UV node with tiling values
- **Property nodes**: `uniform(value)` calls → `property_float` nodes with variable name as property name
- **Three.js editor flat form**: `output = expr;` top-level assignments and `.toVar()` / `.toConst()` passthrough chains

### TSL Code Authoring Constraints

When writing TSL code to paste into FastShaders (or when generating code for an AI/LLM to paste), the following constraints must be respected for the code→graph parser (`codeToGraph.ts`) to produce a correct graph and a working GPU preview:

1. **Every intermediate result must be a named `const` variable.** The `VariableDeclarator` visitor only processes `const x = someCall(...)` statements. Inline/nested call expressions as function arguments (e.g. `smoothstep(float(0.01), float(0.35), x)`) are **silently dropped** — the argument processing loop handles `Identifier` (variable references), `MemberExpression` (`.x`/`.y`), and `NumericLiteral`, but not `CallExpression`. This means:
   - **Bad**: `smoothstep(float(0.01), float(0.35), x)` → first two args lost, compiles as `smoothstep(0, 0, x)` → WGSL error
   - **Good**: `const lo = float(0.01);` then `const hi = float(0.35);` then `smoothstep(lo, hi, x)`
   - **Also good**: `smoothstep(0.01, 0.35, x)` — raw numeric literals work directly

2. **Prefer function-form calls over method chains on non-variable objects.** Method chains like `a.mul(b)` work when `a` is a named variable (the parser reads `objectVarName`). But `float(0.45).sub(x)` fails because the callee object is a `CallExpression`, not an `Identifier` — `objectVarName` is undefined, so the first operand is lost. Break chains into named steps:
   - **Bad**: `float(0.45).sub(softness)` → first operand lost
   - **Good**: `const base = float(0.45);` then `base.sub(softness)`
   - **Also good**: `sub(0.45, softness)` — function form with literal

3. **Use raw numeric literals instead of `float()` wrappers where possible.** `mix(8, 512, t)` is cleaner and guaranteed to parse (the literal handler catches `NumericLiteral`). `float()` works too, but only if the result is stored in a named variable first.

4. **The `Fn` wrapper is silently skipped.** `const shader = Fn(() => { ... })` is the canonical output format from `graphToCode`. `codeToGraph` explicitly skips `Fn` calls (no unknown node, no warning) — Babel's `traverse` already enters the arrow function body and processes its contents via the inner `VariableDeclarator` and `ReturnStatement` visitors.

5. **`uniform()` calls must be inside the `Fn` body.** Property uniforms declared outside the arrow function (e.g. at module top level) won't be traversed by the `VariableDeclarator` visitor inside the `Fn` body, and won't create `property_float` nodes. Place them as the first statements inside `Fn(() => { ... })`.

6. **Function arguments that are supported**: `Identifier` (variable name), `MemberExpression` (`var.x`), `NumericLiteral`, `UnaryExpression` (negative numbers like `-0.5`), `StringLiteral`. Anything else (call expressions, binary expressions, template literals) as a direct argument is silently ignored.

7. **Method chains on named variables are fine.** `coords.mul(cellScale)` works because `coords` resolves to a node ID via `objectVarName`. The chain creates a `mul` node with the object wired to the first input. Multiple chaining (`a.mul(b).add(c)`) works only if each step is a named variable:
   - **Bad**: `coords.mul(cellScale).add(offset)` → `.add()` sees a `CallExpression` object, not a variable
   - **Good**: `const scaled = coords.mul(cellScale);` then `scaled.add(offset)`

8. **MemberExpression assignments are silently dropped.** `const z = positionGeometry.z;` is a `MemberExpression` initializer, NOT a function call — the `VariableDeclarator` visitor ignores it entirely. The variable `z` never enters `varToNodeId`, and every downstream reference silently disconnects. Workaround: assign the *parent* object to a named variable first, then use swizzle as function arguments:
   - **Bad**: `const z = positionGeometry.z;` then `mul(z, 2)` → `z` undefined, argument lost
   - **Good**: `const pos = positionGeometry;` then `mul(pos.z, 2)` → creates split node, wires `.z` output

9. **`resolveMemberExpr` does not call `ensureBareInputNode`.** When `someVar.x` appears as a function argument, `resolveMemberExpr` looks up `someVar` in `varToNodeId`. If `someVar` is a built-in input like `positionGeometry` that was never explicitly declared, the lookup returns `null` and the argument is **silently dropped**. Unlike the `Identifier` handler (which falls back to `ensureBareInputNode` to auto-materialise input nodes), `resolveMemberExpr` has no such fallback. Always declare built-in inputs with an alias first: `const pos = positionGeometry;` before using `pos.x`, `pos.y`, `pos.z`.

10. **`scriptToTSL` only handles shaderloader script format.** The "Load Script" button in the TSL editor runs `scriptToTSL()` which expects `export default function(params) { ... }` + `export const schema = { ... }` format. Files already in `Fn()` form will have their entire body stripped because the `Fn(` keyword triggers the nested-Fn skip logic (line 155). For pasting code directly into the TSL editor, use the canonical `Fn()` format and click Save — do NOT use "Load Script".

**Summary rule of thumb**: Write TSL code in SSA-like form — one operation per line, every result named, arguments are either variable names or numeric literals. For built-in inputs used with swizzle (`.x`, `.y`, `.z`), always declare an alias first (`const pos = positionGeometry;`). This is the same style that `graphToCode` emits, so round-tripping is lossless.

### Zustand Store Shape

```typescript
{
  nodes: AppNode[], edges: AppEdge[]           // Graph data
  code: string, codeErrors: ParseError[]       // Generated code + errors
  totalCost: number                            // Connected node cost sum
  syncSource: 'graph'|'code'|'initial'         // Loop prevention
  syncInProgress: boolean, codeSyncRequested: boolean
  previewCode: string                          // Last code snapshot used by the preview iframe (separate from `code` so typing doesn't thrash the iframe)
  history: HistoryEntry[], historyIndex: number, isUndoRedo: boolean  // 50-entry undo/redo
  splitRatio: number, rightSplitRatio: number  // Panel sizes (localStorage)
  shaderName: string, selectedHeadsetId: string // Toolbar state
  contextMenu: {
    open: boolean, x: number, y: number,
    type: 'canvas' | 'node' | 'shader' | 'edge' | 'group',
    nodeId?: string, edgeId?: string,
    sourceNodeId?: string, sourceHandleId?: string  // for handle-drop AddNodeMenu
  }
  // Groups
  savedGroups: SavedGroup[]                       // user-saved group library (localStorage `fs:savedGroups`)
  // Canvas + editor look-and-feel
  nodeEditorBgColor: string                       // React Flow canvas background hex
  codeEditorTheme: 'vs' | 'vs-dark'               // Monaco theme
  costColorLow: string, costColorHigh: string     // cost gradient endpoints
}
```

---

## Export Pipeline

### Shared TSL Code Processor (`tslCodeProcessor.ts`)

Common processing logic used by `tslToPreviewHTML.ts` (and indirectly by the other pipelines):

- **`collectImports(code, excludeFn?)`** — extracts `three/tsl` import names (returns `{ tslNames }`)
- **`extractFnBody(code, tslNames)`** — extracts the body inside `Fn(() => { ... })`
- **`fixTDZ(body, tslNames)`** — fixes Temporal Dead Zone issues:
  1. Removes self-referencing bare declarations (`const X = X;`)
  2. Renames locals that shadow imported function names (`const color = color(...)` → `const _color = color(...)`) — regex uses `(?!\s*[:(])` to preserve object property keys in return statements
  3. Fixes bare numeric first-arg in MaterialX noise calls (`mx_noise_float(0)` → `mx_noise_float(uv())`)
- **`parseBody(body, tslNames)`** — splits into definition lines and output channels (simple or multi-channel return)
- **`AFRAME_GEO`** / **`CHANNEL_TO_PROP`** — shared constants

### A-Frame HTML Export (`tslToAFrame.ts`)

Generates a self-contained copy-paste `.html` using the shaderloader:

1. Calls `tslToShaderModule()` to generate the shader module code (same as Script tab)
2. Strips header comments and embeds the module as an inline blob URL
3. Loads both CDN scripts: `aframe-171-a-0.1.min.js` (IIFE bundle) + `a-frame-shaderloader-0.3.js`
4. Applies shader via `<a-entity shader="src: blobUrl">` — the shaderloader handles all processing (TDZ fixes, import resolution, property uniforms) at runtime
5. A-Frame scene with geometry, lights, and optional rotation animation
6. Properties and material settings are handled by the shaderloader from the embedded module's `export const schema` and Object API return

### Shader Script Export (`tslToShaderModule.ts`)

Generates a `.js` ES module compatible with the a-frame-shaderloader component. Also reused by `tslToAFrame.ts` for the A-Frame HTML export.

1. Header comments with HTML setup instructions, property attribute examples, and runtime update docs
2. Strips `Fn` from three/tsl imports; bare import (`'three/tsl'`) — also usable directly with Three.js
3. Converts `const shader = Fn(() => {` to `export default function(params) {` (when properties exist) or `export default function() {` (no properties)
4. Converts multi-channel return keys to shaderloader Object API names (`color` → `colorNode`, `position` → `positionNode`, etc.)
5. Accepts optional `materialSettings` and `properties` (PropertyInfo[]) — wraps position channel with displacement logic (same normal/offset modes), injects `positionLocal`/`normalLocal` into the `three/tsl` import line when needed
6. **Property support**: Emits `export const schema = { name: { type: 'number', default: value } }` so the shaderloader reads proper defaults; replaces `const NAME = uniform(VALUE)` with `const NAME = params.NAME`; removes `uniform` from imports when all uniform calls are replaced by params references
7. Removes `export default shader;`
8. The shaderloader handles TDZ fixes, missing import injection, and specifier resolution at runtime

### Preview HTML (`tslToPreviewHTML.ts`)

Generates HTML for the in-app preview iframe:

1. Uses `tslCodeProcessor` to extract imports, body, fix TDZ, and parse channels.
2. **Property uniform rewrite**: `convertToShaderModule()` rewrites every `const N = uniform(V)` line to `const N = params.N`, captures `{N: V}` defaults into a schemaEntries map, exports an explicit `export const schema`, and switches the function signature to `function(params)` (only when there are uniforms — otherwise it stays `function()`). Without this, the shaderloader's auto-detected `_propertyUniforms` would be a *separate* uniform instance from the one wired into the material, and the slider overlay would be talking to the wrong object.
3. Accepts `materialSettings` via `PreviewOptions` — applies displacement wrapping (same normal/offset logic) + transparent/side/alphaTest settings.
4. **Geometry**: `isObjGeometry(geometry)` branches on primitive vs OBJ. Primitives go through `buildGeoAttr(geometry, subdivision)` which clamps subdivision to `[1, 256]` and applies it to the appropriate per-primitive segment fields. OBJ models (`teapot`, `bunny`) are emitted as `<a-entity obj-model="obj: url(${absUrl})" fit-bounds="size: 1.6">`, with `getModelUrl()` resolving `${origin}${BASE_URL}models/<file>` so the blob iframe can fetch the asset cross-origin-free. The `fit-bounds` A-Frame component is registered via the **`FIT_BOUNDS_SCRIPT`** module-level template literal (single `lines.push` call). On `model-loaded` it runs four post-processing steps per Mesh:
   1. **Merge vertices by quantized position** (4-decimal precision) — `OBJLoader` returns *non-indexed* geometry where every triangle owns its own copies of its 3 vertices, so a position shared by N faces becomes N duplicate vertices each with its own face normal. Per-vertex displacement (`positionLocal + normalLocal * val`) then pushes each duplicate along *its own* normal and the surface splits open. The merge step rebuilds the geometry as indexed (handles both pre-indexed and non-indexed input), discarding old normals and UVs since both index into the old vertex layout.
   2. **`computeVertexNormals`** on the merged geometry — produces averaged smooth normals at every shared vertex regardless of whether the source file had normals. Both bunny and teapot OBJs lack normals; even files that have them get recomputed since the layout changed.
   3. **Auto-detect inverted winding** — the Stanford bunny OBJ uses CW triangles, so `computeVertexNormals` produces inward-facing normals and displacement pushes the surface *into* the mesh. We sample ~200 vertices and compare each `(vertex − centroid) · normal`; if a majority are negative, the winding is reversed. Fix: swap the 2nd and 3rd index of every triangle, then recompute normals. Auto-handles any future model with bad winding without hardcoding per-model flips.
   4. **Spherical UVs** generated from each vertex's direction relative to the geometry center, then a final recenter + uniform rescale so the longest axis equals `data.size` — bunny (mm) and teapot (tens of units) frame near the primitives.

   Always emitted (even for primitive previews) — inert if no entity attaches `fit-bounds="..."`. (The standalone export pipeline `tslToAFrame.ts` only supports primitives — OBJ geometries are not threaded through and would fall back to sphere if they were.)
5. **Lighting**: `studio` (4-light three-point rig), `moon` (single cool directional + faint ambient), or `laboratory` (white ambient only).
6. **Per-geometry rotation**: `plane` → `0 0 0` (faces camera); `bunny` → `0 25 0` (upright); `teapot` → `15 35 0` (slight tilt to read the spout/handle); other primitives → `45 45 0`.
7. **Animation**: Y-axis turntable (`0 360 0`) for sphere/cube/teapot/bunny, Z-axis spin (`0 0 360`) for plane. The shaded entity is wrapped in a **spin parent** that owns the `animation` attribute (`from: 0 0 0; to: 0 360 0`); the **child** carries the static tilt (`rotationAttr`) and the shader. Splitting the two is what keeps the loop seamless: if the spin animation lived on the same entity as the tilt, A-Frame would tween componentwise from the current value (e.g. `45 45 0`) to `to` (`0 360 0`), gradually flattening the X tilt and only spinning Y by `+315°` before snapping back to the start on every loop — visible as a slight jump on each full rotation. With the parent/child split, the parent has no tilt of its own so its local Y/Z is the world Y/Z, the animation cleanly tweens `0→360`, and `0 360 0 ≡ 0 0 0` at loop boundary so there's nothing to snap. The `id="preview-entity"` stays on the child since that's where the shader component lives (the bridge looks it up by id) and where `fit-bounds` needs the OBJ entity for `model-loaded`.
8. **Iframe ↔ parent bridge**: emitted as the **`BRIDGE_SCRIPT_TEMPLATE`** module-level template literal with a `__SAVED_CAM__` placeholder replaced by a JSON literal at emit time. Polls for shaderloader readiness → posts `fs:preview-ready` with the uniform name list, listens for `fs:uniform`/`fs:reset-camera`, polls camera position and posts `fs:camera` only on change. Saved camera position is embedded as `window.__savedCameraPos` and applied **after** orbit-controls initializes (not via `initialPosition`, so `controls.reset()` still snaps to the original `0 0 8`).
9. Uses A-Frame IIFE bundle with `a-frame-shaderloader` for rendering.
10. Error display div for runtime errors.

Both `FIT_BOUNDS_SCRIPT` and `BRIDGE_SCRIPT_TEMPLATE` are kept as raw template literals (using `<\/script>` to escape the closing tag) rather than `lines.push(...)` chains — they're large blocks of static iframe-side JS with at most one substitution, and the template-literal form keeps the source readable as JS instead of as a string-concat ladder.

---

## Node System

### Node Registry (~55 nodes in 10 categories — `unknown` is the 10th, hidden from search)

| Category          | Nodes                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| **Input** (8)     | positionGeometry, normalLocal, tangentLocal, time, screenUV, uv, property_float, slider    |
| **Type** (6)      | float, int, vec2, vec3, vec4, color                                                       |
| **Arithmetic** (4)| add, sub, mul, div                                                                        |
| **Math (unary)**  | sin, cos, abs, sqrt, exp, log2, floor, round, fract, oneMinus (Invert) — 10 total          |
| **Math (binary)** | pow, mod, clamp, min, max                                                                 |
| **Interpolation** (4) | mix, smoothstep, remap, select                                                        |
| **Vector** (7)    | normalize, length, distance, dot, cross, split, append                                     |
| **Noise** (8)     | perlin, perlinVec3, fbm, fbmVec3, cellNoise, voronoi, voronoiVec2, voronoiVec3 (all MaterialX-backed) |
| **Color** (2)     | hsl, toHsl                                                                                |
| **Output** (1)    | output (color, normal, displacement, opacity, roughness, emissive inputs + materialSettings) |
| **Unknown** (1, hidden) | `unknown` — round-trip preservation for unrecognized TSL functions parsed from code |

### MaterialX Noise Nodes

8 noise variants share the same parameter convention:

- **Default values**: `{ pos: 'positionGeometry', scale: 1.0 }` — `pos` is a tslRef-style port (hidden by default, exposed via NodeSettingsMenu), `scale` is a numeric input editable inline.
- **Backing TSL functions** (all from `three/tsl`):
  - `perlin` → `mx_noise_float`, `perlinVec3` → `mx_noise_vec3` *(MaterialX Perlin-style; no `mx_perlin_noise_*` exists in three.js — `mx_noise_*` is the equivalent)*
  - `fbm` → `mx_fractal_noise_float`, `fbmVec3` → `mx_fractal_noise_vec3`
  - `cellNoise` → `mx_cell_noise_float`
  - `voronoi` → `mx_worley_noise_float`, `voronoiVec2` → `mx_worley_noise_vec2`, `voronoiVec3` → `mx_worley_noise_vec3`
- **Code generation** ([graphToCode.ts](src/engine/graphToCode.ts)): Dedicated `def.category === 'noise'` branch placed **before** the generic `inputs.length === 0 && defaultValues` branch (otherwise the generic branch would silently emit `mx_noise_float(positionGeometry)` and drop `scale`). Resolves `pos` from the exposed-port edge or stored value (default `positionGeometry`), then chains scale via `pos.mul(scale)` only when `scale !== 1`. Emits `const noise1 = mx_noise_float(positionGeometry.mul(2.5));` and imports `positionGeometry` automatically.
- **Live compilation** ([graphToTSLNodes.ts](src/engine/graphToTSLNodes.ts)): Per-variant factories — `(inputs, values) => mx_noise_float(pos.mul(s))` etc. — read `inputs.pos` (or default `positionGeometry`) and `values.scale`.
- **CPU thumbnails** ([noisePreview.ts](src/utils/noisePreview.ts)): `perlin2D`, `fbm2D`, `cellNoise2D`, `voronoi2D` — perlin/fBm output `~[-1,1]` is remapped to `[0,1]` for display. PreviewNode's `NOISE_TYPES` set must include all 8 variants for the canvas to render.
- **Range eval**: All variants have a stable `[0..1]` range entry in `evaluateNodeRange` (perlin/fBm display-remapped, cell/voronoi naturally 0..1).

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
- **Shape-aware code generation**: The emitted constructor is chosen dynamically from the sum of the input component counts (computed via `getComponentCount` in [cpuEvaluator.ts](src/engine/cpuEvaluator.ts) — which falls back to `evaluateNodeOutput(source, nodes, edges, 0).length`). 2 → `vec2(a,b)`, 3 → `vec3(a,b)`, 4 → `vec4(a,b)`. Unconnected inputs count as 1. Total is clamped to `[2,4]`. This matters for chains like `append(vec2, float)` which must become `vec3` — previously they were truncated to `vec2` and lost the trailing channel, producing the wrong shader output on the GPU.
- **Code parsing**: `vec2(ref1, ref2)` where at least one arg is a variable reference or member expression creates an `append` node (not a `vec2` type constructor). Literal-only `vec2(1, 2)` still creates a `vec2` type node. (vec3/vec4 parsing of append is handled symmetrically in [codeToGraph.ts](src/engine/codeToGraph.ts))
- **TSL compilation** ([graphToTSLNodes.ts](src/engine/graphToTSLNodes.ts)): Before invoking the factory, the loop computes `_appendSize` from `getComponentCount` on each input edge and stashes it into the `values` object. The append factory reads `values._appendSize` and picks `tslVec2` / `vec3` / `tslVec4` accordingly.
- **CPU evaluation**: Concatenates channel arrays (`[...a, ...b]`) — e.g., float+float→vec2, vec2+float→vec3
- **Use case**: Convert UV (vec2) to vec3 for noise `pos` input by appending a Z component, or pack arbitrary scalars into a vector
- **Searchable**: by "append", "combine", or "join"

### Invert Node (`oneMinus`)

Inverts a 0–1 value via TSL's `oneMinus` builtin:

- **Registry**: `tslFunction: 'oneMinus'`, category `'math'`, single `x` input, label `'Invert (oneMinus)'`, description mentions `invert`, `complement`, `negate` so search matches those too
- **TSL compilation**: `oneMinus(x)` (imported from `three/tsl`)
- **CPU evaluation**: Component-wise `1 - x`
- **Why not just multiply by -1**: `mul(-1, x)` for a 0–1 value clamps to 0 (negative color values render as black), not the visual inversion users expect. `oneMinus` gives `1 - x`, the correct inverse.

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
- **`preview`** — Noise nodes with animated CPU canvas thumbnail (PreviewNode.tsx) — used by all 8 MaterialX noise variants
- **`mathPreview`** — Math function nodes with scrolling waveform visualization (MathPreviewNode.tsx)
- **`clock`** — Time node with animated analog clock face (ClockNode.tsx)
- **`output`** — Output sink with two sections: Pixel Shader (color, roughness, emissive, normal, opacity) and Vertex Shader (displacement), plus `materialSettings` for export config (OutputNode.tsx)
- **`group`** — Selection group container (GroupNode.tsx) — owns members via `parentId`, has no registry entry, no shader semantics. Collapsible into a pill with synthetic boundary handles. See the **Groups** section for details.

### Asset Browser (ContentBrowser + NodePreviewCard)

The asset browser is a horizontal scrollable drawer at the bottom of the node editor, showing all available nodes grouped by category tabs. The Noise category lists all 8 MaterialX noise variants sorted by GPU cost ascending.

- **Search bar** — text input before the tab row, filters nodes by label, type, or description. Visible on all tabs (except Saved Groups which shows saved group cards).
- **Folder-style tabs** — styled like the CodeEditor TSL/Script tabs (top/side borders, rounded top corners, `bottom: -1px` overlap so active tab merges with content). Font size 17px, bold (600 weight). Each tab has a tinted category-color background: ~8% opacity when inactive, ~20% when active. The items area below also tints with the active category color at ~10% opacity. A `CAT_HEX` map in ContentBrowser holds raw hex values (the main `CATEGORY_COLORS` uses CSS variables which can't take alpha suffixes).
- **Scrollbar hidden** on the items row (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`). Horizontal scrolling works via vertical-to-horizontal wheel conversion (same listener on both the tabs row and the items row).

**NodePreviewCard** dispatches to visual variants based on `getFlowNodeType(def)` and `def.type`, matching the editor node appearance:

| Flow Type | Renderer | Visual |
|-----------|----------|--------|
| `'shader'` | ShaderCardContent | Header + port rows + fake handle dots (generic) |
| `'mathPreview'` | MathCardContent | Header + 72x72 waveform canvas + input/output dots |
| `'preview'` (noise) | NoiseCardContent | Header + 96x96 pixelated CPU noise canvas + output dot |
| `'clock'` | ClockCardContent | Header + 56x56 circular clock face + output dot |
| `def.type === 'slider'` | SliderCardContent | Header + track/fill/thumb slider + min/value/max labels + output dot |
| `'color'` | ColorCardContent | 28x28 color circle + contrast-aware label + output dot |

- **Cost coloring**: NodePreviewCard reads `costColorLow`/`costColorHigh` from the zustand store and passes them to `getCostColor()`/`getCostTextColor()`, ensuring consistent cost-based coloring across editor nodes, MiniMap, and content browser.
- **Math/noise/clock previews**: CPU-rendered once on mount using existing `renderMathPreview()`, `renderNoisePreview()`, and ClockNode drawing code (frozen at mount time).
- **All sub-renderers** are proper React components (not called as functions) so hooks work correctly.
- **Drag-to-create**: All cards are draggable; dropping on the canvas creates the corresponding node.

### ShaderNode Vector Display

ShaderNode handles Vector3/Vector2 parameters with grouped inputs:

- Detects `_x`/`_y`/`_z` suffixed keys in defaultValues and groups them into `vec3` or `vec2` rows
- Each vector row shows: base key label + 2-3 compact `DragNumberInput` controls
- Non-port settings (colors, vec3, vec2) are collected and appended as extra rows after input ports

### Preview Nodes (Noise)

Noise category nodes (all 8 MaterialX variants) render a 96×96 canvas showing their generated pattern:

- **CPU noise** ([noisePreview.ts](src/utils/noisePreview.ts)): `perlin2D`, `fbm2D`, `cellNoise2D`, `voronoi2D`. `sampleNoise()` dispatches by registry type. Perlin/fBm output is `~[-1,1]` and remapped to `[0,1]` for display; cell/voronoi are naturally `[0,1]`.
- **`NOISE_TYPES` set in [PreviewNode.tsx](src/components/NodeEditor/nodes/PreviewNode.tsx)** must include all 8 registry types (`perlin`, `perlinVec3`, `fbm`, `fbmVec3`, `cellNoise`, `voronoi`, `voronoiVec2`, `voronoiVec3`) — the canvas useEffect early-returns for any type not in the set, so missing entries silently produce blank thumbnails.
- **Upstream-aware inputs**: Uses `evaluateNodeScalar()` from `cpuEvaluator.ts` to resolve connected input values (e.g., a `float(3)` node connected to `scale` updates the preview).
- **Time-conditional animation**: Only animates when a Time node is connected upstream (per-port BFS via `hasTimeUpstream`). When time feeds `pos`, the preview scrolls; otherwise it renders once.

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

### CPU Graph Evaluator (cpuEvaluator.ts)

CPU-side evaluator that walks the node graph and computes values using JS math equivalents. Used by `MathPreviewNode` (deterministic eval), `EdgeInfoCard` (range eval), and codegen (shape inference for `append`).

#### Deterministic eval

- **`evaluateNodeOutput(nodeId, nodes, edges, time)`** → `EvalResult` (multi-channel `number[]` or `null`)
- **`evaluateNodeScalar(nodeId, nodes, edges, time)`** → first channel as `number | null`
- **Multi-channel**: Returns `[x]` for scalar, `[x,y]` for vec2, `[r,g,b]` for vec3/color, `[x,y,z,w]` for vec4
- **Component-wise broadcasting**: Operations like scalar × vec3 broadcast shorter to longer
- **Cycle guard** ([cpuEvaluator.ts:151-156](src/engine/cpuEvaluator.ts#L151-L156)): Before recursing, `evaluate` writes a `null` sentinel into the cache for the current `nodeId`. Any cyclic back-edge hits the sentinel via the `cache.has(nodeId)` check at the top and returns null instead of recursing forever. The real result overwrites the sentinel at the end of the function. Without this guard, a graph cycle (which `topologicalSort` warns about but still produces output for) would crash `<TypedEdge>` with `Maximum call stack size exceeded` on every render and blank out the entire edge layer.
- **Strict null propagation** (important): When an input port is connected to an upstream node, the upstream result is authoritative — including `null`. The `channelInput` helper does NOT silently fall back to the inline value when an edge exists. This was a bug fix: previously `sub(perlinNoise, 0.5)` would compute `sub(0, 0.5) = -0.5` (length 1) because perlinNoise returned null and channelInput substituted the inline default, fooling the visualization layer into thinking a 3-channel chain was a single float.
- **Supported nodes**: time, float/int/property_float/slider, screenUV, uv (with tiling/rotation), vec2/vec3/vec4/color constructors, all arithmetic (add/sub/mul/div), all unary math (sin/cos/abs/sqrt/exp/log2/floor/round/fract/oneMinus), binary math (pow/mod/min/max/clamp), interpolation (mix/smoothstep/remap/select), vector ops (length/distance/dot/normalize/cross/append), all 8 MaterialX noise variants (sampled at UV center, scaled)
- Returns `null` for unevaluable nodes (positionGeometry, normalLocal, tangentLocal, anything downstream of one — evaluation can't sample geometry attributes on the CPU)

#### Static shape inference

- **`getNodeOutputShape(nodeId, nodes, edges)`** → `number` (1–4). Walks the graph using port type info and broadcast rules to compute the *expected* channel count even when eval returns null. Has its own `visited` set for cycle protection. Concrete output port types (vec2/vec3/vec4/color/float/int) win immediately; for `'any'` outputs it sums input shapes for `append` and takes the max otherwise (broadcast rule: vec3 + scalar = vec3).
- **`getComponentCount(nodeId, nodes, edges)`** → `number` (1–4). Tries `evaluateNodeOutput` first; falls back to `getNodeOutputShape` when eval returns null. Used by [graphToCode.ts](src/engine/graphToCode.ts) and [graphToTSLNodes.ts](src/engine/graphToTSLNodes.ts) to pick the right vector constructor for shape-dependent nodes like `append`.

#### Range evaluation

The deterministic evaluator can't sample procedural textures, but the EdgeInfoCard still wants to show *something* useful. `evaluateNodeRange` computes per-channel min/max bounds analytically.

- **`evaluateNodeRange(nodeId, nodes, edges, time?)`** → `RangeResult | null` where `RangeResult = { min: number[]; max: number[] }`
- **Resolution order per node**:
  1. **uv/screenUV** → `[0..1, 0..1]` (more useful than the (0.5, 0.5) sample point).
  2. **Noise variants** — all 8 MaterialX noise types declare a stable `[0..1]` range (perlin/fBm display-remapped, cell/voronoi naturally 0..1).
  3. **Deterministic fallback** — calls `evaluateNodeOutput(time)`. When it succeeds the range is degenerate (min === max), which is exactly right for constants and time-driven inputs.
  4. **Interval propagation** — for nodes whose eval returned null (chain through positionGeometry/normalLocal), propagates ranges using interval arithmetic. Implemented for `add`, `sub`, `mul`, `div`, `oneMinus`, `abs`, `sin`, `cos`, `fract`, `smoothstep`, `sqrt`, `floor`, `round`, `min`, `max`, `clamp`, `mix`, `remap`, `select`, `vec2/3/4`, `append`, `normalize`, `length`, `distance`. `div` falls back to `[0, 1]` if the divisor spans zero (would otherwise be unbounded). `mix`/`select` return the union of the two branches (conservative — doesn't try to weight by `t`).
  5. Anything else → `null` (the EdgeInfoCard renders the `0..1` placeholder).
- **Time forwarding**: range eval forwards `time` to the deterministic fallback, so a slider connected to `time` updates live in the card.
- **`portRange(portId, fallback)`** treats unconnected ports as a degenerate `{min:[v], max:[v]}` from inline values, and treats connected-but-unknown upstream as `[0..1]` (conservative normalized assumption).

---

## Type System

**Data types**: `float | int | vec2 | vec3 | vec4 | color | any`

Each type has a distinct color for handles and edges:

- float: `#3366CC` (blue), int: `#20B2AA` (teal), vec2: `#4A90E2` (sky), vec3: `#E040FB` (magenta), vec4: `#AB47BC` (purple), color: `#E8A317` (gold), any: `#607D8B` (slate)

**AppNode union**: `ShaderFlowNode | ColorFlowNode | PreviewFlowNode | MathPreviewFlowNode | ClockFlowNode | OutputFlowNode | GroupFlowNode`

---

## Edge System (TypedEdge.tsx)

### Visual Style

- **Channel-count-driven rendering**: The visualization is keyed off the *actual* number of channels flowing through the edge, not the static type. 1 channel = single black line, 2 channels = 2 parallel lines (R, G), 3 channels = 3 lines (R, G, B), 4 channels = 4 lines (R, G, B, A). Color-typed nodes render as RGB because they carry 3 channels, not because they're tagged `'color'`.
- **Runtime shape resolution**: Every render, TypedEdge takes the **max** of two signals: (1) the live `evaluateNodeOutput(source, nodes, edges, 0)` length, and (2) the static `getNodeOutputShape(source, nodes, edges)` walk. Each fills the gaps of the other:
  - Live eval handles `any → any` arithmetic broadcasting (e.g. `mul(float, vec2)` where the arithmetic node's port is `'any'` and the static walker would say `float`).
  - Static shape handles chains downstream of unevaluable nodes (e.g. `perlinNoise → sub`): eval returns null because the texture is unevaluable, but the static walker still resolves sub's output to vec3 because perlinNoise's output port is `color`.
  - Final `count = clamp(max(evalLen, shapeLen, 1), 1, 4)`. The older `LINE_COUNT[dataType]` lookup is gone.
- **Count-keyed color maps** in [colorUtils.ts](src/utils/colorUtils.ts):
  - `COUNT_EDGE_COLORS` — saturated, used on edge paths. `1: ['#000000']`, `2: ['#ff4444','#44dd44']`, `3: [...,'#4488ff']`, `4: [...,'#dddddd']`.
  - `COUNT_CARD_COLORS` — lighter versions for the EdgeInfoCard.
  - `COUNT_LABELS` — `1: ['']`, `2: ['R','G']`, `3: ['R','G','B']`, `4: ['R','G','B','A']`. All edge UIs now use RGB labels instead of the older type-specific X/Y/Z/W / R/G/B split.
  - The older `EDGE_CHANNEL_COLORS` / `CARD_CHANNEL_COLORS` / `CHANNEL_LABELS` type-indexed maps are gone.
- **Parallel offset** ([TypedEdge.tsx](src/components/NodeEditor/edges/TypedEdge.tsx)): `GAP = 3.5 / 3` — tight spacing so multi-channel edges read as a single ribbon rather than divergent wires.
- **Dashes**: `strokeDasharray="4 0.5"` when `count > 1`, solid when `count === 1`.
- **Stroke width** narrows with channel count: 1-ch = 1.5 (or 2 when selected), 2-ch = 1.2, 3-ch = 1, 4-ch = 0.8.
- **Selected state**: Glow effect via `drop-shadow` filter keyed on the line color.
- **Static type resolution** (`resolveDataType`) is still used for `baseColor` (the type-token color from CSS vars), which matters for the 1-channel fallback path.

### EdgeInfoCard (Live Value Display)

When an edge is selected, an info card appears at the midpoint showing live values **as ranges**, not just point samples — so chains downstream of procedural textures (e.g. perlinNoise) still display useful information.

- **Range-based**: State is `range: RangeResult | null` populated by `evaluateNodeRange(sourceId, nodes, edges, t)` from [cpuEvaluator.ts](src/engine/cpuEvaluator.ts). Re-runs in a `requestAnimationFrame` loop when a Time node is upstream; otherwise computed once and cached until the node graph changes (effect dep on `nodes`/`edges`, so editing a perlinNoise color in the node settings updates the displayed range live).
- **Per-channel display**: Each channel renders as `LABEL VALUE` where:
  - `LABEL` is colored R/G/B/A from `COUNT_CARD_COLORS` (1-channel has no label).
  - `VALUE` is `lo.toFixed(2)` when `|hi - lo| < 0.005` (degenerate / point value), `${lo.toFixed(2)}..${hi.toFixed(2)}` when bounded (e.g. `0.00..1.00`), or the placeholder `0..1` when the channel is unknown or unbounded (`Infinity`).
- **Vertical layout**: `.edge-info-card__values` is a column flex container — channels stack top-to-bottom (R / G / B). Each row is itself a horizontal flex with the label on the left and the value on the right.
- **Channel count**: `max(range?.min.length ?? 0, getNodeOutputShape(source, nodes, edges), 1)`, clamped to `[1,4]`. Same idea as TypedEdge: prefer the range result, fall back to static shape inference for nodes neither eval nor range propagation can handle (e.g. `length`, `distance` chains).
- **Visual style**: Dark gray background `#2a2a2a` (set in [EdgeInfoCard.css](src/components/NodeEditor/edges/EdgeInfoCard.css)), white value text (`.edge-info-card__num` color is explicitly `#ffffff`), preserved colored R/G/B/A labels via inline styles. The previous type-colored background and the data-type label (`FLOAT` / `VEC3` / etc.) were both removed — the visualization itself conveys the shape, and the dark gray reads cleanly against any background regardless of the edge type.

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
- **Ctrl+G**: Group selected (≥2 non-group nodes); **Ctrl+Shift+G** ungroups any selected group
- **Delete/Backspace**: Remove selected nodes (and their connected edges) and/or selected edges. React Flow's built-in delete is disabled (`deleteKeyCode={null}`); the manual handler in `NodeEditor.tsx` reads both `n.selected` and `edge.selected`. Deleting a group dissolves it first (children lifted) so they aren't orphaned with a dangling `parentId`.

### Mouse Interactions

- **Left-drag on canvas**: Box selection (partial overlap mode — `SelectionMode.Partial`)
- **Middle/right-drag on canvas**: Pan (works even over selected-node regions — a capture-phase `mousedown` handler temporarily strips the `nopan` class from React Flow's `__nodesselection` wrapper so d3-zoom's filter lets the event through)
- **Scroll**: Zoom (0.1x – 3x range)
- **Right-click canvas**: Opens AddNodeMenu (searchable node palette + "Group Selection" entry when ≥2 non-group nodes are selected)
- **Right-click box selection**: Opens AddNodeMenu (same as canvas — shows "Group Selection" at top when ≥2 groupable nodes are selected). Uses React Flow's `onSelectionContextMenu`.
- **Right-click node**: Opens NodeSettingsMenu (edit values, duplicate, delete)
- **Right-click output node**: Opens ShaderSettingsMenu (cost, ports, displacement, material, uniforms)
- **Right-click group**: Opens GroupSettingsMenu (rename, recolor, save to library, ungroup)
- **Right-click edge**: Opens EdgeContextMenu (delete)
- **Drag from handle → release on empty space**: Opens AddNodeMenu at drop position
- **Drop node on edge**: Inserts node between source and target (bezier curve proximity detection, `CONNECTION_RADIUS` = 40px threshold, shared with `connectionRadius` prop). Works both for existing nodes dragged on the canvas **and** for new nodes dragged from the asset browser.

### Drop-on-Edge Insertion

When a node is dragged and dropped near an existing edge:

1. Samples 20 points along the cubic bezier curve between source/target (via `bezierDist()`)
2. `findNearestEdge()` returns the closest edge within `CONNECTION_RADIUS` (40px)
3. `tryInsertOnEdge()` removes the original edge and creates two new edges through the dropped node
4. Uses first input and first output ports of the dropped node's registry definition

**Works for two paths:**
- **Existing nodes** — `onNodeDrag` highlights the candidate edge (thick stroke via `fs-edge-drop-target` CSS class, applied directly to the DOM via ref — not store — to avoid rerenders on every drag frame). `onNodeDragStop` calls `tryInsertOnEdge()`.
- **Asset browser drags** — `onDragOver` converts screen coords to flow-space via `screenToFlowPosition` and highlights the candidate edge. `onDrop` creates the node via `addNode` then calls `tryInsertOnEdge()`.

Both paths share the same module-level helpers (`getNodeSize`, `bezierDist`, `findNearestEdge`, `tryInsertOnEdge`) to avoid duplication.

History is pushed once in `onNodeDragStop` (covering both the position change and any edge insertion). Click-only events (no drag) are skipped via `DRAG_HISTORY_THRESHOLD = 2px` so the undo buffer isn't polluted with no-ops.

### Anti-Overlap

After dropping a node, `onNodeDragStop` checks for AABB overlap with all other nodes. If overlapping, computes the minimum push-out direction (right/left/down/up) and nudges the node with a 10px gap. Group containers are skipped — they don't push their members aside.

### Drag-In / Drag-Out Group Reparenting

After the anti-overlap pass, `onNodeDragStop` reconciles `parentId`:

1. Walks the dragged node's parent chain to compute its absolute (post-nudge) flow-space center via `absolutePos()`.
2. Scans every group node and picks the first whose AABB contains that center. **Collapsed groups are skipped** — their compact pill must not slurp up unrelated nodes.
3. Computes new local coords as `absolute − targetGroupAbs` with `targetGroupAbs` defaulting to `(0, 0)` when no group is found. This single expression covers all three cases (attach, detach, same parent) — the same-parent case is algebraically equivalent to the post-nudge local position because the loop resolves the current parent to the same absolute, and the no-target case collapses to `local = absolute` (top-level frame).
4. Single map-callback strips any existing `extent` + `parentId`, then re-adds `parentId` only when there's a target group. When attaching, also reorders the nodes array so the parent group sits BEFORE the child (React Flow requirement). Early-returns when neither nudged nor reparented to skip the allocation entirely.
5. **Never sets `extent: 'parent'`** — that constraint is what would prevent dragging children out. The reconciliation pass replaces it. `loadGraph()` also strips any persisted `extent: 'parent'` from older saves so existing graphs unblock.

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
- `'group'` → GroupSettingsMenu

### AddNodeMenu

- Auto-focused search input
- Grouped by category when not searching, flat list when searching
- **Enter key**: While a non-empty query is typed, pressing Enter adds the highest-ranked search result (`results[0]`). Lets users add a node without reaching for the mouse — type `invert` + Enter, done. Gated on `query.trim() && results.length > 0`.
- Maps node to React Flow type: output→`'output'`, time→`'clock'`, color→`'color'`, noise category→`'preview'`, sin/cos→`'mathPreview'`, else→`'shader'`
- Places node at context menu screen position via `screenToFlowPosition()`
- Prevents adding multiple output nodes
- **Group Selection** — when ≥2 non-group nodes are selected and the search is empty, a top-of-menu entry calls `groupSelection()` (same path as Ctrl+G). Shows a `N nodes` count badge.
- **Search aliases** — node `description` fields are searched alongside `label`/`type`/`tslFunction`, so common aliases are added as "Also: X, Y, Z" tails. Examples: Float = `number`, `value`; Invert = `invert`, `complement`, `negate`; Append = `combine`, `join`; Slider = `range`; UV = `texcoord`, `texture coordinate`.

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
- **Uniforms**: Lists every `property_float` node in the graph with a text input for the uniform name and a `DragNumberInput` for its default value. Edits flow through `updateNodeData` so they hit history + code regen like any other change.

All settings stored in `OutputNodeData.materialSettings` and threaded through to all 3 export pipelines (preview, A-Frame, script).

### GroupSettingsMenu

Right-click menu for `'group'` nodes:

- **name** — text input that patches `data.label` via `updateGroupData()`.
- **color** — `<input type="color">` that patches `data.color`. Header strip + tinted body update live.
- **Save to Library** — calls `saveGroupToLibrary(groupId)`; the snippet shows up in the asset bar's "Saved Groups" tab.
- **Ungroup** — dissolves the container, lifts children back to root (or to the grandparent group), and restores their absolute positions.

### DragNumberInput

- **Drag mode**: Hold + drag left/right to change value (BASE_SPEED=0.005, acceleration factor 0.002)
- **Edit mode**: Click to enter text editing, Enter/Escape/blur to commit
- **Arrow buttons**: ◂/▸ with configurable step (default 0.1)
- **Rounding**: 4 decimals internal, 2 decimals display

---

## Groups (GroupNode.tsx + store)

Selection groups are first-class React Flow nodes (`type: 'group'`) that own member nodes via `parentId`. They have no registry entry, no inputs/outputs while expanded, and no shader semantics — `graphToCode`/`graphToTSLNodes`/`cpuEvaluator` ignore the *node* entirely, but they call `unwrapCollapsedGroupEdges()` (see below) at their entry to translate any visually-rewritten boundary edges back to their real child endpoints, so the group's collapse state never affects compiled output.

### Lifecycle

- **Create** — `groupSelection(nodeIds)` (Ctrl+G or right-click → Group Selection) computes the bbox of the selected nodes, mints a group container with `width`/`height`/header padding, and re-parents members so their position is group-relative. The group goes at the front of the nodes array (React Flow requires parent-before-child ordering).
- **Resize** — `<NodeResizer>` from `@xyflow/react` (`minWidth=120`, `minHeight=80`) is rendered when expanded + selected.
- **Recolor / rename** — `updateGroupData()` patches `data.color` and `data.label`. Header strip + tinted body update live.
- **Save to library** — `saveGroupToLibrary()` snapshots the container + every direct child + every internal edge into `savedGroups` (localStorage `fs:savedGroups`).
- **Ungroup** — `ungroup()` lifts members back to their grandparent's coordinate space, restores absolute positions, and removes the container. Triggered by Ctrl+Shift+G, the GroupSettingsMenu, or pressing Delete on a selected group.

### Drag-in / drag-out

`onNodeDragStop` reconciles `parentId` after every drag (see "Drag-In / Drag-Out Group Reparenting" above). **No member ever gets `extent: 'parent'`** — that constraint would prevent dragging children outside the group bounds. The reconcile pass replaces it: drop a free node inside a group's footprint and it attaches; drag a member outside and it detaches. Collapsed groups are skipped from the attach scan.

### Collapse / expand

`toggleGroupCollapsed()` flips `data.collapsed` and rewires the graph so the pill stays useful:

- **Members + internal edges** get `className: 'fs-collapsed-member' | 'fs-collapsed-edge'` (hidden via `display: none !important` in [NodeEditor.css](src/components/NodeEditor/NodeEditor.css)). We use a className instead of React Flow's `hidden: true` flag because the latter unmounts the React component, which would tear down preview / clock / math `requestAnimationFrame` loops. With `display: none` the components stay mounted, animations keep running, and restoring is just a class toggle.
- **Boundary edges** are bucketed into input vs output and rewritten to point at synthetic handles on the group node:
  - **Output socket** (source inside, target outside) — deduped per `(nodeId, handleId)`. Multiple downstream consumers share one socket. `name = source node label` (the producer).
  - **Input socket** (source outside, target inside) — `name = port label` of the internal child input the edge feeds (e.g. "Position", "Scale"). The data type comes from `NODE_REGISTRY` lookup.
  - Both record `originalNodeId`/`originalHandleId` so expand can rewire the edge back. The synthetic ids are `__out_<nodeId>_<handleId>` / `__in_<nodeId>_<handleId>`.
- **`unwrapCollapsedGroupEdges(nodes, edges)`** in [edgeUtils.ts](src/utils/edgeUtils.ts) reverses the rewrite for any consumer that needs the *logical* edge graph rather than the visual one. It builds two `(groupId, socketId) → {originalNodeId, originalHandleId}` lookup maps from every collapsed group's stashed `collapsedInputs/Outputs` arrays and returns a new edge array with boundary edges rewritten back to their real endpoints. Short-circuits and returns the original array when nothing is collapsed (no allocation). Called at the entry of:
  - [graphToCode.ts](src/engine/graphToCode.ts) — fixes the iframe preview path. Without this, an edge from `noiseNode → output.color` becomes `groupId.__out_noiseNode_out → output.color` after collapse; `resolveEdgeRef` then calls `varNames.get(groupId)` (no var name — group is not in the registry), returns `null`, the channel falls back to `'0'`, and `colorNode = vec3(0,0,0)` renders as black/gray under any lighting. Same root cause as the "preview goes gray" symptom.
  - [cpuEvaluator.ts](src/engine/cpuEvaluator.ts) — entry of `evaluateNodeOutput`, `getNodeOutputShape`, and `evaluateNodeRange`. Fixes live edge value cards (EdgeInfoCard), PreviewNode/MathPreviewNode thumbnails, and the `getComponentCount` shape inference used by `append` codegen. `evaluateNodeScalar` and `getComponentCount` are pass-throughs to those entries so they inherit the fix. `getNodeOutputShape` only unwraps when `visited.size === 0` (top-level call); recursive calls reuse the already-unwrapped array.
  - The visual rewrite in `toggleGroupCollapsed` stays untouched — the unwrap is purely a logical view applied at engine boundaries. Whichever side a consumer cares about, it gets a coherent answer.
- **Pill geometry** — `COLLAPSED_W = 130`, `HEADER_H = 28`, `SOCKET_TOP_PAD = 8`, `SOCKET_H = 18`. Height = `HEADER_H + SOCKET_TOP_PAD + max(1, socketCount) * SOCKET_H + 6`. The padding pushes the first handle dot below the colored header strip so they don't visually collide. The constant is duplicated in `GroupNode.tsx` and the store — keep them in sync.
- **Cost badge** — `data.cost` is set to the sum of GPU costs of every member (looked up from `complexity.json` by `registryType`). Rendered above the pill via the same `node-base__cost-badge` class as regular nodes (so it auto-flips contrast against the canvas background). The global complexity BFS in `useSyncEngine` also reads this cached value — since boundary edge rewriting makes members unreachable from the group node, the BFS treats collapsed groups as opaque and uses `data.cost` directly.
- **Handle internals** — `GroupNode` calls `useUpdateNodeInternals()` whenever the group is collapsed and the set of boundary sockets changes, matching the pattern used by `OutputNode` and `PreviewNode`. Without this, React Flow's internal bounds map doesn't know about the dynamically mounted synthetic handles and edges fail to render.
- **Resize handles** are hidden while collapsed — the pill is fixed-size.

### BoundarySocket

```typescript
interface BoundarySocket {
  socketId: string;            // synthetic handle id rendered on the group
  originalNodeId: string;      // original child node + port for restore
  originalHandleId: string;
  dataType: TSLDataType;       // colors the handle dot
  name?: string;               // shown next to the dot
}
```

### Saved Group Library

`savedGroups: SavedGroup[]` lives on the store and persists to localStorage (`fs:savedGroups`):

- **`saveGroupToLibrary(groupId)`** — snapshots the group container + every direct child + every edge whose source AND target are both inside the group (cross-boundary edges are dropped — they'd reference nodes that don't exist when the snippet is dropped on a different graph).
- **`deleteSavedGroup(savedId)`** — removes from the library + persists.
- **`instantiateSavedGroup(savedId, position)`** — builds an `oldId → newId` map up front, clones the container at `position`, re-parents members under the new container with original group-relative positions, rewrites edge `source/target/id` references via the id map, and pushes everything in a single `setNodes` / `setEdges` call. Group container is inserted before its children (React Flow ordering).
- **Asset bar tab** — [SavedGroupCard.tsx](src/components/NodeEditor/SavedGroupCard.tsx) is a draggable tile that mirrors the in-canvas GroupNode visual (colored header, tinted body, member count). Drag it onto the canvas; the drop handler in `NodeEditor.onDrop` reads the `application/fastshaders-saved-group` dataTransfer key and calls `instantiateSavedGroup()`. Hover reveals an X button that calls `deleteSavedGroup()`.
- **Tab label**: "Saved Groups (N)" — count badge appears when non-empty.

---

## Canvas Background + Auto-Contrast

- **`nodeEditorBgColor`** store field (localStorage `fs:nodeEditorBgColor`, default `#FAFAFA`). Wired to React Flow's root via `style={{ background }}` and to a color swatch button slotted inside the React Flow `<Controls>` next to the +/- buttons (custom CSS in [NodeEditor.css](src/components/NodeEditor/NodeEditor.css)). Also passed as `--canvas-bg` CSS variable on the `.node-editor` wrapper, consumed by the content browser (`background: var(--canvas-bg, var(--bg-panel))`) so the asset drawer background matches the canvas.
- **Background pattern**: `BackgroundVariant.Cross` — cross/plus pattern with `gap: 20`, `size: 1`, `color: #BBBBBB`.
- **`getContrastColor(hex)`** in [colorUtils.ts](src/utils/colorUtils.ts) returns `'#000000'` or `'#ffffff'` based on Rec. 601 luminance (threshold 0.55).
- **Cost badges** — [NodeBase.css](src/components/NodeEditor/nodes/NodeBase.css) defines `.react-flow .node-base__cost-badge` that reads `--node-cost-text` / `--node-cost-text-shadow` CSS vars set on the `.node-editor` wrapper from `getContrastColor(nodeEditorBgColor)`. The `!important` is needed to override the inline cost-gradient color the components still pass — that inline color only applies to NodePreviewCard tiles in the asset bar (outside React Flow's scope), where it should keep cost-gradient text.
- **1-channel edges** — [TypedEdge.tsx](src/components/NodeEditor/edges/TypedEdge.tsx) reads `nodeEditorBgColor` and substitutes `getContrastColor()` for the single-channel edge color (formerly hardcoded `#000000`). Multi-channel R/G/B(A) edges keep their saturated colors.

---

## Code Editor Theme Toggle

- **`codeEditorTheme: 'vs' | 'vs-dark'`** store field, persisted to `fs:codeEditorTheme`.
- Sun/moon button in the code editor tab bar (after Save / Load Script / Download Script). Applies the chosen theme to both Monaco editors (TSL, Script).

---

## Design System (tokens.css)

- **Theme**: Light, flat design — node shadows tuned **dark + sharp** so they read against any canvas background, not feathery
- **Font**: Inter (sans), JetBrains Mono (mono)
- **Spacing**: 4px base scale (--space-1 through --space-8)
- **Shadows**: 4 levels (sm, md, lg, node). `--shadow-node` is a two-layer combo — tight contact shadow (`0 1px 2px rgba(0,0,0,0.55)`) + slightly diffused offset (`0 3px 6px rgba(0,0,0,0.4)`) — small blur radii keep edges crisp
- **Cost visualization**: Nodes scale (up to 1.35x) and blend color based on GPU cost (green→amber→red). Costs calibrated against mobile GPU SFU quarter-rate (add=1, sin/cos=4, pow=12). Noise costs: cellNoise=12, perlin=35, perlinVec3=75, fbm=95, fbmVec3=200, voronoi=55, voronoiVec2=60, voronoiVec3=65. Budgets assume 3–5 concurrent shaders in scene.
- **Category colors**: Each node category has a distinct accent color for the header strip (defined as `--cat-*` CSS vars in [tokens.css](src/styles/tokens.css), consumed by `CATEGORY_COLORS` in [colorUtils.ts](src/utils/colorUtils.ts))
  - input (#4CAF50), type (#2196F3), arithmetic (#FF9800), math (#9C27B0), interpolation (#00BCD4), vector (#E91E63), noise (#795548), color (#FF5722), unknown (#9E9E9E), output (#f44336)
  - **Dead variable**: `--cat-texture: #8D6E63` is still declared in tokens.css but no node category references it (texture support was removed). Safe to delete.

---

## Key Technical Details

### TypeScript Gotchas

- `@babel/traverse` CJS/ESM interop: `const traverse = (typeof _traverse.default === 'function' ? _traverse.default : _traverse)`
- `AppNode` union: use `getNodeValues(node)` from `@/types` to safely access `.values` (not direct `as` cast)
- React Flow `applyNodeChanges`/`applyEdgeChanges` return base types → need `as AppNode[]` cast
- React Flow `onPaneContextMenu` expects `(event: MouseEvent | React.MouseEvent)`, not just `React.MouseEvent`
- React Flow `onNodeDragStop` expects `React.MouseEvent` (not native `MouseEvent`) for the event parameter

### React Flow: Dynamic handles need `useUpdateNodeInternals`

`PreviewNode` (noise variants) and `OutputNode` mount/unmount handles based on `data.exposedPorts` — e.g. the noise `pos` port only exists when exposed, output `emissive`/`normal`/`opacity` only exist when toggled on. When a handle first mounts, React Flow's internal handle-bounds map is not automatically refreshed, so any edge connecting to that handle silently fails to render even though the edge is in state and graphToCode reads it correctly. (After a page refresh, every handle is measured fresh on initial mount, so the bounds map is correct and the edge appears — that's the giveaway symptom.)

The fix in both nodes is a `useUpdateNodeInternals(id)` effect keyed on the joined `exposedPorts.join('|')` so React Flow re-measures the handles whenever a port is added or removed. Without this, exposing `pos` on a fresh noise node and dropping a vec3 onto it would update the noise effect but no edge polyline would draw.

### VALID_SWIZZLE

Shared constant exported from `graphToCode.ts`, imported by `graphToTSLNodes.ts`. Contains `{'x', 'y', 'z', 'w'}` for split node swizzle validation.

### Three.js TSL Imports Used

**Code generation** (`graphToCode.ts`): Fn, float, int, vec2, vec3, vec4, color, uniform, uv, add, sub, mul, div, sin, cos, abs, pow, sqrt, exp, log2, floor, round, fract, oneMinus, mod, clamp, min, max, mix, smoothstep, normalize, length, distance, dot, cross, positionGeometry, normalLocal, tangentLocal, time, screenUV, hsl, toHsl, remap, select, mx_noise_float, mx_noise_vec3, mx_fractal_noise_float, mx_fractal_noise_vec3, mx_cell_noise_float, mx_worley_noise_float, mx_worley_noise_vec2, mx_worley_noise_vec3

**Live compilation** (`graphToTSLNodes.ts`): float, vec2, vec3, vec4, color, uv, add, sub, mul, div, sin, cos, abs, pow, sqrt, exp, log2, floor, round, fract, oneMinus, mod, clamp, min, max, mix, smoothstep, remap, select, normalize, length, distance, dot, cross, positionGeometry, normalLocal, tangentLocal, time, screenUV, mx_noise_float, mx_noise_vec3, mx_fractal_noise_float, mx_fractal_noise_vec3, mx_cell_noise_float, mx_worley_noise_float, mx_worley_noise_vec2, mx_worley_noise_vec3

### Persistence (localStorage)

- `fs:graph` — nodes + edges (auto-save every 300ms)
- `fs:splitRatio` — left/right panel ratio
- `fs:rightSplitRatio` — code/preview ratio
- `fs:previewGeometry` — selected preview geometry type
- `fs:previewLighting` — preview lighting mode (`'studio' | 'moon' | 'laboratory'`)
- `fs:previewSubdivision` — preview mesh subdivision count (1–256)
- `fs:previewBgColor` — preview background hex color
- `fs:previewUniformBounds` — JSON map of `{ uniformName: { min, max } }` per shader uniform slider
- `fs:shaderName` — shader name (via `loadString()` helper)
- `fs:headsetId` — selected VR headset (via `loadString()` helper)
- `fs:costColorLow` — cost gradient low color
- `fs:costColorHigh` — cost gradient high color
- `fs:nodeEditorBgColor` — canvas background hex color
- `fs:codeEditorTheme` — Monaco theme (`'vs' | 'vs-dark'`)
- `fs:savedGroups` — JSON array of `SavedGroup` snapshots (group + members + internal edges)

### History System

- 50-entry undo/redo stack
- `pushHistory()` called before: node drag, connection, paste, duplicate, delete, edge drag-to-disconnect
- `isUndoRedo` flag prevents sync during undo/redo operations

### Deployment

- **GitHub Pages**: `npm run build && npx gh-pages -d dist`
- **Vite base path**: `/FastShaders/` (configured in `vite.config.ts`)
- **Source vs deployed**: `main` holds source, `gh-pages` is the orphan branch with built `dist/` output. There is **no GitHub Actions workflow** — every deploy is a manual `npx gh-pages -d dist` run, so the two branches can drift if you forget to publish.
- **Cache busting**: `index.html` ships with `Cache-Control: no-cache, no-store, must-revalidate` + `Pragma: no-cache` + `Expires: 0` meta tags. Hashed JS/CSS assets in `/assets/` keep their content-hash filenames and stay infinitely cacheable, but the HTML always revalidates — so a fresh deploy never leaves a returning visitor pointed at a 404'd previous-build asset URL. Only costs a tiny 304 round-trip on a ~1 KB file.

### Version Display

- App version is read from `package.json` at build time. Vite's `define` exposes it as a global `__APP_VERSION__` string (declared in `src/vite-env.d.ts`); a custom `fs-version-html` plugin in [vite.config.ts](vite.config.ts) substitutes `%APP_VERSION%` in `index.html` so the deployed HTML self-reports its build via `<meta name="version" content="0.1.8">` (whatever the current `package.json` version is) — visible in DevTools (or via `view-source:`) without running any JS, useful when debugging stale-tab reports.
- `Toolbar.tsx` renders the same version next to the brand: `FastShaders v{__APP_VERSION__}` (mono font, secondary text color, `.toolbar__version` style). The brand text itself is now a button — clicking it opens a contact popover with the author's name, an email link + Copy button, and a website link + Copy button. Outside-click and Escape close it.
- Bumping the version requires only editing `package.json`'s `version` field; both the JS bundle and the HTML meta tag pick it up automatically on the next build.

---

## ShaderFace (GPU Micro-Benchmark)

Standalone benchmark tool in `ShaderFace/` for empirically measuring per-shader fragment cost. Two modes: **Standard** measures all shaders at fixed 512×512; **Resolution Sweep** steps through increasing resolutions per shader to find the max resolution that fits within VR frame budgets (120/90/72 fps). Produces JSON data to calibrate `complexity.json` performance point weights.

### Architecture

- **`index.html` + `bench.js`** — Main benchmark (bare Three.js quad, two modes: Standard + Resolution Sweep)
- **`aframe.html`** — A-Frame pipeline benchmark (measures scene overhead vs bare Three.js; uses A-Frame IIFE bundle + shaderloader from `public/js/`)
- **`shaderRegistry.js`** — 43 shaders: 1 baseline (flat color), 1 atomic (Voronoi), 41 tsl-textures
- **`lib/`** — Local copies of `three.webgpu.js`, `three.tsl.js`, `three.core.js`, `tsl-textures-src/`

### Benchmark Modes

**Standard**: Fixed 512×512 quad, all shaders, randomized order, multi-loop. Produces marginal cost ranking.

**Resolution Sweep**: Select shaders via checkbox picker, step through resolutions (default 256→1760, step 128). For each shader at each resolution: warmup + measure + record median. Adds A-Frame scene overhead (configurable constant) to compute total frame time. Reports `maxRes120`, `maxRes90`, `maxRes72` — the largest resolution fitting each FPS budget. Quest 3 per-eye is ~1680×1760, so max res defaults to 1760.

### Measurement Method

1. Multi-pass amplification: render N passes synchronously, divide wall-clock by N
2. GPU sync via `device.queue.onSubmittedWorkDone()` (WebGPU) or `gl.finish()` (WebGL fallback)
3. Ramp discard: 5 measurement cycles discarded before recording (GPU DVFS settling)
4. Randomized shader order per loop (decorrelates thermal drift) — standard mode only
5. Auto-calibration: passes=0 finds count where baseline ≥10ms (WebGPU) or ≥50ms (WebGL)
6. Periodic yields every 5 samples (prevents Quest compositor starvation)
7. Unreliable sync compensation: WebGL fallback enforces min 200 passes (vs 100 for WebGPU)

### GPU Sync Reliability

Only WebGPU `onSubmittedWorkDone()` provides real GPU sync. Quest Browser falls to WebGL where `gl.finish()` doesn't truly wait for GPU completion — measurements show bimodal distributions. Mac Safari WebGPU is the gold standard (CV% 0–5%). Quest WebGL data is approximate but ranking is consistent for top ~35/41 shaders.

### Serving

Must be served via static HTTP server (VS Code Live Server, `python3 -m http.server`, `serve.sh`) — **not** through Vite, which interferes with the import map. A-Frame benchmark uses scripts from `public/js/`.

### Output

**Standard**: JSON with raw per-sample timing arrays + summary statistics (median, IQR, CV%, outlier filtering via Tukey fences, baseline-subtracted marginal cost). Auto-downloads at 20% increments. Filename: `shaderface-standard-{sessionId}-{tag}.json`.

**Resolution Sweep**: JSON with `sweepResults[]` containing per-shader cost at each resolution + `maxRes120/90/72`. Filename: `shaderface-resolution_sweep-{sessionId}-{tag}.json`.

### Key Findings

**Mac (WebGPU, 120 passes, 2 loops)** — reliable, CV% 0–5%:

| Shader | Marginal (ms) | Notes |
|--------|-------------:|-------|
| circleDecor | 0.558 | was severely underestimated in complexity.json |
| caustics | 0.542 | roughly correct rank |
| cork | 0.354 | underestimated |
| turbulentSmoke | 0.275 | overestimated |
| dalmatianSpots | 0.250 | severely underestimated |
| protozoa | 0.208 | correct |
| reticularVeins | 0.200 | underestimated |
| planet | 0.142 | overestimated |
| ... (34 more) | 0–0.10 | |
| dysonSphere | 0.000 | was 165 in complexity.json (20x overestimated) |

**Quest 3 (WebGL, 500 passes, 2 loops)** — noisy but ranking matches Mac for 35/41 shaders:

| Shader | Marginal (ms) | Max FPS @512×512 |
|--------|-------------:|:---:|
| cork | 5.54 | 120 |
| circleDecor | 5.15 | 120 |
| caustics | 5.00 | 120 |
| turbulentSmoke | 4.76 | 120 |
| dalmatianSpots | 4.28 | 120 |

All shaders fit 120fps at 512×512 on Quest 3. Resolution sweep mode determines at what resolution each shader breaks the frame budget.
