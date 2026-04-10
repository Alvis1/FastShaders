# FastShaders

Bi-directional TSL (Three.js Shading Language) visual shader editor.

## Stack

- React 18 + TypeScript + Vite (ES modules, base path `/FastShaders/`)
- `@xyflow/react` v12 — node graph editor
- `@monaco-editor/react` — code editor
- `zustand` v5 — state management
- `@babel/parser` + `@babel/traverse` — code→graph parsing
- `@dagrejs/dagre` — auto-layout (LR direction)
- `three` + `tsl-textures` — shader runtime (WebGPU)
- `patch-package` — patches `tsl-textures` at postinstall
- Path alias: `@/*` → `./src/*`

## Commands

- `npm run dev` — start dev server (port 5173)
- `npm run build` — typecheck + build (`tsc -b && vite build`)
- `npx tsc --noEmit` — typecheck only

No test framework is configured.

## Project Structure

```
src/
  App.tsx             — entry component, initial demo graph, SyncController
  main.tsx            — React 18 root, CSS imports
  vite-env.d.ts       — Vite env type declarations
  styles/
    tokens.css        — CSS design tokens (colors, spacing, typography, z-index)
    reset.css         — CSS reset
  components/
    CodeEditor/       — Monaco editor panel (TSL/A-Frame/Script tabs, download)
      tslLanguage.ts  — Monaco TSL type declarations + hex color picker
    Layout/           — Toolbar, CostBar, SplitPane, AppLayout
    NodeEditor/       — React Flow graph editor + ContentBrowser (node palette)
      edges/          — TypedEdge (multi-channel, drag-to-disconnect), EdgeInfoCard
      handles/        — TypedHandle with color-coded data types
      inputs/         — DragNumberInput (drag/click-to-edit number widget)
      menus/          — AddNodeMenu, NodeSettingsMenu, ShaderSettingsMenu, EdgeContextMenu
      nodes/          — ShaderNode, OutputNode, ColorNode, PreviewNode, MathPreviewNode, ClockNode, TexturePreviewNode
      NodePreviewCard.tsx — content browser card renderer (GPU/CPU/canvas previews)
    Preview/          — ShaderPreview (iframe-based 3D preview via blob URL)
  engine/
    graphToCode.ts    — graph → TSL code generation (topological sort, import collection)
    codeToGraph.ts    — TSL code → graph parsing (Babel, node matching, pattern detection)
    graphToTSLNodes.ts — graph → live GPU TSL node tree (runtime compilation)
    tslCodeProcessor.ts — shared TSL processing (import extraction, TDZ fix, body parsing)
    tslToPreviewHTML.ts — TSL → standalone HTML preview (A-Frame + shaderloader 0.3)
    tslToShaderModule.ts — TSL → shaderloader-compatible ES module (property schema)
    tslToAFrame.ts    — TSL → downloadable A-Frame HTML (CDN-loaded)
    topologicalSort.ts — Kahn's algorithm (warns on cycles)
    layoutEngine.ts   — Dagre auto-layout
    cpuEvaluator.ts   — CPU-side recursive graph evaluation (live previews, cost)
    evaluateTSLScript.ts — detects tsl-textures direct-assignment code style
  hooks/
    useSyncEngine.ts  — bidirectional graph↔code sync, undo/redo, complexity calc
  registry/
    nodeRegistry.ts   — 52+ hardcoded node definitions + dynamic texture defs
    tslTexturesRegistry.ts — introspects tsl-textures exports, classifies params
    nodeCategories.ts — 11 category definitions (input, type, arithmetic, …, unknown)
    complexity.json   — per-node GPU cost values
  store/
    useAppStore.ts    — zustand store (23 state fields, 23 actions, localStorage persistence)
  types/
    node.types.ts     — AppNode union, ShaderNodeData, OutputNodeData, MaterialSettings, helpers
    tsl.types.ts      — ParseError (with severity), GeneratedCode
    sync.types.ts     — SyncSource ('graph' | 'code' | 'initial')
    index.ts          — barrel re-exports
  utils/
    idGenerator.ts    — generateId(), generateEdgeId() (4-part deterministic format)
    colorUtils.ts     — hex/RGB conversion, cost color gradient, type/category colors
    noisePreview.ts   — CPU Perlin/fBm/Voronoi noise rendering
    mathPreview.ts    — math function waveform canvas renderer
    texturePreviewRenderer.ts — shared WebGPU renderer for texture node previews
    graphTraversal.ts — hasTimeUpstream() BFS graph walker
    edgeUtils.ts      — removeEdgesForPort() helper
    edgeDisconnectFlag.ts — transient flag for edge disconnect suppression
    nameUtils.ts      — toKebabCase() for export filenames
public/
  js/
    tsl-shim.js             — combined shim: re-exports THREE + THREE.TSL + tsl-textures as ESM
    a-frame-shaderloader-0.3.js — A-Frame shader component (TDZ fix + auto-import + property schema)
    a-frame-shaderloader-0.2.js — legacy shaderloader version
    aframe-171-a-0.1.min.js — A-Frame 1.7 IIFE bundle (WebGPU)
    aframe-orbit-controls.min.js — orbit controls for preview
patches/
  tsl-textures+3.0.1.patch — patch-package patch for tsl-textures
```

