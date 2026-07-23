# FastShaders — Project Context

## Overview

Bi-directional TSL (Three.js Shading Language) visual shader editor. Users build shaders either by connecting nodes in a graph or by writing TSL code — changes in one view sync to the other.

**Live**: https://Alvis1.github.io/FastShaders/

**Stack**: React 18 + TypeScript + Vite | `@xyflow/react` v12 (node graph) | `@monaco-editor/react` + `monaco-editor` (code editor, **bundled locally — no CDN**, see monacoSetup.ts) | `zustand` v5 (state) | `three` 0.184 (WebGPU + TSL — exclusively `three/tsl` built-ins, including the MaterialX noise family) | `@dagrejs/dagre` (auto-layout) | `@babel/parser` + `traverse` + `types` (code parsing) | Tauri v2 (`src-tauri/` — offline desktop shell)

**A-Frame integration**: Exports use the [a-frame-shaderloader](https://github.com/Alvis1/a-frame-shaderloader) IIFE bundle which bundles a custom A-Frame 1.8.0 + Three.js r184 WebGPU in `a-frame-180-a-01.min.js`. The shaderloader (`a-frame-shaderloader-0.5.js`; 0.4 stays frozen for previously-exported shaders) rewrites the bare `'three/tsl'` import specifier into a `globalThis.THREE.TSL` destructure (via `globalizeBareImports`) so blob-loaded modules read the bundle's single Three.js instance — no shim file needed. It detects Object API (multi-channel) vs Simple API (single node) by checking for any `*Node` property (`colorNode`, `positionNode`, `normalNode`, `opacityNode`, `roughnessNode`, `metalnessNode`, `emissiveNode`). It also manages **property uniforms**: reads `export const schema` from modules (or auto-detects `params.XXX`/`const NAME = uniform(VALUE)` patterns), creates TSL uniforms, passes them to the shader function, and exposes `updateProperty(name, value)` for runtime updates. **Colour helpers**: `hsl` and `toHsl` are *not* exports of `three/tsl` (in r173 or r184 — only `mx_hsvtorgb`/`mx_rgbtohsv` exist). Whenever the graph contains an `hsl` or `toHsl` node, `graphToCode` emits a module-local branchless `Fn` helper at top-of-file; `codeToGraph` detects and `path.skip()`s those helpers so their bodies don't round-trip back into the graph as standalone arithmetic nodes.

---

## Project Structure

```
src/
├── App.tsx                            # Root + SyncController (graph↔code sync orchestration)
├── main.tsx                           # Entry point
├── nodeEditor.tsx                     # React root for node-editor.html (renders GraphsPage)
├── nodeEditorBootstrap.ts             # MUST be nodeEditor.tsx's FIRST import — disables the store's graph autosave so that shared-origin page can't overwrite the user's real fs:graph
├── test-utils.ts                      # Shared test factories (makeNode, makeEdge) — import these instead of redefining stub builders per test file
├── vite-env.d.ts                      # Type declarations (Vite env + __APP_VERSION__ + __FS_DESKTOP__ + window.__TAURI__)
├── components/
│   ├── CodeEditor/
│   │   ├── CodeEditor.tsx             # Monaco editor with TSL/Script folder tabs, Save, Load Script, Download Script
│   │   ├── CodeEditor.css
│   │   ├── monacoSetup.ts             # Bundles Monaco locally: loader.config({ monaco }) + Vite ?worker workers (no CDN — offline/desktop requirement)
│   │   └── tslLanguage.ts             # TSL language definition, completions, color picker
│   ├── Graphs/
│   │   ├── GraphsPage.tsx             # node-editor.html root — node/texture registry overview + description/citation editor (+ .css)
│   │   ├── GraphModal.tsx             # (+ .css)
│   │   └── DesignerModal.tsx          # (+ .css)
│   ├── Layout/
│   │   ├── AppLayout.tsx              # Two nested SplitPanes (left: graph | right: code/preview)
│   │   ├── AppLayout.css
│   │   ├── SplitPane.tsx              # Draggable divider (pointer-captured, horizontal or vertical)
│   │   ├── Toolbar.tsx                # Top bar: clickable brand → contact popover, version, shader name input, "Local" desktop-download dropdown (fixed GitHub-release asset names), desktop-only "VR" popover (LAN bench server address + secure-context how-to)
│   │   ├── Toolbar.css
│   │   ├── CostBar.tsx                # GPU complexity bar (totalCost vs headset budget)
│   │   ├── CostBar.css
│   │   ├── PreviewLink.tsx            # Decorative "symbolic edge" wire from the Output node to the 3D preview window (+ .css)
│   │   └── previewLinkGeometry.ts     # Pure geometry for PreviewLink (+ .test.ts)
│   ├── NodeEditor/
│   │   ├── NodeEditor.tsx             # React Flow canvas + keyboard shortcuts + interaction handlers
│   │   ├── NodeEditor.css
│   │   ├── dragConnect.ts             # Pure drag-node-onto-node connect decision logic (+ .test.ts)
│   │   ├── overlapCascade.ts          # Post-snap make-room BFS — pushes overlapped nodes off the connected pair (+ .test.ts)
│   │   ├── DrawingLayer.tsx           # Board-drawing ink layer — SVG via React Flow's ViewportPortal, strokes in flow coords (deliberately NOT a <canvas>)
│   │   ├── DrawToolbar.tsx            # Drawing tool strip
│   │   ├── nodes/
│   │   │   ├── ShaderNode.tsx         # Generic node for all TSL types (dynamic from registry, vec3/vec2 grouped display)
│   │   │   ├── ShaderNode.css
│   │   │   ├── ColorNode.tsx          # Color picker node
│   │   │   ├── ColorNode.css
│   │   │   ├── PreviewNode.tsx        # Noise preview with animated CPU canvas (all 8 MaterialX noise variants)
│   │   │   ├── PreviewNode.css
│   │   │   ├── MathPreviewNode.tsx    # Math function preview with scrolling waveform (sin, cos)
│   │   │   ├── MathPreviewNode.css
│   │   │   ├── ClockNode.tsx          # Time node with animated analog clock face
│   │   │   ├── ClockNode.css
│   │   │   ├── OutputNode.tsx         # Output sink (color, emissive, normal, displacement/position, opacity, roughness, discard)
│   │   │   ├── OutputNode.css
│   │   │   ├── GroupNode.tsx          # Selection group container — collapsible, recolorable, savable
│   │   │   ├── GroupNode.css
│   │   │   ├── NoteNode.tsx            # Resizable editable text sticky (canvas annotation)
│   │   │   ├── NoteNode.css
│   │   │   ├── RevealSockets.tsx       # Drag-to-reveal hidden parameter sockets (dimmed floating dots)
│   │   │   ├── connectionReveal.ts     # Reveal decision logic + shared CONNECTION_RADIUS (+ .test.ts)
│   │   │   ├── NodeBase.css            # shared header/body/border/cost-badge + .node-base__stack layers
│   │   │   └── glyphs/
│   │   │       ├── NodeGlyph.tsx       # light-theme SVG glyphs per registry type
│   │   │       └── customGlyphs.ts     # per-node visual overrides (designer-authored)
│   │   ├── handles/
│   │   │   └── TypedHandle.tsx        # Color-coded handles per data type
│   │   ├── edges/
│   │   │   ├── TypedEdge.tsx          # Multi-channel colored edges, drag-to-disconnect, routing waypoints, info card
│   │   │   ├── bezierGeometry.ts      # Shared render↔hit-test curve math (control points, Catmull-Rom waypoint splines, point-to-spline distance)
│   │   │   ├── bezierGeometry.test.ts # Unit tests for the curve/spline math
│   │   │   ├── EdgeInfoCard.tsx       # Live value display on edges (per-channel, animated)
│   │   │   └── EdgeInfoCard.css
│   │   ├── inputs/
│   │   │   └── DragNumberInput.tsx    # Drag-to-adjust number input with acceleration
│   │   ├── ContentBrowser.tsx         # Category-tabbed asset drawer with search, folder tabs, horizontal scroll + Textures + Saved Groups tabs
│   │   ├── ContentBrowser.css
│   │   ├── NodePreviewCard.tsx        # Type-dispatching preview card (7 visual variants matching editor nodes)
│   │   ├── NodePreviewCard.css
│   │   ├── SavedGroupCard.tsx         # Draggable tile for a user-saved group (Saved Groups tab)
│   │   ├── TextureCard.tsx            # Draggable tile for a built-in texture (Textures tab, CPU canvas preview with per-texture renderer)
│   │   ├── tileDrag.ts                # Single placement path for palette tiles (touch/pen drag, click/Enter via tileActivationProps, HTML5 dragstart payload records) → 'fs-tile-drop' CustomEvent → NodeEditor's placeTilePayload; also streams touch drag-move/end preview events
│   │   ├── AssetTooltip.tsx           # Hover-dwell tooltip for asset-bar tiles (body portal, viewport-clamped)
│   │   ├── AssetTooltip.css
│   │   └── menus/
│   │       ├── ContextMenu.tsx        # Menu dispatcher (canvas/node/shader/edge/group/note/stripes/dataviz)
│   │       ├── ContextMenu.css
│   │       ├── AddNodeMenu.tsx        # Searchable node palette, grouped by category, "Group Selection" + "Add Note" entries
│   │       ├── NodeSettingsMenu.tsx   # Node properties, duplicate, delete (+ Image node UV/Texture section)
│   │       ├── ShaderSettingsMenu.tsx # Output node settings (ports, displacement, material, uniforms)
│   │       ├── GroupSettingsMenu.tsx  # Rename + recolor + title size + Save to Library + Ungroup
│   │       ├── StripesSettingsMenu.tsx # Data Stripes node settings (strength, radial rings)
│   │       ├── DataVizSettingsMenu.tsx # Data Viz node settings (tone curve, radial distribution)
│   │       ├── NoteSettingsMenu.tsx    # Note recolor / delete
│   │       ├── ConnectionStub.tsx     # Screen-space wire from the source handle to the AddNodeMenu on wire-drop-on-empty-canvas
│   │       ├── menuShared.tsx         # Shared row styles + NumberRow + NodeActions
│   │       ├── recentNodes.ts         # fs:recentNodes recency list for AddNodeMenu (+ .test.ts)
│   │       └── EdgeContextMenu.tsx    # Edge delete + Add routing point menu
│   ├── Preview/
│   │   ├── ShaderPreview.tsx          # Sandboxed WebGPU iframe preview (geometry, lighting, subdivision, uniform sliders, camera)
│   │   └── ShaderPreview.css
│   ├── Modals/
│   │   ├── CsvImportModal.tsx         # Over-wide CSV decision dialog (cancel / as-is / transpose rows→columns)
│   │   └── LimitModal.tsx             # Image / storage-quota limit notices + ignore-limits opt-out
│   └── Tooltip/
│       ├── TooltipLayer.tsx           # App-wide delegated title-attribute tooltip (portalled to body)
│       └── TooltipLayer.css
├── engine/
│   ├── graphToCode.ts                 # Graph → TSL code string (import statements + Fn() wrapper)
│   ├── codeToGraph.ts                 # TSL code → nodes + edges (Babel AST, multi-channel returns, noise/UV patterns, three.js editor compat)
│   ├── tslCodeProcessor.ts            # Shared TSL processing: import extraction, TDZ fix, body parsing
│   ├── tslToShaderModule.ts           # TSL code → shaderloader-compatible ES script (materialSettings, properties)
│   ├── tslToPreviewHTML.ts            # TSL code → Three.js WebGPU HTML (uses tslCodeProcessor)
│   ├── layoutEngine.ts                # Dagre auto-layout (LR, nodesep=25, ranksep=60)
│   ├── cpuEvaluator.ts                # CPU-side graph evaluator for real-time values (multi-channel, cycle guard, uses hexToRgb01 from colorUtils)
│   ├── topologicalSort.ts             # Kahn's algorithm for execution order
│   ├── evaluateTSLScript.ts           # isDirectAssignmentCode() — detects `model.material.*Node = …` style scripts
│   ├── scriptToTSL.ts                # Reverse of tslToShaderModule — converts .js script back to Fn-wrapped TSL
│   ├── projectImport.ts              # Shared import path (Load Script / code-panel drop / canvas drop): applyProjectToStore + importShaderText + importShaderZip
│   └── fastShadersProject.ts         # FASTSHADERS_PROJECT_V1 snapshot embed/extract (trailing block comment; proto-pollution-stripping JSON reviver)
├── hooks/
│   ├── useSyncEngine.ts               # Bidirectional sync hook (watches graph/code changes)
│   ├── useLongPress.ts                # Sustained touch/pen press → callback (touch context menus; mouse ignored)
│   └── usePersistedState.ts           # useState mirrored to localStorage (validate-on-seed, throw-safe)
├── i18n/
│   ├── index.ts                       # Pure helpers (formatNodeLabel, nodeDescription, portLabel, t, …)
│   ├── useLanguage.ts                 # Store-reading language hook
│   ├── node-i18n.json                 # LV node/category labels — synced to public/ by fs-i18n-sync
│   └── lv.json                        # LV descriptions / port labels / UI strings
├── registry/
│   ├── nodeRegistry.ts                # 69 palette-visible node definitions + 3 hidden defs (unknown, dataNode, imageNode) = 72 total. NB 9 of the 10 unary-math nodes (sin…fract) are .map()-generated, so a naive grep undercounts
│   ├── nodeCategories.ts              # Category metadata (id + label) — 12 categories (incl. logic, texture, unknown)
│   ├── builtinTextures.ts             # Built-in texture groups (8 textures: polka dots, grid, tiger fur, static noise, crumpled fabric, gas giant, marble, wood) — TSL code parsed to node graphs at startup
│   ├── complexity.json                # GPU cost per operation
│   ├── citations.ts                   # + citations.json — sparse per-node/texture academic provenance references (ref + optional DOI/url)
│   └── descriptionSplice.ts           # Byte-range splice of a `description` string literal in registry source (node-editor.html description editor)
├── store/
│   └── useAppStore.ts                 # Zustand store (nodes, edges, code, sync, history, UI)
├── types/
│   ├── index.ts                       # Re-exports all types
│   ├── node.types.ts                  # AppNode union, ShaderNodeData, OutputNodeData, GroupNodeData, BoundarySocket
│   ├── sync.types.ts                  # SyncSource type ('graph' | 'code')
│   └── tsl.types.ts                   # ParseError, GeneratedCode
├── utils/
│   ├── colorUtils.ts                  # Cost color gradient, type→color mapping, CATEGORY_COLORS, hexToRgb01, getContrastColor (auto-flip text against bg)
│   ├── edgeUtils.ts                   # removeEdgesForPort(), unwrapCollapsedGroupEdges() (group boundary rewrite), bridgeEdgesAcrossDeletedNodes() (splice-delete)
│   ├── exposedPorts.ts                # Single home for the opt-in parameter-socket (`exposedPorts`) rules shared by render, settings menus, connect/sync/import auto-expose
│   ├── drawings.ts                    # Board drawing-layer data model (DrawStroke) + pure helpers backing DrawingLayer — visual-only ink, quantized opacity isolation groups
│   ├── propertyConvert.ts             # Constant ↔ uniform conversion pairs (float↔property_float, color↔property_color) for Node Settings "Convert to …"
│   ├── graphTraversal.ts             # hasTimeUpstream() — BFS time-node detection with O(1) Map lookup
│   ├── idGenerator.ts                 # generateId(), generateEdgeId()
│   ├── mathPreview.ts                 # Sin/math waveform canvas renderer (scrolling curve + dot)
│   ├── noisePreview.ts               # CPU noise (perlin2D, fbm2D, cellNoise2D, voronoi2D) — all 8 noise variants
│   ├── nameUtils.ts                   # toKebabCase() for export filenames
│   ├── edgeDisconnectFlag.ts          # Transient flag for edge disconnect suppression
│   ├── chainOperands.ts               # normalizeChainOperands() — compacts variadic arithmetic operand slots after a disconnect
│   ├── nodeCost.ts                    # nodeCostPoints() — per-node GPU cost, scaling chainable arithmetic by operand count
│   ├── csvParser.ts                   # Strict adversarial CSV parser (delimiter autodetect, finite-cell, caps) + transposeCsv()
│   ├── dataNode.ts                    # Data node payload: pack CSV columns column-major → base64 Float32 blob + per-column dynamicOutputs
│   ├── dataViz.ts                     # Pure DSP for Data Stripes / Data Viz (minMax, normalize01, buildPhaseRamp)
│   ├── binaryCodec.ts                 # base64 ↔ bytes/Float32 + IEEE-754 half-float (WebGPU can't filter float32 textures)
│   ├── imageNode.ts                   # Image node payload: validate adversarial data: URL, decode, caps, sanitize, collect files (pure/node-testable)
│   ├── imageImport.ts                 # Drop-time image re-encode (EXIF strip, WebP→PNG→JPEG, downscale-retry) — DOM-only
│   ├── zipWriter.ts                   # Dependency-free STORE-method ZIP writer (deterministic, CRC-32) for the shader + images download
│   └── zipReader.ts                   # ZIP reader (STORE + deflate via DecompressionStream, adversarial caps) for .zip import
└── styles/
    ├── tokens.css                     # CSS custom properties (colors, spacing, shadows, fonts)
    └── reset.css
public/
├── js/                              # VENDORED (do not hand-edit) — synced from a-frame-shaderloader/js/ by the fs-vendor-sync vite plugin; vendorSync.test.ts fails on drift
│   ├── a-frame-shaderloader-0.5.js   # A-Frame shader component (rewrites three/tsl→globalThis.THREE.TSL, TDZ fix + auto-import + typed property schema: number/color/map)
│   ├── a-frame-shaderloader-0.4.js   # FROZEN previous loader — shaders exported before 0.5 reference it from the CDN
│   ├── a-frame-180-a-01.min.js       # A-Frame 1.8.0 IIFE bundle, r184 WebGPU
│   └── aframe-orbit-controls.min.js  # Orbit controls for preview
├── podest.html                       # "Podest" — standalone full-screen shader viewer (drop .js/.zip shader or .glb/.gltf/.obj model; sandboxed stage). Opened via the toolbar "P" button
├── node-designer.html                # Glyph design tool (served copy synced from repo root; POSTs to the dev /__nd endpoint)
├── node-i18n.json                    # SYNCED copy of src/i18n/node-i18n.json (fs-i18n-sync vite plugin; i18nSync.test.ts fails on drift) — do not hand-edit; fetched by the standalone Node Designer
├── webgpu-xr-demo.html               # Standalone three.js WebGPURenderer + TSL + immersive-WebXR demo page (forceWebGL default for Quest Browser; header comment documents the r184 XR/WebGPU findings)
├── models/                           # teapot.obj + stanford-bunny.obj (preview geometries; pre-normalized: bbox center at origin, longest axis = 1.6)
└── logos/                            # Funding-acknowledgment SVGs (shown in the brand popover)
src-tauri/                            # Tauri v2 desktop shell — tauri.conf.json (dragDropEnabled:false, bundle.resources carousel), icons, capabilities, src/bench_server.rs (LAN bench server)
.github/workflows/                    # ci.yml (test + typecheck on push/PR) + release.yml (v* tags → desktop binaries + gh-pages deploy in lockstep)
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

The Script tab reads `materialSettings` and `properties` (from `property_float` and `property_color` nodes) in `CodeEditor.tsx` and threads them to the generator.

The TSL editor stays mounted (hidden) when switching tabs to avoid Monaco re-initialization freezes.

**Load Script**: On the TSL tab, a "Load Script" button opens a file picker for `.js` files. The selected file is read and converted back to TSL code via `scriptToTSL()` ([scriptToTSL.ts](src/engine/scriptToTSL.ts)), which reverses the `tslToShaderModule` transforms: `export default function(params)` → `Fn(() => {`, `params.NAME` → `uniform(default)` (defaults read from `export const schema`), `colorNode` → `color`, strips nested `Fn()` artifacts from unknown-node round-tripping, and re-adds `Fn`/`uniform` to the import line. The converted TSL is written into the editor and a code→graph sync is triggered.

**No panel headers**: The "Node View" and "TSL Code View" panel labels have been removed. The code editor uses a tab bar with folder-style tabs at the top. The toolbar shows a "Script name:" label before the shader name input. The preview panel has a compact top bar with controls (play/pause, reset, bg color, lighting, geometry, subdivision).

**SplitPane** ([SplitPane.tsx](src/components/Layout/SplitPane.tsx)): Uses `setPointerCapture()` on the divider so dragging never loses grip — even when the cursor flies over iframes or other elements that would swallow regular mouse events. Ratio clamped to `[0.05, 0.95]`. `touchAction: none` prevents browser scroll hijack on touch devices.

### Preview (ShaderPreview.tsx)

- **Rendered in iframe** via blob URL from `tslToPreviewHTML.ts`
- **Renderer**: A-Frame scene with `a-frame-shaderloader` (loads local IIFE bundle via Vite public dir)
- **Camera**: FOV 20 with orbit controls (zoom 2–80, rotate 0.5 speed). Initial position `0 0 8`.
- **Geometry**: Selector dropdown with five built-in options (plus a `custom` entry when a mesh is dropped — see below), persisted to localStorage:
  - **Primitives** — `sphere`, `cube`, `plane`. Plane is rendered un-rotated (faces the camera); sphere and cube use a 45/45 tilt so multiple faces are visible.
  - **OBJ models** — `teapot` (Utah teapot, 15/35/0 tilt) and `bunny` (Stanford bunny, 0/25/0 tilt — silhouette reads better head-on). Backed by static files in `public/models/` (`teapot.obj`, `stanford-bunny.obj`), loaded via A-Frame's `obj-model` component. **Both source OBJs are pre-normalized** (2026-07): bounding-box center exactly at the origin, uniform-scaled so the longest axis is exactly `1.6` (teapot 1.6×0.78×0.99, bunny 1.6×1.59×1.24) — every consumer gets centered, same-size meshes without relying on runtime correction, and `positionGeometry`-driven shaders see comparable coordinate ranges (±0.8) on models and primitives alike (previously the raw teapot spanned ±3.2 and the bunny ±0.08, so the same noise shader looked ultra-dense on one and near-constant on the other). The custom `fit-bounds` component (registered inline in the iframe) still recomputes vertex normals when the source file lacks them, generates spherical UVs from each vertex's direction so TSL shaders that read `uv()` get meaningful values, and recenters/rescales the mesh so the longest axis equals `1.6` — that last step is now a no-op for the bundled models but stays as a safety net for arbitrary models (the viewer's drag-dropped `.glb`s).
  - `isObjGeometry(geometry)` in [tslToPreviewHTML.ts](src/engine/tslToPreviewHTML.ts) is the single source of truth for primitive vs OBJ branching.
- **Subdivision slider**: Symmetrically applied to per-primitive segment fields (`segmentsWidth/Height` for sphere/plane, all three for cube). Range `[1, 256]`, default 64. Built into the geometry attribute by `buildGeoAttr()` in `tslToPreviewHTML.ts`. **Hidden when an OBJ model is selected** — the slider has no meaning for static meshes.
- **Lighting modes** (dropdown, persisted):
  - **light: Studio** (default) — three-point rig (pure white key + cool rim + neutral fill + low ambient).
  - **light: Moon** — single cool directional from `-4 1.5 2` at intensity 4.0 (terminator ~65° off camera axis, ~2/3 of the visible hemisphere lit) + a faint dark-blue ambient floor.
  - **light: Laboratory** — pure white ambient at intensity 2.5, no shadows.
- **Material**: `materialSettings` from output node (displacement mode, transparent, side)
- **Animation**: Play/pause toggle for mesh rotation. Y-axis turntable spin for sphere/cube/teapot/bunny; planes spin on Z (in-plane, like a record).
- **Background**: User-picked color via `<input type="color">` in the header, persisted to `fs:previewBgColor`. Defaults to `#808080`.
- **First-paint WebGPU gate** (important): the iframe's `srcDoc` is withheld until a `ResizeObserver` on `.shader-preview__body` reports non-zero `contentRect` dimensions. Without this gate, on first page load the iframe could boot before its flex container had laid out — A-Frame's WebGPU renderer then initialized against a 0×0 canvas, dawn rejected the framebuffer (`The texture size … is empty`), and the renderer stayed in a broken state that painted the mesh solid red. The symptom previously appeared to "go away" on any user-driven edge change because that triggered a `previewCode` rewrite → fresh iframe rebuild → boot after layout had settled. The gate makes the first boot deterministic.
- **Reset button** (red, left side of header): clears the saved camera position and object rotation (both in-memory refs and localStorage), pauses the spin (`playing=false`), restores **studio** lighting, **subdivision 64**, and every property uniform back to its shader-defined default. Min/max bounds, geometry, and bg color are user preferences and intentionally **not** reset.

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
  - `fs:camera` — sent whenever the camera position changes (200ms polling inside `whenOrbitReady`, only posted on actual change). The poll reads `camEl.getObject3D("camera").position`, **not** `camEl.object3D.position` — `orbit-controls` attaches THREE.OrbitControls to the `PerspectiveCamera` child, not the entity wrapper, so the wrapper's position never moves. Getting this wrong meant `(0,0,0)` was reported and persisted on every rebuild, so the camera always snapped back to `initialPosition`.
  - `fs:rotation` — sent whenever the spin parent's rotation changes (200ms polling, independent of orbit controls, degrees). Runs as a standalone `setInterval` outside `whenOrbitReady` since the spin parent's `object3D` is available before orbit controls.
- **Inbound messages** (parent → iframe):
  - `fs:uniform` — `{name, value}`; bridge writes directly into `_propertyUniforms[name].value` (no setAttribute round-trip).
  - `fs:reset-camera` — bridge calls `oc.controls.reset()`.
- **Camera persistence**: The parent stores the latest position in a `cameraPosRef` (a ref, not state — putting it in state would create an infinite rebuild loop). When `useMemo` rebuilds the iframe (lighting/subdivision/etc. changed), it reads `cameraPosRef.current` and embeds it as `window.__savedCameraPos = {x,y,z}`. The bridge applies that position to `camEl.getObject3D("camera").position` **after** orbit-controls finishes initializing, then calls `oc.controls.update()` so the controls' internal spherical is recomputed from the new camera position — critically, **not** by setting `initialPosition`, because that would also overwrite the controls' internal `position0` snapshot and break `controls.reset()`. Each inbound `fs:camera` message also writes to `localStorage['fs:previewCameraPos']`, so the view survives full page reloads in addition to iframe rebuilds. `loadCameraPos()` filters out origin-ish (`|pos| < 1`) values and wipes that key — a guard against stale `(0,0,0)` entries saved by the pre-fix version of the bridge.
- **Rotation persistence**: Works like camera persistence — `rotationRef` stores the latest spin parent angle (degrees). On iframe rebuild, `initialRotation` is passed through `PreviewOptions` and baked directly into the animation's `from`/`to` attributes (animated mode) or as a static `rotation` attribute (paused mode). Values are normalized to `[0, 360)` via `mod360` to prevent unbounded growth. The spin parent entity has `id="spin-parent"` so the bridge can look it up. Each update is also persisted to `localStorage['fs:previewRotation']`. Play/pause state persists via `localStorage['fs:previewPlaying']` so a rotating object keeps rotating (resuming from where it was) across page reloads. Reset clears all three.

### Sync Engine (prevents infinite loops)

- **`syncSource`** field: `'graph' | 'code'` — tracks who initiated the change
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
- **Property nodes**: `uniform(value)` calls → `property_float` nodes with variable name as property name; `uniform(color(0x…))` → `property_color` nodes
- **Three.js editor flat form**: `output = expr;` top-level assignments and `.toVar()` / `.toConst()` passthrough chains

### TSL Code Authoring Constraints

When writing TSL code to paste into FastShaders (or when generating code for an AI/LLM to paste), the following constraints must be respected for the code→graph parser (`codeToGraph.ts`) to produce a correct graph and a working GPU preview:

1. **Inline/nested call expressions as function arguments are supported.** The argument-processing loop handles `Identifier` (variable references), `MemberExpression` (`.x`/`.y`), `NumericLiteral`, and `CallExpression`: an inline call like `smoothstep(float(0.01), float(0.35), x)` is processed under a synthetic variable (`__arg${n}_${i}`) via recursive `processCall`, and its output node is wired into the input port. Named `const` intermediates remain the canonical style `graphToCode` emits (and what a round-trip regenerates — the synthetic nodes become named consts on the way back out), but they are no longer required for correctness.
   - `smoothstep(float(0.01), float(0.35), x)` → float nodes for 0.01/0.35 wired into the smoothstep node's edge inputs
   - `smoothstep(0.01, 0.35, x)` — raw numeric literals also work directly

2. **Method chains on non-variable receivers are supported.** Chains like `a.mul(b)` work when `a` is a named variable, and the parser also handles call-expression receivers — `float(0.45).sub(softness)` or `positionWorld.sub(cameraPosition).length()` — by recursing on the receiver under a synthetic `__chain` variable and wiring it as the first input. Swizzle receivers (`pos.x.mul(2)`) resolve through a split node the same way. Function-form (`sub(0.45, softness)`), chained, and named-step styles are all equivalent; named steps (`const base = float(0.45);` then `base.sub(softness)`) remain the canonical style `graphToCode` emits, so they round-trip byte-identically.

3. **Use raw numeric literals instead of `float()` wrappers where possible.** `mix(8, 512, t)` is cleaner and guaranteed to parse (the literal handler catches `NumericLiteral`). `float()` works too — inline (processed as a synthetic node) or stored in a named variable.

4. **The `Fn` wrapper is silently skipped.** `const shader = Fn(() => { ... })` is the canonical output format from `graphToCode`. `codeToGraph` explicitly skips `Fn` calls (no unknown node, no warning) — Babel's `traverse` already enters the arrow function body and processes its contents via the inner `VariableDeclarator` and `ReturnStatement` visitors.

5. **`uniform()` declarations are parsed wherever they appear** (module scope or `Fn` body) — the `VariableDeclarator` visitor traverses the whole program, not just the `Fn` body. Keep them inside `Fn(() => { ... })` only to match the canonical `graphToCode` emission format.

6. **Function arguments that are supported**: `Identifier` (variable name), `MemberExpression` (`var.x`), `NumericLiteral`, `UnaryExpression` (negative numbers like `-0.5`), `StringLiteral`, inline `CallExpression` (processed as a synthetic node), and compile-time-constant `BinaryExpression`s (folded to numbers, e.g. `1 / 6`, `2 ** -3`). Non-constant computed expressions (template literals, variable-dependent binary math) produce a parse warning instead of being silently ignored.

7. **Method chains on named variables are fine — including multi-step chains.** `coords.mul(cellScale)` works because `coords` resolves to a node ID via `objectVarName`. Multiple chaining (`coords.mul(cellScale).add(offset)`) also works: the parser recurses on the call-expression receiver under a synthetic `__chain` variable, so each step becomes its own node without a named intermediate const. Named intermediate steps (`const scaled = coords.mul(cellScale);` then `scaled.add(offset)`) are stylistic, not required.

8. **MemberExpression initializers are supported.** `const z = positionGeometry.z;` resolves through `resolveMemberExpr`, wiring the variable to the appropriate component handle of a shared split node (one split per source variable) — and since `resolveMemberExpr` falls back to `ensureBareInputNode`, undeclared built-ins like `positionGeometry` are auto-materialised (no alias workaround needed). Unrepresentable member initializers (non-identifier object/property, invalid swizzle) emit a visible parse warning ("Cannot represent … left unwired") instead of silently disconnecting.

9. **`resolveMemberExpr` auto-materialises bare built-in inputs.** When `someVar.x` appears as a function argument, `resolveMemberExpr` looks up `someVar` in `varToNodeId` and, like the `Identifier` handler, falls back to `ensureBareInputNode` — so `positionGeometry.y` works without a prior `const pos = positionGeometry;` alias, creating the input node and a shared split node on demand. The fallback only covers zero-argument, no-default `category: 'input'` definitions (time, positionGeometry, uv, …); anything parameterised must still be declared explicitly or the argument is silently dropped.

10. **`scriptToTSL` accepts both shaderloader modules and canonical Fn-form TSL.** The "Load Script" button runs `scriptToTSL()`, which reverses the `export default function(params) { ... }` + `export const schema = { ... }` shaderloader format — and passes already-Fn-shaped TSL through unchanged (raw-TSL detection at the top of `scriptToTSL`), so loading an Fn-form file is safe.

**Summary rule of thumb**: SSA-like form — one operation per line, every result named — is exactly what `graphToCode` emits, so writing it round-trips byte-identically. It is no longer a correctness requirement: the parser also accepts inline call arguments, nested method chains, swizzle initializers (`const z = pos.z;`), bare-input swizzles (`positionGeometry.x` with no alias), and compile-time constant arithmetic (`1 / 6`); constructs it genuinely cannot represent now surface as visible warnings instead of silently dropping.

### Zustand Store Shape

```typescript
{
  nodes: AppNode[], edges: AppEdge[]           // Graph data
  code: string, codeErrors: ParseError[]       // Generated code + errors
  totalCost: number                            // Connected node cost sum
  syncSource: 'graph'|'code'                   // Loop prevention
  syncInProgress: boolean, codeSyncRequested: boolean
  previewCode: string                          // Last code snapshot used by the preview iframe (separate from `code` so typing doesn't thrash the iframe)
  past: HistoryEntry[], future: HistoryEntry[], isUndoRedo: boolean  // undo/redo stacks, 50-entry cap; entries snapshot nodes+edges+drawings
  coalescingHistory: boolean                   // beginInteraction/endInteraction gesture bracketing
  splitRatio: number, rightSplitRatio: number  // Panel sizes (localStorage)
  shaderName: string, selectedHeadsetId: string // Toolbar state
  contextMenu: {
    open: boolean, x: number, y: number,
    type: 'canvas' | 'node' | 'shader' | 'edge' | 'group' | 'note' | 'stripes' | 'dataviz',
    nodeId?: string, edgeId?: string,
    sourceNodeId?: string, sourceHandleId?: string  // for handle-drop AddNodeMenu
  }
  // Groups
  savedGroups: SavedGroup[]                       // user-saved group library (localStorage `fs:savedGroups`)
  // Canvas + editor look-and-feel
  nodeEditorBgColor: string                       // React Flow canvas background hex (active-theme value)
  nodeEditorBgColorLight: string, nodeEditorBgColorDark: string  // per-theme canvas bg slots
  codeEditorTheme: 'vs' | 'vs-dark'               // app-wide theme (Monaco + <html data-theme>)
  costColorLow: string, costColorHigh: string     // cost gradient endpoints
  language: 'en' | 'lv'                           // UI language (display-only overlay)
  pendingCsvImports: PendingCsvImport[], pendingLimitNotices: LimitNotice[]  // modal queues
  ignoreImageLimits: boolean, hideImageDownscaleWarning: boolean  // LimitModal opt-outs
  nodeVarNames: Record<string, string>            // node id → generated TSL var name
  drawings: DrawStroke[]                          // canvas ink annotations (ride history + autosave + project embed)
  drawColor, drawOpacity, drawWidth, drawToolActive, drawEraser  // draw tool state (prefs persisted; active/eraser session-only)
}
```

---

## Internationalization (English / Latvian) — `src/i18n/`

A **display-only** English/Latvian overlay. The **LV** toolbar button (next to **SC**) toggles `store.language`, which is persisted to `fs:lang`, stamped on `<html lang>` (inline FOUC guard in `index.html`, mirroring the theme guard), and consumed at render.

**Invariant:** Latvian never touches anything stored, generated, or matched by the engine. Node `type`s, TSL identifiers (`varName`), generated shader code, `.fastshader` payloads, `data.label`, and search's canonical English fields all stay English. Every lookup **falls back to English** when a Latvian string is missing, so partial coverage never breaks the UI. **On-canvas node headers are deliberately NOT translated** — they show the generated TSL variable name (`mul1`, `perlin1`) so the graph mirrors the code. The bilingual `Latviešu (English)` labels live where you *pick and read about* a node: the Add-node menu, the content browser, tooltips, the **Node-Settings menu** (its node-name line + port-toggle labels), and the Node Designer.

**Data & single source of truth:**
- `src/i18n/node-i18n.json` — `{ nodes: {type→LV label}, categories: {id→LV label} }`. The `fs-i18n-sync` vite plugin copies it to `public/node-i18n.json` at dev/build start so the standalone Node Designer fetches the SAME table (relative `fetch('node-i18n.json')`, degrades to EN). `src/i18n/i18nSync.test.ts` fails on drift — edit the source, never the public copy.
- `src/i18n/lv.json` — React-only `{ descriptions: {type→LV}, ports: {EN label→LV}, ui: {EN string→LV} }`.
- `src/i18n/index.ts` — pure helpers (no store dep, node-testable): `formatNodeLabel(enLabel, type, lang, bilingual=true)` → `Reizināt (Multiply)` on roomy surfaces, Latvian-only (`bilingual=false`) on tight palette tiles, bilingual on the Node-Settings menu name line; `formatCategoryLabel`, `nodeDescription`, `portLabel` (canvas socket tooltips via `TypedHandle`, the `ShaderSettingsMenu` output-port rows, and the `NodeSettingsMenu` port-toggle labels), `t(enKey, lang)` (UI strings keyed by their English text), and `nodeSearchLV(type)` (OR'd into `searchNodes` + ContentBrowser's `matchesDef`). `src/i18n/useLanguage.ts` is the store-reading hook. Latvian asset-drawer cards widen to fit-content (floored at the designer width) with the header clamped to two lines (`html[lang="lv"]` CSS) so long palette-tile names like `Vektoriālais reizinājums` stay readable.

**Node Designer** (`node-designer.html`): its own `LV` topbar toggle (persisted to `nd:lang`) fetches `node-i18n.json` and re-renders every label site (`ndBaseLabel`/`ndNodeLabel`/`ndCatLabel`); the preview card header shows the full `Latviešu (English)` form so glyph widths are designed against the real rendered label.

**Translations** were produced high-school-level (vidusskola) from authoritative Latvian math/graphics terminology, adversarially reviewed for grammar, terminology, and brevity; descriptions match the English length (one short 3rd-person-present clause). To regenerate the data files from a vetted `final-translations.json`, the transform splits it into `node-i18n.json` + `lv.json` (labels/categories vs descriptions/ports/ui).

---

## Export Pipeline

### Shared TSL Code Processor (`tslCodeProcessor.ts`)

Exports one shared entry point, **`buildShaderModule(tslCode, options)`** (plus its `BuildShaderModuleOptions` type), used directly by both `tslToShaderModule.ts` (the "Download Shader" export) and `tslToPreviewHTML.ts` (whose `convertToShaderModule` is a thin wrapper) — shared verbatim so the exported file and the live preview can never diverge. Internally it runs:

- **`collectImports`** — extracts `three/tsl` import names (returns `{ tslNames }`)
- **`extractFnBody`** — extracts the body inside `Fn(() => { ... })`; also preserves module-scope preamble imports and declarations (e.g. graphToCode's HSL helper Fns), re-emitted at module scope
- **`fixTDZ`** — fixes Temporal Dead Zone issues:
  1. Removes self-referencing bare declarations (`const X = X;`)
  2. Renames locals that shadow imported function names (`const color = color(...)` → `const _color = color(...)`) — regex uses `(?!\s*[:(])` to preserve object property keys in return statements
  3. Fixes bare numeric first-arg in MaterialX noise calls (`mx_noise_float(0)` → `mx_noise_float(uv())`)
- **`parseBody`** — splits into definition lines and output channels (simple or multi-channel return)
- **`extractDiscards`** — splits bare `Discard();` lines out of the parsed definition lines

These helper names (and the `CHANNEL_TO_PROP` channel→material-property map — `color` → `colorNode`, `position` → `positionNode`, etc.) are private implementation details, not importable API; the old `AFRAME_GEO` constant no longer exists.

### Shader Script Export (`tslToShaderModule.ts`)

Generates a `.js` ES module compatible with the a-frame-shaderloader component (emitted by the "Download Shader" button).

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
4. **Geometry**: `isObjGeometry(geometry)` branches on primitive vs OBJ. Primitives go through `buildGeoAttr(geometry, subdivision)` which clamps subdivision to `[1, 256]` and applies it to the appropriate per-primitive segment fields. OBJ models (`teapot`, `bunny`) are emitted as `<a-entity obj-model="obj: url(${absUrl})" fit-bounds="size: 1.6">`, with `getModelUrl()` resolving the asset through `resolveAssetUrl()` — `new URL(base + path, window.location.href)`, which survives non-http schemes (`tauri://`) and relative bases where the old `location.origin` concatenation broke — so the sandboxed iframe receives a fully-qualified URL. The `fit-bounds` A-Frame component is registered via the **`FIT_BOUNDS_SCRIPT`** module-level template literal (single `lines.push` call). On `model-loaded` it runs four post-processing steps per Mesh:
   1. **Merge vertices by quantized position** (4-decimal precision) — `OBJLoader` returns *non-indexed* geometry where every triangle owns its own copies of its 3 vertices, so a position shared by N faces becomes N duplicate vertices each with its own face normal. Per-vertex displacement (`positionLocal + normalLocal * val`) then pushes each duplicate along *its own* normal and the surface splits open. The merge step rebuilds the geometry as indexed (handles both pre-indexed and non-indexed input), discarding old normals and UVs since both index into the old vertex layout.
   2. **`computeVertexNormals`** on the merged geometry — produces averaged smooth normals at every shared vertex regardless of whether the source file had normals. Both bunny and teapot OBJs lack normals; even files that have them get recomputed since the layout changed.
   3. **Auto-detect inverted winding** — the Stanford bunny OBJ uses CW triangles, so `computeVertexNormals` produces inward-facing normals and displacement pushes the surface *into* the mesh. We sample ~200 vertices and compare each `(vertex − centroid) · normal`; if a majority are negative, the winding is reversed. Fix: swap the 2nd and 3rd index of every triangle, then recompute normals. Auto-handles any future model with bad winding without hardcoding per-model flips.
   4. **Spherical UVs** generated from each vertex's direction relative to the geometry center, then a final recenter + uniform rescale so the longest axis equals `data.size` — a no-op for the bundled teapot/bunny (their OBJs are pre-normalized to origin-centered / longest axis 1.6) but kept as a safety net for models with arbitrary units and offsets (e.g. viewer drops).

   Always emitted (even for primitive previews) — inert if no entity attaches `fit-bounds="..."`.
5. **Lighting**: `studio` (4-light three-point rig), `moon` (single cool directional + faint ambient), or `laboratory` (white ambient only).
6. **Per-geometry rotation**: `plane` → `0 0 0` (faces camera); `bunny` → `0 25 0` (upright); `teapot` → `15 35 0` (slight tilt to read the spout/handle); other primitives → `45 45 0`.
7. **Animation**: Y-axis turntable (`0 360 0`) for sphere/cube/teapot/bunny, Z-axis spin (`0 0 360`) for plane. The shaded entity is wrapped in a **spin parent** (`id="spin-parent"`) that owns the `animation` attribute; the **child** (`id="preview-entity"`) carries the static tilt (`rotationAttr`) and the shader. Splitting the two is what keeps the loop seamless: if the spin animation lived on the same entity as the tilt, A-Frame would tween componentwise from the current value (e.g. `45 45 0`) to `to` (`0 360 0`), gradually flattening the X tilt and only spinning Y by `+315°` before snapping back to the start on every loop. With the parent/child split, the parent has no tilt of its own so its local Y/Z is the world Y/Z. When `initialRotation` is provided, the animation's `from` and `to` are offset by the saved angle (normalized to `[0, 360)`) so the spin continues from where it was; in paused mode, a static `rotation` attribute is set instead. The `id="preview-entity"` stays on the child since that's where the shader component lives (the bridge looks it up by id) and where `fit-bounds` needs the OBJ entity for `model-loaded`.
8. **Iframe ↔ parent bridge**: emitted as the **`BRIDGE_SCRIPT_TEMPLATE`** module-level template literal with a `__SAVED_CAM__` placeholder replaced by a JSON literal at emit time. Polls for shaderloader readiness → posts `fs:preview-ready` with the uniform name list, listens for `fs:uniform`/`fs:reset-camera`. Camera polling (inside `whenOrbitReady`) posts `fs:camera` on change; rotation polling (standalone `setInterval`, not gated on orbit controls) posts `fs:rotation` with degrees from `spinEl.object3D.rotation`. Both poll at 200ms. Saved camera position is embedded as `window.__savedCameraPos` and applied **after** orbit-controls initializes (not via `initialPosition`, so `controls.reset()` still snaps to the original `0 0 8`).
9. Uses A-Frame IIFE bundle with `a-frame-shaderloader` for rendering.
10. Error display div for runtime errors.

Both `FIT_BOUNDS_SCRIPT` and `BRIDGE_SCRIPT_TEMPLATE` are kept as raw template literals (using `<\/script>` to escape the closing tag) rather than `lines.push(...)` chains — they're large blocks of static iframe-side JS with at most one substitution, and the template-literal form keeps the source readable as JS instead of as a string-concat ladder.

---

## Project Files — Save, Import & Export

FastShaders round-trips a whole project through a single self-contained `.js` file (or a `.zip` when images are embedded). One shared import path — [projectImport.ts](src/engine/projectImport.ts) — backs **every** surface (canvas drop, code-panel drop, Load Script).

### Embedded project block (`fastShadersProject.ts`)

- **Download Shader** ([CodeEditor.tsx](src/components/CodeEditor/CodeEditor.tsx)) generates the shaderloader `.js` module (`tslToShaderModule`), then `embedProjectState()` appends a **trailing** block comment `/* FASTSHADERS_PROJECT_V1 … END_FASTSHADERS_PROJECT */` holding `{ version, shaderName, selectedHeadsetId, graph:{nodes,edges}, preview:{…}, ui:{…} }`. Because it comes *after* the code, external tools (A-Frame, a bundler) see a plain TSL module first; drag the same `.js` back into FastShaders and the full graph + preview + UI prefs restore. `*/` inside the JSON is escaped.
- **Adversarial parse**: `extractProjectState()` parses the block with a JSON reviver that strips `__proto__` / `constructor` / `prototype`, returning `{ project, stripped }`.
- **No block? bare-script route**: a `.js` without the block is treated as an exported shaderloader module — `scriptToTSL()` reconstructs the Fn-wrapped TSL and a code→graph sync runs.

### Import surfaces (all → `projectImport`)

- **Canvas drop** ([NodeEditor.tsx](src/components/NodeEditor/NodeEditor.tsx) `onDrop`): a real file drop is partitioned once — `.csv` → Data node, image → Image node, `.zip`/`.js` → **project import (replaces the whole graph)**. A project drop is exclusive: it loads exactly one file and alerts about any others (they would race the graph replace).
- **Code-panel drop + Load Script** ([CodeEditor.tsx](src/components/CodeEditor/CodeEditor.tsx)): accept `.js` and `.zip`.
- **`applyProjectToStore`** restores the graph (`syncSource: 'graph'`, so code regenerates), writes the `fs:preview*` localStorage keys, fires a `fs:project-imported` window event (ShaderPreview re-reads prefs without a reload), and runs `sanitizeImageNodes()` over the incoming (adversarial) image payloads.

### ZIP export / import

- **Export** ([zipWriter.ts](src/utils/zipWriter.ts) + [exportBundle.ts](src/utils/exportBundle.ts)): when the graph embeds images and/or a custom preview mesh is loaded, Download Shader emits a `.zip` instead of a bare `.js` — a dependency-free, deterministic (fixed DOS timestamp) STORE-method archive containing `<name>.js` (self-contained, images inlined as `data:` URLs) + `images/<sanitized-stem>.<real-mime-ext>` + `models/<sanitized-name>` (the dropped mesh, when present) + `README.txt` (with an A-Frame gltf-model/obj-model + shader pairing snippet when a model rides along). The js-vs-zip decision, entry list, and README text are pure and unit-tested (`exportBundle.test.ts`).
- **Import** ([zipReader.ts](src/utils/zipReader.ts)): a central-directory-driven reader (STORE + DEFLATE via native `DecompressionStream`) with adversarial caps (512 entries, 64 MB total, 512-char names). On import the loose `images/` files are ignored — the payloads ride inside the `.js`; the reader just picks the `.js` carrying the `FASTSHADERS_PROJECT_V1` block.
- **Custom preview mesh restore**: `importShaderZip` also picks the first `.obj`/`.glb`/`.gltf` entry (junk-filtered), validates + sanitizes it via `createPreviewMesh` ([previewMesh.ts](src/utils/previewMesh.ts)), stores it as the session `previewMesh`, and forces the preview geometry to `custom` (podest's shader+model pairing semantics). A MODEL-ONLY zip loads the mesh and returns `'model'` (callers treat it as success). A zip WITHOUT a model — and every bare text import — CLEARS the session mesh, so a stale model can neither satisfy an imported project's `custom` pref nor leak into the next export's zip. The mesh is session-only: never in history, autosave, or the project embed.

### Custom preview mesh — drop a 3D model on the preview

Dropping a `.obj`/`.glb`/`.gltf` anywhere on the 3D preview loads it as the `custom` preview geometry (a `Model: <name>` option appears in the geometry select). Key mechanics:

- **Drop surface**: the sandboxed iframe swallows drag events over the whole 3D view, so the generated preview document forwards them (`fs:preview-drag` signal + `fs:preview-drop` File objects — podest's forwarder pattern; the forwarder only reacts to FILE drags, so palette-tile drags pass untouched); ShaderPreview's root handles chrome-area drops. A `.js`/`.zip` dropped on the preview routes through the shared `projectImport` path — but an IFRAME-forwarded shader drop requires a `window.confirm` first: adversarial sandboxed code can forge `fs:preview-drop` with a File it constructed, and a project import replaces the whole graph (a model file only swaps the session mesh, so it stays immediate). A combined shader+model drop is SEQUENCED — shader import first (it clears/overwrites the mesh), then the dropped model — so the dropped model deterministically wins. Anything else surfaces a transient notice. A veil overlay (with the accepted-formats hint) shows during any file drag.
- **State**: the mesh lives in the store's session-only `previewMesh` slice (`{name, kind, bytes, text?, id}` — [previewMesh.ts](src/utils/previewMesh.ts) validates: 64 MB cap, glb magic check, name sanitized at the store boundary). `id` is monotonic — it keys the iframe rebuild (`custom:<id>`) and the model feed, so re-drops force a fresh document and stale feeds can't cross documents.
- **Feed**: the model reaches the iframe over the generalized `fs:obj-model` postMessage feed — glb as bytes (the exact Uint8Array view, structured-cloned; the store copy stays live for export), obj/gltf as text decoded once at load. `fit-bounds` gets an explicit `regen` flag: `true` for obj (rebuild normals/UVs — non-indexed loader output), `false` for glb/gltf (preserve authored data, synthesize spherical UVs only when missing).
- **Security**: model files are adversarial. Bytes cross only via postMessage + iframe-minted blob URLs, and the sandboxed stage installs `THREE.DefaultLoadingManager.setURLModifier` allowlisting `blob:`/`data:` — a hostile `.gltf` naming absolute http(s) buffer/texture URIs cannot phone home from the sandbox (CSP is absent in dev/desktop/podest, so the modifier is the real control). Podest's stage carries the same guard, and the XR popup — which runs at the app's REAL origin — installs an origin-widened variant (`blob:`/`data:`/same-origin, so the built-in teapot/bunny URLs still load).
- **Lifecycle**: `validateGeometry` accepts `'custom'` only while a mesh is loaded (imperative store read — the validator must stay module-scope stable yet see a mesh committed synchronously by a zip import). Reset keeps the mesh (geometry is a user preference); the XR popup loads it via a parent-minted blob URL (same-origin there). DRACO/meshopt GLBs are unsupported (no decoder bundled) — the loader error surfaces in the iframe overlay.

### Standalone Viewer — "Podest" (`public/podest.html`)

A separate full-screen player, opened from the toolbar's **P** button, that runs any exported shader without the editor. Drag-drop (**anywhere** — over the panel or the full-screen stage) or file-pick a shader (`.js`/`.mjs`/`.tsl`/`.txt` exporting a default `Fn`), a model (`.glb`/`.gltf`/`.obj` — OBJ takes the regen path: normals/UVs rebuilt like the built-in teapot/bunny), or a `.zip` (unzipped in-browser via `DecompressionStream`); it renders on the chosen mesh with auto-generated uniform sliders (bounds persisted to `fs:viewerBounds`). Scene controls include a background-color picker and a rotation-speed slider (plus the Spin on/off toggle), persisted to `fs:viewerBg` / `fs:viewerSpinSpeed` / `fs:viewerSpin`. Like the in-app preview, **all shader/model execution lives inside a `sandbox="allow-scripts"` iframe with no `allow-same-origin`** (opaque origin) — source and model bytes ship in over `postMessage`, blob URLs are minted inside the iframe, and it deploys anywhere the app does.

---

## Node System

### Node Registry (69 palette-visible nodes across 12 categories; 72 total incl. 3 hidden defs — `unknown`, `dataNode`, `imageNode` — excluded from search/browser)

| Category          | Nodes                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| **Input** (17)    | positionGeometry, positionLocal, positionWorld, positionView, positionWorldDirection, positionViewDirection, cameraPosition, cameraNear, cameraFar, normalLocal, tangentLocal, time, screenUV, uv, property_float, property_color, slider |
| **Type** (6)      | float, int, vec2, vec3, vec4, color                                                       |
| **Arithmetic** (4)| add, sub, mul, div                                                                        |
| **Math (unary)**  | sin, cos, abs, sqrt, exp, log2, floor, round, fract, oneMinus (Invert) — 10 total          |
| **Math (binary)** | pow, mod, clamp, min, max                                                                 |
| **Interpolation** (4) | mix, smoothstep, remap, select                                                        |
| **Logic** (3)     | greaterThan, lessThan, equal — per-channel comparisons; feed `select.condition` or the Output node's `discard` port |
| **Vector** (7)    | normalize, length, distance, dot, cross, split, append                                     |
| **Noise** (8)     | perlin, perlinVec3, fbm, fbmVec3, cellNoise, voronoi, voronoiVec2, voronoiVec3 (all MaterialX-backed) |
| **Color** (4)     | hsl, toHsl, stripes (Data Stripes), dataviz (Data Viz)                                     |
| **Output** (1)    | output (color, emissive, normal, displacement, opacity, roughness, discard inputs + materialSettings) |
| **Hidden** (3)    | `unknown` (round-trips unrecognized TSL) · `dataNode` (CSV drop) · `imageNode` (image drop) — none appear in the palette/search |

### Position & Camera Inputs

The 8 non-`positionGeometry` position/camera nodes are zero-input, zero-default `category: 'input'` defs that resolve to bare references (`const positionWorld1 = positionWorld;`). They behave exactly like `positionGeometry` from the editor's POV — `getFlowNodeType()` routes them to the generic ShaderNode, the cpuEvaluator returns `null` (geometry/camera attributes can't be sampled CPU-side, so downstream visualization falls back to `getNodeOutputShape()` for shape inference), and `ensureBareInputNode()` in codeToGraph auto-materialises them when bare references like `positionView.z` appear. Direction variants (`positionWorldDirection`, `positionViewDirection`) carry a cost of 7 (matches `normalize`); everything else is cost 0.

Use case: `Position (world) → distance(_, Camera Position) → Greater Than (_, slider) → Output.discard` discards fragments past a chosen world-space distance from the camera.

### Logic Nodes

`greaterThan`, `lessThan`, `equal` are regular two-input shader nodes (`category: 'logic'`, color `#7E57C2`, GPU cost 1). Both inputs declared as `'any'` — they broadcast like the arithmetic nodes. Output is `'any'` too; the cpuEvaluator emits 0/1 per channel for visualization, and `evaluateNodeRange` reports `[0, 1]` per channel so the EdgeInfoCard can show meaningful bounds. graphToCode emits them via the generic-call branch (no special handling needed). Designed to feed the Output node's `discard` port and the `select()` `condition` input.

### MaterialX Noise Nodes

8 noise variants share the same parameter convention:

- **Default values**: `{ pos: 'positionGeometry', scale: 1.0 }` — `pos` is a tslRef-style port (hidden by default, exposed via NodeSettingsMenu), `scale` is a numeric input editable inline.
- **Backing TSL functions** (all from `three/tsl`):
  - `perlin` → `mx_noise_float`, `perlinVec3` → `mx_noise_vec3` *(MaterialX Perlin-style; no `mx_perlin_noise_*` exists in three.js — `mx_noise_*` is the equivalent)*
  - `fbm` → `mx_fractal_noise_float`, `fbmVec3` → `mx_fractal_noise_vec3`
  - `cellNoise` → `mx_cell_noise_float`
  - `voronoi` → `mx_worley_noise_float`, `voronoiVec2` → `mx_worley_noise_vec2`, `voronoiVec3` → `mx_worley_noise_vec3`
- **Code generation** ([graphToCode.ts](src/engine/graphToCode.ts)): Dedicated `def.category === 'noise'` branch placed **before** the generic `inputs.length === 0 && defaultValues` branch (otherwise the generic branch would silently emit `mx_noise_float(positionGeometry)` and drop `scale`). Resolves `pos` from the exposed-port edge or stored value (default `positionGeometry`), then chains scale via `pos.mul(scale)` only when `scale !== 1`. Emits `const noise1 = mx_noise_float(positionGeometry.mul(2.5));` and imports `positionGeometry` automatically.
- **Live preview**: runs the generated TSL through the iframe pipeline (`graphToCode` → `tslToPreviewHTML` → `convertToShaderModule`), so the emitted `mx_noise_float(positionGeometry.mul(scale))` is what executes in the sandboxed preview.
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

### Discard Pipeline

`Discard(cond)` is a side-effect statement (not a value), so it doesn't fit the "every node has an output" model the rest of the registry follows. Instead, it lives as an extra **input port on the Output node** (`{ id: 'discard', label: 'Discard', dataType: 'float' }`, last in `def.inputs`).

- **OutputNode rendering** ([OutputNode.tsx](src/components/NodeEditor/nodes/OutputNode.tsx)): `discard` is in `PIXEL_PORTS` so it renders inside the Pixel Shader section when exposed. Hidden by default — not in `OUTPUT_DEFAULT_EXPOSED`.
- **ShaderSettingsMenu** ([ShaderSettingsMenu.tsx](src/components/NodeEditor/menus/ShaderSettingsMenu.tsx)): `discard` is in `OPTIONAL_OUTPUT_PORTS` alongside roughness/emissive/normal so a checkbox appears under "Output Ports". Toggling it off removes the wired edge via `removeEdgesForPort()`.
- **graphToCode emit** ([graphToCode.ts](src/engine/graphToCode.ts)): when an edge targets `output.discard`, resolves the source ref via `resolveEdgeRef()`, conditionally adds `Discard` to `three/tsl` imports, and emits `Discard(${ref});` as a `discardLine` inserted between `bodyLines` and `returnLine`. Order matters: discard must be after its dependency variables are defined; placing it last in the body satisfies that for any topologically-sorted graph. Discard is **not** a member of `OUTPUT_CHANNELS` (the array used to build the multi-channel return object) — it's strictly a side-effect statement.
- **codeToGraph parse** ([codeToGraph.ts](src/engine/codeToGraph.ts)): an `ExpressionStatement` visitor catches bare `Discard(arg);` calls and buffers the AST argument in `pendingDiscardArg`. The output node may not exist yet (it's created lazily by `ReturnStatement` / `output =` or by the no-output fallback), so wiring is deferred. After traversal completes, the buffered arg is resolved via `resolveReturnSource()` (handles Identifier / MemberExpression / CallExpression — same paths as a return value) and a typed edge is pushed into `output.discard`. The auto-expose pass in `useSyncEngine` then adds `'discard'` to `exposedPorts` because it has an incoming edge, so the toggle reflects the wired state without a manual checkbox poke.
- **Module-emit Fn re-wrap** (important): `Discard()` in TSL is `select(cond, expression('discard')).toStack()` — `.toStack()` only attaches to a live TSL execution stack, which exists inside an `Fn(() => …)` body. Both `convertToShaderModule()` in [tslToPreviewHTML.ts](src/engine/tslToPreviewHTML.ts) and [tslToShaderModule.ts](src/engine/tslToShaderModule.ts) unwrap the canonical `Fn(() => { … })` into a plain `function(params) { … }` so they can rewrite `uniform()` calls into `params.X` references. That unwrap destroys the stack — a bare `Discard(cond);` inside the resulting plain function becomes a silent no-op and live uniform changes can't move the discard threshold. To fix this, both emitters split bare `Discard(cond);` lines out of the body, build a small wrapper `Fn` immediately before the return, and route the color channel through it (object API) so the discard runs inside an active Fn stack and inlines into the compiled fragment shader. `Fn` is re-added to the `three/tsl` imports when this rewrite fires. Single-value `return colorVar;` shapes are promoted to object API (`return { colorNode: __pixel(...), … };`) when Discard is present.
  - **Why parameters, not closures**: the preview iframe runs Three.js r184 (bundled inside `a-frame-180-a-01.min.js`); the issue was first diagnosed on r173, where an `Fn` invoked at module scope didn't reliably wire closure-captured derived nodes (the upstream color chain and the condition node) into the compiled function body — `return mix1` resolved to a default and the mesh painted solid red. The explicit-parameter form below is retained as the robust pattern across r173→r184 (re-validate on r184 before relying on closures). The emitter therefore passes every node the wrapper needs as explicit `Fn` parameters: `const __pixel = Fn(([__c0, __color]) => { Discard(__c0); return __color; })` invoked as `__pixel(condNode, colorNode)`. Upstream defs still live in the outer plain function so they're built once at material-setup time; only their `node` references are threaded through the call. This compiles correctly in both r184 (iframe) and three 0.184 (node_modules).
- **Live preview**: works because the iframe path runs the generated TSL code through `convertToShaderModule()`, which now applies the Fn re-wrap.
- **Round-trip**: graph → code → graph preserves the discard wiring through the pending-arg + auto-expose dance. Toggle the port off and back on in settings without losing the edge by using "Save Code" (Ctrl+S) round-trips.

### React Flow Node Types

- **`shader`** — Generic node for most TSL operations (ShaderNode.tsx)
- **`color`** — Color picker with hex input (ColorNode.tsx)
- **`preview`** — Noise nodes with animated CPU canvas thumbnail (PreviewNode.tsx) — used by all 8 MaterialX noise variants
- **`mathPreview`** — Math function nodes with scrolling waveform visualization (MathPreviewNode.tsx)
- **`clock`** — Time node with animated analog clock face (ClockNode.tsx)
- **`output`** — Output sink with two sections: Pixel Shader (color, roughness, emissive, normal, opacity, **discard**) and Vertex Shader (displacement), plus `materialSettings` for export config (OutputNode.tsx). The `discard` port is hidden by default and exposed via ShaderSettingsMenu → Output Ports → Discard; wiring it emits a `Discard(cond)` statement in the generated TSL (see "Discard Pipeline" below).
- **`group`** — Selection group container (GroupNode.tsx) — owns members via `parentId`, has no registry entry, no shader semantics. Collapsible into a pill with synthetic boundary handles. See the **Groups** section for details.

### Node Visual Anatomy (header = cost, glyph tiles, consistent sockets)

Every editor node — and its NodePreviewCard preview — shares one anatomy. When modifying or adding nodes, keep these consistent:

- **Header** — filled with the node's **performance-impact (cost) color** (`getCostColor`), with auto-contrast title text (`getContrastColor`). The cost "points" badge stays centered *above* the node (`.node-base__cost-badge`), unchanged.
- **Body** — flat white surface (`var(--bg-panel)`).
- **Border** — `1.5px` solid in the node's **category color** (`CAT_HEX[def.category]`); category is read from the outline, not the header. **Frame style is fixed app-wide** — corner radius (8px) and border thickness are the same for every node and are NOT per-node customizable (only `width` is, via `customGlyphs.ts`).
- **Sockets** — type-colored (`getTypeColor`); see *Socket consistency* below.
- **Multi-channel stack** — when 2–4-channel data **arrives on a connected input** (widest edge wins; counts mirror `TypedEdge`), the node renders as **N stacked cards**: N−1 offset layers (3px steps, staggered `z-index` −1/−2/−3 so deeper layers paint first and every strip stays visible) as **siblings** of the card inside its cost-scale wrapper — never children, which would erase the card's bottom border. While stacked the card drops its own shadow; **only the deepest layer casts the single group shadow**. Source/constructor nodes never stack. (`node-base__stack` in `NodeBase.css`, structure in `ShaderNode.tsx`.)

#### Glyph visualizations (`nodes/glyphs/NodeGlyph.tsx`)

Light-theme SVG glyphs (ported from the v14 design mockup) illustrate what a node does — operator symbol, function plot, vector construction, input frame. `NODE_GLYPH_TYPES` / `hasNodeGlyph(type)` gate which registry types have one; per-node designer overrides in `glyphs/customGlyphs.ts` (`{ svg?, justify?, scale?, dx?, dy?, width?, sockets? }`, authored with `node-designer.html`) win over built-in art. Live-preview nodes (`time`, `sin`/`cos`, all noise) are intentionally excluded — they keep their canvases and only got the new header/border.

- **Operator layout (2-input glyph nodes)** — the glyph sits **between** the two inputs (`a` above, `b` below; values centered or per-node `justify`). The body keeps a 52px base height; **`scale` grows the glyph ONLY** (body grows just enough to fit — `max(52, glyphPx+10)`; socket/value spacing never changes). `dx`/`dy` nudge the art visually without affecting layout. **Socket positions are px offsets from the body center** (defaults a −12.5, b +12.5, out 0 — the classic 26%/74% spots), per-node movable via the designer with **4px snap** (`customGlyphs.ts → sockets`); each value label follows its socket.
- **Glyph icon + rows (other glyph nodes)** — `ShaderNode` renders a small glyph icon (`size=30`, `.shader-node__glyph`) between the header and the port rows. The glyph is **purely an icon — values are never drawn on top of it.** A designer `sockets[id]` / `sockets.out` override **detaches that socket from its row** and anchors it to the below-header region's center (same center-relative px convention as the operator layout); a detached input's **value widget follows its socket** (op-val styling), and the vacated row keeps its spacing. No override = classic row anchoring. Row-anchored inputs keep their value in the row, **horizontally aligned with that input's socket** (right after the `TypedHandle`):
  - **Unconnected** → editable `DragNumberInput` literal (the existing row control).
  - **Connected** → the value(s) on the **connecting edge** via `evaluateNodeOutput(source)`: one channel → the number (up to 2 decimals), multiple channels → **`min…max` range rounded to whole numbers** (integer part only: `-0.8…0.8` displays `-1…1`; endpoints compared *after* formatting so `3.687…3.694` collapses to a single `3.69`, and a range whose rounded ends meet collapses to that integer) — both blue `#2D6CDF`, `.shader-node__edge-val`. When the upstream isn't directly evaluable (texture chains), `evaluateNodeRange(source)` supplies an inferred range (gray, same integer rounding); geometry attributes carry analytical ranges (normals/tangents/view directions `-1…1`, `positionGeometry`/`positionLocal` `-0.8…0.8` → shown `-1…1`). **Nothing derivable → `…`** — a connected socket never shows a blank. Logic lives in the module-level `edgeValueLabel()` helper, shared by every input row; the `EdgeInfoCard` keeps precise 2-decimal figures with the same `…` separator.
- **No glyph** — interpolation, `hsl`/`toHsl`, `split`/`append`, `vec2`/`vec3`/`vec4`, position variants, `property`/`slider`, etc. render standard rows. **`float`/`int` are not glyph nodes** — they render as ordinary number rows like `vec2`/`vec3` (no knob).

#### Socket consistency

Sockets (`TypedHandle`) are **always visually constant and static** — no hover zoom, scale, movement, animation, or transition. A port looks identical whether idle, hovered, or mid-connection; only the instant text tooltip reacts to hover. Enforced in `TypedHandle.css` via `transition: none !important` and by **not touching `transform` on `:hover` at all — not even `transform: none`**: React Flow positions handles *via* transform (`translate(±50%, -50%)` for the side classes), so any hover transform override — the old `:hover { transform: none }` guard included — moves the socket and makes it jump under the cursor. **Do not re-introduce a `scale()` hover or any hover transform** on handles. Socket size is driven solely by `--handle-size` (10px desktop, 18px coarse-pointer) so every port matches across all node types. Sockets also never render stacked/ghost copies — multi-channel signal comes from the edges and the node-body stack.

#### Drag proximity (connection reveal)

While an output wire is dragged within **snapping distance** of a node — the reveal radius IS the editor's snap radius, one shared `CONNECTION_RADIUS = 40` constant in [connectionReveal.ts](src/components/NodeEditor/nodes/connectionReveal.ts), imported by NodeEditor — three escalating behaviors kick in (the pointer position from React Flow's raw `s.connection.to` is **screen/pane px** and is converted to flow coords with `s.transform` first):

1. **Nodes with named input sockets** force their input name-tooltips visible — floated to the **left** of each socket, behind it (`.typed-handle--reveal`, driven by TypedHandle's `reveal` prop) — so every target is readable while aiming and the socket + wire endpoint stay unobstructed. Applies to ShaderNode's rows layout (incl. designer-detached sockets), PreviewNode, and MathPreviewNode. Opted OUT (hover tooltips still work): **operator cards** (arithmetic, dot/cross/distance — generic a/b operands are noise), the **Output node** and **collapsed groups** (their rows/sockets already carry permanent labels).
2. **Chainable arithmetic** mounts its NEXT (grow) operand socket.
3. **Noise and Image nodes** additionally mount their hidden `exposedPorts` parameter sockets as dimmed floating dots on the card's left edge (`RevealSockets.tsx`, spread 25–75% of card height) — the card's resting layout **never changes** during a reveal. Landing the connection makes that port's exposure permanent (`exposeConnectedTarget`, shared by the connect and reconnect gestures); releasing elsewhere hides them again. The **Output node is deliberately excluded** — its hidden channels are exposed only via ShaderSettingsMenu (or auto-exposed when an edge arrives through sync/import).

### Asset Browser (ContentBrowser + NodePreviewCard)

The asset browser is a horizontal scrollable drawer at the bottom of the node editor, showing all available nodes grouped by category tabs. The Noise category lists all 8 MaterialX noise variants sorted by GPU cost ascending.

- **Search bar** — text input before the tab row, filters nodes by label, type, or description. Visible on all tabs (except Saved Groups which shows saved group cards).
- **Folder-style tabs** — styled like the CodeEditor TSL/Script tabs (top/side borders, rounded top corners, `bottom: -1px` overlap so active tab merges with content). Font size 17px, bold (600 weight). Each tab has a tinted category-color background: ~8% opacity when inactive, ~20% when active. The items area below also tints with the active category color at ~10% opacity. A `CAT_HEX` map in ContentBrowser holds raw hex values (the main `CATEGORY_COLORS` uses CSS variables which can't take alpha suffixes).
- **Scrollbar hidden** on the items row (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`). Horizontal scrolling works via vertical-to-horizontal wheel conversion (same listener on both the tabs row and the items row).

**NodePreviewCard** dispatches to visual variants based on `getFlowNodeType(def)` and `def.type`, matching the editor node appearance:

| Flow Type | Renderer | Visual |
|-----------|----------|--------|
| `'shader'` | ShaderCardContent | Exact inert replica of the live node — same classes/widgets (real DragNumberInput, live handle geometry) **incl. all designer overrides** (operator layout, width/height, justify, text scale, moved sockets); 1:1 proportions (`--exact` opts out of card size overrides) |
| `'mathPreview'` | MathCardContent | Header + 72x72 waveform canvas + input/output dots |
| `'preview'` (noise) | NoiseCardContent | Header + 96x96 pixelated CPU noise canvas + output dot |
| `'clock'` | ClockCardContent | Header + 56x56 circular clock face + output dot |
| `def.type === 'slider'` | SliderCardContent | Header + track/fill/thumb slider + min/value/max labels + output dot |
| `'color'` | ColorCardContent | 84x84 color circle + contrast-aware label + output dot |

- **Cost coloring**: NodePreviewCard reads `costColorLow`/`costColorHigh` from the zustand store and passes them to `getCostColor()`/`getCostTextColor()`, ensuring consistent cost-based coloring across editor nodes, MiniMap, and content browser.
- **Matches editor anatomy** (see *Node Visual Anatomy*): cards use the same cost-colored header (auto-contrast title), white body, and category-colored border as live nodes; `ShaderCardContent` renders the same small glyph icon above the port rows for glyph nodes (default values shown statically; cards have no live edges so no connected-value labels).
- **Math/noise/clock previews**: CPU-rendered once on mount using existing `renderMathPreview()`, `renderNoisePreview()`, and ClockNode drawing code (frozen at mount time).
- **All sub-renderers** are proper React components (not called as functions) so hooks work correctly.
- **Drag-to-create**: All cards are draggable; dropping on the canvas creates the corresponding node.

### ShaderNode Vector Display

ShaderNode handles Vector3/Vector2 parameters with grouped inputs:

- Detects `_x`/`_y`/`_z` suffixed keys in defaultValues and groups them into `vec3` or `vec2` rows
- Each vector row shows: base key label + 2-3 compact `DragNumberInput` controls
- Non-port settings (colors, vec3, vec2) are collected and appended as extra rows after input ports
- `float`/`int`/`vec2`/`vec3`/`vec4` type constructors all render as plain number rows (no knob/glyph) so they read identically — see *Node Visual Anatomy*.

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
- **Cycle guard** ([cpuEvaluator.ts:184-189](src/engine/cpuEvaluator.ts#L184-L189)): Before recursing, `evaluate` writes a `null` sentinel into the cache for the current `nodeId`. Any cyclic back-edge hits the sentinel via the `cache.has(nodeId)` check at the top and returns null instead of recursing forever. The real result overwrites the sentinel at the end of the function. Without this guard, a graph cycle (which `topologicalSort` warns about but still produces output for) would crash `<TypedEdge>` with `Maximum call stack size exceeded` on every render and blank out the entire edge layer.
- **Strict null propagation** (important): When an input port is connected to an upstream node, the upstream result is authoritative — including `null`. The `channelInput` helper does NOT silently fall back to the inline value when an edge exists. This was a bug fix: previously `sub(perlinNoise, 0.5)` would compute `sub(0, 0.5) = -0.5` (length 1) because perlinNoise returned null and channelInput substituted the inline default, fooling the visualization layer into thinking a 3-channel chain was a single float.
- **Supported nodes**: time, float/int/property_float/slider, screenUV, uv (with tiling/rotation), vec2/vec3/vec4/color constructors, all arithmetic (add/sub/mul/div), all unary math (sin/cos/abs/sqrt/exp/log2/floor/round/fract/oneMinus), binary math (pow/mod/min/max/clamp), interpolation (mix/smoothstep/remap/select), vector ops (length/distance/dot/normalize/cross/append), all 8 MaterialX noise variants (sampled at UV center, scaled)
- Returns `null` for unevaluable nodes (positionGeometry, normalLocal, tangentLocal, anything downstream of one — evaluation can't sample geometry attributes on the CPU)

#### Static shape inference

- **`getNodeOutputShape(nodeId, nodes, edges)`** → `number` (1–4). Walks the graph using port type info and broadcast rules to compute the *expected* channel count even when eval returns null. Has its own `visited` set for cycle protection. Concrete output port types (vec2/vec3/vec4/color/float/int) win immediately; for `'any'` outputs it sums input shapes for `append` and takes the max otherwise (broadcast rule: vec3 + scalar = vec3).
- **`getComponentCount(nodeId, nodes, edges)`** → `number` (1–4). Tries `evaluateNodeOutput` first; falls back to `getNodeOutputShape` when eval returns null. Used by [graphToCode.ts](src/engine/graphToCode.ts) to pick the right vector constructor for shape-dependent nodes like `append`.

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

### Data Node (CSV import)

Dropping a `.csv` on the canvas creates a hidden **Data node** (`type: 'dataNode'`, category `input`, excluded from the palette — its outputs are per-instance):

- **Parsing** ([csvParser.ts](src/utils/csvParser.ts)): strict adversarial parse — delimiter autodetect (`,` `;` tab), multi-row header join, **every data cell must be a finite number**, caps 16 columns / 1M rows. A drop wider than 10 columns queues a `CsvImportModal` (cancel / place as-is / **transpose** rows→columns).
- **Payload** ([dataNode.ts](src/utils/dataNode.ts)): columns are packed column-major into one base64 **Float32** blob on `values.dataB64`, with per-column `dynamicOutputs` (`col0`, `col1`, …). Column names are UI-only — they never reach codegen.
- **Code generation** ([graphToCode.ts](src/engine/graphToCode.ts)): `decodeDataNode()` → a baked `THREE.DataTexture` (half-float via [binaryCodec.ts](src/utils/binaryCodec.ts) — WebGPU can't filter float32 textures without an unrequested device feature). A malformed payload degrades to an inert fallback.

### Data Stripes & Data Viz Nodes

Two palette-visible nodes (category `color`) turn a Data node column into a shader pattern:

- **Data Stripes** (`stripes`) — phase-accumulation stripes whose density tracks the data. `buildPhaseRamp()` in [dataViz.ts](src/utils/dataViz.ts) emits a **prefix-sum cumulative phase** ramp (so stripe density never tears), baked into a `HalfFloat` DataTexture; `totalCycles` stays off-texture for float16 precision. Settings via `StripesSettingsMenu` — strength + radial (rings) mode with center X/Y + radius.
- **Data Viz** (`dataviz`) — a color-ramp heatmap of the normalized column with a tone curve (scale, offset, low/high cutoffs, midpoint, contrast) + radial distribution, set via `DataVizSettingsMenu`. It has **two** outputs (Color `vec3` + Value `float` for displacement) — the only multi-output def besides `split` and the Data node.

Both are emitted by dedicated branches in `graphToCode` (their `tslFunction` is empty; the pure DSP lives in `dataViz.ts`, consumed only by codegen).

### Image Node

Drag-dropped images become a hidden **Image node** (`type: 'imageNode'`, category `texture`, mirrors the Data pipeline). The payload is a whitelisted `data:` URL on `values.imageB64` and is treated as **adversarial**:

- **Drop-time re-encode** ([imageImport.ts](src/utils/imageImport.ts), DOM-only): decode with `createImageBitmap` (honoring EXIF orientation), then canvas re-encode to a bounded `data:` URL — strips EXIF/GPS, WebP→PNG(alpha)→JPEG(Safari) via returned-MIME detect (PNG sources stay lossless within budget), with downscale-retry. SVG is rejected outright. Over-limit images queue a `LimitModal` (600K chars/image soft cap with downscale-retry · 3M total · 64 MP source guard · 8M-char hard ceiling) with an ignore-limits opt-out (`fs:ignoreImageLimits`).
- **Validation is pure/node-testable** ([imageNode.ts](src/utils/imageNode.ts)): `validImageDataUrl` / `decodeImageNode` / `sanitizeImageNodes` / `collectImageFiles`. The split from the DOM-only `imageImport` is deliberate so validation runs under the node test env.
- **Code generation** re-encodes the *decoded bytes* (never interpolates the stored string) into flat module-scope statements with top-level `await`: `new Image()` → `try { await decode() } catch` → 1×1 fallback → `THREE.Texture` (RepeatWrapping, pinned flipY, sRGB or linear per `values.colorSpace`). Malformed payloads render an inert `vec3(0,0,0)`.
- **UV / Texture controls** (`NodeSettingsMenu`): `tileX/tileY`, `offsetX/offsetY`, `repeat` (off → ClampToEdge), `flipX`/`flipY`, and the data-map toggle. The five inputs (`uv`, `tileX/tileY`, `offsetX/offsetY`) follow the same opt-in exposed-port rules as the noise nodes.
- **Download with images** produces a `.zip` (see *Project Files → ZIP export*); the self-contained `.js` still embeds each image as a `data:` URL, so a bare `.js` remains runnable on its own.

---

## Type System

**Data types**: `float | int | vec2 | vec3 | vec4 | color | any`

Each type has a distinct color for handles and edges:

- float: `#3366CC` (blue), int: `#20B2AA` (teal), vec2: `#4A90E2` (sky), vec3: `#E040FB` (magenta), vec4: `#AB47BC` (purple), color: `#E8A317` (gold), any: `#607D8B` (slate)

Socket handles render this color as a constant disc — no hover zoom/scale/animation (see *Node Visual Anatomy → Socket consistency*).

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
- **Right-click** → Opens EdgeContextMenu (Delete + "Add routing point")
- **Double-click edge** → Drops a routing waypoint at the click point (see Routing Waypoints below)
- **Invisible hit area**: 20px wide transparent stroke path for easy interaction

### Routing Waypoints

Edges can be curved through user-placed points so wires route around nodes.

- **Add**: double-click an edge, or right-click → **"Add routing point"** (EdgeContextMenu). Both funnel through `insertWaypointOrdered()` + `store.setEdgeWaypoints(edgeId, next, { history: true })`. **Remove**: double-click the point dot.
- **Storage & scope**: waypoints live on `edge.data.waypoints` (an array of `{x, y}` in **flow coords**) and are **visual-only** — `graphToCode`/`cpuEvaluator` never read them. They persist via the localStorage graph autosave and participate in undo (`setEdgeWaypoints` pushes history once per gesture), and are carried across a code→graph resync by endpoint match in `useSyncEngine` (like groups; a fresh `.js`/zip import starts without them).
- **Spline**: the wire curves through the points as a Catmull-Rom spline. **The renderer and the drop-on-edge hit test share [bezierGeometry.ts](src/components/NodeEditor/edges/bezierGeometry.ts)** — a routed edge is measured against the SAME spline it draws (`distancePointToSpline`), so what highlights on hover is exactly what snaps.

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
- **Shift+A**: Open the Add Node menu at canvas centre (search autofocused; keyboard-only node adding)
- **Delete/Backspace**: Remove selected nodes and/or selected edges. React Flow's built-in delete is disabled (`deleteKeyCode={null}`); the manual handler in `NodeEditor.tsx` reads both `n.selected` and `edge.selected`. Deleting a group dissolves it first (children lifted) so they aren't orphaned with a dangling `parentId`. **Splice-delete**: the outgoing edges of a deleted node are re-parented to the upstream source of its first connected input via `bridgeEdgesAcrossDeletedNodes()`, so chains like `X → A → B → C` with A+B selected collapse to `X → C`. Multi-output deleted nodes fan out from the same live upstream; single-input-per-port is preserved by dropping duplicate bridges. Same helper is wired into `store.removeNode`, so every deletion path (Delete key, context menu, programmatic) behaves identically.

### Mouse Interactions

- **Left-drag on canvas**: Box selection (partial overlap mode — `SelectionMode.Partial`)
- **Middle/right-drag on canvas**: Pan (works even over selected-node regions — a capture-phase `mousedown` handler temporarily strips the `nopan` class from React Flow's `__nodesselection` wrapper so d3-zoom's filter lets the event through)
- **Scroll**: Zoom (0.1x – 3x range)
- **Right-click canvas**: Opens AddNodeMenu (searchable node palette + "Group Selection" entry when ≥2 non-group nodes are selected)
- **Right-click box selection**: Opens AddNodeMenu (same as canvas — shows "Group Selection" at top when ≥2 groupable nodes are selected). Uses React Flow's `onSelectionContextMenu`.
- **Right-click node**: Opens NodeSettingsMenu (edit values, duplicate, delete)
- **Right-click output node**: Opens ShaderSettingsMenu (cost, ports, displacement, material, uniforms)
- **Right-click group**: Opens GroupSettingsMenu (rename, recolor, save to library, ungroup)
- **Right-click edge**: Opens EdgeContextMenu (delete + Add routing point)
- **Drag from handle → release on empty space**: Opens AddNodeMenu at drop position
- **Drop node on edge**: Inserts node between source and target (curve-proximity detection via the shared `bezierGeometry.ts` math, within `DROP_ON_EDGE_RADIUS` = 12 screen-px ÷ zoom). Works both for existing nodes dragged on the canvas **and** for new nodes dragged from the asset browser. (Distinct from `CONNECTION_RADIUS` = 40, the separate wire-snap/reveal radius passed to React Flow's `connectionRadius` prop.) Suppressed while a drag-connect preview is active — node-body hover wins over the edge highlight, and the drop never splices over a node body (what wasn't previewed is never committed).
- **Drag node onto node (drag-connect, `dragConnect.ts`)**: dragging a node so its CENTER lands on another node's body proposes a connection — the hovered node and the chosen input socket ring, a tooltip names it, and releasing commits exactly what the tooltip showed. Direction follows the side (dragged left of hover → dragged.out feeds hover.in), vertical alignment picks the best (output, input) pair, free inputs beat occupied, and cycles are never offered (checks run on the unwrapped logical graph). The drop snaps the node beside its peer and `overlapCascade.ts` makes room. Palette tiles drag-connect too (planned as a `TILE_PHANTOM_ID` phantom; click/Enter adds never connect). Wire-connects and drop-connects share one `applyConnection` (single-input enforcement, hidden-socket exposure, image→normal colorSpace flip).

### Drop-on-Edge Insertion

When a node is dragged and dropped near an existing edge:

1. Measures the cursor's distance to each edge's drawn curve via the shared [bezierGeometry.ts](src/components/NodeEditor/edges/bezierGeometry.ts) math — `distancePointToCubicBezier()` for a plain edge, `distancePointToSpline()` for a routed (waypoint) edge — so hit-testing always matches the exact spline the renderer draws
2. `findNearestEdge()` returns the closest edge within `DROP_ON_EDGE_RADIUS` (12 screen-px ÷ current zoom)
3. `tryInsertOnEdge()` removes the original edge and creates two new edges through the dropped node
4. Uses first input and first output ports of the dropped node's registry definition

**Works for two paths:**
- **Existing nodes** — `onNodeDrag` highlights the candidate edge (thick stroke via `fs-edge-drop-target` CSS class, applied directly to the DOM via ref — not store — to avoid rerenders on every drag frame). `onNodeDragStop` calls `tryInsertOnEdge()`.
- **Asset browser drags** — `onDragOver` converts screen coords to flow-space via `screenToFlowPosition` and highlights the candidate edge. `onDrop` creates the node via `addNode` then calls `tryInsertOnEdge()`.

Both paths share the same module-level helpers (`getNodeSize`, `findNearestEdge`, `tryInsertOnEdge`), with the curve/spline distance math factored into `bezierGeometry.ts` (`bezierDist` no longer exists), to avoid duplication.

History is pushed once in `onNodeDragStop` (covering both the position change and any edge insertion). Click-only events (no drag) are skipped via `DRAG_HISTORY_THRESHOLD = 2px` so the undo buffer isn't polluted with no-ops.

### Anti-Overlap

After a **non-connect** drop, `onNodeDragStop` checks for AABB overlap with all other nodes; if overlapping, it computes the minimum push-out direction (right/left/down/up) and nudges the dropped node with a 10px gap. **Connect drops** (see *Drag node onto node* above) instead keep the newly connected pair fixed and make room via `overlapCascade.ts` — overlapped nodes escape along the cheapest single axis (+10px gap) that clears all offenders and the settled set, with knock-on pushes rippling outward (BFS, settle-once). Group containers are skipped in both paths — they don't push their members aside.

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
- `'note'` → NoteSettingsMenu
- `'stripes'` → StripesSettingsMenu
- `'dataviz'` → DataVizSettingsMenu

### AddNodeMenu

- Auto-focused search input
- Grouped by category when not searching, flat list when searching; in browse view (empty search) a **Recent** section floats above the category list — the last-used node types, newest first (deduped, capped at 6, `output` excluded, persisted to `fs:recentNodes` via `recentNodes.ts`; display-order only, throw-safe so private mode just means no recents). Recent rows participate in keyboard navigation under distinct `recent:`-prefixed keys, so a def appearing both there and in its category is two independent focus stops
- **Keyboard navigation** — full ArrowUp / ArrowDown / Home / End / Enter handling on the search input. A `focusedIndex` state walks a flat `actionItems[]` list built in **render order** (Group Selection entry → Output entry → grouped/flat defs) so the highlight follows what's actually drawn. Reset to 0 whenever the visible list changes (`useEffect` keyed on `actionItems.length` and `query`). The focused row gets `.context-menu__item--focused` (stronger background + 2px inset accent) and is scrolled into view via `el.scrollIntoView({ block: 'nearest' })` after every move. Mouse `onMouseEnter` syncs `focusedIndex` to the hovered row so keyboard and mouse stay in agreement. Enter runs `actionItems[focusedIndex].run()` — adds the highlighted node, runs Group Selection, or adds the Output entry as appropriate.
- **Enter without arrows** — still works: when the user types and presses Enter without arrowing, `focusedIndex` is 0 (auto-reset on query change) so Enter adds the top-ranked search result, preserving the original "type `invert` + Enter" workflow.
- Maps node to React Flow type: output→`'output'`, time→`'clock'`, color→`'color'`, noise category→`'preview'`, sin/cos→`'mathPreview'`, else→`'shader'`
- Places node at context menu screen position via `screenToFlowPosition()`
- Prevents adding multiple output nodes
- **Group Selection** — when ≥2 non-group nodes are selected and the search is empty, a top-of-menu entry calls `groupSelection()` (same path as Ctrl+G). Shows a `N nodes` count badge. Participates in keyboard navigation as the first `actionItems[]` entry.
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
- **Output Ports**: Checkboxes to toggle optional ports (roughness, emissive, normal, **discard**); hiding a port removes connected edges via `removeEdgesForPort()`. Opacity port is auto-managed by Transparent/Alpha Clip toggles. `discard` is also auto-exposed when the code→graph parser wires it from a `Discard(cond)` statement (see useSyncEngine auto-expose pass).
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
- **title size** — number input (range slider) that patches `data.titleSize` via `updateGroupData()`. Values >1 scale the header height and font proportionally (`22 * titleSize` px header, `font-size-xs * titleSize` label).
- **Save to Library** — calls `saveGroupToLibrary(groupId)`; the snippet shows up in the asset bar's "Saved Groups" tab.
- **Ungroup** — dissolves the container, lifts children back to root (or to the grandparent group), and restores their absolute positions.

### DragNumberInput

- **Drag mode**: Hold + drag left/right to change value (BASE_SPEED=0.005, acceleration factor 0.002)
- **Edit mode**: Click to enter text editing, Enter/Escape/blur to commit
- **Arrow buttons**: ◂/▸ with configurable step (default 0.1)
- **Rounding**: 4 decimals internal, 2 decimals display

---

## Groups (GroupNode.tsx + store)

Selection groups are first-class React Flow nodes (`type: 'group'`) that own member nodes via `parentId`. They have no registry entry, no inputs/outputs while expanded, and no shader semantics — `graphToCode`/`cpuEvaluator` ignore the *node* entirely, but they call `unwrapCollapsedGroupEdges()` (see below) at their entry to translate any visually-rewritten boundary edges back to their real child endpoints, so the group's collapse state never affects compiled output.

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

- **`nodeEditorBgColor`** store field — the effective active-theme canvas color, remembered **per theme** as `nodeEditorBgColorLight` / `nodeEditorBgColorDark` (localStorage `fs:nodeEditorBgColor` / `fs:nodeEditorBgColorDark`; light default `#FAFAFA`, dark default `#1e1f22`). Wired to React Flow's root via `style={{ background }}` and to a color swatch button slotted inside the React Flow `<Controls>` next to the +/- buttons (custom CSS in [NodeEditor.css](src/components/NodeEditor/NodeEditor.css)). Also passed as `--canvas-bg` CSS variable on the `.node-editor` wrapper, consumed by the content browser (`background: var(--canvas-bg, var(--bg-panel))`) so the asset drawer background matches the canvas.
- **Background pattern**: `BackgroundVariant.Cross` — cross/plus pattern with `gap: 20`, `size: 1`. The grid `color` is theme/contrast-driven (light: `#BBBBBB`; dark canvas: `rgba(255,255,255,0.12)`), computed in `NodeEditor.tsx` and passed as a prop.
- **`getContrastColor(hex)`** in [colorUtils.ts](src/utils/colorUtils.ts) returns `'#000000'` or `'#ffffff'` based on Rec. 601 luminance (threshold 0.55).
- **Cost badges** — [NodeBase.css](src/components/NodeEditor/nodes/NodeBase.css) defines `.react-flow .node-base__cost-badge` that reads `--node-cost-text` / `--node-cost-text-shadow` CSS vars set on the `.node-editor` wrapper from `getContrastColor(nodeEditorBgColor)`. The `!important` is needed to override the inline cost-gradient color the components still pass — that inline color only applies to NodePreviewCard tiles in the asset bar (outside React Flow's scope), where it should keep cost-gradient text.
- **1-channel edges** — [TypedEdge.tsx](src/components/NodeEditor/edges/TypedEdge.tsx) reads `nodeEditorBgColor` and substitutes `getContrastColor()` for the single-channel edge color (formerly hardcoded `#000000`). Multi-channel R/G/B(A) edges keep their saturated colors.

---

## Theme Toggle (App-Wide Dark Mode)

- **`codeEditorTheme: 'vs' | 'vs-dark'`** store field, persisted to `fs:codeEditorTheme`. The sun/moon button in the code editor tab bar (after Save / Load Script / Download Script) is the **one** dark-mode control for the whole app — not just Monaco.
- **`setCodeEditorTheme(theme)`** does two things: (1) applies the theme to both Monaco editors (TSL, Script), and (2) stamps `data-theme="dark"` (or `"light"`) on `<html>` via `applyThemeAttribute()`. An inline FOUC guard in `index.html` sets that attribute from `fs:codeEditorTheme` **before first paint**, so the chrome never flashes light while the bundle loads; the store re-applies it on every toggle.
- **Chrome tokens flip, node visuals don't**: `data-theme="dark"` flips only the CHROME tokens redefined in the `:root[data-theme="dark"]` block of [tokens.css](src/styles/tokens.css) (backgrounds, text, borders, chrome shadows, `color-scheme`). **Graph nodes render identically in both themes** — node bodies read the theme-invariant `--node-bg` (not `--bg-panel`), and `--shadow-node*` / `--type-*` / `--cost-*` / `--cat-*` are deliberately **not** redefined in the dark block.
- **Canvas background is remembered PER THEME**: the store keeps `nodeEditorBgColorLight` / `nodeEditorBgColorDark` (persisted to `fs:nodeEditorBgColor` / `fs:nodeEditorBgColorDark`; light default `#FAFAFA`, dark default `#1e1f22`), and `nodeEditorBgColor` is the effective active-theme value the toggle swaps in. The color swatch writes back to whichever per-theme slot is active.
- **React Flow surfaces flip via props, not tokens**: the dot-grid color and the minimap mask are computed in [NodeEditor.tsx](src/components/NodeEditor/NodeEditor.tsx) from `isDarkTheme` (the grid also tracks canvas contrast) and passed as props, since they're SVG fill / canvas paint rather than CSS-token-driven.

---

## Design System (tokens.css)

- **Theme**: Light by default, with an app-wide **dark mode** toggled by the code-editor sun/moon button (see "Theme Toggle" below) — flat design, node shadows tuned **dark + sharp** so they read against any canvas background, not feathery. Only chrome tokens flip in the `:root[data-theme="dark"]` block; graph nodes stay theme-invariant.
- **Font**: Inter (sans), JetBrains Mono (mono)
- **Spacing**: 4px base scale (--space-1 through --space-8)
- **Shadows**: 4 levels (sm, md, lg, node). `--shadow-node` is a two-layer combo — tight contact shadow (`0 1px 2px rgba(0,0,0,0.55)`) + slightly diffused offset (`0 3px 6px rgba(0,0,0,0.4)`) — small blur radii keep edges crisp
- **Cost visualization**: Nodes scale (up to 1.35x) and blend color based on GPU cost (green→amber→red). Costs calibrated against mobile GPU SFU quarter-rate (add=1, sin/cos=4, pow=12). Noise costs (recalibrated 2026-07-23 from measured Quest 3 / Adreno 740 GPU-timestamp benchmarks — see `ShaderCarousel/benchData/`): cellNoise=12, perlin=35, perlinVec3=75, fbm=105, fbmVec3=190, voronoi=230, voronoiVec2=235, voronoiVec3=245. Budgets assume 3–5 concurrent shaders in scene.
- **Category colors**: Each node category has a distinct accent color for the header strip (defined as raw hex in `CAT_HEX` in [colorUtils.ts](src/utils/colorUtils.ts) and published at runtime as `--cat-*` CSS vars on `:root`, consumed by `CATEGORY_COLORS`)
  - input (#4CAF50), type (#2196F3), arithmetic (#FF9800), math (#9C27B0), interpolation (#00BCD4), logic (#7E57C2), vector (#E91E63), noise (#795548), color (#FF5722), unknown (#9E9E9E), output (#f44336)
  - `--cat-texture: #8D6E63` is used by ContentBrowser for the Textures tab background tint (via `CATEGORY_COLORS.texture` in colorUtils.ts and the `texture` entry in nodeCategories.ts). No node has `category: 'texture'` in the registry, but the category exists as a special tab that shows built-in texture groups.

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

Shared constant exported from `graphToCode.ts`, imported by `codeToGraph.ts` (for the member-expression → split-node pattern). Contains `{'x', 'y', 'z', 'w'}` for split node swizzle validation.

### Three.js TSL Imports Used

**Code generation** (`graphToCode.ts`): Fn, float, int, vec2, vec3, vec4, color, uniform, uv, add, sub, mul, div, sin, cos, abs, pow, sqrt, exp, log2, floor, round, fract, oneMinus, mod, clamp, min, max, mix, smoothstep, normalize, length, distance, dot, cross, positionGeometry, positionLocal, positionWorld, positionView, positionWorldDirection, positionViewDirection, cameraPosition, cameraNear, cameraFar, normalLocal, tangentLocal, time, screenUV, remap, select, greaterThan, lessThan, equal, Discard, mx_noise_float, mx_noise_vec3, mx_fractal_noise_float, mx_fractal_noise_vec3, mx_cell_noise_float, mx_worley_noise_float, mx_worley_noise_vec2, mx_worley_noise_vec3. *(`hsl` and `toHsl` are emitted as module-local `Fn` helpers, not imported — `three/tsl` (r173 or r184) does not export them. `Discard` is added to imports only when the Output node has a wired `discard` port.)* This generated TSL is what runs in the live preview (via the iframe pipeline), so live preview and generated code stay pixel-for-pixel identical, including the discard path.

### Persistence (localStorage)

- `fs:graph` — nodes + edges (auto-save every 300ms)
- `fs:splitRatio` — left/right panel ratio
- `fs:rightSplitRatio` — code/preview ratio
- `fs:previewGeometry` — selected preview geometry type
- `fs:previewLighting` — preview lighting mode (`'studio' | 'moon' | 'laboratory'`)
- `fs:previewSubdivision` — preview mesh subdivision count (1–256)
- `fs:previewBgColor` — preview background hex color
- `fs:previewUniformBounds` — JSON map of `{ uniformName: { min, max } }` per shader uniform slider
- `fs:previewUniformValues` — JSON map of per-name uniform values (persists tuning by name across graph edits)
- `fs:previewCameraPos` — last orbit-camera position (survives reloads)
- `fs:previewRotation` — last object spin angle (degrees)
- `fs:previewPlaying` — spin play/pause state
- `fs:shaderName` — shader name (via `loadString()` helper)
- `fs:headsetId` — selected VR headset (via `loadString()` helper)
- `fs:costColorLow` — cost gradient low color
- `fs:costColorHigh` — cost gradient high color
- `fs:nodeEditorBgColor` — canvas background hex color (light theme; also holds the active-theme value)
- `fs:nodeEditorBgColorDark` — canvas background hex color for the dark theme (per-theme slot; default `#1e1f22`)
- `fs:codeEditorTheme` — app-wide theme (`'vs' | 'vs-dark'`): themes Monaco AND stamps `data-theme` on `<html>`
- `fs:savedGroups` — JSON array of `SavedGroup` snapshots (group + members + internal edges)
- `fs:ignoreImageLimits` — user opted out of image size/pixel caps (set via the LimitModal checkbox)
- `fs:assetBarCollapsed` — ContentBrowser (asset bar) collapse state
- `fs:assetZoom` — ContentBrowser (asset bar) tile zoom level (Ctrl/Cmd+wheel over the strip or the floating +/− buttons)
- `fs:recentNodes` — recently-added node types, floated to the top of the AddNodeMenu browse view (`recentNodes.ts`)
- `fs:lang` — UI language (`'en' | 'lv'`), see *Internationalization*
- `fs:hideImageDownscaleWarning` — user opted out of the image downscale notice
- `fs:drawColor` / `fs:drawOpacity` / `fs:drawWidth` — canvas drawing-layer pen preferences (DrawingLayer/DrawToolbar)
- `fs:viewerBounds` — standalone `podest.html` per-uniform slider bounds (that page owns this key, separate from the editor). Sibling keys `fs:viewerBg`, `fs:viewerSpinSpeed`, `fs:viewerSpin` persist that page's background color and spin speed/on-off

> **Not storage keys:** `fs:uniform`, `fs:camera`, `fs:rotation`, `fs:reset-camera`, `fs:bg-color`, `fs:lighting`, `fs:playing`, `fs:geometry`, `fs:preview-ready`, `fs:preview-error`, `fs:obj-model`, `fs:obj-model-error`, `fs:preview-drag`, `fs:preview-drop` are **postMessage** types between ShaderPreview and the preview iframe; `fs:scene-booted` is a plain **window Event** dispatched and consumed inside the preview iframe (and `podest.html`) itself as the scene-injection handshake; `fs:project-imported` is a **window CustomEvent** dispatched by `projectImport`.

### History System

- 50-entry undo/redo stack
- `pushHistory()` called before: node drag, connection, paste, duplicate, delete, edge drag-to-disconnect
- **Gesture bracketing**: `beginInteraction()`/`endInteraction()` snapshot ONCE up front and suppress `pushHistory` until the gesture ends — a DragNumberInput scrub or waypoint drag is one undo entry, not one per pointermove frame (also avoids `structuredClone`-ing the whole graph 60×/s). `beginInteraction` deliberately ignores `isUndoRedo`; DragNumberInput brackets on first move and closes on pointerup/pointercancel/unmount.
- `isUndoRedo` flag prevents sync during undo/redo operations

### Deployment

**Deploy order — submodule FIRST, then the main repo.** The vendored A-Frame bundle + shaderloader live in the `a-frame-shaderloader` git submodule (its own GitHub repo). Whenever that vendored code changed (e.g. a new `a-frame-shaderloader-0.5.js`), do this **before** any main-repo deploy or `npm version`:

```bash
# 1. In the submodule: commit the vendored change and push it to ITS master.
cd a-frame-shaderloader
git add js/a-frame-shaderloader-0.5.js        # + any other changed vendored file
git commit -m "js: <what changed>"
git push origin master                        # makes the jsdelivr @master CDN URL resolve
# (jsdelivr caches branch refs ~12h + caches 404s — force-refresh a brand-new file via
#  https://purge.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/a-frame-shaderloader-0.5.js)

# 2. Back in the main repo: bump the recorded submodule pointer, THEN version + push.
cd ..
git add a-frame-shaderloader                   # records the new submodule commit
git commit -m "chore: bump shaderloader submodule"
npm version patch && git push --follow-tags    # tag release → CI (see Release flow)
```

Why the order is load-bearing — two independent failures if the main repo ships first:

1. **CDN 404**: exported shader `.js` files reference the loader on jsdelivr at `@master` (`CDN_BASE` in [tslToShaderModule.ts](src/engine/tslToShaderModule.ts)), served from the **submodule's** GitHub repo — not from this app's gh-pages. Deploy the app before pushing the submodule and every freshly-exported shader loads a loader URL that 404s for anyone hosting it elsewhere. (The app's OWN preview + podest load the loader from `public/js/` off the app origin — committed here, deployed with gh-pages — so they work regardless; only shared/self-hosted **exports** depend on the CDN.)
2. **CI drift-guard**: `release.yml` checks out the submodule at the pointer recorded in the main repo (`submodules: recursive`), and the `fs-vendor-sync` plugin copies `a-frame-shaderloader/js/*` → `public/js/`; `vendorSync.test.ts` fails on drift. If the recorded pointer lacks a loader that `public/js/` already carries, the copy/drift check breaks the release. So the submodule-pointer bump (step 2's `git add a-frame-shaderloader`) must be committed **before** `npm version patch` — which refuses a dirty tree anyway, so a clean, pointer-bumped commit is mandatory before tagging.

- **GitHub Pages** (primary): `npm run deploy` = `npm run build && gh-pages -d dist` for ad-hoc web-only pushes; tagged releases deploy automatically in lockstep with the desktop binaries (see Release flow below). Both paths still require the submodule prerequisite above when the vendored code changed.
- **Configurable base + CSP via env vars** ([vite.config.ts](vite.config.ts)): `FS_BASE` sets the Vite base path (default `/FastShaders/`); `FS_PREVIEW_ORIGIN` appends space-separated origin(s) to the build-time CSP `connect-src` — required because the sandboxed preview iframe has an **opaque origin** (its `'self'` resolves to `null`), so the deploy domain must be whitelisted explicitly; `FS_DESKTOP=1` selects the desktop profile (see "Desktop build" below). No `.env` files exist — these are read from `process.env` (shell env) at build time. Example self-host build: `FS_BASE=/fastshaders/ FS_PREVIEW_ORIGIN='https://alvismisjuns.lv https://www.alvismisjuns.lv' npm run build`. The CSP contains **no CDN origins** — Monaco and the fonts are bundled with the app (offline requirement; never reintroduce `cdn.jsdelivr.net` / `fonts.googleapis.com`); the only remote entry is `https://alvis1.github.io` (opaque-origin iframe fetches) plus any `FS_PREVIEW_ORIGIN`.
- **Standalone viewer "Podest"** (`public/podest.html`) ships inside every deploy at `<base>podest.html` — no separate pipeline; it loads the vendored A-Frame bundle off the page's own origin, so it works anywhere the app is hosted.
- **Source vs deployed**: `main` holds source, `gh-pages` is the orphan branch with built `dist/` output. CI: [`ci.yml`](.github/workflows/ci.yml) typechecks + tests on push/PR to `main`; [`release.yml`](.github/workflows/release.yml) runs on `v*` tags and deploys web + desktop **in lockstep** (manual `npm run deploy` between releases can still drift the site ahead of the binaries — the Local dropdown's baked version then leads the release assets until the next tag).
- **Cache busting**: `index.html` ships with `Cache-Control: no-cache, no-store, must-revalidate` + `Pragma: no-cache` + `Expires: 0` meta tags. Hashed JS/CSS assets in `/assets/` keep their content-hash filenames and stay infinitely cacheable, but the HTML always revalidates — so a fresh deploy never leaves a returning visitor pointed at a 404'd previous-build asset URL. Only costs a tiny 304 round-trip on a ~1 KB file.

### Desktop build (Tauri v2)

The app ships as an **offline desktop app** for Windows and macOS, downloadable from the Toolbar's **Local** dropdown. Everything lives in [`src-tauri/`](src-tauri/) plus a vite build profile. The shell carries exactly one custom Rust module — the LAN bench server below; everything else is config.

- **Offline hardening (applies to the web build too)**: Monaco is bundled locally via [`monacoSetup.ts`](src/components/CodeEditor/monacoSetup.ts) — `loader.config({ monaco })` short-circuits the CDN loader, Vite `?worker` imports emit the editor + TS/JS workers as same-origin assets, and a `manualChunks` entry splits Monaco into its own ~3.8 MB cacheable chunk. Fonts (Inter, JetBrains Mono) are self-hosted via `@fontsource` imports in `main.tsx`. Verified by a Playwright run with **all non-localhost requests blocked**: zero external requests, editor + preview fully functional.
- **FS_DESKTOP profile** ([vite.config.ts](vite.config.ts)): `FS_DESKTOP=1` — set automatically when the Tauri CLI runs the build hooks (it exports `TAURI_ENV_*`) — switches base to `/`, suppresses the CSP meta (the wrapper's CSP config governs), excludes the WebGPU-only ShaderCarousel from dist (it ships as a Tauri resource instead — next bullet), and defines `__FS_DESKTOP__` so the Local button and SC link hide themselves inside the desktop app (which instead shows the "VR" bench popover).
- **LAN bench server** ([src-tauri/src/bench_server.rs](src-tauri/src/bench_server.rs) + the "VR" Toolbar popover): the desktop app bundles the full ShaderCarousel suite and serves it over the local network so a headset can run the benches against this exact app version. The `fs-stage-shadercarousel-desktop` vite plugin stages the filtered suite (same exclude set as the web deploy — no benchData, no `https/` TLS material) into `src-tauri/carousel-dist/` (gitignored) at buildStart — this fires for `vite build` AND the dev server, so `tauri dev` gets fresh assets too — and `tauri.conf.json`'s `bundle.resources` maps it into the resource dir. The Rust side exposes `bench_server_start` / `bench_server_stop` / `bench_server_status` commands: a `tiny_http` thread bound to `0.0.0.0:5199` (ephemeral-port fallback), **GET-only, read-only, path-sanitized** (`..`/backslash rejection + canonicalize-prefix check), `Cache-Control: no-cache` so the headset never runs a stale bench; the LAN IP comes from the routing table (`local-ip-address`). The frontend calls these through Tauri's `withGlobalTauri` bridge (`window.__TAURI__`, typed in `vite-env.d.ts`) — only ever accessed behind `__FS_DESKTOP__`. **Secure-context catch**: browsers expose WebXR *and* WebGPU only on secure origins, and `http://<lan-ip>` isn't one — the popover therefore shows, next to the connect URL, the two one-time per-headset fixes (Quest Browser `chrome://flags` → "Insecure origins treated as secure" → add the shown origin; or `adb reverse tcp:5199 tcp:5199` + open `http://localhost:5199/`). Plain HTTP is deliberate: a built-in self-signed cert would still hit a warning interstitial on every headset, so it buys nothing over the flag route.
- **Critical Tauri config**: `dragDropEnabled: false` in `tauri.conf.json` — without it Tauri's native drop handler swallows OS file drops and every HTML5 import surface (canvas CSV/image/project drops, code-panel drop, viewer drop) silently dies. App version comes from `package.json` via `"version": "../package.json"`.
- **Renderer**: the preview runs WebGPU where the webview has it (WebView2 on Windows; WKWebView on macOS 26+) and falls back automatically to three's **WebGL2 backend** elsewhere — smoke-tested: the demo shader renders correctly with `navigator.gpu` removed ("WebGPURenderer: WebGPU is not available, running under WebGL2 backend").
- **Release flow** ([release.yml](.github/workflows/release.yml)): after the submodule prerequisite (see Deployment — commit + push the submodule, bump its pointer here first), `npm version patch && git push --follow-tags` → test gate → draft GitHub Release → native runners build a macOS **universal** `.dmg` + Windows **NSIS installer** + **portable `.zip`** (FastShaders.exe + the ShaderCarousel resource folder — Windows `resource_dir()` is the exe's directory, so a bare exe would ship the VR bench broken), uploaded under FIXED names (`FastShaders-macOS.dmg`, `FastShaders-Windows-Setup.exe`, `FastShaders-Windows-Portable.zip`) → web deploy to gh-pages (gated on the desktop job — a failed binary build must not leave the live site advertising a version whose binaries never published) → release published. The Local dropdown links to `/releases/latest/download/<fixed-name>` — permanent URLs that always serve the newest release; **keep `DESKTOP_DOWNLOADS` in `Toolbar.tsx` in sync with the workflow's asset names**.
- **Local dev**: `npm run tauri dev` / `npm run tauri build` (needs a Rust toolchain; CI needs none of your machine). Unsigned builds: Windows shows SmartScreen ("More info → Run anyway"), macOS needs System Settings → "Open Anyway" or `xattr -d com.apple.quarantine` — signing hooks (APPLE_* env) are stubbed in the workflow, pending an Apple Developer ID.
- **Known-open item**: teapot/bunny OBJ fetches from the opaque-origin preview iframe need CORS headers from Tauri's asset protocol — verify on the first real WKWebView run; fallback is shipping model bytes via postMessage (the podest.html pattern).

### Version Display

- App version is read from `package.json` at build time. Vite's `define` exposes it as a global `__APP_VERSION__` string (declared in `src/vite-env.d.ts`); a custom `fs-version-html` plugin in [vite.config.ts](vite.config.ts) substitutes `%APP_VERSION%` in `index.html` so the deployed HTML self-reports its build via `<meta name="version" content="0.2.7">` (whatever the current `package.json` version is) — visible in DevTools (or via `view-source:`) without running any JS, useful when debugging stale-tab reports.
- `Toolbar.tsx` renders the same version next to the brand: `FastShaders v{__APP_VERSION__}` (mono font, secondary text color, `.toolbar__version` style). The brand text itself is now a button — clicking it opens a contact popover with the author's name, an email link + Copy button, and a website link + Copy button. Outside-click and Escape close it.
- The **Local** dropdown (top right) shows the same `v{__APP_VERSION__}` next to its "Desktop app" label — with releases deployed in lockstep by `release.yml`, that version matches the binaries behind the download links.
- The desktop shell reuses the same source of truth: `tauri.conf.json` declares `"version": "../package.json"`.
- Bumping the version requires only editing `package.json`'s `version` field (or `npm version patch`, which also creates the release tag); the JS bundle, the HTML meta tag, and the desktop app all pick it up automatically on the next build.

---

## ShaderCarousel (GPU Micro-Benchmark)

Standalone benchmark suite in [`ShaderCarousel/`](ShaderCarousel/) for empirically measuring per-shader fragment cost to calibrate `complexity.json`. **(This replaced the earlier `ShaderFace/` tool, which relied on the now-removed `tsl-textures` library.)** Three purpose-built pages share one launcher and one `lib/` infrastructure; each has a centred Start gate (no auto-play). See [`ShaderCarousel/context.md`](ShaderCarousel/context.md) for the authoritative design rationale and the paper-section mapping.

### The three benches

- **bench-inout** — A-Frame 1.8.0 / Three.js r184 on the **WebGL** backend; immersive **WebXR** on Quest 3. An inverted sphere ping-pongs through the camera (`sphere-mover`); the Start gate triggers `enterVR()`. rAF deltas are logged via a one-shot `bench-tick` A-Frame component so frames are captured in-headset too.
- **bench-static** — `THREE.WebGPURenderer`; a full-coverage static sphere at **2064×2208** (Quest 3 per-eye). GPU-timestamp-timed (`trackTimestamp`) with a wall-clock-fence fallback + multi-pass **two-level N/2N slope** defeats desktop vsync clamping.
- **bench-microplane** — `THREE.WebGPURenderer`; a **1024×1024** ortho quad (raised from the old 512² so cheap atomics clear ~1 ms clock quantization). Defaults to the 8 noise atomics + baseline, for per-node cost recovery by baseline subtraction; marginal ms is normalized to the 2064×2208 currency (`REF_PIXELS`) before points. No XR.

### Shared infrastructure (`lib/`)

- `bench-style.css`, `bench-stats.js` (`computeStats`, two-level `slopeMsPerPass`, `REF_PIXELS`-normalized `annotateMarginalCost`, validity-gated `buildSuggestion`/`exportResults`, schema v2), `bench-timing.js` (`createBenchTimer` — GPU timestamp queries with wall-clock-fence fallback, two-level slope, quantization heuristic), `bench-registry.js` (corpus: baseline + 8 presets + 8 noise atomics + a DCE-safe **calibration corpus** — a `calib` k-sweep group plus 7 `combo` additivity/throughput/latency/model-check entries incl. two `combo_dce_*` sentinels, off by default (picker groups "Calibration (k-sweep)" / "Combinations") — + saved-groups loader), `bench-driver.js` (shared WebGPU measurement driver for bench-static/bench-microplane — initRenderer / benchmarkOne / runBenchmark / results-popup / boot wiring, extracted from ~220 formerly-duplicated lines), `bench-ui.js` (grouped picker, settings persistence, Reset-to-defaults, Start gate, done popup, headset detect).
- `lib/three/` — Three.js **r184** WebGPU ESM (regenerated from `node_modules/three@0.184`), used by the static/microplane benches via import map.
- Launcher [`ShaderCarousel/index.html`](ShaderCarousel/index.html) loads each bench in a same-origin iframe and **adopts** its HUD/controls into a sidebar (keeping `<style>` + `<link>` so styling survives); the Start gate and done popup stay inside the iframe so the XR-entry gesture origin is correct.

### Measurement & output

1. **Multi-pass, two-level slope**: `bench-timing.calibrate` bumps N per shader (until a batch spans ~`CALIBRATE_TARGET_MS` 20 ms) and measures at N and 2N passes/batch. Per-pass cost = (median(total@2N) − median(total@N)) / N, so fixed per-batch overhead C cancels (the old single-level divide-by-N left C/N in every marginal). `totalMs` is GPU-timestamp time when available (`resolveTimestampsAsync`), else wall-clock around a fence (`onSubmittedWorkDone()` / `gl.finish()`).
2. **Marginal cost**: every run's first shader is the flat-color baseline; `marginalMs = msPerPass − baselineMs` isolates each shader's contribution above scene + driver overhead. `marginalMsAtRef` rescales it to the 2064×2208 reference pixel count so points are in one currency. Baseline missing ⇒ marginal fields are `null` (no silent raw-median fallback).
3. **Output**: each run writes three files — raw JSON (batches + per-shader stats + schema-v2 provenance), a summary CSV (one row per shader), and a **complexity-suggestion JSON** mapping marginal ms → suggested points (`marginalMsAtRef / 8.33 × 100`), diffable against `src/registry/complexity.json`. `metadata.valid`/`reasons[]` gate whether the numbers are trustworthy; commit runs into `benchData/<device-slug>/`. **The loop closed 2026-07-23**: the first measured run is committed at `ShaderCarousel/benchData/quest3-20260723/` (Static + MicroPlane agree), and the noise family in `complexity.json` was repriced from it (voronoi was ~4x underpriced: 55 → 230). `ShaderCarousel/benchData/METHODS.md` documents the methodology and `ShaderCarousel/benchData/fit-calibration.mjs` fits the calibration corpus.
4. **Serving**: static HTTP only (e.g. `python3 -m http.server`) — **not** Vite, which interferes with the WebGPU import maps.

### Saved-groups status

The bench picker reads `localStorage['fs:savedGroups']` and lists each saved group, but `compileSavedGroup` currently returns `runnable: false` for all of them: inline `tslCode` execution (`new Function('TSL', …)`) was **removed for security**. Making saved groups benchmarkable requires *both* the editor persisting a `tslCode` field *and* a sandboxed compile step (worker or shaderloader parse path) on the bench side — see `ShaderCarousel/context.md`.
