# FastShaders

FastShaders is a visual 3D graphics editor for web-based virtual reality content, built to be an accessible and convenient shader programming experience for both beginners and experienced content creators.

Main features:

- **Nodes and code in sync**: build a shader as a node graph or write it as [TSL (Three.js Shading Language)](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language). The code follows every graph edit, and **Apply** turns edited code back into nodes.
- **Performance cost while you build**: each node's GPU cost is measured on the target VR headset, and the editor shows the shader's total against that device's budget.
- **Visual-effect presets** to start from or take apart, plus reconstructed TSL textures and distance-field (SDF) nodes. Switch the Textures and SDF tabs on from the toolbar's right-click menu.
- **Your own material**: images, 3D models (`.obj`, `.glb`, `.gltf`), Gaussian splats, colour palettes, microphone or desktop audio, and CSV data.
- **Export for the web**: a `.js` module for A-Frame or plain Three.js, a `.zip` with its images and model, or one `.glb` that holds the model, its textures and the shader.
- **Browser or desktop**: runs in the browser, or offline as a desktop app for Windows and macOS. The interface is in English and Latvian.

**[Open](https://alvismisjuns.lv/fastshaders/)** · [GitHub Pages build](https://alvis1.github.io/FastShaders/)

**[Desktop app downloads](https://github.com/Alvis1/FastShaders/releases/latest)**

## How it works

![FastShaders architecture: images (converted to WebP), 3D geometry, Gaussian splats, colour palettes, audio, data files and a benchmark profile feed a node editor kept in sync with a Monaco TSL code editor; node assets supply 75+ nodes by category, visual-effect presets and reconstructed TSL textures; the node editor drives a sandboxed real-time preview of the 3D geometry and shader, a live estimate of the shader's performance cost, and a download as a .js shader file, a .zip with images and geometry, or a .glb with the node structure and textures embedded; exported files import back by drag and drop; the ShaderLoader A-Frame component loads the shader and its assets into an A-Frame 1.8.0 scene; ShaderCarousel measures per-node performance points on the device, and Podest is a standalone shader viewer built on A-Frame.](docs/fastshaders-function-diagram.png)

Every export carries the editor project inside it, so dragging an exported file back onto FastShaders reopens its graph. A dropped `.js` or `.zip` asks first: **Open** replaces the current graph, **Add** places the dropped shader beside it as one group. A `.glb` comes back through its import dialog's **Restore** (see [Single-GLB export](#single-glb-export)).

## Also in this repo

- **[Podest](docs/PODEST.md)** — a standalone full-screen shader viewer built for
  unattended pedestal displays. Drop a shader, a model or a `.zip`; it reopens
  itself after a reload and can run for weeks.
- **[ShaderCarousel](ShaderCarousel/README.md)** — the benchmark suite that
  measures per-node GPU cost on the target headset, so the editor's cost bar
  shows measured numbers rather than guesses.
- **[a-frame-shaderloader](https://github.com/Alvis1/a-frame-shaderloader#readme)** — the A-Frame
  component that runs an exported shader on any entity (a git submodule, and the
  source of the scripts below, including the Gaussian-splat runtime).

## Using the shader module with a-frame-shaderloader

```html
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/a-frame-180-a-01.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/a-frame-shaderloader-0.8.js"></script>

<a-scene renderer="backend: webgl">
  <a-sphere shader="src: myshader.js" position="0 1.6 -3"></a-sphere>
</a-scene>
```

1. Click **EXPORT** in FastShaders. You get `myshader.js` (a `.zip`? unzip it and keep its folders).
2. Put it in a folder next to an `index.html` holding the code above, with `myshader.js` changed to your file's name. Easier: the code panel's **A-Frame** tab → **Copy** gives that page ready-made.
3. Open the page through a local web server. Double-clicking it gives `Failed to fetch`. **Search for:** `VS Code Live Server`.

For VR, put the folder online over https (**search for:** `GitHub Pages tutorial`) and keep `renderer="backend: webgl"`. A shader using **Displacement** needs `segments-width="64" segments-height="64"` on the shape. Stuck? Open the console (F12, or Cmd+Option+J on a Mac) and search the web for its first red message. Without A-Frame, see [plain Three.js](#using-the-shader-module-with-plain-threejs).

<!-- Maintainers: every export pins its loader (LOADER_FILE in src/engine/tslToShaderModule.ts).
     When that moves, update every snippet in this file; src/loaderSwitch.test.ts checks them. -->

## Single-GLB export

With your own `.glb` model in the preview, EXPORT saves one `.glb` holding the model, its pictures and the shader (right-click **EXPORT** → **Export .zip** for separate files). Drag it back in and choose **Restore** to keep editing. On a page, use the two scripts above and:

```html
<a-entity gltf-model="url(my-shader.glb)" shader="src: model" position="0 1.6 -3"></a-entity>
```

**Never use `src: model` on a page that loads models other people supply:** it runs the code inside the file. Blender and other viewers show the model without the shader, and re-saving it there deletes the shader.

## Gaussian splats

Drop a `.splat`, `.spz`, `.ply` or `.ksplat` scan (up to 1,000,000 splats) on the preview and wire a **Splat Output**: **Cut**, **Color**, **Opacity**, **Move**, **Size**. Right-click it for **Invert**, **Replace own colour** and **React to light**. A refused `.ply`? Convert it to `.splat` in [SuperSplat](https://superspl.at/editor). On a page, add the splat script after the two above (`kind` = the file type):

```html
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/fs-splat-0.1.js"></script>
<a-entity splat-model="src: url(scene.splat); kind: splat" shader="src: myshader.js" position="0 1.6 -3"></a-entity>
```

## Using the shader module with plain Three.js

For Three.js programmers. The code panel's **Three.js** tab writes a full page; the core is:

```html
<script type="importmap">
  { "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.min.js",
      "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.min.js",
      "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.tsl.min.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/" } }
</script>
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/a-frame-shaderloader-0.8.js"></script>
<script type="module">
  import * as THREE from 'three/webgpu';
  FastShaders.use(THREE);
  const shader = await FastShaders.load('./myshader.js');
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.8, 64, 32));
  const binding = FastShaders.apply(mesh, shader, { values: { speed: 2 } }); // binding.set('speed', 3) later
  // add `mesh` to your scene and render with THREE.WebGPURenderer as usual
</script>
```

Keep three at 0.184.0, the version every export is made for. For glTF models call `loader.register(FastShaders.gltfPlugin)`; for compressed ones import `three/addons/loaders/DRACOLoader.js`, then `FastShaders.decoders.configure({ DRACOLoader })` and `FastShaders.decoders.install(loader)`. A shader inside a `.glb` runs through `FastShaders.applyFromGltf(gltf)`.

## Browser support

Chrome 111+, Safari 16.4+, Firefox 126+ (and Edge, Opera). In older Safari the editor starts but the code panel fails.

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

MIT: you may use, change and share FastShaders, also commercially, as long as you keep its copyright and licence notice ([LICENSE](LICENSE)). The other projects bundled with it (three.js, A-Frame, Monaco, fonts, scientific colormap data…) are credited in [public/THIRD-PARTY-NOTICES.txt](public/THIRD-PARTY-NOTICES.txt), which ships with every build.

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
