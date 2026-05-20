# FastShaders

A visual shader editor for [TSL (Three.js Shading Language)](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language) with bi-directional sync between a node graph and code.

**[Live Demo](https://Alvis1.github.io/FastShaders/)**

## Features

- **Bi-directional sync** — edit either the graph or the TSL code; changes round-trip in both directions
- **Node graph editor** — ~70 TSL node types across 10 visible categories (input, type, arithmetic, math, interpolation, logic, vector, noise, color, output), drag from the palette or right-click → search to add. The right-click menu supports full keyboard navigation: type to filter, arrow keys to move the highlight, Enter to add.
- **Code editor** — Monaco with TSL syntax highlighting, light/dark toggle, inline error/warning squiggles, and a separate read-only Script tab showing the exported `.js` module
- **Live 3D preview** — WebGPU-rendered preview with five geometries (sphere, cube, plane, Utah teapot, Stanford bunny), three lighting modes (studio / moon / laboratory), subdivision slider, picked background color, orbit camera, and play/pause
- **MaterialX noise** — 8 built-in noise variants (Perlin, fBm, cell, Worley/Voronoi) backed by `three/tsl`'s MaterialX functions
- **Position & camera inputs** — `positionLocal`, `positionWorld`, `positionView` (+ direction variants), `cameraPosition`, `cameraNear`, `cameraFar` for camera-relative effects
- **Logic category** — `greaterThan`, `lessThan`, `equal` per-channel comparisons that feed `select()` or the Output node's new **discard** input (wire any condition into Output → discard to kill those fragments — emits `Discard(cond)` in TSL)
- **Built-in textures** — 8 procedural texture presets (polka dots, grid, tiger fur, static noise, crumpled fabric, gas giant, marble, wood) draggable from the palette
- **Groups** — Ctrl/Cmd+G to wrap selected nodes in a recolorable, collapsible container; save groups to a per-browser library and drag them onto any graph
- **Property uniforms** — `property_float` nodes become live-tunable sliders in the preview overlay and component attributes in the A-Frame export
- **A-Frame export** — download a self-contained VR-ready `.html` file
- **Shader module export** — download a `.js` module for use with [a-frame-shaderloader](https://github.com/Alvis1/a-frame-shaderloader)
- **Undo / redo** — 50-entry history with Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z
- **Copy / paste / duplicate** — Cmd/Ctrl+C, Cmd/Ctrl+V, Cmd/Ctrl+D across nodes (internal edges preserved)
- **VR cost budget** — per-headset cost meter (Quest 2/3/3s, Steam Frame, Pico 4, Apple Vision Pro) with a color-gradient bar
- **Persistent state** — graph, code, shader name, split ratios, headset, cost colors, canvas background, editor theme, preview prefs, and saved groups all auto-save to localStorage

## Quick Start

```bash
git clone --recurse-submodules https://github.com/Alvis1/FastShaders.git
cd FastShaders
npm install
npm run dev
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule init && git submodule update
```

## Build & Deploy

```bash
npm run build          # typecheck + production build → dist/
```

## UI Guide

The app is laid out in three resizable panes: a **Node Editor** on the left, a **Code Editor** in the top-right, and a **3D Preview** in the bottom-right. A **Toolbar** sits on top and a **Cost Bar** runs along the bottom. Both split dividers persist their position to localStorage.

### Toolbar

- **Brand button** — clicking *FastShaders* toggles a contact popover (name, email, website with copy buttons)
- **Version label** — current app version
- **Shader name input** — sets the export filename and persists across reloads

### Cost Bar (VR budget)

- **Headset selector** — picks a target device (Meta Quest 3 / 3s / 2, Steam Frame, Pico 4, Apple Vision Pro), each with its own GPU point budget (90–350)
- **Cost readout** — `current / max` points; turns red when over budget
- **Gradient bar** — slider position reflects budget usage; both pole colors (low-impact and high-impact) are user-customizable

### Node Editor (canvas)

**Selection & navigation**

- Click a node to select; box-select by dragging on empty canvas (partial-selection mode)
- Pan: middle-click drag, right-click drag, two-finger trackpad gesture, or double-click-and-drag
- Zoom: mouse wheel or trackpad pinch (range 0.1×–3.0×)
- MiniMap (top-left of canvas) shows the full graph with cost-coloured nodes; click to jump
- Background colour is user-pickable from the bottom-right Controls panel; cost badges and 1-channel edges auto-flip contrast for readability

**Keyboard shortcuts**

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` | Undo / redo |
| `Ctrl/Cmd+C` / `Ctrl/Cmd+V` | Copy / paste selected nodes (internal edges preserved, paste offsets cascade) |
| `Ctrl/Cmd+D` | Duplicate selection |
| `Ctrl/Cmd+G` / `Ctrl/Cmd+Shift+G` | Group / ungroup selection |
| `Delete` / `Backspace` | Delete nodes and edges (chains bridge across removed nodes when ends are kept) |
| `↑` / `↓` (in the right-click Add Node menu) | Move the highlighted entry up / down |
| `Home` / `End` (in the right-click Add Node menu) | Jump to the first / last entry |
| `Enter` (in the right-click Add Node menu) | Add the highlighted entry |

**Drag interactions**

- Drag from the **Content Browser** (palette) to drop a new node, group instance, or texture onto the canvas
- Drop a node *onto an edge* to splice-insert it between source and target
- New nodes auto-nudge if they would overlap an existing one
- Dragging a node near an existing edge highlights the edge in yellow as a drop target
- Dragging a node into a group reparents it; dragging outside un-parents (members never use `extent: 'parent'`)

### Content Browser

A horizontally-scrolling palette pinned to the canvas with three modes:

- **Nodes** — All / per-category tabs (Input, Math, Noise, Type, Arithmetic, Interpolation, Vector, Color, Sampling) with a search box that matches label, type, and description
- **Textures** — 8 procedural texture presets, each rendered as a CPU canvas thumbnail
- **Saved Groups** — your local group library with thumbnails; drag any tile to instantiate

Every node card shows its complexity cost so you can budget while building.

### Context Menus

Right-click anywhere to open a context menu — the dispatcher picks the right one based on what you clicked.

- **Canvas → AddNodeMenu** — searchable node list grouped by category; "Group Selection" entry (active when ≥2 nodes selected). Fully keyboard-driven: type to filter, `↑`/`↓` (or `Home`/`End`) to move the highlight, Enter to add the highlighted entry, hover to sync the highlight to the mouse. If the menu opened from a failed connection drag, the new node auto-connects from the source pin.
- **Node → NodeSettingsMenu** — Duplicate, Delete, toggle individual input port visibility, and edit inline values (drag-number inputs, color pickers, vec2/vec3 rows).
- **Output node → ShaderSettingsMenu** — total cost vs. headset budget, output port toggles (roughness / emissive / normal / opacity / discard), displacement mode (Along Normal / Offset), Transparent toggle, Alpha Clip + threshold, side rendering (Front / Back / Double), Depth Write, and a per-uniform editor that lists every `property_float` in the graph. Wiring anything into the **discard** port emits a `Discard(cond)` statement in the shader so fragments where the condition is true are killed.
- **Group → GroupSettingsMenu** — rename, recolor, title-size slider, Save to Library, Ungroup, Delete Group (with members).
- **Edge → EdgeContextMenu** — Delete Connection.

### Nodes

| Node | UI |
| --- | --- |
| **ShaderNode** | Generic dynamic node — header with title and color-coded cost badge, input ports on the left, output ports on the right, inline drag-number / color / vec2 / vec3 controls in the middle |
| **OutputNode** | Two sections (Pixel / Vertex shader); only exposed ports show as handles; cost badge sums the upstream graph |
| **ColorNode** | Square colour swatch with native colour picker; outputs a color value |
| **PreviewNode** | 96×96 canvas thumbnail of the noise function (CPU evaluator), animates if `time` is upstream |
| **MathPreviewNode** | 72×72 waveform thumbnail of sin/cos curves, animates with `time` upstream |
| **ClockNode** | 56×56 analog clock face with a moving second hand; outputs the time value |
| **GroupNode** | Coloured header bar with name and a +/− collapse toggle, semi-transparent body, resizable corners; collapse hides member nodes via CSS (rAF loops keep running) and presents synthetic boundary sockets for crossing edges |

### Edges

- **TypedEdge** — animated dashed line, color-coded by data type (float, int, vec2/3/4, color, any)
- **Multi-channel display** — vec3/vec4 edges render as 1–4 parallel offset paths
- **Drag-to-reconnect** — grab either endpoint to rewire; drop on empty canvas to delete
- **EdgeInfoCard** — hover label showing channel count and live min/max range per channel (animates if time is upstream)

### Number Input (DragNumberInput)

Reusable across every numeric field:

- Click to enter text mode (select-all)
- Drag horizontally to scrub; speed accelerates with distance
- ◂ / ▸ arrow buttons for ±step nudges
- Enter to commit, Escape to cancel

### Code Editor

- **TSL tab** — editable Monaco editor with custom TSL grammar, hex color picker on color literals, word wrap, inline red squigglies for errors and orange for warnings
- **Script tab** — read-only export of the generated `.js` shaderloader module
- **Theme toggle** — light (`vs`) / dark (`vs-dark`), persists separately from the rest of the app
- **Buttons** — *Save Code* (commit code → graph), *Load Script* (file picker, parses a `.js` script back into TSL + graph), *Download Script* (downloads the Script tab as `<shader-name>.js`)
- `Ctrl/Cmd+S` saves code → graph

### 3D Preview

- **Geometry** — Sphere, Cube, Plane, Teapot, Bunny (OBJ models with auto-generated spherical UVs and recomputed normals)
- **Lighting** — Studio, Moon, Laboratory presets
- **Subdivision** slider (1–256) for primitive geometry detail
- **Background** colour picker
- **Camera** — orbit drag, scroll-zoom; position + rotation persist
- **Play / Pause** — freezes animation that depends on time
- **Property uniform overlay** — collapsible panel listing every `property_float` in the graph as a live slider; min/max bounds are user-editable per uniform and persist to localStorage
- **Reset** — restores camera home position, lighting, subdivision, and uniforms to defaults (geometry, background colour, and uniform bounds are kept as preferences)

## ShaderCarousel — viewer & benchmark suite

`ShaderCarousel/` is a standalone static-HTML suite used for shader research and Quest 3 benchmarking. It is not part of the main Vite build — serve it with any static HTTP server (e.g. `python3 -m http.server` from the repo root). Do **not** use the Vite dev server; it interferes with the WebGPU import maps the benchmarks rely on.

A single launcher (`ShaderCarousel/index.html`) hosts three purpose-built benchmark pages in a full-screen iframe. The mode selector at the top-left switches between them; the chosen mode persists to localStorage and is mirrored to `?mode=…` in the URL so links are shareable. Press `M` to hide / show the overlay. **No bench auto-plays** — each one shows a centred Start button and waits for the user.

| Mode | Iframe target | Purpose |
| --- | --- | --- |
| **Sphere InOut — immersive WebXR** | `bench-inout/index.html` | A-Frame WebGL pipeline with WebXR session entry. Inverted sphere ping-pongs through the camera (10 s cycles) while the bench logs rAF frame deltas via an A-Frame `tick` component (XR-safe). The Start button gates `enterVR()` — the only way to capture true stereoscopic per-eye cost on a standalone HMD. Headset name is auto-detected (Quest 3 / Quest Pro / Pico / Vision Pro) with a text-input override. |
| **Sphere Static — WebGPU multi-pass** | `bench-static/index.html` | Static full-coverage sphere at Quest 3 per-eye resolution (2064×2208), Three.js WebGPU with `device.queue.onSubmittedWorkDone` fence sync. Renders the shader 30× per measurement (default) and divides by N, so per-pass cost rises above the display vsync floor — the macOS calibration technique from the paper. Best for ranking compositions on desktop. |
| **MicroPlane — per-node microbench** | `bench-microplane/index.html` | Small ortho quad (default 512×512), WebGPU fence sync, multi-pass timing. Defaults to noise atomics + baseline — designed for deriving per-node points by subtraction. Does not enter immersive mode. Closes the gap the paper § 3.3 identifies: "Recovering individual node costs requires microbenchmarks". |

All three share a unified style (`lib/bench-style.css`), corpus (`lib/bench-registry.js`: baseline + 8 presets + 8 noise atomics + saved-groups stub), settings persistence with **Reset to defaults**, frame-log stride parameter, and the export pipeline (`lib/bench-stats.js`). Each run emits **three files**: the raw frame JSON, a per-shader summary CSV, and a `complexity-suggestion.json` mapping each measured shader to its implied points (`marginalMs / 8.33 × 100`) — diffable against `src/registry/complexity.json` to close the paper's calibration loop.

The first shader of every run is always the flat-color baseline (`ref_baseline`); subsequent shaders' marginal cost (median minus baseline median) is what the suggestion file is built from. Multi-pass benches default to **30 passes per measurement** on the user's request, after benchmark-corpus testing on Quest 3 (~3 s per shader, 16-shader default = ~1 min total).

## Export Formats

| Tab         | Output                   | Usage                                                                                                              |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **TSL**     | `Fn(() => { ... })` code | Edit in-app, syncs with node graph                                                                                 |
| **A-Frame** | Self-contained `.html`   | Open in browser / VR headset                                                                                       |
| **Module**  | ES module `.js` file     | `<a-entity shader="src: myshader.js">` with [a-frame-shaderloader](https://github.com/Alvis1/a-frame-shaderloader) |

### Using the shader module with a-frame-shaderloader

```html
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.3.js"></script>

<a-scene>
  <a-sphere shader="src: myshader.js" position="0 1.5 -3"></a-sphere>
</a-scene>
```

## Tech Stack

- React 18 + TypeScript + Vite
- [@xyflow/react](https://reactflow.dev/) v12 — node graph
- [@monaco-editor/react](https://github.com/suren-atoyan/monaco-react) — code editor
- [zustand](https://github.com/pmndrs/zustand) v5 — state management
- [three.js](https://threejs.org/) 0.183 (WebGPU build) — shader runtime, exclusively `three/tsl` built-ins (including the MaterialX noise family)
- [@babel/parser](https://babeljs.io/docs/babel-parser) + [@babel/traverse](https://babeljs.io/docs/babel-traverse) — code-to-graph parsing
- [dagre](https://github.com/dagrejs/dagre) — automatic graph layout

## License

MIT

## Contact

Alvis Misjuns

- Email: [alvis.misjuns@va.lv](mailto:alvis.misjuns@va.lv)
- Web: [alvismisjuns.lv](https://alvismisjuns.lv)
