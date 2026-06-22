# FastShaders

Bi-directional TSL (Three.js Shading Language) visual shader editor. Users author and execute their own shader code inside the app, and `.fastshader` files can be shared between users — treat any loaded `.fastshader` or pasted shader source as adversarial input.

> **Before changing node visuals, the glyph system, `ShaderNode`, `NodePreviewCard`, or the Node Designer (`node-designer.html`), read [`NODE_DESIGN_REQUIREMENTS.md`](NODE_DESIGN_REQUIREMENTS.md) — it is the authoritative spec for node appearance/layout.**

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
- `npm test` — run the vitest suite once (CI-friendly)
- `npm run test:watch` — run vitest in watch mode

## Testing

- Framework: **vitest** (configured in `vite.config.ts` so `@/*` alias + TS setup are inherited from the build config). Test files match `src/**/*.test.ts`; environment is `node` (no jsdom — tests target pure logic only).
- Shared test factories live in `src/test-utils.ts` (`makeNode`, `makeEdge`). Always import these instead of redefining stub builders in each test file — the helpers cast through `unknown as AppNode/AppEdge` to skip React Flow's full Node generic constraints.
- Current coverage: utilities (`colorUtils`, `idGenerator`, `nameUtils`, `graphTraversal`) + engine core (`topologicalSort`, `cpuEvaluator`, `graphToCode`, `codeToGraph`, plus a `graphToCode ↔ codeToGraph` round-trip invariant suite).

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
    NodeEditor/       — React Flow graph editor + ContentBrowser (node palette + Textures + Saved Groups tabs)
      edges/          — TypedEdge (multi-channel, drag-to-disconnect), EdgeInfoCard
      handles/        — TypedHandle with color-coded data types
      inputs/         — DragNumberInput (drag/click-to-edit number widget)
      menus/          — ContextMenu (dispatcher), AddNodeMenu, NodeSettingsMenu, ShaderSettingsMenu, GroupSettingsMenu, EdgeContextMenu
      nodes/          — ShaderNode, OutputNode, ColorNode, PreviewNode, MathPreviewNode, ClockNode, GroupNode
      NodePreviewCard.tsx — content browser card renderer (CPU/canvas previews)
      SavedGroupCard.tsx  — draggable tile for a user-saved group (Saved Groups tab)
      TextureCard.tsx     — draggable tile for a built-in texture (Textures tab, CPU canvas preview)
    Preview/          — ShaderPreview (iframe-based 3D preview via blob URL, property uniform overlay, geometry/lighting/subdivision/bg controls)
  engine/
    graphToCode.ts    — graph → TSL code generation (topological sort, import collection)
    codeToGraph.ts    — TSL code → graph parsing (Babel, node matching, pattern detection)
    tslCodeProcessor.ts — shared TSL processing (import extraction, TDZ fix, body parsing)
    tslToPreviewHTML.ts — TSL → standalone HTML preview (A-Frame + shaderloader 0.3)
    tslToShaderModule.ts — TSL → shaderloader-compatible ES module (property schema)
    topologicalSort.ts — Kahn's algorithm (warns on cycles)
    layoutEngine.ts   — Dagre auto-layout
    cpuEvaluator.ts   — CPU-side recursive graph evaluation (live previews, cost)
    evaluateTSLScript.ts — detects `model.material.*Node = ...` direct-assignment style
    scriptToTSL.ts    — reverse of tslToShaderModule (converts .js script back to Fn-wrapped TSL)
  hooks/
    useSyncEngine.ts  — bidirectional graph↔code sync, undo/redo, complexity calc
  registry/
    nodeRegistry.ts   — ~55 hardcoded node definitions (8 input, 6 type, 4 arithmetic, 15 math, 4 interpolation, 7 vector, 8 noise, 2 color, 1 output) + hidden `unknown` def
    nodeCategories.ts — 11 category definitions (input, type, arithmetic, math, interpolation, vector, noise, color, texture, unknown, output)
    builtinTextures.ts — 8 built-in texture groups (polka dots, grid, tiger fur, static noise, crumpled fabric, gas giant, marble, wood) — TSL code parsed to node graphs at startup
    complexity.json   — per-node GPU cost values
  store/
    useAppStore.ts    — zustand store (graph, sync, history, UI, groups + saved-group library, preview/canvas/code-editor prefs, localStorage persistence)
  types/
    node.types.ts     — AppNode union, ShaderNodeData, OutputNodeData, GroupNodeData, BoundarySocket, MaterialSettings, helpers
    tsl.types.ts      — ParseError (with severity), GeneratedCode
    sync.types.ts     — SyncSource ('graph' | 'code')
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

- `ShaderCarousel/` — three purpose-built benchmark pages (no auto-play; centred Start gate each):
  - `bench-inout/` — A-Frame WebGL + WebXR, sphere-mover ping-pong, gate triggers `enterVR()`; logs rAF deltas via the bench-tick A-Frame component so frames are captured during XR too. UA-sniff headset detect + text override
  - `bench-static/` — Three.js WebGPU, static full-coverage sphere @ Quest 3 per-eye (2064×2208), `onSubmittedWorkDone` fence + multi-pass (default 30) defeats vsync clamping
  - `bench-microplane/` — Three.js WebGPU, 512×512 ortho quad, multi-pass; defaults to noise atomics only (per-node calibration via baseline subtraction)
  - Shared infra in `lib/`: `bench-style.css`, `bench-stats.js` (computeStats + exportResults emitting raw JSON + summary CSV + **complexity-suggestion JSON** mapping marginal ms → suggested points), `bench-registry.js` (baseline + 8 presets + 8 noise atomics + saved-groups loader stub — reads `fs:savedGroups` but greys entries lacking a `tslCode` field), `bench-ui.js` (grouped picker with master checkboxes, settings persistence, Reset-to-defaults, start gate, done popup, headset detect)
  - Three.js WebGPU bundle at `lib/three/`, A-Frame 1.7 IIFE at `components/three/aframe-171-a-0.1.min.js`, `sphere-mover.js` (used by InOut)
  - Launcher at `ShaderCarousel/index.html` adopts each iframe's `<style>` AND `<link rel=stylesheet>` so adopted controls keep styling; `#bench-start-gate` + `#bench-done-popup` stay in the iframe (XR-entry needs the gesture origin to be inside the iframe document)
