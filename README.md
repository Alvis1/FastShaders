# FastShaders

A visual shader editor for [TSL (Three.js Shading Language)](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language) with bi-directional sync between a node graph and code.

**[Live Demo](https://Alvis1.github.io/FastShaders/)**

## Features

- **Node graph editor** — drag, connect, and configure ~40 TSL node types
- **Code editor** — write TSL directly with Monaco; changes sync back to the graph
- **Live 3D preview** — WebGPU-rendered preview with geometry selector and rotation
- **tsl-textures support** — procedural texture nodes (camouflage, rust, marble, etc.)
- **A-Frame export** — download a self-contained VR-ready `.html` file
- **Shader module export** — download a `.js` module for use with [a-frame-shaderloader](https://github.com/Alvis1/a-frame-shaderloader)
- **Undo / redo** — full history for node graph changes
- **VR cost budget** — tracks shader complexity against target headset limits

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Build & Deploy

```bash
npm run build          # production build → dist/
npx gh-pages -d dist   # deploy to GitHub Pages
```

## Export Formats

| Tab | Output | Usage |
|-----|--------|-------|
| **TSL** | `Fn(() => { ... })` code | Edit in-app, syncs with node graph |
| **A-Frame** | Self-contained `.html` | Open in browser / VR headset |
| **Module** | ES module `.js` file | `<a-entity shader="src: myshader.js">` with [a-frame-shaderloader](https://github.com/Alvis1/a-frame-shaderloader) |

### Using the shader module with a-frame-shaderloader

```html
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/a-frame-shaderloader-0.2.js"></script>

<a-scene>
  <a-entity shader="src: TSL/myshader.js" position="0 1.5 -3"></a-entity>
</a-scene>
```

## Tech Stack

- React 18 + TypeScript + Vite
- [@xyflow/react](https://reactflow.dev/) v12 — node graph
- [@monaco-editor/react](https://github.com/suren-atoyan/monaco-react) — code editor
- [zustand](https://github.com/pmndrs/zustand) v5 — state management
- [three.js](https://threejs.org/) 0.183 + [tsl-textures](https://github.com/nicolo-ribaudo/tsl-textures) 3.0 — shader engine
- [@babel/parser](https://babeljs.io/docs/babel-parser) — code-to-graph parsing
- [dagre](https://github.com/dagrejs/dagre) — automatic graph layout

## License

MIT
