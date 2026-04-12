# FastShaders

Bi-directional TSL (Three.js Shading Language) visual shader editor.

## Stack

- React 18 + TypeScript + Vite (ES modules, base path `/FastShaders/`)
- `@xyflow/react` v12 — node graph editor
- `@monaco-editor/react` — code editor
- `zustand` v5 — state management
- `@babel/parser` + `@babel/traverse` — code→graph parsing
- `@dagrejs/dagre` — auto-layout (LR direction)
- `three` (WebGPU build) — shader runtime; FastShaders uses only `three/tsl`
  built-in functions including the MaterialX noise family (`mx_noise_*`,
  `mx_fractal_noise_*`, `mx_worley_noise_*`, `mx_cell_noise_float`)
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
    CodeEditor/       — Monaco editor panel (TSL/Script folder tabs, Save, Load Script, Download Script)
      tslLanguage.ts  — Monaco TSL type declarations + hex color picker
    Layout/           — Toolbar (brand→contact popover, version), CostBar, SplitPane, AppLayout
    NodeEditor/       — React Flow graph editor + ContentBrowser (node palette + Saved Groups tab)
      edges/          — TypedEdge (multi-channel, drag-to-disconnect), EdgeInfoCard
      handles/        — TypedHandle with color-coded data types
      inputs/         — DragNumberInput (drag/click-to-edit number widget)
      menus/          — ContextMenu (dispatcher), AddNodeMenu, NodeSettingsMenu, ShaderSettingsMenu, GroupSettingsMenu, EdgeContextMenu
      nodes/          — ShaderNode, OutputNode, ColorNode, PreviewNode, MathPreviewNode, ClockNode, GroupNode
      NodePreviewCard.tsx — content browser card renderer (CPU/canvas previews)
      SavedGroupCard.tsx  — draggable tile for a user-saved group (Saved Groups tab)
    Preview/          — ShaderPreview (iframe-based 3D preview via blob URL, property uniform overlay, geometry/lighting/subdivision/bg controls)
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
    evaluateTSLScript.ts — detects `model.material.*Node = ...` direct-assignment style
    scriptToTSL.ts    — reverse of tslToShaderModule (converts .js script back to Fn-wrapped TSL)
  hooks/
    useSyncEngine.ts  — bidirectional graph↔code sync, undo/redo, complexity calc
  registry/
    nodeRegistry.ts   — ~55 hardcoded node definitions (8 input, 6 type, 4 arithmetic, 15 math, 4 interpolation, 7 vector, 8 noise, 2 color, 1 output) + hidden `unknown` def
    nodeCategories.ts — 10 category definitions (input, type, arithmetic, math, interpolation, vector, noise, color, unknown, output)
    complexity.json   — per-node GPU cost values
  store/
    useAppStore.ts    — zustand store (graph, sync, history, UI, groups + saved-group library, preview/canvas/code-editor prefs, localStorage persistence)
  types/
    node.types.ts     — AppNode union, ShaderNodeData, OutputNodeData, GroupNodeData, BoundarySocket, MaterialSettings, helpers
    tsl.types.ts      — ParseError (with severity), GeneratedCode
    sync.types.ts     — SyncSource ('graph' | 'code' | 'initial')
    index.ts          — barrel re-exports
  utils/
    idGenerator.ts    — generateId(), generateEdgeId() (4-part deterministic format)
    colorUtils.ts     — hex/RGB conversion, cost color gradient, type/category colors, getContrastColor() for auto-contrast text
    noisePreview.ts   — CPU Perlin/fBm/Cell/Voronoi noise rendering for thumbnails
    mathPreview.ts    — math function waveform canvas renderer
    graphTraversal.ts — hasTimeUpstream() BFS graph walker
    edgeUtils.ts      — removeEdgesForPort(), unwrapCollapsedGroupEdges() (rewrites visual boundary edges back to real endpoints for engine consumers)
    edgeDisconnectFlag.ts — transient flag for edge disconnect suppression
    nameUtils.ts      — toKebabCase() for export filenames
public/
  js/
    tsl-shim.js             — re-exports window.THREE + THREE.TSL as ESM (consumed by preview iframes)
    a-frame-shaderloader-0.3.js — A-Frame shader component (TDZ fix + auto-import + property schema)
    a-frame-shaderloader-0.2.js — legacy shaderloader version
    aframe-171-a-0.1.min.js — A-Frame 1.7 IIFE bundle (WebGPU)
    aframe-orbit-controls.min.js — orbit controls for preview
  models/
    teapot.obj              — Utah teapot (preview geometry)
    stanford-bunny.obj      — Stanford bunny (preview geometry)