- `a-frame-shaderloader/` — shaderloader component dev project (source of public/js builds)
- `Tests/` — test shader JS files + test HTML page
- `a-frame-shaderloader/` — shaderloader component dev project (source of public/js builds)
- `Tests/` — test shader JS files + test HTML page

## Key Conventions

- **Sync engine**: `syncSource` field in zustand (`'graph'` | `'code'`) prevents infinite sync loops. `useSyncEngine` hook manages bidirectional sync with `lastSyncedCodeRef` to skip no-op updates
- **Node values**: always use `getNodeValues(node)` from `@/types` — never cast `node.data as ...`
- **Edge IDs**: always use `generateEdgeId(source, sourceHandle, target, targetHandle)` from `@/utils/idGenerator`
- **Single ShaderNode**: one component handles all TSL node types dynamically via registry
- **Node visuals**: per-node designer overrides live in `glyphs/customGlyphs.ts` — `{ svg, justify, scale (glyph-only; spacing fixed), dx/dy (glyph nudge), width (exact, ≥24), height (exact in both layouts, ≥28; shorter than content overflows; independent of glyph scale), text (0.4–2.5× header/value/label fonts via --node-text-scale), sockets (center-relative offsets, 4px snap; op layout natively, rows layout detaches the socket from its row — values follow) }`; frame radius/border are **fixed app-wide**. Connected inputs show edge values (`min…max` ranges, bare `…` when underivable; geometry attributes have analytical ranges). Multi-channel data **arriving on a connected input** stacks the node into N cards (sibling layers behind the card, staggered negative z, single group shadow from the deepest layer). Sockets are **static** — never set `transform` on handle `:hover` (React Flow positions handles via transform) — and never stack. The Node Designer (`node-designer.html`) saves via the dev-server endpoint `/__nd` (any browser), the File System Access API (Chromium), or download; see `NODE_DESIGN_REQUIREMENTS.md`
- **Light theme by default**: flat design with sharp dark shadows, CSS tokens in `tokens.css`. The Monaco code editor has its own light/dark toggle (`codeEditorTheme`, persisted to `fs:codeEditorTheme`). The React Flow canvas background is user-pickable (`nodeEditorBgColor`, persisted to `fs:nodeEditorBgColor`); cost badges and 1-channel edges auto-flip via `getContrastColor()` so they remain readable on any background.
- **A-Frame pipeline**: graphToCode → tslToShaderModule → shaderloader 0.3 (runtime TDZ fix + auto-import injection + `export const schema` parsing) → dynamic blob import. The standalone `.html` export embeds the same module as a blob URL.
- **rAF ref pattern**: PreviewNode/MathPreviewNode/EdgeInfoCard overwrite refs for animation — this is correct (avoids stale closures)
- **Noise nodes**: 8 MaterialX-backed nodes (`perlin`, `perlinVec3`, `fbm`, `fbmVec3`, `cellNoise`, `voronoi`, `voronoiVec2`, `voronoiVec3`) all use the same `pos`/`scale` parameter convention. graphToCode emits them via the `def.category === 'noise'` branch; codeToGraph parses them via `processNoiseCall`; CPU thumbnails come from `noisePreview.ts`; live GPU previews run the generated TSL through the preview iframe (`graphToCode` → `tslToPreviewHTML` → `convertToShaderModule`). There is no `texture` category — `tsl-textures` was removed in favour of three.js's built-in MaterialX noise.
- **Groups**: selection groups are first-class React Flow nodes (`type: 'group'`) created via Ctrl+G or right-click → Group Selection. They have no registry entry and no shader semantics — `graphToCode`/`cpuEvaluator` ignore the *node*, but call `unwrapCollapsedGroupEdges()` from `edgeUtils.ts` at their entry to translate visually-rewritten boundary edges back to their real child endpoints, so collapse state never affects compiled output. Groups can be recolored, renamed, collapsed (members hidden via `display: none` className — *not* React Flow's `hidden: true`, which would unmount rAF loops), saved to a per-browser library (`fs:savedGroups`), and dragged out of containers. Members never get `extent: 'parent'` — `onNodeDragStop` reconciles `parentId` after every drag instead.
- **History**: circular buffer (50 entries) with undo/redo via `structuredClone`, Cmd+Z/Cmd+Shift+Z shortcuts
- **localStorage**: auto-saves graph, split ratios, shader name, headset selection, cost colors, canvas bg color, code editor theme, preview prefs (geometry, lighting, subdivision, bg, uniform bounds, uniform values, camera pos, rotation, playing state), saved groups (debounced 300ms). Reset clears camera/rotation/playing and restores lighting/subdivision/uniforms — bg color, uniform bounds, and geometry are treated as user preferences. Uniform values persist by name: removing a property node from the graph keeps the stored value (the iframe ignores `fs:uniform` messages for unknown names), so re-adding a property with the same name restores the user's last tuning.
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
