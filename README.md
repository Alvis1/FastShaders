# FastShaders

FastShaders is a visual 3D graphics editor for web-based virtual reality content, built to be an accessible and convenient shader programming experience for both beginners and experienced content creators. Shaders are authored in [TSL (Three.js Shading Language)](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language) — edit the node graph or the code, and changes round-trip in both directions.

Main features:

- shader's impact on performance visualization
- node-function and real-time data visualizations
- visual-effect templates

**[Open](https://alvismisjuns.lv/fastshaders/)** · [GitHub Pages build](https://alvis1.github.io/FastShaders/)

**[Desktop app downloads](https://github.com/Alvis1/FastShaders/releases/latest)**

## Using the shader module with a-frame-shaderloader

```html
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/a-frame-180-a-01.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/a-frame-shaderloader-0.5.js"></script>

<a-scene>
  <a-sphere shader="src: myshader.js" position="0 1.5 -3"></a-sphere>
</a-scene>
```

Those two scripts are all you need: `a-frame-180-a-01.min.js` bundles **A-Frame 1.8.0 + Three.js r184 (WebGPU)**, and `a-frame-shaderloader-0.5.js` rewrites the module's `import … from 'three/tsl'` to read that bundle's single Three.js instance — so **no import map and no shim are required**. The exported `.js` also works directly with Three.js, or any bundler that resolves `three/tsl`. Serve the page over http(s): the loader `fetch`es `myshader.js` and imports it as a blob, so opening the HTML straight from disk (`file://`) leaves the mesh unshaded with `Failed to fetch` in the console.

## Tech Stack

- React 18 + TypeScript + Vite
- [@xyflow/react](https://reactflow.dev/) v12 — node graph
- [@monaco-editor/react](https://github.com/suren-atoyan/monaco-react) — code editor (Monaco bundled locally, no CDN — the app works fully offline)
- [zustand](https://github.com/pmndrs/zustand) v5 — state management
- [three.js](https://threejs.org/) 0.184 (WebGPU build) — shader runtime, exclusively `three/tsl` built-ins (including the MaterialX noise family)
- [@babel/parser](https://babeljs.io/docs/babel-parser) + [@babel/traverse](https://babeljs.io/docs/babel-traverse) — code-to-graph parsing
- [dagre](https://github.com/dagrejs/dagre) — automatic graph layout
- [Tauri](https://v2.tauri.app/) v2 — offline desktop builds (Windows / macOS)

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # vitest suite
npm run build      # typecheck + production build
```

Node 20+. The vendored A-Frame and shaderloader scripts are committed under `public/js/`, so a plain
clone builds; the `a-frame-shaderloader` submodule is only needed to change them (clone with
`--recurse-submodules`). Desktop builds additionally need a [Rust toolchain](https://rustup.rs):
`npm run tauri dev` / `npm run tauri build`. Release binaries are built by CI on version tags.

## License

MIT. Bundled third-party components (three.js, A-Frame, Monaco, fonts, scientific colormap data…) are credited in [public/THIRD-PARTY-NOTICES.txt](public/THIRD-PARTY-NOTICES.txt), which ships with every build.

## Contact

Alvis Misjuns

- Email: [alvis.misjuns@va.lv](mailto:alvis.misjuns@va.lv)
- Web: [alvismisjuns.lv](https://alvismisjuns.lv)

## Research

FastShaders is doctoral research at the Faculty of Engineering, Vidzeme University of Applied Sciences, on
performance-aware shader authoring for standalone VR headsets: per-node GPU costs are measured on the target
device with the bundled ShaderCarousel benchmark, so the editor can show a shader's cost against a real
budget while it is being built. A paper is in preparation; until it appears, please link to this repository.

This research was supported by the project No. 1.1.1.8/1/24/I/001 VeA and ViA Doctoral Grants, co-funded by the European Union (European Regional Development Fund) and the Latvian state budget within the European Union Cohesion Policy Programme 2021–2027.