```

### Subprojects (outside src/)

- `ShaderCarousel/` — standalone shader showcase gallery (A-Frame, separate from editor)
- `a-frame-shaderloader/` — shaderloader component dev project (source of public/js builds)
- `Tests/` — test shader JS files + test HTML page

## Key Conventions

- **Sync engine**: `syncSource` field in zustand (`'graph'` | `'code'` | `'initial'`) prevents infinite sync loops. `useSyncEngine` hook manages bidirectional sync with `lastSyncedCodeRef` to skip no-op updates
- **Node values**: always use `getNodeValues(node)` from `@/types` — never cast `node.data as ...`
- **Edge IDs**: always use `generateEdgeId(source, sourceHandle, target, targetHandle)` from `@/utils/idGenerator`
- **Single ShaderNode**: one component handles all TSL node types dynamically via registry
- **Light theme by default**: flat design with sharp dark shadows, CSS tokens in `tokens.css`. The Monaco code editor has its own light/dark toggle (`codeEditorTheme`, persisted to `fs:codeEditorTheme`). The React Flow canvas background is user-pickable (`nodeEditorBgColor`, persisted to `fs:nodeEditorBgColor`); cost badges and 1-channel edges auto-flip via `getContrastColor()` so they remain readable on any background.
- **A-Frame pipeline**: graphToCode → tslToShaderModule → shaderloader 0.3 (runtime TDZ fix + auto-import injection + `export const schema` parsing) → dynamic blob import. The standalone `.html` export embeds the same module as a blob URL.
- **rAF ref pattern**: PreviewNode/MathPreviewNode/EdgeInfoCard overwrite refs for animation — this is correct (avoids stale closures)
- **Noise nodes**: 8 MaterialX-backed nodes (`perlin`, `perlinVec3`, `fbm`, `fbmVec3`, `cellNoise`, `voronoi`, `voronoiVec2`, `voronoiVec3`) all use the same `pos`/`scale` parameter convention. graphToCode emits them via the `def.category === 'noise'` branch; codeToGraph parses them via `processNoiseCall`; CPU thumbnails come from `noisePreview.ts`; live GPU previews from the factories in `graphToTSLNodes.ts`. There is no `texture` category — `tsl-textures` was removed in favour of three.js's built-in MaterialX noise.
- **Groups**: selection groups are first-class React Flow nodes (`type: 'group'`) created via Ctrl+G or right-click → Group Selection. They have no registry entry and no shader semantics — `graphToCode`/`graphToTSLNodes`/`cpuEvaluator` ignore the *node*, but call `unwrapCollapsedGroupEdges()` from `edgeUtils.ts` at their entry to translate visually-rewritten boundary edges back to their real child endpoints, so collapse state never affects compiled output. Groups can be recolored, renamed, collapsed (members hidden via `display: none` className — *not* React Flow's `hidden: true`, which would unmount rAF loops), saved to a per-browser library (`fs:savedGroups`), and dragged out of containers. Members never get `extent: 'parent'` — `onNodeDragStop` reconciles `parentId` after every drag instead.
- **History**: circular buffer (50 entries) with undo/redo via `structuredClone`, Cmd+Z/Cmd+Shift+Z shortcuts
- **localStorage**: auto-saves graph, split ratios, shader name, headset selection, cost colors, canvas bg color, code editor theme, preview prefs (geometry, lighting, subdivision, bg, uniform bounds), saved groups (debounced 300ms)
- **VR cost budgeting**: 6 VR headset presets with maxPoints, cost gradient visualization in CostBar
- **Unknown nodes**: unrecognized TSL functions in code→graph parsing create `unknown` nodes that store `functionName` and `rawExpression` in values. These round-trip through graphToCode (emitted verbatim), render as magenta `vec3(1,0,1)` fallback in live preview, and show as orange warnings (not errors) in the code editor. The `unknown` definition lives in `NODE_REGISTRY` but is excluded from `allDefinitions` (hidden from content browser/search)
- **Preview geometries**: five options — `sphere`, `cube`, `plane` (primitives) and `teapot`, `bunny` (OBJ models in `public/models/`). `isObjGeometry()` in `tslToPreviewHTML.ts` is the single source of truth for primitive vs OBJ branching. The inline `fit-bounds` A-Frame component recomputes vertex normals (after merging vertex duplicates so per-vertex displacement doesn't split the surface), auto-detects inverted winding (the bunny is CW), generates spherical UVs from each vertex's direction so `uv()` reads cleanly on OBJ meshes, and rescales so the longest axis = 1.6 to match primitive framing.

## TypeScript Notes

- `@babel/traverse` CJS/ESM interop: `const traverse = (typeof _traverse.default === 'function' ? _traverse.default : _traverse)`
- React Flow v12: import from `@xyflow/react`, use `Node<DataType, TypeName>` generics
- `applyNodeChanges`/`applyEdgeChanges` return base types — cast with `as AppNode[]`
- `@types/three` uses `>=0.182.0` range (not caret) to match installed version
- `ParseError.severity` is optional — omitted (or `'error'`) blocks code→graph sync; `'warning'` allows sync to proceed
- `tsconfig.node.json` must have `"composite": true` and `"noEmit": false` when referenced from main tsconfig
