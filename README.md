# FastShaders

A visual shader editor for [TSL (Three.js Shading Language)](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language) with bi-directional sync between a node graph and code.

**[Live Demo](https://Alvis1.github.io/FastShaders/)**
**[Live Demo2](https://alvismisjuns.lv/fastshaders/)**
**[Desktop app downloads](https://github.com/Alvis1/FastShaders/releases/latest)** (Windows / macOS — or use the **Local** button in the editor)

## Features

- **Bi-directional sync** — edit either the graph or the TSL code; changes round-trip in both directions
- **Node graph editor** — 68 built-in TSL node types across 10 categories
- **Drag-aware sockets** — dragging a wire near a node labels its input sockets with their names; noise and Image nodes also reveal their hidden parameter sockets so you can wire a parameter without opening its settings first
- **Wire editing** — drop a node onto a wire to splice it into that connection, and double-click a wire to add draggable routing points it curves through
- **Code editor** — Monaco with TSL syntax highlighting, a sun/moon toggle that drives app-wide dark mode (not just the editor — it flips the whole editor's chrome and remembers a canvas background per theme), inline error/warning squiggles, and a separate read-only Script tab showing the exported `.js` module
- **Bilingual — Latviešu / English** — an **LV** toggle (top-right, next to **SC**) switches the whole editor to Latvian: node names read as `Reizināt (Multiply)` — the Latvian term with the original English kept in brackets — alongside high-school-level (vidusskola) Latvian node descriptions, category names, socket labels, and UI chrome. Search also matches Latvian terms. It's display-only: node types, generated TSL, and `.fastshader` files stay canonical English, so a graph authored in Latvian is byte-identical to the same graph in English. The Node Designer (`node-designer.html`) has its own EN/LV switch
- **Live 3D preview** — WebGPU-rendered preview (automatic WebGL2 fallback) with five geometries (sphere, cube, plane, Utah teapot, Stanford bunny — all normalized to the same centered bounds), three lighting modes (studio / moon / laboratory), subdivision slider, picked background color, orbit camera, and play/pause
- **MaterialX noise** — 8 built-in noise variants (Perlin, fBm, cell, Worley/Voronoi) backed by `three/tsl`'s MaterialX functions
- **Built-in textures** — 8 procedural texture presets (polka dots, grid, tiger fur, static noise, crumpled fabric, gas giant, marble, wood) draggable from the palette
- **CSV data import** — drop a `.csv` onto the canvas to create a Data node, then drive shaders from real data with the **Data Stripes** and **Data Viz** nodes (columns baked into GPU textures)
- **Image textures** — drop an image to create an Image node (re-encoded and validated on import) with UV tiling / offset / flip controls
- **Project save & restore** — "Download Shader" embeds the whole project inside the exported `.js`; drop that `.js` (or a `.zip` when images are included) back in — on the canvas, the code panel, or via Load Script — to restore the graph, preview settings, and UI prefs
- **Standalone viewer** — a separate full-screen player (opened from the toolbar) that runs any exported shader `.js`/`.zip` or a `.glb`/`.gltf` model, sandboxed, with auto uniform sliders
- **Groups** — Ctrl/Cmd+G to wrap selected nodes in a recolorable, collapsible container; save groups to a per-browser library and drag them onto any graph
- **Property uniforms** — `property_float` nodes become live-tunable sliders in the preview overlay and component attributes in the A-Frame export
- **Copy / paste / duplicate** — Cmd/Ctrl+C, Cmd/Ctrl+V, Cmd/Ctrl+D across nodes (internal edges preserved)
- **VR cost budget** — per-headset cost meter (Quest 2/3/3s, Steam Frame, Pico 4, Apple Vision Pro) with a color-gradient bar that fills as the graph's GPU cost approaches the selected headset's budget (advisory, not a hard limit)
- **Offline desktop app** — a lightweight Tauri build for Windows and macOS, downloadable from the **Local** button in the editor's toolbar; the whole editor (Monaco and fonts included) is bundled, so it runs with no internet at all

## Desktop app

The **Local** button (top right in the editor) offers three downloads, rebuilt automatically with every release:

| Platform | File | Notes |
| --- | --- | --- |
| Windows | `FastShaders-Windows-Setup.exe` | Installer. Unsigned — SmartScreen may warn: *More info → Run anyway* |
| Windows | `FastShaders-Windows-Portable.zip` | Portable build, no install: unzip anywhere and run `FastShaders.exe` — keep the `ShaderCarousel` folder next to it (the VR bench serves it). Needs the WebView2 runtime, preinstalled on Windows 10/11 |
| macOS | `FastShaders-macOS.dmg` | Universal (Apple Silicon + Intel). Unsigned — first launch via System Settings → Privacy & Security → *Open Anyway* |

The desktop build adds a **VR** button in the toolbar: it starts an in-app server that serves the bundled ShaderCarousel GPU-benchmark suite to a VR headset over your local network, so you can benchmark shaders on a real headset.

The preview uses WebGPU when the system webview provides it and falls back to WebGL2 otherwise. To build locally: install a [Rust toolchain](https://rustup.rs), then `npm run tauri build` (or `npm run tauri dev` while developing). Releases are produced by CI on version tags (`npm version patch && git push --follow-tags`).

### Using the shader module with a-frame-shaderloader

```html
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-180-a-01.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.5.js"></script>

<a-scene>
  <a-sphere shader="src: myshader.js" position="0 1.5 -3"></a-sphere>
</a-scene>
```

Those two scripts are all you need: `a-frame-180-a-01.min.js` bundles **A-Frame 1.8.0 + Three.js r184 (WebGPU)**, and `a-frame-shaderloader-0.5.js` rewrites the module's `import … from 'three/tsl'` to read that bundle's single Three.js instance — so **no import map and no shim are required**. The exported `.js` also works directly with Three.js, or any bundler that resolves `three/tsl`.

## Tech Stack

- React 18 + TypeScript + Vite
- [@xyflow/react](https://reactflow.dev/) v12 — node graph
- [@monaco-editor/react](https://github.com/suren-atoyan/monaco-react) — code editor (Monaco bundled locally, no CDN — the app works fully offline)
- [zustand](https://github.com/pmndrs/zustand) v5 — state management
- [three.js](https://threejs.org/) 0.184 (WebGPU build) — shader runtime, exclusively `three/tsl` built-ins (including the MaterialX noise family)
- [@babel/parser](https://babeljs.io/docs/babel-parser) + [@babel/traverse](https://babeljs.io/docs/babel-traverse) — code-to-graph parsing
- [dagre](https://github.com/dagrejs/dagre) — automatic graph layout
- [Tauri](https://v2.tauri.app/) v2 — offline desktop builds (Windows / macOS)

## License

MIT

## Contact

Alvis Misjuns

- Email: [alvis.misjuns@va.lv](mailto:alvis.misjuns@va.lv)
- Web: [alvismisjuns.lv](https://alvismisjuns.lv)

This research was supported by the project No. 1.1.1.8/1/24/I/001 VeA and ViA Doctoral Grants, co-funded by the European Union (European Regional Development Fund) and the Latvian state budget within the European Union Cohesion Policy Programme 2021–2027.
