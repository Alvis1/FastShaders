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
- `npm run tauri dev` / `npm run tauri build` — desktop (Tauri v2) shell; needs a local Rust toolchain. Releases are built in CI (no local Rust required)

## Testing

- Framework: **vitest** (configured in `vite.config.ts` so `@/*` alias + TS setup are inherited from the build config). Test files match `src/**/*.test.ts`; environment is `node` (no jsdom — tests target pure logic only).
- Shared test factories live in `src/test-utils.ts` (`makeNode`, `makeEdge`). Always import these instead of redefining stub builders in each test file — the helpers cast through `unknown as AppNode/AppEdge` to skip React Flow's full Node generic constraints.
- Current coverage: utilities (`colorUtils`, `idGenerator`, `nameUtils`, `graphTraversal`, `csvParser`, `binaryCodec`, `dataNode`, `dataViz`, `imageNode`, `zipReader`, `zipWriter`) + engine (`topologicalSort`, `cpuEvaluator`, `graphToCode`, `codeToGraph`, `tslToShaderModule`, `tslCodeProcessor`, `dataStripes`, `dataViz.node`, `imageNode`, `variadicArithmetic`, `reviewFixes` regression suite, plus a `graphToCode ↔ codeToGraph` round-trip invariant suite) + a vendor-sync drift guard (`vendorSync.test.ts`).

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
    Layout/           — Toolbar (brand→contact popover, version, "Local" desktop-download dropdown, desktop-only "VR" LAN-bench popover), CostBar, SplitPane, AppLayout
    NodeEditor/       — React Flow graph editor + ContentBrowser (node palette + Textures + Saved Groups tabs)
      edges/          — TypedEdge (multi-channel, drag-to-disconnect), EdgeInfoCard
      handles/        — TypedHandle with color-coded data types
      inputs/         — DragNumberInput (drag/click-to-edit number widget)
      menus/          — ContextMenu (dispatcher), AddNodeMenu, NodeSettingsMenu, ShaderSettingsMenu, GroupSettingsMenu, EdgeContextMenu, NoteSettingsMenu, StripesSettingsMenu, DataVizSettingsMenu, menuShared (row styles + NumberRow + NodeActions)
      nodes/          — ShaderNode, OutputNode, ColorNode, PreviewNode, MathPreviewNode, ClockNode, GroupNode, NoteNode, NodeBase.css, glyphs/ (NodeGlyph, customGlyphs)
      NodePreviewCard.tsx — content browser card renderer (CPU/canvas previews)
      SavedGroupCard.tsx  — draggable tile for a user-saved group (Saved Groups tab)
      TextureCard.tsx     — draggable tile for a built-in texture (Textures tab, CPU canvas preview)
    Modals/           — CsvImportModal (over-wide CSV decision), LimitModal (image/storage limit notices + ignore-limits opt-out)
    Preview/          — ShaderPreview (iframe-based 3D preview via blob URL, property uniform overlay, geometry/lighting/subdivision/bg controls)
  engine/
    graphToCode.ts    — graph → TSL code generation (topological sort, import collection)
    codeToGraph.ts    — TSL code → graph parsing (Babel, node matching, pattern detection)
    tslCodeProcessor.ts — shared TSL processing (import extraction, TDZ fix, body parsing)
    tslToPreviewHTML.ts — TSL → standalone HTML preview (A-Frame + shaderloader 0.4)
    tslToShaderModule.ts — TSL → shaderloader-compatible ES module (property schema)
    topologicalSort.ts — Kahn's algorithm (warns on cycles)
    layoutEngine.ts   — Dagre auto-layout
    cpuEvaluator.ts   — CPU-side recursive graph evaluation (live previews, cost)
    evaluateTSLScript.ts — detects `model.material.*Node = ...` direct-assignment style
    scriptToTSL.ts    — reverse of tslToShaderModule (converts .js script back to Fn-wrapped TSL)
    projectImport.ts  — shared import path for every surface (Load Script, code-panel drop, canvas drop): applyProjectToStore + importShaderText + importShaderZip
  hooks/
    useSyncEngine.ts  — bidirectional graph↔code sync, undo/redo, complexity calc
  registry/
    nodeRegistry.ts   — ~68 hardcoded node definitions (16 input, 6 type, 4 arithmetic, 15 math, 4 interpolation, 3 logic, 7 vector, 8 noise, 4 color [incl. the `stripes` + `dataviz` data-visualization nodes], 1 output) + hidden `unknown`, `dataNode` (CSV drop), and `imageNode` (image drop) defs, all excluded from allDefinitions. NB: the 9 unary-math nodes are generated via a `.map()`, so a naive grep of `category: 'math'` undercounts
    nodeCategories.ts — 12 category definitions (input, type, arithmetic, math, interpolation, logic, vector, noise, color, texture, unknown, output)
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
    imageNode.ts      — Image node payload: caps/validation (whitelisted data: URL, decodeImageNode, sanitizeImageNodes, collectImageFiles) — pure, node-testable
    imageImport.ts    — drop-time canvas re-encode (EXIF strip/orient, WebP→PNG(alpha)→JPEG(Safari) via returned-MIME detect, PNG-source stays lossless in budget, downscale-retry) — DOM-only
    zipWriter.ts      — dependency-free STORE-method ZIP writer (deterministic, CRC-32) for the shader+images download
    zipReader.ts      — ZIP reader (STORE + deflate via native DecompressionStream; central-directory-driven, adversarial caps) for .zip import
