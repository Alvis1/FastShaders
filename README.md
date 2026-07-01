# FastShaders

A visual shader editor for [TSL (Three.js Shading Language)](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language) with bi-directional sync between a node graph and code.

**[Live Demo](https://Alvis1.github.io/FastShaders/)**

## Features

- **Bi-directional sync** — edit either the graph or the TSL code; changes round-trip in both directions
- **Node graph editor** — ~66 TSL node types across 10 visible categories
- **Code editor** — Monaco with TSL syntax highlighting, light/dark toggle, inline error/warning squiggles, and a separate read-only Script tab showing the exported `.js` module
- **Live 3D preview** — WebGPU-rendered preview with five geometries (sphere, cube, plane, Utah teapot, Stanford bunny), three lighting modes (studio / moon / laboratory), subdivision slider, picked background color, orbit camera, and play/pause
- **MaterialX noise** — 8 built-in noise variants (Perlin, fBm, cell, Worley/Voronoi) backed by `three/tsl`'s MaterialX functions
- **Built-in textures** — 8 procedural texture presets (polka dots, grid, tiger fur, static noise, crumpled fabric, gas giant, marble, wood) draggable from the palette
- **Groups** — Ctrl/Cmd+G to wrap selected nodes in a recolorable, collapsible container; save groups to a per-browser library and drag them onto any graph
- **Property uniforms** — `property_float` nodes become live-tunable sliders in the preview overlay and component attributes in the A-Frame export
- **Copy / paste / duplicate** — Cmd/Ctrl+C, Cmd/Ctrl+V, Cmd/Ctrl+D across nodes (internal edges preserved)
- **VR cost budget** — per-headset cost meter (Quest 2/3/3s, Steam Frame, Pico 4, Apple Vision Pro) with a color-gradient bar that fills as the graph's GPU cost approaches the selected headset's budget (advisory, not a hard limit)


### Using the shader module with a-frame-shaderloader

```html
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-180-a-01.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.4.js"></script>

<a-scene>
  <a-sphere shader="src: myshader.js" position="0 1.5 -3"></a-sphere>
</a-scene>
```

Those two scripts are all you need: `a-frame-180-a-01.min.js` bundles **A-Frame 1.8.0 + Three.js r184 (WebGPU)**, and `a-frame-shaderloader-0.4.js` rewrites the module's `import … from 'three/tsl'` to read that bundle's single Three.js instance — so **no import map and no shim are required**. The exported `.js` also works directly with Three.js, or any bundler that resolves `three/tsl`.

## Tech Stack

- React 18 + TypeScript + Vite
- [@xyflow/react](https://reactflow.dev/) v12 — node graph
- [@monaco-editor/react](https://github.com/suren-atoyan/monaco-react) — code editor
- [zustand](https://github.com/pmndrs/zustand) v5 — state management
- [three.js](https://threejs.org/) 0.184 (WebGPU build) — shader runtime, exclusively `three/tsl` built-ins (including the MaterialX noise family)
- [@babel/parser](https://babeljs.io/docs/babel-parser) + [@babel/traverse](https://babeljs.io/docs/babel-traverse) — code-to-graph parsing
- [dagre](https://github.com/dagrejs/dagre) — automatic graph layout

## License

MIT

## Contact

Alvis Misjuns

- Email: [alvis.misjuns@va.lv](mailto:alvis.misjuns@va.lv)
- Web: [alvismisjuns.lv](https://alvismisjuns.lv)
