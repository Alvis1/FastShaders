# FastShaders

A visual shader editor for [TSL (Three.js Shading Language)](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language) with bi-directional sync between a node graph and code.

**[Live Demo](https://Alvis1.github.io/FastShaders/)**

## Features

- **Node graph editor** — drag, connect, and configure ~55 TSL node types across 9 categories (input, type, arithmetic, math, interpolation, vector, noise, color, output)
- **Code editor** — write TSL directly with Monaco; changes sync back to the graph. Light / dark theme toggle.
- **Live 3D preview** — WebGPU-rendered preview with five geometries (sphere, cube, plane, Utah teapot, Stanford bunny), three lighting modes (studio / moon / laboratory), subdivision slider, picked background color, and a property-uniform slider overlay
- **MaterialX noise** — 8 built-in noise variants (Perlin, fBm, cell, Worley/Voronoi) backed by `three/tsl`'s MaterialX functions
- **Groups** — select nodes and Ctrl+G to wrap them in a recolorable, collapsible container; save groups to a per-browser library and drag them back onto any graph
- **A-Frame export** — download a self-contained VR-ready `.html` file
- **Shader module export** — download a `.js` module for use with [a-frame-shaderloader](https://github.com/Alvis1/a-frame-shaderloader)
- **Property uniforms** — `property_float` nodes become live-tunable component attributes in the A-Frame export
- **Undo / redo** — 50-entry history for node graph changes
- **VR cost budget** — tracks shader complexity against target headset limits

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
npm run build          # production build → dist/
```

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