public/
  js/                       — VENDORED, do not hand-edit: synced from a-frame-shaderloader/js/ by the fs-vendor-sync vite plugin (vendorSync.test.ts fails on drift)
    a-frame-shaderloader-0.4.js — A-Frame shader component (rewrites three/tsl imports → globalThis.THREE.TSL, TDZ fix + auto-import + property schema)
    a-frame-180-a-01.min.js — A-Frame 1.8.0 IIFE bundle, Three.js r184 WebGPU
    aframe-orbit-controls.min.js — orbit controls for preview
  models/
    teapot.obj              — Utah teapot (preview geometry)
    stanford-bunny.obj      — Stanford bunny (preview geometry)
```

### Subprojects (outside src/)

- `ShaderCarousel/` — three purpose-built benchmark pages (no auto-play; centred Start gate each):
  - `bench-inout/` — A-Frame WebGL + WebXR, sphere-mover ping-pong, gate triggers `enterVR()`; logs rAF deltas via the bench-tick A-Frame component so frames are captured during XR too. UA-sniff headset detect + text override
  - `bench-static/` — Three.js WebGPU, static full-coverage sphere @ Quest 3 per-eye (2064×2208), `onSubmittedWorkDone` fence + multi-pass (default 30) defeats vsync clamping
  - `bench-microplane/` — Three.js WebGPU, 1024×1024 ortho quad, multi-pass; defaults to noise atomics only (per-node calibration via baseline subtraction)
  - Shared infra in `lib/`: `bench-style.css`, `bench-stats.js` (computeStats + exportResults emitting raw JSON + summary CSV + **complexity-suggestion JSON** mapping marginal ms → suggested points), `bench-registry.js` (baseline + 8 presets + 8 noise atomics + saved-groups loader stub — reads `fs:savedGroups` but greys entries lacking a `tslCode` field), `bench-ui.js` (grouped picker with master checkboxes, settings persistence, Reset-to-defaults, start gate, done popup, headset detect)
  - Three.js **r184** WebGPU ESM at `lib/three/` (the official `.min` builds — `three.webgpu.min.js`/`three.core.min.js`/`three.tsl.min.js` — copied from `node_modules/three@0.184`; used by the static/microplane benches via import map), A-Frame 1.8.0 IIFE at `components/three/a-frame-180-a-01.min.js` (synced from `a-frame-shaderloader/js/` by fs-vendor-sync; used by InOut), `sphere-mover.js`
  - Launcher at `ShaderCarousel/index.html` adopts each iframe's `<style>` AND `<link rel=stylesheet>` so adopted controls keep styling; `#bench-start-gate` + `#bench-done-popup` stay in the iframe (XR-entry needs the gesture origin to be inside the iframe document)