### Subprojects (outside src/)

- `ShaderCarousel/` — standalone shader showcase gallery (A-Frame, separate from editor)
- `a-frame-shaderloader/` — shaderloader component dev project (source of public/js builds)
- `Tests/` — test shader JS files + test HTML page

## Key Conventions

- **Sync engine**: `syncSource` field in zustand (`'graph'` | `'code'`) prevents infinite sync loops. `useSyncEngine` hook manages bidirectional sync with `lastSyncedCodeRef` to skip no-op updates
- **Node values**: always use `getNodeValues(node)` from `@/types` — never cast `node.data as ...`
- **Edge IDs**: always use `generateEdgeId(source, sourceHandle, target, targetHandle)` from `@/utils/idGenerator`
- **Single ShaderNode**: one component handles all TSL node types dynamically via registry
- **Light theme**: flat design with subtle shadows, CSS tokens in `tokens.css`
- **A-Frame pipeline**: graphToCode → tslToShaderModule → shaderloader 0.3 (runtime TDZ fix + auto-import injection) → dynamic blob import
- **rAF ref pattern**: PreviewNode/MathPreviewNode/EdgeInfoCard overwrite refs for animation — this is correct (avoids stale closures)
- **WebGPU texture previews**: singleton renderer in `texturePreviewRenderer.ts`, serialized render queue, per-node material cache, animation loop for time-connected nodes
- **History**: circular buffer (50 entries) with undo/redo via `structuredClone`, Cmd+Z/Cmd+Shift+Z shortcuts
- **localStorage**: auto-saves graph, split ratios, shader name, headset selection, cost colors (debounced 300ms)
- **VR cost budgeting**: 6 VR headset presets with maxPoints, cost gradient visualization in CostBar
- **Unknown nodes**: unrecognized TSL functions in code→graph parsing create `unknown` nodes that store `functionName` and `rawExpression` in values. These round-trip through graphToCode (emitted verbatim), render as magenta `vec3(1,0,1)` fallback in live preview, and show as orange warnings (not errors) in the code editor. The `unknown` definition lives in `NODE_REGISTRY` but is excluded from `allDefinitions` (hidden from content browser/search)

## TypeScript Notes

- `@babel/traverse` CJS/ESM interop: `const traverse = (typeof _traverse.default === 'function' ? _traverse.default : _traverse)`
- React Flow v12: import from `@xyflow/react`, use `Node<DataType, TypeName>` generics
- `applyNodeChanges`/`applyEdgeChanges` return base types — cast with `as AppNode[]`
- `@types/three` uses `>=0.182.0` range (not caret) to match installed version
- `ParseError.severity` is optional — omitted (or `'error'`) blocks code→graph sync; `'warning'` allows sync to proceed
- `tsconfig.node.json` must have `"composite": true` and `"noEmit": false` when referenced from main tsconfig
