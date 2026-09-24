# FastShaders

Bi-directional TSL (Three.js Shading Language) visual shader editor. Users author and execute their own shader code inside the app, and `.fastshader` files can be shared between users — **treat any loaded `.fastshader`, pasted shader source, dropped model or `fs:*` localStorage value as adversarial input.**

> **Before changing node visuals, the glyph system, `ShaderNode`, `NodePreviewCard`, or the Node Designer (`node-designer.html`), read `private/NODE_DESIGN_REQUIREMENTS.md` — the authoritative spec for node appearance/layout.** It is internal working material: `private/` is gitignored, so the file is not in a fresh clone and the path is deliberately not a link (it would 404 on GitHub). Elsewhere in this file and in source comments the spec is cited by bare name — that is the file.

## How this file works

The **rules** are here; the **reasoning, measurements and negative results** behind them live in `docs/dev/`. Nearly every rule records a bug that shipped once already, so before changing an area, read its file — the one-liner tells you *what* not to do, the file tells you *why* and what was already tried and rejected.

| Read before touching | File |
|---|---|
| Browser floor, offline/desktop builds, vendoring, releases, feedback button | `docs/dev/platform-and-release.md` |
| The user-study mode (`/eval`, `/evalpro`, `/evalp`), consent, telemetry | `docs/dev/eval-mode.md` |
| Sync engine, store, history, ids, rAF loops, import auto-fit | `docs/dev/graph-and-store.md` |
| localStorage keys, ASCII storage, payload refs, viewport memory, cost profiles | `docs/dev/storage-and-limits.md` |
| `graphToCode` / `codeToGraph`, emission contracts, alpha, discard, helpers | `docs/dev/codegen.md` |
| Output nodes, per-mesh materials, `parts`/`materialParts`, active sink | `docs/dev/outputs-and-materials.md` |
| Distance-field nodes and the Raymarch Output | `docs/dev/sdf-and-raymarch.md` |
| Noise, colormaps, dataviz, Data Range formula, Time, Sound | `docs/dev/node-types.md` |
| The Image (Texture) node, drop-time conversion, resolution, revert | `docs/dev/images-and-textures.md` |
| Node appearance, selection/lift, theming, glyphs, Node Designer | `docs/dev/node-visuals-and-designer.md` |
| Canvas navigation, edges, drag-connect, groups, Preview mode | `docs/dev/canvas-interaction.md` |
| 3D preview, shaderloader 0.8, podest, XR, preview geometries | `docs/dev/preview-and-runtime.md` |
| Dropped models, glTF reader/strip, GLB import/export, decoders, zips | `docs/dev/models-and-gltf.md` |
| Node search, editor visibility, optional categories, i18n | `docs/dev/discovery-and-i18n.md` |
| Full annotated source tree (rules live in the annotations) | `docs/dev/project-structure.md` |
| Test harness contracts and the coverage inventory | `docs/dev/testing.md` |

## Stack

- React 18 + TypeScript + Vite (ES modules, base path `/FastShaders/`)
- `@xyflow/react` v12 — node graph editor
- `@monaco-editor/react` — code editor
- `zustand` v5 — state management
- `@babel/parser` + `@babel/traverse` — code→graph parsing
- `@dagrejs/dagre` — auto-layout (LR direction)
- `three` (WebGPU build) — shader runtime; FastShaders uses only `three/tsl` built-in functions including the MaterialX noise family (`mx_noise_*`, `mx_fractal_noise_*`, `mx_worley_noise_*`, `mx_cell_noise_float`)
- Path alias: `@/*` → `./src/*`

## Commands

