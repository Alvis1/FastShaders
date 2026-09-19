# FastShaders

FastShaders is a visual 3D graphics editor for web-based virtual reality content, built to be an accessible and convenient shader programming experience for both beginners and experienced content creators. Shaders are authored in [TSL (Three.js Shading Language)](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language) — edit the node graph or the code, and changes round-trip in both directions.

Main features:

- shader's impact on performance visualization
- node-function and real-time data visualizations
- visual-effect templates

**[Open](https://alvismisjuns.lv/fastshaders/)** · [GitHub Pages build](https://alvis1.github.io/FastShaders/)

**[Desktop app downloads](https://github.com/Alvis1/FastShaders/releases/latest)**

## How it works

![FastShaders architecture: images, 3D geometry, colour palettes, uniforms, audio, data files and a benchmark profile feed a node editor kept in sync with a Monaco TSL code editor by zustand; node assets supply 75+ nodes, visual-effect presets and reconstructed TSL textures; output goes to a real-time A-Frame preview in an iframe, a live shader cost estimate, and a .js or .zip download that the ShaderLoader A-Frame component loads into a scene, with ShaderCarousel supplying measured per-node performance points and Podest presenting the result standalone.](docs/fastshaders-function-diagram.png)

## Also in this repo

- **[Podest](docs/PODEST.md)** — a standalone full-screen shader viewer built for
  unattended pedestal displays. Drop a shader, a model or a `.zip`; it reopens
  itself after a reload and can run for weeks.
- **[ShaderCarousel](ShaderCarousel/README.md)** — the benchmark suite that
  measures per-node GPU cost on the target headset, so the editor's cost bar
  shows measured numbers rather than guesses.
- **[a-frame-shaderloader](https://github.com/Alvis1/a-frame-shaderloader#readme)** — the A-Frame
  component that runs an exported shader on any entity (a git submodule, and the
  source of the two scripts below).

## Using the shader module with a-frame-shaderloader

```html
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/a-frame-180-a-01.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/a-frame-shaderloader-0.8.js"></script>

<a-scene renderer="backend: webgl">
  <a-sphere shader="src: myshader.js" position="0 1.6 -3"></a-sphere>
</a-scene>
```

Those two scripts are all you need: `a-frame-180-a-01.min.js` bundles **A-Frame 1.8.0 + Three.js r184 (WebGPU)**, and `a-frame-shaderloader-0.8.js` rewrites the module's `import … from 'three/tsl'` to read that bundle's single Three.js instance — so **no import map and no shim are required**. The loader version is not a choice: every export the app produces pins it (`LOADER_FILE` in `src/engine/tslToShaderModule.ts`), so bump this snippet whenever that moves. Shaders exported by older releases name 0.6 or 0.5 in their header; those files stay on the CDN, frozen, so an old export keeps loading the loader it was written for. Without A-Frame the same loader runs the exported `.js` on plain Three.js r184 — see [Using the shader module with plain Three.js](#using-the-shader-module-with-plain-threejs). Serve the page over http(s): the loader `fetch`es `myshader.js` and imports it as a blob, so opening the HTML straight from disk (`file://`) leaves the mesh unshaded with `Failed to fetch` in the console.

A **single-GLB** export carries the shader inside the model. Load the `.glb` and opt in with `src: model`:

```html
<a-entity gltf-model="url(my-shader.glb)" shader="src: model" position="0 1.6 -3"></a-entity>
```

Never use `src: model` on a page that loads models other people supply: the shader inside runs with the page's privileges, exactly like a script tag. On plain Three.js the same module runs through `FastShaders.applyFromGltf` (see the loader's own README, *Shader inside the model*).

`renderer="backend: webgl"` is what makes the page enter VR: Three.js r184 picks its WebGPU backend whenever `navigator.gpu` exists, and that backend refuses a WebXR session outright. The attribute forces the WebGL2 path, which compiles the same TSL and can present to a headset. Drop it for a flat page if you would rather have WebGPU.

## Using the shader module with plain Three.js

Loader 0.8 is a plain Three.js loader too: without A-Frame on the page it installs `globalThis.FastShaders`, which does for a mesh what the A-Frame component does for an entity. The code panel's **Three.js** tab writes such a page for the current shader, making these same three calls. With the loader:

```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.min.js",
    "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.min.js",
    "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.tsl.min.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/"
  }
}
</script>
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/a-frame-shaderloader-0.8.js"></script>
<script type="module">
  import * as THREE from 'three/webgpu';

  FastShaders.use(THREE);                                  // the three/webgpu namespace
  const shader = await FastShaders.load('./myshader.js');  // fetch, the loader's transforms, import

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 0, 3);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(2, 3, 2);
  scene.add(key);

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.8, 64, 32));
  scene.add(mesh);
  const binding = FastShaders.apply(mesh, shader, { values: { speed: 2 } });

  renderer.setAnimationLoop(() => renderer.render(scene, camera));
</script>
```

Three is pinned to **0.184.0**, the revision every export names in its header and declares as `export const threeRevision`; a floating version tag can rename a TSL function out from under a saved page. `FastShaders.use(THREE)` takes the `three/webgpu` namespace and sets `globalThis.THREE` when the page has none. `FastShaders.apply` is synchronous and returns a binding: change a property at runtime with `binding.set('speed', 3)` (a number, or a colour as `'#rrggbb'`), read it as `binding.uniforms.speed.value`, and `binding.dispose()` puts the mesh back as it was. Serve the folder over http(s).

What `apply` does for you, as the A-Frame component does:

- **Uniforms from `schema`** — one `uniform()` node per entry, a `THREE.Color` for `type: 'color'`, starting at `values` where you pass them.
- **The material** — the returned channels (`colorNode`, `roughnessNode`, …) on a `MeshPhysicalNodeMaterial`, with `emissiveNode` copied to `colorNode` when no colour is wired, and the material settings `transparent`, `side`, `alphaTest` and `depthWrite`.
- **`parts`** — a per-mesh shader returns `parts: { "<mesh name>": { …same keys… } }`, and each entry becomes the material of the sub-mesh with that name.
- **The weld** — a shader with `positionNode` has a box's corner copies welded by POSITION, or its faces separate, unless the module returns `mergeVertices: false`. Under the default it welds only three's own primitive geometries, never a loaded model.
- **Barycentric corners** — a Wireframe node returns `barycentric: true` and reads an `attribute('bary')` the loader builds.
- **The revision check** — one warning when the module's `threeRevision` differs from the page's three. It never stops the shader.

Tessellation stays your job: a shader with `positionNode` needs vertices to move, and a default `PlaneGeometry`/`BoxGeometry` has one segment per side.

**glTF models.** Register the loader's plugin on your `GLTFLoader` before loading — `loader.register(FastShaders.gltfPlugin)` — so a shader that shades by glTF material index knows which material each mesh came from; `FastShaders.decoders.install(loader)` adds the Draco and meshopt decoders the loader ships, from the `decoders/` folder beside its script. The bare `three/webgpu` namespace has no `DRACOLoader`, so a plain page imports it from `three/addons/loaders/DRACOLoader.js` (the import map's `three/addons/` entry, where `GLTFLoader` lives too) and calls `FastShaders.decoders.configure({ DRACOLoader })` before `install(loader)`. `LoadingManager` comes from the namespace `use()` bound.

**WebGLRenderer.** three r184 can render node materials on the classic renderer through `renderer.setNodesHandler(new WebGLNodesHandler())` (`three/addons/tsl/WebGLNodesHandler.js`). `WebGLRenderer` is not in the `three/webgpu` build, so such a page maps `three` to `build/three.module.min.js`. The handler states its own limits (no VSM shadows, no MRT, no transmission, fog and environment that do not update until disposed), and an environment map may be prefiltered twice. Untested here.

**Without the loader.** A module imports `THREE` from `three/webgpu` when it builds a texture (Image, Data and Colormap nodes, and Data Stripes / Data Viz fed by a Data node) and imports every `three/tsl` function it calls, so `await import('./myshader.js')` works with the import map above. Everything in the list above is then yours to redo by hand: `BufferGeometryUtils.mergeVertices`, for one, does not weld a box, because its corner copies differ in normal and UV.

## Single-GLB export

One `.glb` can carry the whole thing: the 3D model you dropped on the preview, the textures the shader uses, the shader module and the editor project. Right-click **EXPORT** → **Format** → *One .glb*. It is offered for a loaded `.glb`, or a `.gltf` whose data is embedded — not for a built-in shape, an `.obj`, or a `.gltf` that keeps its buffers and images in separate files — and never in a study session.

The page that runs it is the code panel's **A-Frame** tab, which switches to the model while that format is picked:

```html
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/a-frame-180-a-01.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js/a-frame-shaderloader-0.8.js"></script>
```

```html
<a-entity gltf-model="url(my-shader.glb)" shader="src: model" position="0 1.6 -3"></a-entity>
```

Loader **0.8 or later** is required: `src: model` is its opt-in for the module stored inside the file. Loader 0.6 reads it as a file path, logs one `shader-error`, and the model keeps its own PBR materials. On plain Three.js the same module runs through `FastShaders.applyFromGltf(gltf)` after `loader.register(FastShaders.gltfPlugin)`.

**Never use `src: model` on a page that loads models other people supply.** The code inside the file runs with the page's privileges, exactly like a script tag.

What other tools show:

- **Blender, the three.js editor, Babylon's sandbox, model-viewer, any glTF 2.0 viewer** — an ordinary PBR model with the OPTIMISED textures, which replace the originals. Viewers that implement `EXT_texture_webp` read the WebP; the others read the PNG/JPEG copy, re-encoded from the same pixels (the extension is listed in `extensionsUsed`, never in `extensionsRequired`). None of them shows the authored shader look: extras are ignored.
- **Round trips that LOSE the shader, silently** — a Blender re-export (even with Custom Properties ticked), `gltf-transform prune`, gltfpack. The module and project live in buffer views that only `extras` references, so a repack drops them or leaves the indices dangling. FastShaders then reports the file as carrying no shader, or as damaged.
- **Scale** — the model appears at its AUTHORED scale on such a page; the editor's own preview normalises it to 1.6 units.

Drag the `.glb` back onto FastShaders and the import dialog offers **Restore** — the graph, its stored values and the model come back.

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

## Browser support

**Chrome 111+ · Safari 16.4+ · Firefox 126+** (and Chromium-based Edge/Opera at the Chrome floor).
Builds target `esnext` with no polyfills and nothing transpiled down, so the floor is whatever the
newest feature actually used demands. That feature differs per engine, and so does the damage below it
— only Safari's is a hard break, which is exactly why the single number is not the whole story:

| Engine | Floor | Set by | What an older version does |
| --- | --- | --- | --- |
| Chrome | 111 | `color-mix()` (`CostBar.css`) | Everything works; the benchmark drop-target loses a tint (a literal `rgba()` fallback runs first). |
| Safari | 16.4 | ES2022 class static blocks, shipped by `monaco-editor` 0.55 | The app boots and the node editor works; the **code panel** fails when opened, because Monaco is a lazily-loaded chunk. |
| Firefox | 126 | the non-standard `zoom` property (`NodePreviewCard.css`) | The app works, but every asset-browser tile renders ~1.49× and is clipped by the strip. |

A browser too old to start the app at all lands on a bilingual note in `index.html` rather than a blank
page. That watchdog fires only when React never mounts, so it does **not** catch the Safari case above —
there the editor really did start.

Beyond the app itself, the 3D preview needs WebGL2 (WebGPU is used when the browser offers a working
adapter, and the preview falls back on its own when it does not).

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