- `a-frame-shaderloader/` — **single source of truth** for the A-Frame bundle (`build/build.mjs` emits it), the shaderloader component, and orbit-controls. The `fs-vendor-sync` vite plugin copies these into `public/js/` (all three) and `ShaderCarousel/components/three/` (the bundle) at dev/build start — edit only here, never the copies. Also a git submodule + the jsdelivr CDN source for exported shaders.
- `src-tauri/` — Tauri v2 desktop shell. One custom Rust module: `src/bench_server.rs` — the LAN bench server (`bench_server_start/stop/status` commands; GET-only, path-sanitized tiny_http file server on 0.0.0.0:5199, ephemeral-port fallback) that serves the bundled ShaderCarousel to headsets on the local network; the suite is staged into `src-tauri/carousel-dist/` (gitignored) by the vite desktop profile and bundled via `tauri.conf.json`'s `bundle.resources`. The frontend reaches the commands through `withGlobalTauri` (`window.__TAURI__`, typed in `vite-env.d.ts`) — only ever touched behind `__FS_DESKTOP__` (the Toolbar "VR" popover, which also documents the WebXR/WebGPU secure-context workarounds: Quest Browser insecure-origins flag or `adb reverse`; plain HTTP is deliberate — a self-signed cert would interstitial anyway). `dragDropEnabled: false` in `tauri.conf.json` is REQUIRED — without it the OS-level drop handler swallows HTML5 drag-drop and every file-import surface silently dies. App version comes from `package.json` via `tauri.conf.json`'s `"version": "../package.json"`. Releases: `.github/workflows/release.yml` triggers on `v*` tags (flow: `npm version patch && git push --follow-tags`), tests, builds a macOS-universal `.dmg` + Windows NSIS installer + portable `.zip` (exe + the ShaderCarousel resource folder — a bare exe would break the VR bench, since Windows `resource_dir()` is the exe's directory) on native runners, deploys the web app to gh-pages in lockstep (the `web` job is gated on `desktop` so a failed binary build never leaves the site advertising unpublished binaries), and uploads assets under FIXED names (`FastShaders-macOS.dmg`, `FastShaders-Windows-Setup.exe`, `FastShaders-Windows-Portable.zip`) — the Toolbar "Local" dropdown links to `/releases/latest/download/<name>`, so keep `DESKTOP_DOWNLOADS` in `Toolbar.tsx` in sync with the workflow's asset names.
- `Tests/` — test shader JS files + test HTML page

## Key Conventions

- **Offline/desktop**: the app must run with NO network. Monaco is bundled locally (`CodeEditor/monacoSetup.ts` — `loader.config({ monaco })` + Vite `?worker` workers; never reintroduce the jsdelivr CDN loader) and fonts are self-hosted (`src/styles/fonts.css` — hand-written woff2-only `@font-face` rules referencing `@fontsource` package files, imported from `main.tsx`; do NOT re-add the `@fontsource/*.css` imports — they would duplicate the registrations and reintroduce the legacy `.woff` copies into dist). `FS_DESKTOP=1` — set automatically for `tauri dev`/`tauri build` via the CLI's `TAURI_ENV_*` env — switches vite to the desktop profile: base `/`, CSP meta suppressed, ShaderCarousel excluded from dist (it ships instead as a Tauri resource staged in `src-tauri/carousel-dist/`, served over LAN by the in-app bench server — see the src-tauri bullet under Subprojects), and the `__FS_DESKTOP__` define hides the Local button + SC link and shows the "VR" bench popover. Preview-iframe asset URLs resolve via `new URL(base + path, location.href)` (`resolveAssetUrl` in `tslToPreviewHTML.ts`) so they survive non-http schemes (tauri://) — don't revert to `location.origin` concatenation.
- **Sync engine**: `syncSource` field in zustand (`'graph'` | `'code'`) prevents infinite sync loops. `useSyncEngine` hook manages bidirectional sync with `lastSyncedCodeRef` to skip no-op updates
- **Node values**: always use `getNodeValues(node)` from `@/types` — never cast `node.data as ...`
- **Edge IDs**: always use `generateEdgeId(source, sourceHandle, target, targetHandle)` from `@/utils/idGenerator`
- **Single ShaderNode**: one component handles all TSL node types dynamically via registry
- **Node visuals**: per-node designer overrides live in `glyphs/customGlyphs.ts` — `{ svg, justify, scale (glyph-only; spacing fixed), dx/dy (glyph nudge), width (exact, ≥24), height (exact in both layouts, ≥28; shorter than content overflows; independent of glyph scale), text (0.4–2.5× header/value/label fonts via --node-text-scale), sockets (center-relative offsets, 4px snap; op layout natively, rows layout detaches the socket from its row — values follow) }`; frame radius/border are **fixed app-wide**. Connected inputs show edge values (`min…max` ranges, bare `…` when underivable; geometry attributes have analytical ranges). Multi-channel data **arriving on a connected input** stacks the node into N cards (sibling layers behind the card, staggered negative z, single group shadow from the deepest layer). Sockets are **static** — never set `transform` on handle `:hover` (React Flow positions handles via transform) — and never stack. The Node Designer (`node-designer.html`) saves via the dev-server endpoint `/__nd` (any browser), the File System Access API (Chromium), or download; see `NODE_DESIGN_REQUIREMENTS.md`
- **Light theme by default, app-wide dark mode**: flat design with sharp dark shadows, CSS tokens in `tokens.css`. The code-editor sun/moon button (`codeEditorTheme`, persisted to `fs:codeEditorTheme`) is the ONE dark-mode control: it themes Monaco AND stamps `data-theme="dark"` on `<html>` (via `setCodeEditorTheme` + an inline FOUC guard in `index.html`), which flips the CHROME tokens redefined in `tokens.css`'s `:root[data-theme="dark"]` block (backgrounds, text, borders, chrome shadows, `color-scheme`). **Graph nodes must render identically in both themes** — node bodies read the theme-invariant `--node-bg` (not `--bg-panel`), node text/borders are hardcoded literals or inline cost/category colors, and `--shadow-node*`/`--type-*`/`--cost-*`/`--cat-*` are deliberately NOT redefined in the dark block. Per-surface dark tweaks (hardcoded light-assuming literals that tokens can't reach) live as `:root[data-theme="dark"]` blocks in each component's own CSS; the React Flow grid + minimap-mask are props flipped in `NodeEditor.tsx`. The canvas background is user-pickable AND remembered PER THEME (`nodeEditorBgColorLight`/`Dark`; `nodeEditorBgColor` is the effective active-theme value; dark default `#1e1f22`); cost badges and 1-channel edges auto-flip via `getContrastColor(nodeEditorBgColor)` so they invert to light on the dark canvas automatically. `projectImport` applies theme BEFORE canvas color so the color lands in the right per-theme slot.
- **A-Frame pipeline**: graphToCode → tslToShaderModule → shaderloader 0.4 (runtime TDZ fix + auto-import injection + `export const schema` parsing) → dynamic blob import. (The old standalone `.html` export left with the A-Frame tab — the `.js` download is the only export.)
- **Centralized vendoring (single source + sync)**: the A-Frame IIFE bundle (`a-frame-180-a-01.min.js`), shaderloader (`a-frame-shaderloader-0.4.js`), and orbit-controls live ONLY in `a-frame-shaderloader/js/`. The `fs-vendor-sync` vite plugin (`vite.config.ts`) copies them into `public/js/` and the bundle into `ShaderCarousel/components/three/` at dev/build start; `src/vendorSync.test.ts` fails on drift. **Never hand-edit the copies** — edit the submodule source and re-run vite. Everything runs **Three.js r184**: the bundle (super-three 0.184), `node_modules/three` (`^0.184.0`), and the carousel's standalone ESM `ShaderCarousel/lib/three/*.min.js` (the official minified builds copied from `node_modules/three`, used by static/microplane benches via import map).
- **rAF ref pattern**: PreviewNode/MathPreviewNode/EdgeInfoCard overwrite refs for animation — this is correct (avoids stale closures)
- **Canvases inside the React Flow viewport MUST be CPU-backed**: every `getContext('2d', { willReadFrequently: true })` in PreviewNode/MathPreviewNode/ClockNode is deliberate — an ACCELERATED canvas becomes its own compositing layer in Safari, WebKit's overlap compositing then promotes the surrounding nodes into layers rasterized at 1×, and the whole zoomed canvas goes blurry (empirically bisected 2026-07-11 via the `?fsdbg=nocanvas` switch in `main.tsx`, which stays available for renderer triage). Never add a plain-context or WebGL canvas to anything rendered inside `.react-flow__viewport`.
- **Noise nodes**: 8 MaterialX-backed nodes (`perlin`, `perlinVec3`, `fbm`, `fbmVec3`, `cellNoise`, `voronoi`, `voronoiVec2`, `voronoiVec3`) all use the same `pos`/`scale` parameter convention. graphToCode emits them via the `def.category === 'noise'` branch; codeToGraph parses them via `processNoiseCall`; CPU thumbnails come from `noisePreview.ts`; live GPU previews run the generated TSL through the preview iframe (`graphToCode` → `tslToPreviewHTML` → `convertToShaderModule`). `tsl-textures` was removed in favour of three.js's built-in MaterialX noise; the `texture` category backs the content-browser Textures tab (`builtinTextures.ts`) and holds exactly one (hidden) node definition — the drag-dropped Image node.
- **Image node**: drag-dropped images become a hidden `imageNode` (mirrors the Data node pipeline). Payload = whitelisted `data:` URL on `values.imageB64` — **adversarial**: codegen re-encodes the decoded bytes (`decodeImageNode` → `bytesToBase64`, never the stored string), the ShaderNode thumbnail renders only `validImageDataUrl()`, malformed payloads degrade to an inert `vec3(0,0,0)`. Emission = FLAT module-scope statements with top-level await (never an async IIFE — codeToGraph's ReturnStatement visitor would hijack the output): `new Image()` → `try { await decode() } catch` → 1×1 fallback → `THREE.Texture` with RepeatWrapping, pinned `flipY`, sRGB or linear data-map per `values.colorSpace` ('color' | 'data'); the Fn body samples `texture(tex, uvExpr).rgb` (vec3 out; `uv` input falls back to `uv()`). **Normal-map decode**: an image wired into the Output node's `normal` socket is a tangent-space normal MAP, not a raw normal — graphToCode wraps that channel in TSL's `normalMap(...)` (which does the `*2-1` remap + TBN tangent→view transform + normalize) rather than feeding the raw [0,1] sample into `normalNode`. `normalMap()` needs LINEAR input, so `NodeEditor.onConnect` auto-switches the image to the `data` colorSpace on connect (skipped if the same image also drives an sRGB channel — one texture, one colorSpace; mutated via `setNodes` so connect+flip is a single undo step). Non-image sources feeding `normal` stay a raw normal override (unwrapped). NodeSettingsMenu has a "UV / Texture" section (values read Number-coerced by codegen): `tileX/tileY`, `offsetX/offsetY`, `repeat` (off → ClampToEdge), `flipX`/`flipY`, and the data-map toggle. All five inputs (`uv`, `tileX/tileY`, `offsetX/offsetY`) follow the SAME opt-in `exposedPorts` rules as the noise nodes (see NODE_DESIGN_REQUIREMENTS.md → "Exposed parameter sockets"): hidden until checked in the generic NodeSettingsMenu sections, auto-exposed when an edge arrives (useSyncEngine + loadGraph migration), wired edge overrides the stored value, hiding drops the port's edges. Dragging a wire within snapping distance of a node with named input sockets forces its input name-tooltips visible (floated left of each socket — TypedHandle `reveal` prop; operator cards, the Output node, and collapsed groups opt out — generic/permanent labels); noise + Image nodes additionally reveal their hidden sockets as floating dots on the card's left edge — dimmed, layout untouched — and landing the connection exposes that port permanently (`connectionReveal.ts` + `RevealSockets.tsx` + onConnect/onReconnect auto-expose; the reveal radius IS the editor's snap radius, one shared `CONNECTION_RADIUS`). The Output node does NOT drag-reveal hidden channels (settings-menu only). On the card, imageNode input rows show ONLY the port label (`.shader-node__in-label`) — never inline number widgets (numbers are context-menu-only). When the graph embeds images, "Download Shader" produces a `.zip` (dependency-free STORE writer, `zipWriter.ts`): the self-contained `.js` + `images/<sanitized-name>.<real-mime-ext>` + README. Import accepts `.js` AND `.zip` on every surface — Load Script, the code-panel drop, and the canvas drop — via the shared `projectImport.ts` path (`zipReader.ts` picks the `.js` carrying the FASTSHADERS_PROJECT_V1 block; the loose image files are ignored on import since the payloads ride in the `.js`). NB the raw sample renders mirrored left-right in the preview, so codegen bakes the `1-u` correction into the DEFAULT; the Flip X checkbox (unchecked by default) mirrors relative to the corrected look — checking it emits the raw `uv()`. Context menus get enlarged type via `--font-size-*` token overrides scoped on `.context-menu` (ContextMenu.css) — all submenus + DragNumberInput inherit them. Limits (`imageNode.ts`): 600K chars/image with downscale-retry, 3M chars total, 64MP source guard — bypassable via the LimitModal checkbox (`fs:ignoreImageLimits`); the 8M-char hard ceiling always applies. localStorage quota failures (graph autosave + saved groups) surface a `storage-quota` LimitModal notice instead of failing silently.
- **Groups**: selection groups are first-class React Flow nodes (`type: 'group'`) created via Ctrl+G or right-click → Group Selection. They have no registry entry and no shader semantics — `graphToCode`/`cpuEvaluator` ignore the *node*, but call `unwrapCollapsedGroupEdges()` from `edgeUtils.ts` at their entry to translate visually-rewritten boundary edges back to their real child endpoints, so collapse state never affects compiled output. Groups can be recolored, renamed, collapsed (members hidden via `display: none` className — *not* React Flow's `hidden: true`, which would unmount rAF loops), saved to a per-browser library (`fs:savedGroups`), and dragged out of containers. Members never get `extent: 'parent'` — `onNodeDragStop` reconciles `parentId` after every drag instead.
- **History**: circular buffer (50 entries) with undo/redo via `structuredClone`, Cmd+Z/Cmd+Shift+Z shortcuts
- **localStorage**: auto-saves graph, split ratios, shader name, headset selection, cost colors, canvas bg color, code editor theme, preview prefs (geometry, lighting, subdivision, bg, uniform bounds, uniform values, camera pos, rotation, playing state), saved groups (debounced 300ms), asset-bar collapse + tile zoom (`fs:assetBarCollapsed`, `fs:assetZoom` — Ctrl/Cmd+wheel over the strip or the floating +/− buttons). Reset clears camera/rotation/playing and restores lighting/subdivision/uniforms — bg color, uniform bounds, and geometry are treated as user preferences. Uniform values persist by name: removing a property node from the graph keeps the stored value (the iframe ignores `fs:uniform` messages for unknown names), so re-adding a property with the same name restores the user's last tuning.
- **VR cost budgeting**: 6 VR headset presets with maxPoints, cost gradient visualization in CostBar
- **Unknown nodes**: unrecognized TSL functions in code→graph parsing create `unknown` nodes that store `functionName` and `rawExpression` in values. These round-trip through graphToCode (emitted verbatim), render as magenta `vec3(1,0,1)` fallback in live preview, and show as orange warnings (not errors) in the code editor. The `unknown` definition lives in `NODE_REGISTRY` but is excluded from `allDefinitions` (hidden from content browser/search)
- **Preview geometries**: five options — `sphere`, `cube`, `plane` (primitives) and `teapot`, `bunny` (OBJ models in `public/models/`). `isObjGeometry()` in `tslToPreviewHTML.ts` is the single source of truth for primitive vs OBJ branching. The inline `fit-bounds` A-Frame component recomputes vertex normals (after merging vertex duplicates so per-vertex displacement doesn't split the surface), auto-detects inverted winding (the bunny is CW), generates spherical UVs from each vertex's direction so `uv()` reads cleanly on OBJ meshes, and rescales so the longest axis = 1.6 to match primitive framing. The source OBJs themselves are **pre-normalized** (bbox center at origin, longest axis exactly 1.6), so the runtime recenter/rescale is a no-op for them (kept as a safety net for arbitrary models) and `positionGeometry` ranges are comparable across all five geometries.

## TypeScript Notes

- `@babel/traverse` CJS/ESM interop: `const traverse = (typeof _traverse.default === 'function' ? _traverse.default : _traverse)`
- React Flow v12: import from `@xyflow/react`, use `Node<DataType, TypeName>` generics
- `applyNodeChanges`/`applyEdgeChanges` return base types — cast with `as AppNode[]`
- `@types/three` uses `>=0.182.0` range (not caret) to match installed version
- `ParseError.severity` is optional — omitted (or `'error'`) blocks code→graph sync; `'warning'` allows sync to proceed
- `tsconfig.node.json` must have `"composite": true` and `"noEmit": false` when referenced from main tsconfig