- `npm run dev` — start dev server (port 5173)
- `npm run build` — typecheck + build (`tsc -b && vite build`)
- `npx tsc --noEmit` — typecheck only
- `npm test` — run the vitest suite once (CI-friendly)
- `npm run test:watch` — run vitest in watch mode
- `npm run tauri dev` / `npm run tauri build` — desktop (Tauri v2) shell; needs a local Rust toolchain. Releases are built in CI (no local Rust required)
- `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`, run inside `src-tauri/` — the Rust gate for any change to the desktop shell. The crate is fmt- and clippy-clean, so a failure is always the change under test. CI runs only `cargo test` (release.yml's desktop job, after the build), never clippy, so a new toolchain's lint cannot block a release. Two traps: `generate_context!` needs `../dist` and `../package.json` (a placeholder `dist/index.html` does), and tauri-build writes `src-tauri/gen/`, so a throwaway check is best run in a copy of `src-tauri/`

## Deployment

**When the user says "deploy" (or "deploy to all"), it ALWAYS means: commit the pending work, push, and ship to ALL THREE targets** — never stop after the release pipeline. They serve different audiences and drift apart silently, because each one is deployed by its own command and only the first is triggered by the tag. Nothing reconciles them — a release that stops after step 1 leaves two hosts on an older build with no warning anywhere (measured 2026-09-09: Pages 0.3.31, sferas 0.3.28).

0. **Commit + push first**: commit whatever is pending (and push the `a-frame-shaderloader` submodule first if it changed, then purge jsdelivr for every new/changed loader file). "Deploy" is standing authorization to commit and push; don't ask again.
1. **Release pipeline** (web on GitHub Pages + desktop binaries, in lockstep): `npm version patch && git push --follow-tags`. The `v*` tag triggers `.github/workflows/release.yml` → tests, macOS `.dmg` + Windows installers, gh-pages deploy.
2. **alvismisjuns.lv** (the author's site): `npm run deploy:alvismisjuns` — builds with `FS_BASE=/fastshaders/` + that host's CSP origins and uploads `dist-alvismisjuns/` via psftp (credentials in the gitignored `.vscode/sftp.json`; needs `brew install putty`). `-- --no-build` re-uploads the existing snapshot. Run it from the SAME committed/tagged state as step 1 — it deploys the working tree, not the last tag. It curl-verifies the deployed version meta.
3. **fs.sferas.lv** (the STUDY host — `…/eval`, `…/evalpro`, `…/evalp` are handed to participants from here, so it is the one host where being behind changes what a study measures): `npm run deploy:sferas`. Three differences from step 2, spelled out in the script's header: base is `/` (this host serves at ROOT), `FS_PREVIEW_ORIGIN` names this host so the sandboxed preview's opaque origin may fetch the built-in models, and the target is **`/var/www/fs/src`** — the docroot of the dedicated `fs` container, NEVER `/var/www/sferas/src`, a shared directory of a dozen unrelated projects. It curl-verifies the version meta AND that **`/evalp/` returns 200** — the study entries are DIRECTORY urls, so a path or rewrite mistake shows up there while `index.html` still looks perfect.

## Testing

Framework: **vitest** (configured in `vite.config.ts` so `@/*` + TS setup are inherited). Tests match `src/**/*.test.ts`; environment is `node` (no jsdom — pure logic only). The zustand store imports cleanly under `node`, so store logic is unit-testable.

- **The suite runs with `isolate: false`**, so every file in a worker SHARES that worker's module registry and globals. The contract: **every file calling `vi.stubGlobal` must restore it** (`vi.unstubAllGlobals()` in `afterEach`/`afterAll`) — `src/stubGlobalRestore.test.ts` fails on one that does not, since a leaked stub lands on whatever file runs next. `registry/editorVisibility.test.ts` is the ONE file that may call `vi.doMock`/`vi.resetModules`. Keep store-mutating suites self-resetting in `beforeEach` — and a suite that touches the undo history spreads **`HISTORY_IDLE`** (`src/test-utils.ts`) into that reset, since a leaked `isUndoRedo`/`coalescingHistory` makes `pushHistory` a silent no-op in whichever file runs next (`historyIdleReset.test.ts` enforces it).
- **Shared factories live in `src/test-utils.ts`** (`makeNode`, `makeEdge`) — always import these rather than redefining stubs. It also holds the KTX2 harness (`installInProcessWorker`, `fakeRenderer`, `makeKtx2Glb`) and the ONE glTF/GLB fixture set (`makeGlb`, `gltfPrimitiveDoc`, the header-only image fixtures, `makeRealPng`). Don't write a local `glb()` helper.
- **Every shaderloader suite gets its loader from `src/shaderloaderHarness.ts`.** `ACTIVE_LOADERS` is `['0.6', '0.8']` and the shared suites assert against both. **Never read a loader at a suite's module top level** — a copy that stops being vendored makes that read THROW, not skip.
- **A suite that pins a documented CLAIM reads `src/projectDocs.ts`, never `CLAUDE.md` directly** — the corpus is CLAUDE.md plus `docs/dev/*.md`, so a guard keeps holding when a paragraph moves between them. A positive pin still fails when the claim is deleted anywhere; a NEGATIVE pin (a retracted claim that must not come back) gets stronger, since it now covers every doc file. Seven suites depend on this.
- **Coverage is `find src -name '*.test.ts'`, not a written list** (365 files as of 2026-09-19). Any count written into prose is stale within a week.

Full harness contracts and the coverage inventory: `docs/dev/testing.md`.

## Project Structure

Compact map. **The full annotated tree is `docs/dev/project-structure.md`** — many rules live only in those annotations, so grep it before changing a path you do not recognise.

```
src/
  App.tsx              — entry component, demo graph, SyncController, seedFromStored boot seed
  main.tsx             — React 18 root, CSS imports
  nodeEditor.tsx       — React root for node-editor.html (GraphsPage overview + description editor)
  nodeEditorBootstrap.ts — MUST be nodeEditor.tsx's FIRST import: disables graph autosave
  styles/              — tokens.css (design tokens), controls.css (.fs-seam, .fs-dragging), reset.css
  components/
    CodeEditor/        — Monaco panel (TSL / A-Frame / Three.js tabs, Apply, Import)
    Graphs/            — GraphsPage (node/texture overview, "In editor" checkboxes) + modals
    Layout/            — Toolbar, CostBar, SplitPane + SeamLens, AppLayout, WorkFolder (desktop),
                         PreviewLink + PreviewRail (Output→preview wires), toolbarOverflow,
                         assetBarDrag, ScrollArrows, AssetCostBadge, tile cards, tileDrag
    NodeEditor/        — React Flow canvas, ContentBrowser (palette/Presets/Textures/Saved Groups),
                         DrawingLayer, edges/ (TypedEdge, bezierGeometry), handles/ (TypedHandle),
                         inputs/ (DragNumberInput), menus/ (ContextMenu + per-node settings),
                         nodes/ (ShaderNode, OutputNode, RaymarchOutputNode, Color/Preview/Clock/
                         Sound/Group/Note, glyphs/, NodeVisual, outputNodePlans, sectionLabelText),
                         dragConnect, overlapCascade, keyboardNav, flowTypes, PreviewRoute
    Modals/            — CsvImport, Limit, Feedback, NewShader, ExportPreflight, DesktopAppNote,
                         GlbImport, GlbExport
    Preview/           — ShaderPreview (sandboxed iframe), useGlbImport, subdivisionSteps
    Tooltip/           — TooltipLayer (app-wide tooltip portal)
    inputs/            — PaletteColorPicker (app-wide colour picker, outside the NodeEditor tree)
  engine/
    graphToCode.ts / codeToGraph.ts     — the two directions of the graph↔TSL bridge
    tslCodeProcessor.ts                 — shared TSL processing (imports, TDZ fix, body parsing)
    partKeyLiteral.ts                   — THE encoder of string keys written into generated code
    moduleHelpers.ts                    — the ONE table of module-scope helper Fns + aliases
    tslToPreviewHTML / tslToAFrameHTML / tslToThreeHTML — the three generated documents
    tslToShaderModule.ts / scriptToTSL.ts — module emit and its reverse
    topologicalSort / cpuEvaluator / evaluateTSLScript / layoutEngine
    projectImport.ts                    — shared import path for EVERY surface
    gltfImport.ts / gltfSectionBuilder.ts / gltfImportFixtures.ts — GLB→shader composer
    fastShadersProject.ts / projectImageRefs.ts — the FASTSHADERS_PROJECT_V1 embed
    imageAssets.ts / previewAssetFeed.ts / imageTexturePlan.ts — image payload plumbing
    exportShader.ts / exportSingleGlb.ts / glbShaderContract.ts — export assembly
    teapotData.ts / teapotGeometry.ts   — runtime Utah teapot tessellator
  eval/                — the user-study mode (arm, consent, telemetry, SUS, package, upload)
  hooks/               — useSyncEngine, useLongPress, usePersistedState, useDismiss, useFitText
  i18n/                — t() overlay; lv.json + node-i18n.json (SINGLE source for node labels)
  nodeDesigner/        — Node Designer module (node-designer.html is a real Vite entry)
  registry/
    nodeRegistry.ts    — 98 hardcoded node definitions (+ hidden unknown/dataNode)
    nodeCategories.ts  — 14 categories; optionalCategories.ts — Textures + Distance fields switches
    builtinTextures.ts (8) / builtinPresets.ts (24) / builtinPalettes.ts / codeGroupBuilder.ts
    colormapData.ts (GENERATED) / colormaps.ts / complexity.json (per-node GPU cost)
    citations / descriptionSplice / legacyNodeTypes / editorVisibility
  store/
    useAppStore.ts     — zustand: graph, sync, history, UI, groups, prefs, drawings, previewMesh
    desktopAutosaveBoot.ts — desktop-only file-backed autosave boot
  types/               — node.types, tsl.types, sync.types, index barrel
  utils/               — pure helpers; the load-bearing ones:
    outputMaterials    — Output predicates, materials, cross-node plans, restore sanitizers
    sdfPartition       — activeSink, drivingMarchOutput, marchPartition
    nodeCost / costTable (LEAF) / costOverride — pricing
    exposedPorts / chainOperands / edgeUtils / graphShape / graphSemantics
    previewMesh + gltfCompression (LEAF) / gltfReader / gltfStrip / glbContainer / gltfNaming
    glbImportGate / gltfImportPlan / gltfTextureEncode / glbImportReport / glbImportLimits (LEAF)
    imageNode / imageCodec / imageImport / imageChannels (LEAF) / imageTextureSpec / imageUvMapping
    imagePayloadRefs / imageOriginCache / previewMeshCache / idbSafe / payloadDigest (LEAF)
    zipReader / zipWriter / exportBundle / exportPreflight / glbExportAvailability (LEAF)
    asciiStorage / viewportMemory / platformCaps (LEAF) / formatSize / fillTemplate (LEAF)
    soundSession / soundAnalysis / deviceCapture / audioCaptureCore / systemAudioCapture
    dataViz / dataNode / csvParser / dataRangeFormula / colorUtils / drawings / palettes
    desktopIpc / desktopAutosave / tauriBridge / workFolderFile / desktopDownloads (LEAF)
    dragChrome / historyGesture / meshInventory / meshHighlight / textureMemory
public/
  js/                  — VENDORED, do not hand-edit (synced by the fs-vendor-sync vite plugin):
                         a-frame-shaderloader-0.8.js, a-frame-180-a-01.min.js, orbit controls,
                         decoders/ (Draco, meshopt, basis KTX2)
  models/              — teapot.obj (GENERATED via npm run gen:teapot), stanford-bunny.obj
  podest.html          — standalone full-screen shader viewer (see docs/PODEST.md)
  webgpu-xr-demo.html  — standalone WebGPU/TSL + immersive-WebXR demo
  images/              — every served picture, with provenance README
docs/
  dev/                 — the deep reference for this file (see the table above)
  PODEST.md, fastshaders-function-diagram.{png,svg} — deliberately NOT in public/
```

### Subprojects (outside `src/`)

- **`ShaderCarousel/`** — three benchmark pages (`bench-inout` A-Frame WebXR, `bench-static` and `bench-microplane` Three.js WebGPU), shared `lib/` (driver, timing, stats, registry, ui), `benchData/` (committed calibration runs + `fit-core.mjs`, imported by the vitest suite). The launcher's front door is one button running MicroPlane with shipped defaults — the ONE mode whose export prices nodes. `DEFAULT_MODE` is `bench-microplane`; InOut never prices.
- **`a-frame-shaderloader/`** — **single source of truth** for the A-Frame bundle, the shaderloaders and orbit-controls; `fs-vendor-sync` copies them into `public/js/` and `ShaderCarousel/`. Also a git submodule + the jsdelivr CDN source for exported shaders. **Edit only here, never the copies.**
- **`src-tauri/`** — Tauri v2 desktop shell. Four Rust modules: `podest_window.rs` (`podest_open` — a real second window; the builder MUST call `disable_drag_drop_handler()`), `work_folder.rs` (the desktop open/save loop; bytes cross IPC RAW both ways), `autosave.rs` (file-backed `fs:graph`/`fs:savedGroups`, content-addressed images), `bench_server.rs` (LAN bench server on :5199). `dragDropEnabled: false` in `tauri.conf.json` is REQUIRED. Releases: `.github/workflows/release.yml` on `v*` tags, assets under FIXED names kept in sync with `utils/desktopDownloads.ts`.
- **`Tests/`** — test shader JS files + a test HTML page.

## Key Conventions

Every rule below is a guard rail with a measured failure behind it. Where a group names a `docs/dev/` file, read it before changing that area.

### Platform, offline and release → `docs/dev/platform-and-release.md`

- **The browser floor is Chrome 111 / Safari 16.4 / Firefox 126, and it MOVES silently.** `build.target` is `esnext` with nothing transpiled down, so the floor is whatever newest feature is used. Today: `color-mix()` (Chrome 111), monaco's ES2022 static blocks (Safari 16.4 — the one HARD break, and it only fires when the CODE PANEL opens, since CodeEditor is `lazy()`), non-standard `zoom` (Firefox 126). The numbers are a drift set stated in index.html's fallback text, README's table and here. Nothing feature-detects, deliberately.
- **The app must run with NO network.** Monaco is bundled locally (`CodeEditor/monacoSetup.ts`) and fonts are self-hosted — never reintroduce a jsdelivr/Google-Fonts CDN link. `FS_DESKTOP=1` switches vite to the desktop profile (base `/`, no CSP meta, ShaderCarousel as a Tauri resource, `__FS_DESKTOP__` define, raised size caps via `utils/platformCaps.ts`). Preview-iframe asset URLs resolve via `new URL(base + path, location.href)` so they survive `tauri://` — don't revert to `location.origin`.
- **Feedback uploads nothing, and that is a constraint, not a preference** — the build CSP blocks any hosted endpoint, the desktop build must work offline, and a third-party form would make someone else a data processor for grant-funded research. `mailto:` + clipboard fallback. The report carries COUNTS only, never graph content; edges are counted on the UNWRAPPED graph.
- **Vendored copies in `public/js/` are generated — edit `a-frame-shaderloader/` and re-run vite.** `vendorSync.test.ts` fails on drift in either direction. Loaders 0.4/0.5/0.6 are FROZEN (already-exported shaders fetch them from the CDN); new work goes in 0.8, additively. Everything runs Three.js **r184**.
- **Push the submodule and purge jsdelivr BEFORE the release tag.** Exported `.js` reference the loader on jsdelivr, which caches branch refs AND caches the 404 — so a loader pushed after the app deploys 404s for every recipient while working perfectly for the author. Order: push submodule → commit pointer bump + `npm test` → purge each changed file → `npm version patch && git push --follow-tags` → the two host deploys. `release.yml` checks out the RECORDED pointer, so an un-bumped pointer fails `vendorSync.test.ts` before any binary builds.

### Eval mode (the study switch) → `docs/dev/eval-mode.md`

- **`/eval`, `/evalpro`, `/evalp` arm a sessionStorage flag — never localStorage**, or the browser stays in eval mode forever. Consent comes BEFORE any logging; Agree adopts the participant code as the shader name and runs `cleanSlateForStudy()` (which is more than `newGraph()` — preview mesh, uniform prefs, history, viewport, cost budgets and the optional categories all have to go).
- **Telemetry is a closed vocabulary logged from a REVIEWED chokepoint set** pinned by `evalHooks.test.ts`; adding a chokepoint changes what a running study records. `telemetry.ts` must never import the store. Events sit on ONE monotonic clock (the journal persists a wall anchor and recovery REBASES).
- **In a study session: EXPORT is the finish control** (it opens EvalFinishModal, not a download), the single-GLB export is never offered, the export pre-flight never shows, and `/evalp` removes EVERY point figure (`pointsVisible` implies `costBarVisible`; suppression is display-only — snapshots keep recording cost).
- **The study host is fs.sferas.lv.** The upload endpoint is a RELATIVE path that only alvismisjuns serves, so from the study host it 404s and reports `'failed'` — the download is the floor.

### Graph core, store and loops → `docs/dev/graph-and-store.md`

- **Sync engine**: `syncSource` (`'graph' | 'code'`) prevents infinite loops; `useSyncEngine` manages both directions with `lastSyncedCodeRef` to skip no-ops.
- **Node values**: always `getNodeValues(node)` from `@/types` — never cast `node.data as …`. Output nodes use `outputNodeValues(data)` (the nullish-only guard throws on a tampered primitive).
- **Edge IDs**: always `generateEdgeId(source, sourceHandle, target, targetHandle)`.
- **Single ShaderNode**: one component handles all TSL node types dynamically via the registry.
- **History**: 50-entry circular buffer via `structuredClone`. **Continuous gestures MUST be bracketed** (`beginInteraction`/`endInteraction`) so a scrub is one undo entry and the graph isn't cloned 60×/s. `beginInteraction` also clears `future`, so never bracket a write that might change nothing, and never bracket a PREFERENCE site.
- **`setCode(code, 'code')` writes `code` ONLY**; `previewCode` advances on a graph→code sync or Apply. Collapsing the two is the accidental way to make every keystroke rebuild the preview iframe.
- **Deleting a node SPLICES the chain** (`bridgeEdgesAcrossDeletedNodes`). React Flow's own delete is disabled so every path goes through that ONE helper; a fourth path that skips it silently redefines what Delete means.
- **A component that mounts/unmounts handles at runtime MUST call `useUpdateNodeInternals(id)`** keyed on the handle SET — otherwise edges stay in the store, emit correct code, and simply never DRAW (and a reload "fixes" it, so it reads as a React Flow glitch).
- **rAF ref pattern**: PreviewNode/MathPreviewNode/EdgeInfoCard overwrite refs for animation — correct, avoids stale closures.
- **Canvases inside the React Flow viewport MUST be CPU-backed** (`willReadFrequently: true`) or Safari's overlap compositing blurs the whole zoomed canvas. Prefer SVG outright for VECTOR content (`WaveformSvg`, `ClockFaceSvg`); only raster content still earns a canvas.
- **Animated editor surfaces read ONE clock** (`utils/appClock.ts`) — never a per-loop `startTime = timestamp` epoch, or two surfaces evaluate the same wire at different `t`.
- **An import auto-frames the canvas** via `fs:graph-imported` (deliberately not `fs:project-imported`, which also fires for a model-only zip). NodeEditor ARMS a fit rather than fitting on the event, behind a double-rAF measurement guard and a timeout disarm.
- **A dropped shader ASKS — Open or Add** (`Modals/ShaderImportModal.tsx`, raised by the ONE gate `utils/shaderDropRequest.ts` from all three drop surfaces; never in a study session, and never for "Load Script…" or the Work folder, which are already explicit opens). **OPEN** is today's import plus the NAME: the authored one wins, the file's STEM is the fallback (`utils/shaderDropName.ts`) — `nameFallback` defaults to absent, so every other caller stays byte-identical. The forwarded-shader `window.confirm` stays AHEAD of the gate, on the surface.
- **ADD parks the dropped shader beside the graph in one group named after the file, wired to nothing** (`engine/shaderGroupImport.ts`). Every sink LEAVES with its edges (`isSinkNode`) — an arriving Output would silently take over the render — so no Output arrives and the unfold/active-sink repairs have nothing to do. Ids are all re-minted (a file usually carries the live graph's own), a Sound node is REDIRECTED onto the live one, nesting survives parents-first, and it announces **`fs:graph-merged`, never `fs:graph-imported`**: one undo entry, the budget counted before `pushHistory`, the preview mesh untouched.

### Storage, persistence and cost budgets → `docs/dev/storage-and-limits.md`
- **A `values` ENTRY is adversarial, and coercing one can THROW** — `String(v)`/`Number(v)` run ToPrimitive, which dies on `{"toString":1}` or a symbol. There is NO error boundary in this app, so a throw from codegen or a render blanks the whole screen, and the 300 ms autosave (a store SUBSCRIPTION, outside React) writes the poisoned graph back so every reload blanks again. `rawNodeValues` drops uncoercible entries — BY IDENTITY when there are none, so no memo moves — and `utils/valueCoerce.ts` (`valueStr`/`valueNum` drop-ins, `plainStr` strict) guards the readers that take a `values` map as a PARAMETER. Both are permissive on purpose: anything that coerces without throwing is kept EXACTLY, because those coercions are pinned (`repeat: false` must stay CLAMP). Measured 2026-09-19: 38 single-key poisoned graphs across 17 node types, all fatal; guarding call sites one at a time did not converge.

- **The localStorage inventory lives in `docs/dev/storage-and-limits.md` and a key missing from it is a key nobody audits** — that is how `fs:costBudgets` reached the study as an inherited CONDITION rather than a preference.
- **`fs:graph` and `fs:savedGroups` are written as pure ASCII** (`utils/asciiStorage.ts` — the ONE writer path). WebKit charges localStorage by the stored string's in-memory width, so one Latvian diacritic doubles a multi-megabyte autosave. The `TextEncoder`/`TextDecoder` re-encode after escaping is NOT optional; never decode as `latin1`.
- **An image payload is STORED once per localStorage document** (`imageRef`, content-compared, never trusted by hash alone — FNV collides for real). In memory nothing changes. There is deliberately NO shared table key.
- **`fs:viewport`, `fs:nodeEditorScroll`** and friends are **validated, never coerced** (`Number(' 1 ')`, `Number('١٢')` and `Number('0x10')` all parse). `fs:viewport`'s boot arm is skipped in `App.tsx` when a saved graph AND a stored viewport exist.
- **Uniform values persist by name and are never SEEDED** — an entry exists only because the user tuned something, so "no entry" means the graph decides. Editing a property node clears that uniform's entry via `fs:uniform-authored`.
- **`VR_HEADSETS` ships ONLY measured devices.** A device earns a row by running ShaderCarousel and importing the result; hand-authored profiles are marked `manual` and never claim "measured" provenance.

### Codegen: graph ↔ TSL → `docs/dev/codegen.md`

- **Pipeline**: graphToCode → tslToShaderModule → shaderloader 0.8 (TDZ fix, auto-import injection, typed `export const schema`, per-sub-mesh `parts`) → dynamic blob import. Every new export references 0.8 unconditionally. Every module also carries `export const threeRevision`, a `three/webgpu` import when a baked texture spells `globalThis.THREE`, and a COMPLETED `three/tsl` import — all MODULE-only, so graphToCode and the byte-stability snapshots never move.
- **Anything graphToCode emits at module scope is graph content to codeToGraph until explicitly excluded.** Hand-emitted helpers must be skipped BY NAME (`MODULE_HELPER_NAMES`); the emitted name and the skip name are a drift pair a synthetic test cannot catch. Never emit an async IIFE — codeToGraph's ReturnStatement visitor hijacks it.
- **Module-scope helpers live in ONE table** (`engine/moduleHelpers.ts`), keyed by helper NAME, with `HELPER_ALIASES` mapping variants and legacy names back to their def. **Every helper name is RESERVED from the variable namer**, or a second Box node named `sdBox2` shadows the Fn it calls (TDZ ReferenceError).
- **Helper VARIANTS are chosen by `values.mode`**, never from `defaultValues` (on a ShaderNode that map is the socket list). An ABSENT mode key is the default, which is what keeps older graphs byte-identical.
- **Emit `mix(a, b, t)` as a FUNCTION, never `a.mix(b, t)`** — TSL puts the RECEIVER in the FACTOR slot. `smoothstep` and `step` displace the receiver too; `clamp` and `pow` are positional. When emitting a named function you have not measured, write the free-function form.
- **Every input port needs a `defaultValues` entry unless 0 is genuinely neutral.** The silent `'0'` fallback made `clamp(x,0,0)` a constant, `hsl(0,0,0)` black and `log2(0)`/`smoothstep(0,0,x)` hard WGSL compile errors. Registry and `cpuEvaluator` must AGREE. `resolveExposedParam` consults the registry before its `?? 1`.
- **A zero-input node's `defaultValues` KEY ORDER is a positional codegen contract in both directions** — the constructor value must stay FIRST. Alphabetizing the literal silently changes what the node emits.
- **Alpha comes ONLY from the `opacity` channel.** A source whose shape is `!== 3` wired to an alpha-bearing channel (`color`, `emissive`) is emitted as `vec3(ref)`; shape is read from the PORT, not the node. `depthWrite:false` is gated on `transparent`; `alphaTest` is clamped ≤ 0.99.
- **Scalar→vec3 widening on Output channels**, and `codeToGraph` MUST mirror it (`unwrapScalarWiden`) or the round trip grows a Vec3 node and turns a grey ramp red.
- **Discard is a TRUTHINESS test** (`0.2` culls), emitted as a statement routed through the `__pixel` Fn. The condition is shape-coerced to a scalar EXCEPT for `logic` nodes. `extractDiscards` scans `maskNonCode(body)` — a discard in a comment or string is not code. `select`'s condition is the same truthiness test, not `>= 0.5`.
- **Imperative TSL (`Loop`, `If`, `.assign`) needs an ACTIVE STACK**, which the loader-run module has none of — so it must be a self-invoked `Fn(() => {…})()`. `parseBody` counts brace depth so a nested `return` isn't hijacked; codeToGraph warns and skips imperative blocks rather than walking into them.
- **Edge VALUES are read per SOURCE SOCKET, not per node** (`handleChannels`/`portShapeForHandle`). **Every cheap-string memo key that folds `e.source` must also fold `e.sourceHandle`**, or re-wiring between two sockets of one source shows the old channel forever. Never read the handle off React Flow's `sourceHandleId` — read the UNWRAPPED edge.
- **A SAMPLED FIELD's value is not its range** — `analyticalRange` + `getFieldUpstreamSet` keep interval arithmetic alive downstream of `uv`, `screenUV`, geometry attributes, noise and images; a finite sample must not collapse the chain to a flat `0`.
- **`toHsl` exposes h/s/l as SWIZZLES of ONE emitted call** and `out` stays `outputs[0]`; `codeToGraph` carries the INVERSE map or every Apply splices a Split node.
- **Emitted order is `emitOrder`, and may NEVER be derived from the nodes array** (`emitRank`: integer else 0; absent = 0 keeps old files byte-identical; the node-id tie-break belongs at the SORT). Array order is spliced by drag-into-group and reordered by every Apply, so deriving from it rewrites the module on a layout gesture.
- **A baked lookup texture sampled LINEARLY must be `HalfFloatType`** — WebGPU refuses to filter float32 without `float32-filterable`, so it looks right on WebGL2 and breaks only on WebGPU. The Data node keeps `FloatType` + Nearest deliberately.
- **Unknown nodes** round-trip verbatim, render magenta, and warn (not error).

### Output nodes and per-mesh materials → `docs/dev/outputs-and-materials.md`

- **ONE Output node is ONE material.** An UNTARGETED plain Output is the DEFAULT material (the module's top-level channels); a TARGETED one emits its own `parts` entry and ALWAYS contributes. Every node wears BARE channel handles — the `m<n>:` namespace survives only inside `unfoldOutputMaterials`.
- **"THE Output" is FOUR different questions** — `defaultOutput`, `contributingOutputs`, `moduleSettingsOutput`, `findDefaultOutput` — and each call site must pick deliberately. One blind predicate hands a targeted node the module's top-level channels the moment array order shifts.
- **Among UNTARGETED plain Outputs exactly ONE contributes** (the flagged one, else lowest-ranked); a DRIVING Raymarch Output suppresses every plain Output. An ABSENT `activeOutput` key means "never chose" and keeps old graphs byte-identical. `normalizeActiveOutput` strips the flag from a targeted node.
- **The emitted module text did not change when one node became one material** — `unfoldEmissionParity.test.ts` asserts string equality between the folded and split shapes. Keep that gate.
- **`unfoldOutputMaterials` runs on every restore path in the order sanitize → unfold → normalize**, with `sanitizeEdgeExtras` above it. Sibling ids are DETERMINISTIC (`<id>#m01`) or a saved group re-lays-out on every load; the unfold GROWS any group frame it overflows.
- **Emission and the parse must land in ONE commit**, and the resync pairs Outputs on their BINDING, not their label — every parsed Output is labelled `"Output"`, so a label key moves one material's identity onto another mesh with `errors: []` and byte-identical output.
- **A targeted plain Output is NOT carried across a resync** (the parse rebuilds it); a PARKED sink IS. An unpaired plain Output is PLACED, not handed to the relayout — one unpositioned node deletes every group frame on the canvas.
- **Mesh names are a REJECT-list, not an ASCII whitelist** (three's sanitizer keeps non-ASCII), and every map keyed by one is a `Map` or null-prototype object.
- **A mesh belongs to exactly ONE material: ticking MOVES it**, across nodes, in ONE `setNodes` inside ONE history entry with the no-op guard OUTSIDE the bracket. Caps: `MAX_PARTS` 9 names per NODE, `MAX_PART_ENTRIES` 90 as a RUNNING TOTAL across nodes, `MAX_INDEX_MATERIALS` 16 counted apart. The PARSE counts against `MAX_PART_ENTRIES`, not `MAX_PARTS`.
- **The emitted part key is `JSON.stringify` plus TWO escapes** — the star-slash (the project block is a block comment) and `<` → `<` (the module is inlined into a `<script>`, and the XR popup is a TOP-LEVEL document at the real origin). The parts splitter may not use `indexOf(':')` — a mesh name can contain a colon.
- **The mesh inventory is session-only, forgeable and NEVER persisted**; emission may never depend on it. Dormancy and the scoped React Flow 008 swallow are decided trusted-side, keyed on the EDGE ID.
- **Index bindings replicate `modelSignature` on every index node** (dormancy is per node) while `modelMeshes` is ONE list on the lowest-ranked node, in first-scene-appearance order. Mirrors are MODULE-only.
- **Material settings ride INSIDE each part's entry** and are carried per key across a resync — code-authoritative on a targeted node, inherited on an untargeted one; `displacementMode`/`mergeVertices` are always carried. Always a FRESH object, never a mutation.
- **Cost is seeded from the whole CONTRIBUTING SET** inside one walk, so a shared feeder is counted once.
- **Every Output carries its own preview SOCKET**, a `<button>` only when untargeted (activation is meaningless otherwise) and an inert `<span>` with real pointer-events elsewhere so its tooltip still opens.
- **Env maps**: an image wired to Environment emits the TEXTURE, never the sampled vec3, guarded on the planner having declared that var. Stored channel values emit inline, are EXPOSURE-gated, and an ABSENT key emits nothing.

### Distance fields and the Raymarch Output → `docs/dev/sdf-and-raymarch.md`

- **Negative inside, zero on the edge, positive outside**; 2D primitives take a CENTRED position, box extents are HALF-sizes, axial shapes stand along Y.
- **A vec3 input socket emits its unwired default as a BARE NUMBER and the helper broadcasts it** — emitting `vec3(0)` makes codeToGraph mint a real Vec3 node and the graph grows on every Apply. `cpuEvaluator` carries a matching broadcast. A group whose unwired default is NON-UNIFORM cannot use this shape.
- **The Raymarch Output DRIVES when Field OR Density is wired** (`drivingMarchOutput`, the ONE predicate every surface asks). Emission is ONE IIFE returning ONE vec4 — r184 overflows on a struct return — so scene lights never reach a marched surface.
- **The VR popup renders what the PANE renders**: pass `previewGeometry` + `marchWindow`, never the persisted Model choice.

### Node families: noise, colormaps, dataviz, Time, Sound → `docs/dev/node-types.md`

- **The Perlin family is SIGNED; cellNoise/voronoi are already [0,1] and must NEVER carry the range flag.** The flag lives in `values.signed` as 0/1 and an **ABSENT key means SIGNED**, so every older graph and built-in is byte-identical. The read is an EXACT `=== 0 || === '0'` — a coercing read changes a shader's appearance across a reload. It is deliberately NOT in `defaultValues` (that map is the socket list on PreviewNode-rendered nodes). `matchNoiseUnsignedRemap` is MANDATORY, not tidiness.
- **Colormap LUTs are baked in LINEAR light** — the catalogue is sRGB-encoded, and interpolating it as linear destroys the uniformity these maps exist for, invisibly. One hex means one colour app-wide (`color(0x…)`). The half-texel inset puts t=0/t=1 on the true endpoints.
- **The dataviz family is emitted by hand and is ONE-WAY through codeToGraph** — each needs a `CUSTOM_EMISSION_BASENAMES` entry or every instance collides. Inputs are scalars (`.x`-coerced), and stored numbers re-emit through `num(Number(…))`, never `String()`.
- **`dataRange` decides its DOMAIN on the CPU**, tracing exactly ONE hop from a Data node's `colN` handle; anything else means "no statistics" rather than a guess. Every degenerate case still renders.
- **The Data Range formula box is PARSE-THEN-RE-EMIT**: the user's string contributes ZERO characters to the emitted TSL, so injection is unrepresentable rather than filtered. ASCII by explicit code-unit range, never `normalize()`; `VARS`/`FUNCS` are `Map`s; every rejection falls back to the built-in chain and says so IN THE GENERATED CODE.
- **`isolines` takes the derivative of the CONTINUOUS phase, never of `fract(phase)`** — `fract` spikes once per level and draws a line through the contour it is smoothing.
- **Ramp ends (`lowColor`/`highColor`) are real wireable `def.inputs`** that KEEP their `defaultValues` entries, filtered through the ONE `effectiveRampDef`. Emission WIDENS a scalar with `vec3()` (the inverse of `scalarRefOf`).
- **Time's `speed` lives in `defaultValues`, not `def.inputs`** (`ensureBareInputNode` would drop the node), emits `time.mul(k)` only when it differs from 1, and `tryParseTimeSpeed` collapses only the bare-`time` receiver form.
- **Sound is a SINGLETON on the canvas** — one capture, one analyser, so a second node would lie about being its own input. Both add surfaces glide to the existing node.
- **Sound emits four ORDINARY numeric uniforms** (`sound<n>_<channel>`), so nothing new crosses the sandbox boundary but numbers. It needs its own alias branch to reserve those names, and that branch must sit BEFORE the generic zero-input branch. One-way through codeToGraph.
- **Capture is parent-side only and gated on a REAL CLICK.** `deviceCapture.ts` is the one `getUserMedia` call site, `systemAudioCapture.ts` the one `getDisplayMedia` one, `armSound` the one path to either, reachable from exactly two buttons — never an effect, message handler or store subscription, since a node's presence in a restored graph IS its execution. **Choosing a source can never START a capture.** There is deliberately no persisted grant and no "remember this".
- **`gain` is applied SHADER-side as a separate statement** (folding it into `uniform(0).mul(g)` breaks `uniformLineRe` and silently drops the export schema property); `smoothing` is CPU-side and resolved with `evaluateNodeOutput`, never codegen. ShaderPreview splits sound uniforms out BEFORE anything reads the map.
- **Podest hears a microphone and is deaf to system audio on purpose**, and never auto-arms — it replays its last drop at boot, so auto-arming would open the mic silently for weeks. The desktop build needs `NSMicrophoneUsageDescription` in `src-tauri/Info.plist` or capture is dead in the `.dmg` with no prompt (and `tauri dev` can never test it).

### The Image (Texture) node → `docs/dev/images-and-textures.md`

- **The payload is a whitelisted `data:` URL on `values.imageB64` and is adversarial**: codegen re-encodes the DECODED bytes, the thumbnail renders only `validImageDataUrl()`, malformed payloads degrade to an inert black.
- **The payload does NOT sit in the editor's code** — graphToCode emits `fs-asset:<node>-<hash>` placeholders, expanded only at surfaces that run or export a standalone document. The sandboxed preview resolves them itself from the per-document asset feed, so a scrub posts the small module, not megabytes.
- **Emission is FLAT module-scope statements with top-level await** — never an async IIFE.
- **Every socket rides the card's BORDER, spread evenly, centred on the picture, with NO text** (`nodes/edgePorts.ts`) — offsets in px from the port region's centre, the same units an authored designer offset uses, so `sockOv[id] ?? edgePortOffset(...)` lets a design replace a slot. Inputs index against the FULL list (exposing one, or a drag-reveal, must never move a socket a wire is aiming at) and the hidden ones reveal IN the rail. The names live in the socket's own tooltip — hover, a touch tap, the double-click pin — which RESTORES rule #8 rather than excepting it: `LABELLED_OUTPUT_TYPES` is EMPTY and kept as the negative guard, and `.shader-node__in-label` is retired. Only the Data node still labels outputs (8a — CSV headers are user data). **The re-measure key must fold the PICTURE** (`imageGeomKey` + `onLoad`): offsets are from the region's centre, so the region changing height moves every socket.
- **Output order is Color, R, G, B, Alpha**; all four channels are SWIZZLES of ONE sample. The order after `out` is free — emission is handle-keyed and edge ids are handle STRINGS, so no emitted byte and no saved file moves — but `out` MUST stay `outputs[0]`. Move `IMAGE_CHANNEL_COMPONENTS` in lockstep. While no channel socket is wired the emission is byte-identical. The wide sample must stay the member form `.rgba`.
- **The Texture picker offers every picture in the loaded MODEL too**, not just the project's Image nodes (`utils/modelTextureSources.ts`). A 'model' source is an image INDEX, never a payload: thumbnail AND pick go through the GLB import's own encoder at the picture's glTF SLOT class, so raw model bytes never reach an `<img>`. The parse is once per model, behind a cheap key, only while the grid is open. Project sources are listed FIRST (after a materials build the built textures are already nodes — one click, no re-encode). LIMIT: after that build the stripped copy no longer holds the textures the builder never makes (occlusion, dead emissive, budget-skipped).
- **Image nodes SHARE their module-scope `Image()` and `THREE.Texture`** through the ONE planner (`engine/imageTexturePlan.ts`); grouping is on the full canonical `src`, never the FNV hash. A new Texture-OBJECT setting must JOIN `readImageTextureSpec` or two nodes silently share one texture. graphToCode constructs no `THREE.Texture` itself.
- **Image → Output `normal` is a normal MAP**: wrap in `normalMap(...)` and auto-switch the image to `data` colour space on connect (skipped when the same image also drives an sRGB channel). A CHANNEL socket is a scalar — never decoded, never flips the colour space.
- **Drop-time conversion is ASKED, not assumed**, and the preference MUST stay reversible from the UI — a remembered `never` with no way back reads exactly like the feature being broken. "No" is not Cancel (the image imports either way); "keep as-is" still strips EXIF, applies the device cap and the budget.
- **Power-of-two snap is unconditional under "convert"**, per axis, rounding up at ≥ 0.8 of the next power. It never trades losslessness for a round-up, and it is declined outright when the pre-snap original cannot be stashed — a destructive step never ships without its escape hatch. Nothing in this stack NEEDS POT; it is hygiene.
- **Resolution re-encodes from the ORIGINAL, never from what is stored**, on a POT ladder anchored to the original, through a 2:1 PYRAMID for large steps (a single `drawImage` from 2048 to 8 is aliased noise, measured in three engines). The whole await precedes a SINGLE `updateNodeData`.
- **"Revert to original" bytes live in IndexedDB, content-keyed — never on `values`**, or they would be invisible to every image cap and ride ~101 history clones. Only `originId` + `srcWidth`/`srcHeight` ride the node.
- **Every limit announces itself**, and the path that ADDS a payload is checked differently from the one that REPLACES it. Loads keep hard caps only.
- **An Image node never samples KTX2** — an HTMLImageElement cannot decode it, and a CompressedTexture emission is a third resolution mode older loaders cannot run.

### Node appearance, theming and the Node Designer → `docs/dev/node-visuals-and-designer.md`

- **One node, one look — the CANVAS is the reference.** A node is drawn on four surfaces (canvas, asset tiles, node-editor.html overview, Designer stage). Only `shader` types share `NodeVisual`; every hand-written card is a drift site. A node's styling must never depend on which page draws it; shared geometry beats a copied replica; every flow type needs a dispatch branch. **The card layer may SCALE a node, never RESTYLE one**, and a surface may scale only from a WRAPPER around the card (`assetCardGeometry.test.ts` enforces both).
- **Surface parity is MEASURED, not assumed** (`nodeVisualParity.test.ts`) — the opt-in ramp filter belongs INSIDE `NodeVisual`, and `.node-base` sets its own font-size so a card can't inherit the page's.
- **A node title wraps at ONE balanced seam, caps at two rows, and the node keeps its designed width** — `nodes/NodeTitle.tsx` is the ONE renderer. TRAP: the pure module is `titleSplit.ts`; a file differing from `NodeTitle.tsx` only by case breaks `tsc` and Vite resolution on this filesystem.
- **A row the design has emptied is not rendered** (`visiblePortRows`) — filtering rows rather than growing the region is what keeps 25 authored designs from moving.
- **Selection is an ELEVATION change, not a band**: shells swap the WHOLE `box-shadow` token, driven by `--fs-node-lift` published on React Flow's node WRAPPER (the one element the card and its stack layers share). Hover lifts too; only selection also thickens the border.
- **The lift deepens the shadow and GROWS the card — it must never MOVE it.** Written as the standalone `scale` property, never `transform: scale()` (four node components set `transform` inline and would win). A translate is what made every wire on a selected node sit 3px off its socket permanently: React Flow computes endpoints from stored positions, the border thickening re-measures mid-transition, and the offset got baked in. `--fs-node-rise` is retired, not merely unused.
- **A `var()` naming a property nothing declares drops the ENTIRE declaration** — which is how a first cut left selected nodes with no shadow while every test stayed green. `cssTokens.test.ts` is the guard that makes retiring a token safe.
- **The Sound arm light lifts under its OWN pointer**, re-publishing the two custom properties on itself; keyframes must COMPOSE the lift, since a running animation's `box-shadow` replaces the author rule.
- **Flat TECHNICAL style: every corner square, every elevation shadow a hard offset with zero blur.** `--shadow-float` is the ONE token for every panel floating over the canvas. Never reintroduce a blur radius or a nonzero radius literal. One `--ctl-size`, one chrome text size.
- **Dark mode flips the CHROME and the node SURFACE, never the MEANING** — `--type-*`, `--cost-*`, `--cat-*` stay out of the dark block. Glyph art inverts with a filter rather than being re-authored (scoped to `.node-glyph`: the colormap strip, image thumbnail, noise previews, waveform and clock face are readings and must not invert). `--node-ink-rgb` is an `r, g, b` TRIPLE because ~39 sites pick their own alpha.
- **Designer overrides live in `glyphs/customGlyphs.ts`**; frame radius/border are fixed app-wide. The corner DRAG rescales socket offsets; the W/H fields deliberately do not. Sockets are static — never `transform` on handle `:hover`.
- **A node's `type` is not editable, its LABEL is** — `type` is the registry key stored in every `.fastshader`. Label and description splice slots are keyed by node type and must never be merged into one array. Renaming moves the node in SEARCH and is NOT retroactive to `data.label`.
- **The Designer edits exactly what `NodeVisual` draws** (`getFlowNodeType === 'shader'`); the 16 excluded types have no glyph to author. Making one designable is a real feature, not a filter tweak.
- **Glyph modal**: the selection is a set of INDICES validated by a structure signature; `mApply` is the SOLE commit path, so Cancel is the session-level undo; hit order is the handle layer's contract; every gesture gates on Apply being enabled FIRST; rotation has two mechanisms (points vs a folded `rotate()`) and the KEYBOARD path is a RUN that re-plans from the original, or the art walks; `pruneEmptyGroups` before commit.
- **The colour picker is app-wide and lives OUTSIDE the NodeEditor tree.** `history` is a REQUIRED prop (`'bracket' | 'none'`) — bracketing a preference site wipes the redo stack. Live-apply and commit are different paths; every effect is keyed on `open`; an iframe click closes it via window `blur`; Escape `stopPropagation`s; the portal host is RESOLVED so it survives fullscreen. `NodeVisual` gets an inert `<span>`, never a picker.

### Canvas interaction → `docs/dev/canvas-interaction.md`

- **Canvas navigation, the whole model**: mouse — wheel ZOOMS, middle/right drag PANS. Touch — two fingers PAN, pinch ZOOMS. Trackpad — the user SAYS so (`trackpadScroll`, toolbar right-click); horizontal always pans, pinch and Ctrl/Cmd+wheel always zoom, so **zoom is never unreachable**. One finger on touch never navigates. **Never device-sniff the wheel** — a heuristic was built, shipped and REVERTED for reading a real mouse as a trackpad; the failure is asymmetric and untestable from here.
- **One placement path**: every add funnels through `tileDrag.ts` → `fs-tile-drop` → `placeTilePayload`. A click/Enter add is SCATTERED off centre by a golden-angle step (two adds on the exact centre are indistinguishable from nothing happening); a DRAG is never scattered. A SINGLETON type glides to the existing node instead, and that check sits ABOVE the auto-connect on both surfaces.
- **AddNodeMenu rows are ONE line; the description is the row's `title`.** Hover must NOT scroll the list (the scroll event dismisses the tooltip it just armed). A press anywhere else closes the menu — capture-phase `pointerdown`, with the menu's own subtree and its portalled popovers exempt.
- **Floating chrome over the canvas needs `.nowheel`** — NodeEditor's capture-phase wheel handler beats the scroll container the wheel was aimed at. `canvasWheel.test.ts` sweeps for new scroll containers.
- **A canvas gesture takes the preview iframe out of hit-testing** (`fs-canvas-busy`, refcounted) — the iframe is opaque-origin, so a drag crossing it never ends. A CONNECTION drag also arms `.fs-dragging`, measured at 38 stray selection rectangles in WebKit.
- **Double-click a node to pin EVERY socket label** — built on counting two clicks, not `dblclick`, so one implementation serves touch. State is LOCAL and applied imperatively: looking at a node is not an edit.
- **A socket's label has ONE placement** (beside the dot, outer side), whatever trigger showed it. A `title` on a `pointer-events: none` element is DEAD.
- **F frames the selection, A selects all** — both through the same glide, both guarded against typing, neither an edit. Every control that moves the view glides through `VIEW_GLIDE_MS`; the −/+ buttons step from the PENDING target, not the current transform.
- **Edges**: drag-to-disconnect, drop-on-edge insertion, and routing waypoints that are visual-only. **`edge.data` is sanitized as adversarial input on ALL THREE restore paths** — it is the one payload the engine never reads, which is exactly why it was unvalidated while `TypedEdge` dereferences it during render. The renderer and the hit test share `bezierGeometry.ts`, so what highlights is what snaps. A splice lands on the first FREE input.
- **A wire dropped on empty canvas connects from EITHER end** — the side rides in the menu state as React Flow's own `handleType`. Getting the direction wrong renders as NOTHING while the store keeps the edge and codegen still reads it.
- **Drag-connect** previews with the node's CENTER inside the hover node; direction follows the side, and every mounted input must be REACHABLE — physical alignment alone cannot promise that, so the sweep STRETCHES when it fails (246 unreachable sockets → 0). Cycle/occupancy checks run on the UNWRAPPED graph. Palette tiles plan as a PHANTOM id and only phantom plans may commit.
- **Preview mode routes ONE node's output to the 3D view** in a DERIVED graph only `previewCode` sees — never an edit, never in history. A code→graph pass ENDS it. Its node marks are ATTRIBUTES, not classes: React Flow rewrites the wrapper's whole `className` and erases hand-added classes.
- **Shift+click adds to the selection**, which REQUIRES `selectionKeyCode={null}`; marquee is mouse-only and BOUNDARY-only (a translucent wash tints the very colours the canvas exists to show).
- **Groups are real React Flow nodes with no shader semantics** — engines call `unwrapCollapsedGroupEdges()` so collapse state never affects compiled output. A frame's size has ONE home (top-level `width`/`height` + the `data` mirror). Members never get `extent: 'parent'`. An expanded frame's only interactive surface is its HEADER. A marquee selects the frame only once it has selected EVERY member.
- **Board drawings are VISUAL-ONLY**, ride history by reference (never `structuredClone` a committed stroke), and are sanitized on load; opacity is quantized and colours are 6-digit hex only.
- **Dividers no longer push each other** — do not reintroduce a divider that reaches into a neighbouring pane.

### Preview, shaderloader runtime, podest and XR → `docs/dev/preview-and-runtime.md`

- **Loader 0.8 = core + component, and the component IS the core's state object.** State field names, method signatures and events are 0.6's, verbatim — the editor and podest read them off `entity.components.shader`, so a rename breaks them with no error. **Every 0.8.x edit after the first push is ADDITIVE.**
- **Vertex WELD for displaced primitives lives in the LOADER, not the app.** The displacement gate is `material.positionNode != null`, NOT `!== undefined` (three assigns `null`, so an undefined test welds every primitive). Primitives only. WHICH groups merge is the correctness of it: normals differ, or UVs differ AND the shader reads `uv()` — welding a sphere for a position-driven shader smears the poles. The author's opt-out travels as `mergeVertices: false`, `=== false`.
- **glTF material-index parts**: the index is RECORDED AT PARSE into plugin-private WeakMaps — **never into `userData`**, which is JSON-copied on clone and re-exported as `extras`. `materialParts` applies only when `modelSignature` matches the parse; the status event is FORGEABLE, so the editor must derive dormancy trusted-side. A `materialParts` module MUST carry a `parts` object, or frozen 0.6 renders it near-black with no error.
- **A GLB can carry its own shader, and 0.8 runs it ONLY on `shader="src: model"`.** It fails CLOSED before a line runs. No document the app itself runs spells the opt-in, and each closes the one-way `disableModelModules()` latch. It is a `.js` in a model's clothing — a page loading user GLBs must never say `src: model`.
- **Preview rebuild is debounced and module edits HOT-SWAP**; only the COLD keys rebuild `srcDoc`. The swap's no-op bail compares against the module the live document is RUNNING, never against what was baked — that is what made NEW leave the previous shader on screen. Image payloads cross ONCE per key per document.
- **The preview backend is decided at document boot**: both sandboxed documents pre-flight WebGPU and hide `navigator.gpu` when it can't deliver; Safari is force-hidden. The XR popups instead force declaratively with `<a-scene renderer="backend: webgl">` — the only way into WebXR on this bundle. The sandboxed preview KEEPS `hideGpu()`, because that state is the truth the `fs:backend` report and the toggle's locked state read.
- **The XR popup runs at the app's REAL origin**, so its URL allowlist is origin-widened and it never runs a module found inside a model.
- **Podest must survive weeks unattended**: presentation mode is WIDER than the Fullscreen API (nobody is there to give a gesture after an auto-update), `time` is folded back every ~4.4h on an exact 2π multiple, device loss is caught three ways with a beat watchdog, the last drop is mirrored to IndexedDB, and the wake lock is re-requested on every tick. Everything that must survive asks `presenting()`, never `fsElement()`.
- **Podest VR locomotion** moves the camera RIG (three composes the XR pose with the parent's world matrix), reads the head from the FRAME not the camera object3D, draws its own hands (`hand-tracking-controls` reparents to the scene root and ignores the rig), and never counter-moves physical walking. Untested on a headset.
- **Preview geometries**: three predicates in `tslToPreviewHTML.ts` are the source of truth (`isObjGeometry`, `isTeapotGeometry`, `isModelGeometry` — the teapot is deliberately NOT a model).
- **`fit-bounds` BAKES normalization into the geometry attributes** — scaling the Object3D is invisible to `positionGeometry`, so a dropped model fed authored units to every position-tuned preset. Measure in the ENTITY's frame; clone geometries; dequantize first. The world-AABB flaw is a deliberate trade — the obvious fix makes animated models grow.
- **Generated spherical UVs are SEAM-SPLIT** (duplicate low-u corners at u+1, keeping the mesh welded for displacement). The POLE is an unfixable limit of the projection, so the test pins "zero spanning triangles away from the poles". An OBJ carrying its own `vt`/`vn` KEEPS them.
- **The teapot is tessellated at RUNTIME** from recovered Bézier control points; `SUBDIVISION_CAP` is 128 app-wide and a persisted value CLAMPS rather than resets. Keep the script self-contained (node tests and the OBJ generator evaluate the same text).
- **`normalWorld`, not `normalLocal`, whenever a normal meets a world-space direction** — the preview's resting tilt and turntable make the object→world rotation essentially never identity. Displacement keeps `normalLocal`.
- **The A-Frame tab is DERIVED FROM THE MODULE and DEFAULTS-ONLY on purpose** — no lights, no camera, no background, no inline script. Uniform rows are parsed out of the emitted `schema` block (a parsed format now), re-normalized, and a uniform named `src` is DROPPED or the page loads no shader at all. The two exceptions are tessellation for a displacing shader and the single-GLB `src: model` form.
- **Plain Three.js is loader 0.8's FastShaders core** (`use` → `load` → synchronous `apply`), documented in README and every export's header. The header may never contain `import {`, `params.<ident>` or `const X = uniform(` — the loader's own transforms scan for them.

### Dropped models, glTF and zips → `docs/dev/models-and-gltf.md`

- **Model bytes are never parsed on the trusted side**, with two documented exceptions: the two JSON-header readers in `previewMesh.ts`, and `utils/gltfReader.ts`. The reader is STRICTER than GLTFLoader, never throws, bounds-checks every index, count-caps every array before walking it, resolves no URI, and its report is TRANSIENT — only `gltfPreviewFacts` (strings and numbers) may be kept.
- **Model files cross into the preview only via postMessage + iframe-minted blob URLs**, and BOTH sandboxed stages install a `setURLModifier` allowlisting `blob:`/`data:` — that modifier is the real control, not CSP (which is absent in dev, desktop and podest).
- **An iframe-forwarded SHADER drop requires a `window.confirm`** — sandboxed code can forge the drop, and a project import replaces the whole graph. Model files stay immediate; restoring a shader stored IN a GLB needs the same confirm.
- **A FastShaders single-GLB export is RESTORED only by an explicit choice, and its payload never survives into a preview copy** — `createPreviewMesh` prefers the COMPACTING strip, so the XR blob, the IndexedDB mirror and every zip `models/` entry are payload-free. The sniff answers `\u00` escapes as well as the literal key.
- **A dropped PBR model is OFFERED as a shader through ONE dialog** which IS the confirm gate; never offered in a study session or for a model dropped with a shader. The dialog has TWO answers — **Only Mesh** (the materials and textures are discarded) and **Mesh with Materials** — and the texture-budget resolution FOLDS INTO the second label rather than becoming a third button; only a stored-shader RESTORE gets its own. Every refusal happens before the store is touched.
- **"Mesh with Materials" replaces the GRAPH and keeps the DOCUMENT** (`commitGlbImport`, the ONE commit path): the nodes, the wires and the board drawings go, the shader takes the model's name — and the palettes, the tuned uniform values, the preview preferences and the desktop Work-folder file all STAY. That is why it is not `applyProjectToStore` (the open-a-document path, which clears all four) and why it fires **`fs:graph-merged`, never `fs:graph-imported`**: the latter means "a different document now", and the Work folder answers it by forgetting the open file, turning the next Save into a Save-as. Board ink goes with the graph because it annotates nodes; a palette library is the user's, not the shader's. The image cap is re-asserted at the store boundary (`sanitizeImageNodes`) even though the builder already encoded under it — every path that brings payloads in checks at the boundary.
- **Draco/meshopt/KTX2 decode via bytes pushed into the sandbox**, only when the model needs them. A missing decoder must FAIL, never hang (`setDRACOLoader(null)`, never a data: URL). meshopt is a fresh shim per PARSE; KTX2's `detectSupport` needs an INITIALISED renderer and its manager must CHAIN `DefaultLoadingManager.resolveURL`.
- **A refused zip says WHY on every surface** — typed `ZipLimitError` rethrown by `importShaderZip`, mapped once by `reportZipImportError`. The invariant is "the reader opens anything the writer emits"; podest's twin carries the same literals and is drift-guarded.
- **An export FastShaders could not open again asks FIRST** (N1) — the size is what the READER counts, from the same entry list the zip is written from. The ENTRY cap is reachable with default limits. Every `await` between the click and the download must stay a microtask or Safari drops the transient activation.
- **Model animation**: `fit-bounds` must NOT bake an animated model (a node-TRS clip would apply twice); in place FREEZES the root track rather than deleting it; a clip change re-reports duration and capability; the playhead survives a stage rebuild. Podest's hand-minified twin is drift-guarded against the editor's.

### Finding nodes: search, visibility, categories, i18n → `docs/dev/discovery-and-i18n.md`

- **English is the DEFAULT UI language**; the study arms carry their own switch on the consent dialog. The toolbar button labels the language it switches TO, so it is an ACTION and carries no `aria-pressed`.
- **Latvian is a display-only overlay** — node types, TSL identifiers, generated code and `data.label` stay canonical English, and canvas headers deliberately show the generated varName. The two Output nodes render their own markup, so they do NOT get ShaderNode's `portLabel` path for free.
- **Node search is RANKED and `description` is part of the corpus** (`nodeMatchRank`, shared by both surfaces). Keep UI-instruction wording out of `description`, put aliases in the `Also:` tail, and never let prose casually repeat another node's name.
- **Hiding an unfinished node is an ADD-SURFACE filter, never a registry filter** — the JSON lists what is HIDDEN (default-visible), and exactly two accessors carry the filter. Filtering the registry would turn every saved `.fastshader` holding that node into `unknown` nodes. **The suite must stay green with nodes actually hidden**, since `release.yml` runs `npm test` before deploying. `getEditorDefinitions()` is computed ONCE at module init — a per-call `filter()` breaks every downstream memo.
- **Textures and Distance fields are OPTIONAL categories, off by default**, switched on per browser from the toolbar's right-click list, and they take their COMPANIONS with them (Raymarch Output, Ray Direction — a family hidden with one door left open was the reported bug). Add surfaces must pass the hidden set on EVERY call. Nothing under `engine/`/`utils/`/`hooks/` may import the module.
- **A stored tab naming a switched-off category stays VALID and is DERIVED at render**, never written back.
- **"Hard reload" navigates to `?fsreload=<stamp>`** — `location.reload(true)` does NOTHING (the IDL takes no arguments and TS's signature invites a cast that ships a no-op). The cleared-keys list is EXPLICIT and names no eval key.
- **Asset tiles are spaced by SILHOUETTE, not frame** (sockets straddle the border), measured per tile rather than tabled. Both ready-made strips sort by GPU points, on the same total their badge prints.

## TypeScript Notes

- `@babel/traverse` CJS/ESM interop: `const traverse = (typeof _traverse.default === 'function' ? _traverse.default : _traverse)`
- React Flow v12: import from `@xyflow/react`, use `Node<DataType, TypeName>` generics
- `applyNodeChanges`/`applyEdgeChanges` return base types — cast with `as AppNode[]`
- `@types/three` uses `^0.184.0` (caret) to match the installed three `^0.184.0`
- `ParseError.severity` is optional — omitted (or `'error'`) blocks code→graph sync; `'warning'` allows sync to proceed
- `tsconfig.node.json` must have `"composite": true` and `"noEmit": false` when referenced from main tsconfig
