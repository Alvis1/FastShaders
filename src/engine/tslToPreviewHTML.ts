/**
 * Generates a self-contained A-Frame HTML page that renders a TSL shader
 * using the a-frame-shaderloader component. Used for the in-app preview iframe.
 *
 * Loads the IIFE bundle (A-Frame 1.8.0 + Three.js r184 WebGPU) and the shaderloader
 * from local files served via Vite's public directory. The editor's TSL code
 * is converted into a shaderloader-compatible ES module, served as a blob URL,
 * and applied via the shaderloader's `shader` component.
 */

import { buildShaderModule } from './tslCodeProcessor';
import type { MaterialSettings } from '@/types';
import type { PreviewMeshKind } from '@/utils/previewMesh';

// 'env' = environment-map lighting: NO analytic lights — the material's own
// envNode (an image wired to the Output node's Environment socket) is the
// light source (IBL). The option is offered in the Light dropdown only while
// an env map is attached; ShaderPreview falls back to 'studio' otherwise.
export type LightingMode = 'studio' | 'moon' | 'laboratory' | 'env';

export type GeometryType = 'sphere' | 'cube' | 'plane' | 'teapot' | 'bunny' | 'custom';

/** Geometry types backed by a BUILT-IN OBJ model file (public/models/). */
const OBJ_GEOMETRIES: ReadonlySet<GeometryType> = new Set(['teapot', 'bunny']);

export function isObjGeometry(geometry: GeometryType): boolean {
  return OBJ_GEOMETRIES.has(geometry);
}

/**
 * True for every model-file-backed geometry — the built-in OBJs plus the
 * user's dropped mesh (`custom`). These share the non-primitive plumbing:
 * no subdivision slider, mesh delivered via the postMessage model feed, and
 * geometry changes force an iframe rebuild instead of a live hot-swap.
 */
export function isModelGeometry(geometry: GeometryType): boolean {
  return isObjGeometry(geometry) || geometry === 'custom';
}

export interface CameraPosition {
  x: number;
  y: number;
  z: number;
}

export interface PreviewOptions {
  geometry?: GeometryType;
  animate?: boolean;
  materialSettings?: MaterialSettings;
  bgColor?: string;
  lighting?: LightingMode;
  /** Mesh subdivision count — applied symmetrically to each axis (primitives only). */
  subdivision?: number;
  /**
   * Camera position to restore after orbit-controls initialization. Passed
   * out-of-band rather than baked into orbit-controls' `initialPosition` so
   * the controls' internal `position0` stays at the original `0 0 8` and
   * `reset()` snaps back there instead of to the saved view.
   */
  initialCameraPosition?: CameraPosition | null;
  /** Spin parent rotation to restore so the object angle survives iframe rebuilds. */
  initialRotation?: CameraPosition | null;
  /**
   * Build a top-level (non-sandboxed) immersive-VR page instead of the
   * sandboxed editor preview. Immersive WebXR can NEVER run inside the
   * preview iframe — but NOT at the Permissions-Policy layer (researched
   * 2026-08-07: the spec matches a `*` allowlist BEFORE the opaque-origin
   * rejection, and Chromium's parser sets matches_opaque_src for it, so
   * `allow="xr-spatial-tracking *"` would delegate fine). Three blockers
   * sit below that layer: (1) Chromium's permission layer auto-denies any
   * permission request from an opaque origin before grant logic runs
   * (permission_context_base.cc — the same mechanism that blocks
   * getUserMedia there), and immersive-vr needs the VR permission;
   * (2) Meta Quest Browser empirically fails — and can crash — running
   * WebXR in allow-scripts-only sandboxed iframes (its forum bug tracker
   * says allow-same-origin is required, which this app must never grant);
   * (3) a parent click never confers transient activation on an
   * opaque-origin child (HTML activation propagates to same-origin
   * descendants only), so requestSession's gesture requirement could not be
   * met from the app's chrome anyway. Hence entry happens from a top-level
   * document (ShaderPreview opens an about:blank popup that inherits the
   * app's real origin). In xr mode the page:
   *   - hides `navigator.gpu` up front so three r184 auto-falls back to its
   *     WebGL2 backend — the WebGPU backend hard-throws in
   *     XRManager.setSession (r173–r184) and Quest Browser has no
   *     WebXR+WebGPU at all; TSL compiles identically via GLSLNodeBuilder.
   *     This is the no-bundle-patch equivalent of the proven forceWebGL
   *     recipe (aframe issue 5749).
   *   - keeps `navigator.xr` visible (the normal preview hides it because
   *     A-Frame's XR init path breaks on the WebGPU backend).
   *   - enables A-Frame's own Enter-VR button (`vr-mode-ui`).
   *   - loads OBJ models directly by URL — the page is same-origin, so the
   *     CORS constraint that forces the sandboxed preview onto the
   *     postMessage model feed does not apply.
   */
  xr?: boolean;
  /** Document title — the XR popup shows the shader name in its tab. */
  title?: string;
  /**
   * Descriptor of the user's dropped mesh — required when `geometry` is
   * `'custom'`. `id` is the mesh's monotonic identity: it keys the model feed
   * so a slow post for a previous mesh can't apply to a newer document. The
   * BYTES never ride in the generated HTML — the sandboxed preview receives
   * them via the postMessage model feed (same security model as podest.html);
   * only the same-origin XR popup loads directly via `url` (a parent-minted
   * blob URL, omitted in the sandboxed case).
   */
  customModel?: { kind: PreviewMeshKind; id: number; url?: string } | null;
}

/**
 * Build the A-Frame `geometry` attribute string with the requested
 * subdivision count baked into the per-primitive segment fields. The
 * subdivision is clamped to a sensible range so the slider can't lock the
 * tab up with millions of vertices.
 *
 * Exported because ShaderPreview also needs this for the postMessage
 * geometry/subdivision hot-updates (keeps the formula in one place so the
 * initial-HTML and live-update paths can't drift).
 */
export function buildGeoAttr(
  geometry: 'sphere' | 'cube' | 'plane',
  subdivision: number,
): string {
  const seg = Math.max(1, Math.min(256, Math.round(subdivision)));
  switch (geometry) {
    case 'cube':
      return `primitive: box; width: 1.4; height: 1.4; depth: 1.4; segmentsWidth: ${seg}; segmentsHeight: ${seg}; segmentsDepth: ${seg}`;
    case 'plane':
      return `primitive: plane; width: 2; height: 2; segmentsWidth: ${seg}; segmentsHeight: ${seg}`;
    case 'sphere':
    default:
      return `primitive: sphere; radius: 1; segmentsWidth: ${seg}; segmentsHeight: ${seg}`;
  }
}

/**
 * Resolve an app-served asset path (relative to the Vite base) to a fully-
 * qualified URL. The preview iframe is sandboxed srcdoc with an opaque
 * origin, so path-only or relative URLs won't resolve inside it — every URL
 * handed in must be absolute. Resolving via `new URL(..., location.href)`
 * works from any scheme the app is served on (https://, tauri://, file://)
 * and with both absolute ('/FastShaders/') and relative ('./') base paths,
 * whereas `location.origin + base` concatenation breaks on non-http schemes
 * and relative bases. (Same pattern as public/podest.html.)
 */
function resolveAssetUrl(pathFromBase: string): string {
  const base = import.meta.env.BASE_URL;
  if (typeof window === 'undefined') return `${base}${pathFromBase}`;
  return new URL(`${base}${pathFromBase}`, window.location.href).href;
}

/** Escape text for safe interpolation into HTML content (the <title>). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/**
 * Resolve the absolute URL of an OBJ model in `public/models/`.
 *
 * Exported so ShaderPreview can fetch the model text for the sandboxed
 * preview's postMessage model feed (and for any future direct-URL use).
 */
export function getModelUrl(geometry: 'teapot' | 'bunny'): string {
  const file = geometry === 'bunny' ? 'stanford-bunny.obj' : 'teapot.obj';
  return resolveAssetUrl(`models/${file}`);
}

/**
 * Per-geometry static rotation applied to the inner `preview-entity`. The
 * spin parent handles the live rotation animation; this is the resting tilt.
 * Exported so the hot-update path can set the same value as the initial HTML.
 */
export const GEOMETRY_ROTATIONS: Record<GeometryType, string> = {
  sphere: '45 45 0',
  cube: '45 45 0',
  plane: '0 0 0',
  teapot: '15 35 0',
  bunny: '0 25 0',
  // Dropped models keep their authored upright orientation (same as podest).
  custom: '0 0 0',
};

/**
 * Light-rig definitions for each lighting mode. The bridge script reads
 * these via postMessage when the parent dispatches a lighting change, and
 * recreates `<a-light>` elements without a full iframe rebuild.
 *
 * Format: array of attribute bags. `type` becomes `a-light type=...`, all
 * other keys become element attributes verbatim.
 */
export interface LightSpec {
  type: 'directional' | 'ambient';
  color: string;
  intensity: number;
  position?: string;
}

export const LIGHT_PRESETS: Record<LightingMode, LightSpec[]> = {
  studio: [
    // Key — raking angle, warm, exposes normal/bump detail
    { type: 'directional', color: '#ffffff', position: '-3 4 2', intensity: 2.5 },
    // Rim — backlight, cool tint, defines specular silhouette
    { type: 'directional', color: '#d4e5ff', position: '2 3 -4', intensity: 2.0 },
    // Fill — opposite key, neutral, lifts shadows
    { type: 'directional', color: '#e8e8e8', position: '4 1 3', intensity: 0.6 },
    // Ambient — minimal base so crevices aren't pure black
    { type: 'ambient', color: '#ffffff', intensity: 0.15 },
  ],
  moon: [
    // Single cool directional angled in front of the object so roughly 2/3 of
    // the camera-facing hemisphere is lit. Faint ambient floor.
    { type: 'directional', color: '#cfd8ff', position: '-4 1.5 2', intensity: 4.0 },
    { type: 'ambient', color: '#1a1f33', intensity: 0.05 },
  ],
  laboratory: [
    // Pure flat ambient — every surface lit identically, no shadows.
    { type: 'ambient', color: '#ffffff', intensity: 2.5 },
  ],
  // Environment-map mode: an EMPTY rig on purpose. material.envNode supplies
  // radiance + irradiance (three's EnvironmentNode/pmremTexture), so any
  // analytic light on top would double-light the surface and drown the map.
  env: [],
};

// Resolve full absolute URLs for the IIFE bundle and shaderloader at runtime.
// The sandboxed iframe can't resolve path-only URLs — see resolveAssetUrl.
function getScriptUrls() {
  return {
    iife: resolveAssetUrl('js/a-frame-180-a-01.min.js'),
    shaderloader: resolveAssetUrl('js/a-frame-shaderloader-0.5.js'),
    orbitControls: resolveAssetUrl('js/aframe-orbit-controls.min.js'),
  };
}

/**
 * A-Frame component registration for OBJ-backed previews. On `model-loaded`,
 * for every Mesh in the loaded hierarchy:
 *   1. **Merge vertices by position.** OBJLoader returns non-indexed geometry
 *      where every triangle owns its own vertices, so a position shared by N
 *      faces becomes N duplicate vertices with N different face normals. Per-
 *      vertex displacement (`positionLocal + normalLocal * val`) then pushes
 *      each duplicate along *its own* face normal and the shape splits open.
 *      Merging by quantized position rebuilds an index so shared points stay
 *      a single vertex — and after \`computeVertexNormals\` they share a single
 *      averaged smooth normal, so displacement keeps faces stitched together.
 *   2. Compute vertex normals from the merged (indexed) geometry, producing
 *      smooth shading regardless of whether the source file had normals.
 *   3. Generate spherical UVs from each vertex's direction relative to the
 *      geometry's local center, so TSL shaders reading \`uv()\` get meaningful
 *      values. Spherical projection seams at the atan2 wrap; acceptable for
 *      procedural shaders (proper unwrap needs offline tools).
 *   4. Recenter the world bbox at the origin and rescale so the longest axis
 *      equals \`data.size\` — bunny (mm) and teapot (tens of units) otherwise
 *      would not frame anywhere near the primitives.
 *
 * String literal so the iframe sees raw JS — no Vite transformation pass.
 */
/**
 * Frame-time / FPS readout for the immersive popup (xr only).
 *
 * Head-locked the ONLY way that survives an XR session: the panel is added to
 * the THREE.PerspectiveCamera A-Frame installs via setObject3D('camera') —
 * NOT to the camera entity's object3D. A child <a-entity> attaches to the
 * camera's PARENT, which look-controls rotates in flat mode but which XR
 * leaves alone, so it looks head-locked on a desktop and silently world-locks
 * in the headset.
 *
 * Text is rasterized into a canvas + CanvasTexture rather than drawn with
 * <a-text>: A-Frame's text component fetches its MSDF font from
 * cdn.aframe.io, and this app must run with no network.
 *
 * Measurement rides A-Frame's tick, which is driven by
 * renderer.setAnimationLoop — three swaps that for session.requestAnimationFrame
 * when presenting, so it keeps ticking in XR (window.requestAnimationFrame
 * does not). The number is the presented FRAME PERIOD, i.e. it includes vsync:
 * on a headset locked to 72/90/120 Hz it reads the refresh rate until the
 * shader actually misses frames.
 */
const XR_STATS_SCRIPT = `<script>
  if (window.AFRAME && !AFRAME.components["fs-xr-stats"]) {
    AFRAME.registerComponent("fs-xr-stats", {
      init: function () {
        var canvas = document.createElement("canvas");
        canvas.width = 512;
        canvas.height = 128;
        this.ctx = canvas.getContext("2d");
        this.tex = new THREE.CanvasTexture(canvas);
        this.tex.minFilter = THREE.LinearFilter;
        this.mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, toneMapped: false })
        );
        // Draw last and ignore depth: entering VR zeroes the camera position,
        // which puts the viewer inside the previewed mesh — without this the
        // shaded surface would occlude the panel.
        this.mesh.renderOrder = 999;
        this.mesh.frustumCulled = false;
        this.acc = 0;
        this.frames = 0;
        this.sinceDraw = 0;
        this.last = 0;
        this.ft = 0;
        this.fps = 0;
        this.draw();
      },
      attach: function () {
        if (this.cam) return true;
        var camEl = document.querySelector("[camera]");
        var cam = camEl && camEl.getObject3D && camEl.getObject3D("camera");
        if (!cam) return false;
        cam.add(this.mesh);
        this.cam = cam;
        return true;
      },
      place: function () {
        // three rewrites camera.fov from the live XR projection every frame,
        // so this tracks the headset's real vertical FOV, never the authored
        // fov: 20 (which XR overwrites).
        var dist = 1;
        var halfH = Math.tan((this.cam.fov * Math.PI / 180) / 2) * dist;
        var h = halfH * 0.16;
        this.mesh.scale.set(h * 4, h, 1);
        // Centered, one quarter of the FULL view height above centre.
        this.mesh.position.set(0, halfH * 0.5, -dist);
      },
      draw: function () {
        var ctx = this.ctx;
        var w = ctx.canvas.width;
        var h = ctx.canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = "#ffffff";
        ctx.font = "600 54px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(this.ft.toFixed(1) + " ms   " + Math.round(this.fps) + " fps", w / 2, h / 2);
        this.tex.needsUpdate = true;
      },
      tick: function () {
        if (!this.attach()) return;
        var now = (window.performance && performance.now) ? performance.now() : Date.now();
        if (this.last) {
          var dt = now - this.last;
          // Drop absurd gaps (tab hidden, session handover) so one stall
          // doesn't poison the average.
          if (dt > 0 && dt < 1000) {
            this.acc += dt;
            this.frames++;
            this.sinceDraw += dt;
          }
        }
        this.last = now;
        this.place();
        // Redraw at ~4Hz: re-rasterizing and re-uploading a texture every
        // frame is itself a measurable GPU cost, and this app exists to
        // measure GPU cost — the readout must not bias what it reports.
        if (this.sinceDraw >= 250 && this.frames > 0) {
          this.ft = this.acc / this.frames;
          this.fps = 1000 / this.ft;
          this.acc = 0;
          this.frames = 0;
          this.sinceDraw = 0;
          this.draw();
        }
      }
    });
  }
<${''}/script>`;

/**
 * Exported for `previewFitBounds.test.ts`, which evaluates this script against a
 * real `three` import and a stubbed AFRAME to pin the normalization maths — the
 * function body is otherwise untested (the HTML tests only assert the emitted
 * attribute string, so a body rewrite would pass silently).
 */
export const FIT_BOUNDS_SCRIPT = `<script>
  if (window.AFRAME && !AFRAME.components["fit-bounds"]) {
    // Merge vertices that share a quantized position. Discards old normals/UVs
    // (they index into the old layout and we recompute both anyway) and
    // returns a freshly indexed BufferGeometry.
    function mergeByPosition(geom) {
      var pos = geom.attributes.position;
      if (!pos) return geom;
      var oldIndex = geom.index;
      var precision = 1e4; // 4 decimal places — tighter than typical OBJ precision
      var lookup = Object.create(null);
      var newPositions = [];
      var remap = new Uint32Array(pos.count);
      var nextIndex = 0;
      for (var i = 0; i < pos.count; i++) {
        var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        var key = Math.round(x * precision) + "_" + Math.round(y * precision) + "_" + Math.round(z * precision);
        var idx = lookup[key];
        if (idx === undefined) {
          idx = nextIndex++;
          lookup[key] = idx;
          newPositions.push(x, y, z);
        }
        remap[i] = idx;
      }
      var indexCount = oldIndex ? oldIndex.count : pos.count;
      var Arr = nextIndex < 65535 ? Uint16Array : Uint32Array;
      var newIndex = new Arr(indexCount);
      if (oldIndex) {
        for (var j = 0; j < indexCount; j++) newIndex[j] = remap[oldIndex.getX(j)];
      } else {
        for (var k = 0; k < indexCount; k++) newIndex[k] = remap[k];
      }
      var merged = new THREE.BufferGeometry();
      merged.setAttribute("position", new THREE.BufferAttribute(new Float32Array(newPositions), 3));
      merged.setIndex(new THREE.BufferAttribute(newIndex, 1));
      return merged;
    }

    // Reverse triangle winding. Used both by the inverted-winding heuristic and
    // by the bake step when a node's transform is mirrored (negative
    // determinant), which flips handedness and would otherwise leave the model
    // inside-out. Non-indexed geometry gets an index built for the purpose.
    function flipWinding(g) {
      var idx = g.index;
      if (!idx) {
        var pos = g.attributes.position;
        if (!pos) return;
        var n = pos.count;
        var Arr = n < 65535 ? Uint16Array : Uint32Array;
        var arr = new Arr(n);
        for (var i = 0; i < n; i++) arr[i] = i;
        for (var t0 = 0; t0 + 2 < n; t0 += 3) {
          var tmp = arr[t0 + 1];
          arr[t0 + 1] = arr[t0 + 2];
          arr[t0 + 2] = tmp;
        }
        g.setIndex(new THREE.BufferAttribute(arr, 1));
        return;
      }
      for (var t = 0; t + 2 < idx.count; t += 3) {
        var b = idx.getX(t + 1);
        idx.setX(t + 1, idx.getX(t + 2));
        idx.setX(t + 2, b);
      }
      idx.needsUpdate = true;
    }

    // Spherical UVs from each vertex's direction relative to the local center
    // — shared by the regen path (always) and the preserve path (only when the
    // source mesh has no UVs at all).
    function sphericalUVs(g, c) {
      var pos = g.attributes.position;
      var uvs = new Float32Array(pos.count * 2);
      var v = new THREE.Vector3();
      var TWO_PI = Math.PI * 2;
      for (var i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).sub(c);
        var len = v.length();
        if (len > 0) v.multiplyScalar(1 / len);
        uvs[i * 2] = Math.atan2(v.z, v.x) / TWO_PI + 0.5;
        uvs[i * 2 + 1] = Math.asin(Math.max(-1, Math.min(1, v.y))) / Math.PI + 0.5;
      }
      g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    }

    AFRAME.registerComponent("fit-bounds", {
      // regen:true rebuilds normals + spherical UVs (built-in OBJ primitives +
      // dropped OBJs — OBJLoader output is non-indexed, see mergeByPosition).
      // regen:false preserves a dropped GLB's authored normals/UVs and only
      // synthesizes UVs when the mesh has none (same split as podest.html).
      schema: { size: { type: "number", default: 1.6 }, regen: { type: "boolean", default: true } },
      init: function () { this.el.addEventListener("model-loaded", this.fit.bind(this)); },
      fit: function () {
        var root = this.el.getObject3D("mesh");
        if (!root) return;
        var regen = this.data.regen;
        var target = this.data.size;
        root.updateMatrixWorld(true);

        // Collect the mesh nodes and their transforms BEFORE mutating anything
        // — a glTF can share ONE BufferGeometry across several nodes carrying
        // different transforms, so measuring and baking must both work off a
        // snapshot rather than off geometry another node has already changed.
        //
        // \`m\` puts a node's geometry into the ENTITY's frame (the root's own
        // matrix included), which is the frame the normalization has to land
        // in: root.matrix * root.matrixWorld⁻¹ * node.matrixWorld.
        var rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
        var pre = new THREE.Matrix4().multiplyMatrices(root.matrix, rootInv);
        var entries = [];
        var skinned = false;
        root.traverse(function (node) {
          if (!node.isMesh || !node.geometry) return;
          // Baking would desync a skeleton's bind matrices and would miss an
          // InstancedMesh's per-instance transforms — fall back for those.
          if (node.isSkinnedMesh || node.isInstancedMesh) { skinned = true; return; }
          entries.push({ node: node, m: new THREE.Matrix4().multiplyMatrices(pre, node.matrixWorld) });
        });

        // A rigged or instanced model keeps the legacy Object3D normalization:
        // baking would desync a skeleton's bind matrices and would miss an
        // InstancedMesh's per-instance transforms. Its \`positionGeometry\` stays
        // in authored units — position-driven shaders are mis-scaled on it, as
        // they were on every dropped model before this — but nothing renders
        // inconsistently.
        if (skinned) {
          var wbox = new THREE.Box3().setFromObject(root);
          if (wbox.isEmpty()) return;
          var wsize = new THREE.Vector3(), wcenter = new THREE.Vector3();
          wbox.getSize(wsize);
          wbox.getCenter(wcenter);
          var ws = target / (Math.max(wsize.x, wsize.y, wsize.z) || 1);
          root.position.sub(wcenter.multiplyScalar(ws));
          root.scale.setScalar(ws);
          return;
        }
        if (!entries.length) return;

        // Measure the union AABB in the entity's own frame. The old code used
        // \`Box3.setFromObject\`, which is WORLD-axis-aligned and therefore
        // included #preview-entity's resting tilt and #spin-parent's live
        // rotation — so a model was scaled by its ROTATED hull (the teapot came
        // out ~19% undersized) and a dropped model's centring depended on
        // whatever spin phase it happened to load at.
        var box = new THREE.Box3();
        for (var i = 0; i < entries.length; i++) {
          var g0 = entries[i].node.geometry;
          if (!g0.boundingBox) g0.computeBoundingBox();
          if (g0.boundingBox) box.union(g0.boundingBox.clone().applyMatrix4(entries[i].m));
        }
        if (box.isEmpty()) return;
        var ext = new THREE.Vector3(), center = new THREE.Vector3();
        box.getSize(ext);
        box.getCenter(center);
        var s = target / (Math.max(ext.x, ext.y, ext.z) || 1);

        // N maps entity-frame coordinates to the normalized preview box, so
        // baking N·m into the ATTRIBUTES is what makes \`positionGeometry\` read
        // ±size/2 for a dropped model. Scaling the Object3D (what this used to
        // do) is invisible to the shader: positionGeometry is three's raw
        // position attribute, so every position-driven preset, built-in texture
        // and noise-node default was reading the model's authored units.
        var N = new THREE.Matrix4().makeScale(s, s, s)
          .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));

        for (var e = 0; e < entries.length; e++) {
          var node = entries[e].node;
          var bake = new THREE.Matrix4().multiplyMatrices(N, entries[e].m);
          // Clone rather than mutate: the same geometry may be reachable from
          // more than one node (and from outside this subtree).
          var g = node.geometry.clone();
          g.applyMatrix4(bake);
          // A mirrored ancestor transform reverses handedness — restore it so
          // the winding heuristic below and back-face culling both stay honest.
          if (bake.determinant() < 0) flipWinding(g);

          if (regen) {
            // Weld AFTER the bake so the 1e-4 quantization is a fixed fraction
            // of the preview box rather than of the model's authored units (on
            // a centimetre-scale scan it used to weld the mesh into a blob).
            g = mergeByPosition(g);
            g.computeVertexNormals();
            var pos = g.attributes.position;
            g.computeBoundingBox();
            var c = new THREE.Vector3();
            g.boundingBox.getCenter(c);
            // Detect inverted winding (e.g. the Stanford bunny OBJ uses CW
            // triangles, so computeVertexNormals produces inward-facing normals
            // and displacement pushes the surface *into* the mesh). Sample a
            // sparse set of vertices: if most have a normal pointing toward the
            // centroid, the winding is reversed — flip every triangle and
            // recompute.
            var nrm = g.attributes.normal;
            var inward = 0, sampled = 0;
            var step = Math.max(1, Math.floor(pos.count / 200));
            for (var sv = 0; sv < pos.count; sv += step) {
              var dx = pos.getX(sv) - c.x;
              var dy = pos.getY(sv) - c.y;
              var dz = pos.getZ(sv) - c.z;
              var dot = dx * nrm.getX(sv) + dy * nrm.getY(sv) + dz * nrm.getZ(sv);
              if (dot < 0) inward++;
              sampled++;
            }
            if (sampled > 0 && inward * 2 > sampled) {
              flipWinding(g);
              g.computeVertexNormals();
            }
            sphericalUVs(g, c);
          } else {
            // Preserve path (dropped GLB): keep authored normals/UVs, but a
            // glTF primitive is allowed to ship without a NORMAL accessor and
            // GLTFLoader does not synthesize one — an absent normal attribute
            // reads as garbage in \`normalLocal\`/\`normalWorld\` and lights the
            // whole model in any fresnel shader.
            if (!g.attributes.normal && g.attributes.position) g.computeVertexNormals();
            if (!g.attributes.uv && g.attributes.position) {
              g.computeBoundingBox();
              var c0 = new THREE.Vector3();
              g.boundingBox.getCenter(c0);
              sphericalUVs(g, c0);
            }
          }
          node.geometry = g;
        }

        // The transforms now live in the vertex data, so every local matrix in
        // the subtree (the root's included) must go to identity or they would
        // be applied a second time.
        root.traverse(function (node) {
          node.position.set(0, 0, 0);
          node.quaternion.set(0, 0, 0, 1);
          node.scale.set(1, 1, 1);
        });
        root.updateMatrixWorld(true);
      }
    });
  }
<\/script>`;

/**
 * `weld-verts` A-Frame component: welds coincident primitive vertices so
 * per-vertex displacement stays continuous across faces.
 *
 * BoxGeometry splits every face into its own 4 vertices (24 total) each
 * carrying that face's normal + UV. Normal-based displacement
 * (`positionLocal + normalLocal * h`) then drives the 3 coincident copies at
 * each corner along 3 different normals, so the faces visibly separate. Welding
 * collapses same-position vertices into one (with smooth, recomputed normals),
 * so the surface deforms as a single skin — the same merge `fit-bounds` does
 * for OBJ models.
 *
 * Only attached to primitive entities that actually displace, and only when the
 * output node's "Merge Vertices" displacement setting is on (default). It
 * re-welds on every geometry (re)build — the initial mesh plus subdivision /
 * geometry hot-swaps — via A-Frame's componentinitialized/componentchanged
 * events (plus a direct call in case geometry initialized first). UVs are
 * preserved (representative per welded vertex) so texture-driven shaders keep
 * working; a plane (no coincident verts) is left untouched.
 *
 * String literal so the iframe sees raw JS — no Vite transformation pass.
 */
const WELD_VERTS_SCRIPT = `<script>
  if (window.AFRAME && !AFRAME.components["weld-verts"]) {
    function weldByPosition(geom) {
      var pos = geom.attributes.position;
      if (!pos) return null;
      var uv = geom.attributes.uv;
      var oldIndex = geom.index;
      var precision = 1e4; // 4 decimal places
      var lookup = Object.create(null);
      var newPositions = [];
      var newUVs = uv ? [] : null;
      var remap = new Uint32Array(pos.count);
      var nextIndex = 0;
      for (var i = 0; i < pos.count; i++) {
        var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        var key = Math.round(x * precision) + "_" + Math.round(y * precision) + "_" + Math.round(z * precision);
        var idx = lookup[key];
        if (idx === undefined) {
          idx = nextIndex++;
          lookup[key] = idx;
          newPositions.push(x, y, z);
          if (newUVs) newUVs.push(uv.getX(i), uv.getY(i));
        }
        remap[i] = idx;
      }
      // Nothing coincident (e.g. a plane, or an already-welded grid) — leave the
      // geometry and its original attributes untouched.
      if (nextIndex === pos.count) return null;
      var indexCount = oldIndex ? oldIndex.count : pos.count;
      var Arr = nextIndex < 65535 ? Uint16Array : Uint32Array;
      var newIndex = new Arr(indexCount);
      if (oldIndex) {
        for (var j = 0; j < indexCount; j++) newIndex[j] = remap[oldIndex.getX(j)];
      } else {
        for (var k = 0; k < indexCount; k++) newIndex[k] = remap[k];
      }
      var merged = new THREE.BufferGeometry();
      merged.setAttribute("position", new THREE.BufferAttribute(new Float32Array(newPositions), 3));
      if (newUVs) merged.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(newUVs), 2));
      merged.setIndex(new THREE.BufferAttribute(newIndex, 1));
      merged.computeVertexNormals();
      merged.userData.__welded = true;
      return merged;
    }

    AFRAME.registerComponent("weld-verts", {
      init: function () {
        this.weld = this.weld.bind(this);
        var self = this;
        var onGeom = function (e) { if (e.detail && e.detail.name === "geometry") self.weld(); };
        // componentinitialized covers the case where the geometry component
        // inits after this one; componentchanged covers subdivision / geometry
        // hot-swaps; the direct call covers geometry already being built.
        this.el.addEventListener("componentinitialized", onGeom);
        this.el.addEventListener("componentchanged", onGeom);
        this.weld();
      },
      weld: function () {
        var mesh = this.el.getObject3D("mesh");
        if (!mesh || !mesh.geometry) return;
        var g = mesh.geometry;
        // Already our welded copy — nothing to do (guards against re-welding
        // when unrelated components change).
        if (g.userData && g.userData.__welded) return;
        var welded = weldByPosition(g);
        if (!welded) {
          // Mark so we don't rescan the same original every componentchanged.
          g.userData.__welded = true;
          return;
        }
        mesh.geometry = welded;
        // Dispose only geometries WE created; the geometry component owns and
        // disposes the originals it builds.
        if (this._welded) this._welded.dispose();
        this._welded = welded;
      },
      remove: function () {
        if (this._welded) { this._welded.dispose(); this._welded = null; }
      }
    });
  }
<\/script>`;

/**
 * Error overlay plumbing. Must be the FIRST script in the document so its
 * hooks exist while the vendored bundles load and while the shader module
 * fetch/import/build runs.
 *
 * Channels that end up in the `#error` div:
 *   - uncaught errors + unhandled promise rejections
 *   - `console.error` (mirrored — the shaderloader reports module
 *     fetch/import/build failures via console.error, and three's WebGPU
 *     backend logs pipeline/validation errors the same way)
 *   - `shader-error` events emitted by the shaderloader (structured message,
 *     fires after its console.error so the cleaner text wins the overlay)
 * A successful apply emits `shader-applied`, which clears the overlay — so
 * boot-time noise or a failure fixed by a later re-apply doesn't stick.
 *
 * The `#error` div lives in `<body>`, which isn't parsed yet when this runs —
 * messages are queued until DOMContentLoaded. Events bubble, so listening on
 * `window` needs no scene/entity reference.
 */
const ERROR_OVERLAY_SCRIPT = `<script>
  (function () {
    // One current message + its stickiness. The #error div may not be parsed
    // yet when an error arrives (this script runs first in <head>), so the
    // state lives here and render() re-applies it whenever possible.
    // "Sticky" marks resource-load failures (vendored script 404s): a later
    // successful shader apply must NOT clear those — the failure still
    // matters (e.g. dead orbit controls) even though the shader works.
    var current = null;
    function errEl() { return document.getElementById("error"); }
    function render() {
      try {
        var el = errEl();
        if (el) el.textContent = current ? current.msg : "";
      } catch (e) {}
    }
    function show(msg, sticky) {
      try {
        // A sticky (resource-load) failure is the root cause — don't let
        // downstream consequences (AFRAME undefined, muted script errors)
        // displace it.
        if (current && current.sticky && !sticky) return;
        msg = String(msg == null ? "Unknown error" : msg).slice(0, 2000);
        current = { msg: msg, sticky: !!sticky };
        render();
        // Tell the parent an error is on screen. A failed shader never reaches
        // the fs:preview-ready handshake (checkShaderReady polls for bound
        // uniforms and simply gives up), so this is the parent's only signal to
        // drop the "Compiling shader…" overlay — otherwise it would cover the
        // very message the user needs to read.
        try {
          window.parent.postMessage({ type: "fs:preview-error", message: msg }, "*");
        } catch (e) {}
      } catch (e) {}
    }
    window.__fsShowError = function (msg) { show(msg, false); };
    window.__fsShowStickyError = function (msg) { show(msg, true); };
    window.__fsClearError = function () {
      if (current && current.sticky) return;
      current = null;
      render();
    };
    document.addEventListener("DOMContentLoaded", render);
    window.addEventListener("error", function (ev) {
      var m = ev && ((ev.error && ev.error.message) || ev.message);
      if (!m) return;
      // Cross-origin scripts (the vendored bundles, from the opaque srcdoc
      // origin's perspective) report muted "Script error." with no detail.
      // When a real message is already recorded (e.g. the script tag's own
      // onerror), don't let the mute overwrite the root cause.
      if (/^Script error\\.?$/.test(String(m)) && current) return;
      show("Error: " + m, false);
    });
    window.addEventListener("unhandledrejection", function (ev) {
      var r = ev && ev.reason;
      show("Error: " + ((r && r.message) || String(r || "Shader load failed")), false);
    });
    var origError = console.error;
    console.error = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          parts.push(a instanceof Error ? (a.message || String(a)) : String(a));
        }
        show(parts.join(" "), false);
      } catch (e) {}
      return origError.apply(console, arguments);
    };
    window.addEventListener("shader-error", function (ev) {
      var d = ev && ev.detail;
      show("Shader error: " + ((d && d.message) || "failed to apply"), false);
    });
    window.addEventListener("shader-applied", function () { window.__fsClearError(); });
  })();
<\/script>`;

/**
 * Iframe ↔ parent bridge: shader uniform readiness + camera persistence.
 *
 * - Shader uniforms: poll for the shaderloader's `_propertyUniforms` (it's
 *   populated asynchronously after fetch/import/extendSchema), announce
 *   readiness, listen for direct value updates. We mutate `.value` directly
 *   — going through setAttribute round-trips through A-Frame's component
 *   data layer for no benefit.
 *
 * - Camera persistence: if the parent passed a saved position, apply it
 *   AFTER orbit-controls initializes — and only after, so the controls'
 *   internal `position0` snapshot remains the original `0 0 8` and `reset()`
 *   snaps back to home, not to the saved view.
 *
 * `__SAVED_CAM__` is replaced with a JSON literal at emit time.
 */
const BRIDGE_SCRIPT_TEMPLATE = `<script>
  window.__savedCameraPos = __SAVED_CAM__;
  // Deferred until the WebGPU pre-flight injects the <a-scene> (scene-slot
  // script in buildPreviewHTML) — every element ref below is captured at
  // callback time, so the scene must exist first.
  __fsWhenSceneBooted(function() {
    var entity = document.getElementById("preview-entity");
    var spinEl = document.getElementById("spin-parent");
    var camEl = document.querySelector("[camera]");

    // A fresh boot can record a stale/zero canvas size (the srcdoc swap can
    // land while the host pane is mid-layout), leaving the scene unpainted
    // until something re-runs renderer.setSize — the "preview is blank until
    // I resize the pane" bug. Re-run A-Frame's resize path a few times while
    // the async WebGPU init settles; when the recorded size already matches,
    // setSize dedupes and these are no-ops.
    var sceneEl = document.querySelector("a-scene");
    function kickResize() {
      try {
        if (sceneEl && typeof sceneEl.resize === "function") sceneEl.resize();
        else window.dispatchEvent(new Event("resize"));
      } catch (e) {}
    }
    function scheduleResizeKicks() {
      kickResize();
      setTimeout(kickResize, 250);
      setTimeout(kickResize, 1000);
      setTimeout(kickResize, 2500);
    }
    if (sceneEl) {
      if (sceneEl.hasLoaded) scheduleResizeKicks();
      else sceneEl.addEventListener("loaded", scheduleResizeKicks);
    }

    var shaderRetries = 0;
    function checkShaderReady() {
      var comp = entity && entity.components && entity.components.shader;
      if (comp && comp._propertyUniforms) {
        try {
          window.parent.postMessage({
            type: "fs:preview-ready",
            uniforms: Object.keys(comp._propertyUniforms)
          }, "*");
        } catch (e) {}
        return;
      }
      if (shaderRetries++ < 200) setTimeout(checkShaderReady, 50);
    }
    checkShaderReady();

    var camRetries = 0;
    function whenOrbitReady(cb) {
      var oc = camEl && camEl.components && camEl.components["orbit-controls"];
      if (oc && oc.controls) { cb(oc); return; }
      if (camRetries++ < 200) setTimeout(function() { whenOrbitReady(cb); }, 50);
    }
    whenOrbitReady(function(oc) {
      // The orbit-controls component attaches THREE.OrbitControls to
      // \`el.getObject3D("camera")\` (the PerspectiveCamera child), not to the
      // entity's own object3D group. Reading/writing \`camEl.object3D.position\`
      // manipulates the wrapper group (which never moves) — so both restore
      // and polling must go through the camera child.
      var getCam = function() { return camEl && camEl.getObject3D && camEl.getObject3D("camera"); };
      var saved = window.__savedCameraPos;
      var cam = getCam();
      if (saved && cam) {
        cam.position.set(saved.x, saved.y, saved.z);
        try { oc.controls.update(); } catch (e) {}
      }
      var lx = NaN, ly = NaN, lz = NaN;
      setInterval(function() {
        var c = getCam();
        var p = c && c.position;
        if (p && (p.x !== lx || p.y !== ly || p.z !== lz)) {
          lx = p.x; ly = p.y; lz = p.z;
          try {
            window.parent.postMessage({ type: "fs:camera", x: p.x, y: p.y, z: p.z }, "*");
          } catch (e) {}
        }
      }, 200);
    });

    // Rotation polling runs independently of orbit controls — the spin
    // parent's object3D is available as soon as A-Frame initializes the entity.
    var rx = NaN, ry = NaN, rz = NaN;
    setInterval(function() {
      var r = spinEl && spinEl.object3D && spinEl.object3D.rotation;
      if (!r) return;
      var dx = r.x * 180 / Math.PI;
      var dy = r.y * 180 / Math.PI;
      var dz = r.z * 180 / Math.PI;
      if (dx !== rx || dy !== ry || dz !== rz) {
        rx = dx; ry = dy; rz = dz;
        try {
          window.parent.postMessage({ type: "fs:rotation", x: dx, y: dy, z: dz }, "*");
        } catch (e) {}
      }
    }, 200);

    // ── Hot-update helpers ────────────────────────────────────────────────
    //
    // Each handler below mutates one piece of scene state without an iframe
    // rebuild. We do this because under sandbox=allow-scripts (no
    // allow-same-origin) each iframe reload gets a new opaque origin, and
    // Chrome's cache partitioning means the ~1MB A-Frame bundle + workers
    // re-fetch + re-parse on every reload. Pushing appearance changes
    // (bg color, lights, geometry, animate toggle) through postMessage
    // keeps the existing document live so the user sees sub-frame updates
    // instead of a full re-init.
    //
    // Each handler is *idempotent*: it tracks the last-applied payload key
    // (seeded from the baked-in initial HTML state) and skips if the new
    // payload matches. This is required for correctness, not just perf —
    // React StrictMode double-fires the parent's mount useEffects in
    // development, and even without StrictMode a useEffect runs once on
    // mount with the value that's already baked into the HTML. Without
    // skip-if-same the duplicate post on mount re-applies the geometry
    // attribute (recreating the THREE.Mesh) and re-creates all the
    // <a-light> nodes (forcing a WebGPU pipeline recompile) right while
    // shaderloader's first applyTSLShader is still mid-fetch, leaving
    // the mesh on a fallback red material until something else triggers
    // an iframe rebuild.
    //
    // The parent still rebuilds the iframe for structural changes
    // (previewCode, materialSettings) where a new shader module is needed.

    var __lastBgKey = __INITIAL_BG_KEY__;
    function __applyBgColor(color) {
      var key = String(color);
      if (key === __lastBgKey) return;
      __lastBgKey = key;
      var scene = document.querySelector("a-scene");
      if (scene) scene.setAttribute("background", "color: " + color);
    }

    var __lastLightingKey = __INITIAL_LIGHTING_KEY__;
    function __applyLighting(lights) {
      var key = JSON.stringify(lights || []);
      if (key === __lastLightingKey) return;
      __lastLightingKey = key;
      var scene = document.querySelector("a-scene");
      if (!scene) return;
      var existing = scene.querySelectorAll("a-light");
      for (var i = 0; i < existing.length; i++) existing[i].parentNode.removeChild(existing[i]);
      for (var j = 0; j < lights.length; j++) {
        var spec = lights[j];
        var el = document.createElement("a-light");
        el.setAttribute("type", spec.type);
        el.setAttribute("color", spec.color);
        if (spec.position) el.setAttribute("position", spec.position);
        el.setAttribute("intensity", String(spec.intensity));
        scene.appendChild(el);
      }
    }

    var __lastPlayingKey = __INITIAL_PLAYING_KEY__;
    function __applyPlaying(payload) {
      var key = JSON.stringify({ p: !!payload.playing, f: payload.from, t: payload.to });
      if (key === __lastPlayingKey) return;
      __lastPlayingKey = key;
      if (!spinEl) return;
      if (payload.playing) {
        spinEl.setAttribute(
          "animation",
          "property: rotation; from: " + payload.from +
          "; to: " + payload.to +
          "; loop: true; dur: 12000; easing: linear"
        );
      } else {
        var r = spinEl.object3D && spinEl.object3D.rotation;
        if (r) {
          var rx = r.x * 180 / Math.PI;
          var ry = r.y * 180 / Math.PI;
          var rz = r.z * 180 / Math.PI;
          spinEl.removeAttribute("animation");
          spinEl.setAttribute("rotation", rx + " " + ry + " " + rz);
        } else {
          spinEl.removeAttribute("animation");
        }
      }
    }

    var __lastGeometryKey = __INITIAL_GEOMETRY_KEY__;
    function __applyGeometry(payload) {
      var key = JSON.stringify({
        o: !!payload.isObj,
        m: payload.objModel || null,
        g: payload.geometry || null,
        r: payload.rotation || null,
      });
      if (key === __lastGeometryKey) return;
      __lastGeometryKey = key;
      if (!entity) return;
      if (payload.isObj) {
        entity.removeAttribute("geometry");
        entity.setAttribute("fit-bounds", payload.fitBounds || "size: 1.6");
        entity.setAttribute("obj-model", payload.objModel);
      } else {
        entity.removeAttribute("obj-model");
        entity.removeAttribute("fit-bounds");
        entity.setAttribute("geometry", payload.geometry);
        setTimeout(function() {
          var comp = entity.components && entity.components.shader;
          if (comp && typeof comp.applyShader === "function") {
            comp.applyShader();
          }
        }, 0);
      }
      if (payload.rotation) {
        entity.setAttribute("rotation", payload.rotation);
      }
    }

    window.addEventListener("message", function(e) {
      // Accept messages only from our parent document — both extra safety
      // and a guard against accidental fan-out from other embedded frames.
      if (e.source !== window.parent) return;
      var msg = e.data;
      if (!msg) return;
      if (msg.type === "fs:uniform") {
        var comp = entity && entity.components && entity.components.shader;
        if (!comp || !comp._propertyUniforms) return;
        var u = comp._propertyUniforms[msg.name];
        if (!u) return;
        // Colour uniforms hold a THREE.Color — assigning a hex string to
        // .value would replace the Color object with a string the renderer
        // can't read; .set() mutates it in place instead.
        if (u.value && u.value.isColor) {
          try { u.value.set(msg.value); } catch (err) { /* bad colour string — keep last */ }
        } else {
          u.value = msg.value;
        }
      } else if (msg.type === "fs:reset-camera") {
        var oc = camEl && camEl.components && camEl.components["orbit-controls"];
        if (oc && oc.controls && typeof oc.controls.reset === "function") {
          oc.controls.reset();
        }
      } else if (msg.type === "fs:bg-color") {
        __applyBgColor(msg.color);
      } else if (msg.type === "fs:lighting") {
        __applyLighting(msg.lights || []);
      } else if (msg.type === "fs:playing") {
        __applyPlaying(msg);
      } else if (msg.type === "fs:geometry") {
        __applyGeometry(msg);
      }
    });
  });
<\/script>`;

/**
 * Convert editor TSL code (with Fn wrapper) into a shaderloader-compatible
 * ES module that exports a default function returning shader node properties.
 *
 * Thin wrapper over the shared `buildShaderModule` so the live preview and the
 * `.js` export (tslToShaderModule) emit byte-identical shader logic — the only
 * difference being the export's usage-comment header. The preview auto-detects
 * property uniforms (no explicit `properties` list).
 */
function convertToShaderModule(
  tslCode: string,
  materialSettings?: MaterialSettings,
): string {
  return buildShaderModule(tslCode, { materialSettings });
}

export function tslToPreviewHTML(
  tslCode: string,
  options: PreviewOptions = {},
): string {
  const {
    animate = false,
    materialSettings,
    bgColor = '#808080',
    lighting = 'studio',
    subdivision = 64,
    initialCameraPosition = null,
    initialRotation = null,
    xr = false,
    title,
  } = options;
  const customModel = options.customModel ?? null;
  // A 'custom' geometry without its mesh descriptor can't render — degrade to
  // a sphere rather than emitting a modelless document (defensive; the
  // ShaderPreview UI gates the 'custom' option on a loaded mesh).
  const requestedGeometry = options.geometry ?? 'sphere';
  const geometry: GeometryType =
    requestedGeometry === 'custom' && !customModel ? 'sphere' : requestedGeometry;

  const shaderModule = convertToShaderModule(tslCode, materialSettings);
  const isModel = isModelGeometry(geometry);
  const isCustom = geometry === 'custom';
  // The dropped mesh's feed key: ties every model message to the document
  // built for exactly this mesh instance (see PreviewOptions.customModel.id).
  const customKey = isCustom && customModel ? `custom:${customModel.id}` : null;
  // Dropped OBJs get the full normals/UV regen (OBJLoader output is
  // non-indexed, like the built-ins); GLB/glTF keep their authored data.
  const customRegen = customModel?.kind === 'obj';
  const { iife, shaderloader, orbitControls } = getScriptUrls();

  // Weld coincident primitive vertices so displacement stays continuous across
  // faces (default on). Only relevant when the shader actually displaces —
  // `positionNode` in the emitted module is the tell — and only for primitives
  // (model files weld via fit-bounds' regen path instead). Attaching the
  // `weld-verts` component to the entity does the work; see WELD_VERTS_SCRIPT.
  const hasDisplacement = /positionNode\s*:/.test(shaderModule);
  const weldPrimitive =
    !isModel && hasDisplacement && materialSettings?.mergeVertices !== false;

  // Plane spins on its Z axis (in-plane, like a record), since the flat face
  // is already pointed at the camera. Everything else spins on Y like a turntable.
  //
  // The spin lives on a *parent* entity wrapping the shaded entity (see scene
  // markup below). The parent has no tilt of its own, so its local Y/Z is the
  // world Y/Z, and the animation cleanly tweens 0→360 with no end-of-loop snap.
  // If we instead applied this animation to the same entity that holds the
  // static tilt (e.g. `45 45 0`), A-Frame would interpolate componentwise from
  // the current value (`45 45 0`) to `to: 0 360 0` — flattening the X tilt
  // over the loop and only spinning Y by 315° before snapping back. That snap
  // is what produced the visible jump on every full rotation.
  // Build animation from/to, incorporating saved rotation so the spin
  // continues from where it left off across iframe rebuilds.
  const rawRot = initialRotation ?? { x: 0, y: 0, z: 0 };
  // Normalize to [0, 360) so values don't grow unboundedly across rebuilds
  const mod360 = (v: number) => ((v % 360) + 360) % 360;
  const savedRot = { x: mod360(rawRot.x), y: mod360(rawRot.y), z: mod360(rawRot.z) };
  const isPlane = geometry === 'plane';
  const animFrom = `${savedRot.x} ${savedRot.y} ${savedRot.z}`;
  const animTo = isPlane
    ? `${savedRot.x} ${savedRot.y} ${savedRot.z + 360}`
    : `${savedRot.x} ${savedRot.y + 360} ${savedRot.z}`;
  const spinAttr = animate
    ? ` animation="property: rotation; from: ${animFrom}; to: ${animTo}; loop: true; dur: 12000; easing: linear"`
    : (initialRotation ? ` rotation="${animFrom}"` : '');

  // Plane is meant to be viewed flat-on, so leave it un-rotated (it already
  // faces +Z, which is where the camera sits). OBJ models are normalized and
  // recentered on load, so we tilt them like the other primitives. The bunny
  // is shown upright (no tilt) since its silhouette reads better head-on.
  // Source-of-truth values live in GEOMETRY_ROTATIONS so the hot-update path
  // (postMessage fs:geometry) sets the same tilt without drifting.
  const rotationAttr = GEOMETRY_ROTATIONS[geometry] ?? '45 45 0';

  // Build the per-geometry entity attribute(s).
  // - Primitives: A-Frame `geometry` component with subdivision baked in.
  // - OBJ models: A-Frame `obj-model` component pointing at public/models/*,
  //   plus a custom `fit-bounds` component (registered below) that recenters
  //   and rescales the loaded mesh into a unit-ish bounding box so the camera
  //   framing matches the primitives.
  let entityAttrs: string;
  if (isModel) {
    // regen is ALWAYS explicit — podest.html registers a fit-bounds twin whose
    // schema default is the opposite (false), so relying on either default
    // would flip behavior in a future copy-paste between the two.
    const fitBoundsAttr = `fit-bounds="size: 1.6; regen: ${!isCustom || customRegen ? 'true' : 'false'}"`;
    if (xr) {
      // Top-level XR page: same-origin, CORS never applies — load directly.
      // Custom meshes use the parent-minted blob URL (same-origin here too).
      const url = isCustom
        ? customModel?.url ?? ''
        : getModelUrl(geometry as 'teapot' | 'bunny');
      const modelAttr = isCustom && customModel?.kind !== 'obj'
        ? `gltf-model="url(${url})"`
        : `obj-model="obj: url(${url})"`;
      entityAttrs = `${modelAttr} ${fitBoundsAttr}`;
    } else {
      // Sandboxed preview: the iframe's opaque origin makes a model fetch a
      // CORS request, and generic hosts don't answer it (gh-pages sends
      // ACAO:*, most others don't — deploy-only teapot/bunny breakage). No
      // network obj-model here: the PARENT supplies the model (built-ins are
      // fetched same-origin, dropped meshes come from memory) and posts it in
      // via fs:obj-model; the feed script below applies it as a blob: URL.
      // Until it arrives the entity has no mesh and the scene shows the bg
      // color, exactly like the old still-downloading state.
      entityAttrs = fitBoundsAttr;
    }
  } else {
    const geoAttr = buildGeoAttr(geometry as 'sphere' | 'cube' | 'plane', subdivision);
    entityAttrs = `geometry="${geoAttr}"${weldPrimitive ? ' weld-verts' : ''}`;
  }

  const lines: string[] = [];

  lines.push('<!DOCTYPE html>');
  lines.push('<html lang="en">');
  lines.push('<head>');
  lines.push('  <meta charset="UTF-8">');
  if (xr) {
    // XR mode: hide navigator.gpu BEFORE anything can read it (first head
    // script) so three r184 deterministically picks its WebXR-capable WebGL2
    // backend — see the `xr` option doc on PreviewOptions. Both the prototype
    // getter and the instance property are overridden, mirroring hideGpu in
    // the scene-boot pre-flight (some browsers expose gpu on
    // Navigator.prototype, where an instance define alone wouldn't stick).
    lines.push(`  <script>try{Object.defineProperty(Navigator.prototype,"gpu",{get:function(){return undefined;},configurable:true});}catch(e){}try{Object.defineProperty(navigator,"gpu",{value:undefined,configurable:true});}catch(e){}<${''}/script>`);
  }
  if (title) {
    lines.push(`  <title>${escapeHtml(title)}</title>`);
  }
  // Error overlay hooks early — they must be installed before the bundles
  // load and before any shader code runs. See ERROR_OVERLAY_SCRIPT.
  lines.push(ERROR_OVERLAY_SCRIPT);
  if (!xr) {
    // Neutralize WebXR BEFORE A-Frame loads. The editor preview is a desktop
    // render that never enters XR, but A-Frame 1.8.0 initializes its WebXR path
    // whenever `navigator.xr` is present — and on the Three.js r184 WebGPU backend
    // that init can throw "Cannot read properties of undefined (reading 'id')" and
    // abort the render, especially when a browser extension (e.g. the Immersive
    // Web Emulator) injects/overrides `navigator.xr`. Hiding it keeps A-Frame on
    // the plain desktop renderer. (The XR popup skips this — there navigator.xr
    // must stay visible, and the WebGL2 fallback avoids the broken init path.)
    lines.push(`  <script>try{Object.defineProperty(navigator,"xr",{value:undefined,configurable:true});}catch(e){}<${''}/script>`);
    // Drag/drop forwarding (same pattern as podest.html): this iframe covers
    // the whole preview body, so its document captures drag events over that
    // area and they never reach the parent — without preventDefault a drop
    // would even navigate the frame. Forward a drag SIGNAL and the dropped
    // File objects to the parent (ShaderPreview), which owns validation and
    // loading; the files never execute here. Installed BEFORE the heavy
    // bundle <script src> tags so an early drop is caught. The dragover
    // heartbeat (250ms) keeps the parent's overlay safety-timeout armed.
    lines.push('  <script>');
    lines.push('  (function () {');
    lines.push('    function toParent(m) { try { parent.postMessage(m, "*"); } catch (e) {} }');
    lines.push('    // Only FILE drags participate — internal drags (palette tiles, text');
    lines.push('    // selections) must neither raise the parent veil nor be intercepted.');
    lines.push('    function hasFiles(e) { var t = e.dataTransfer && e.dataTransfer.types; return !!t && Array.prototype.indexOf.call(t, "Files") !== -1; }');
    lines.push('    var depth = 0, lastBeat = 0, lastEvt = 0;');
    lines.push('    // dragenter/dragleave pairing is NOT guaranteed for a drag aborted');
    lines.push('    // with Esc or dropped outside the window — a stale depth would make');
    lines.push('    // every later leave under-count and stop the on:false signal forever.');
    lines.push('    // A fresh drag after >1s of drag-silence starts from depth 0.');
    lines.push('    function touch() { var t = Date.now(); if (t - lastEvt > 1000) depth = 0; lastEvt = t; }');
    lines.push('    addEventListener("dragenter", function (e) { if (!hasFiles(e)) return; e.preventDefault(); touch(); if (depth++ === 0) toParent({ type: "fs:preview-drag", on: true }); });');
    lines.push('    addEventListener("dragover", function (e) { if (!hasFiles(e)) return; e.preventDefault(); touch(); try { if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; } catch (err) {} var t = Date.now(); if (t - lastBeat > 250) { lastBeat = t; toParent({ type: "fs:preview-drag", on: true }); } });');
    lines.push('    addEventListener("dragleave", function (e) { if (!hasFiles(e)) return; e.preventDefault(); touch(); if (--depth <= 0) { depth = 0; toParent({ type: "fs:preview-drag", on: false }); } });');
    lines.push('    addEventListener("drop", function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; lastEvt = 0; var f = e.dataTransfer && e.dataTransfer.files ? Array.prototype.slice.call(e.dataTransfer.files) : []; toParent({ type: "fs:preview-drag", on: false }); if (f.length) toParent({ type: "fs:preview-drop", files: f }); });');
    lines.push('  })();');
    lines.push(`  <${''}/script>`);
  }
  // The onerror attributes route through __fsShowStickyError (never a direct
  // getElementById — these fire while <head> is still parsing, before the
  // #error div exists, so a direct lookup would null-deref). Sticky: a load
  // failure stays visible even if a shader later applies successfully.
  lines.push(`  <script src="${iife}" onerror="__fsShowStickyError('Failed to load A-Frame bundle')"><${''}/script>`);
  lines.push(`  <script src="${shaderloader}" onerror="__fsShowStickyError('Failed to load shaderloader')"><${''}/script>`);
  lines.push(`  <script src="${orbitControls}" onerror="__fsShowStickyError('Failed to load orbit controls')"><${''}/script>`);
  // SECURITY: dropped model files are adversarial input. A .gltf/.glb can
  // reference buffers or textures by ABSOLUTE http(s) URL — GLTFLoader
  // would fetch them, leaking the viewer's IP to an attacker-controlled
  // host (a CSP is not present in dev or desktop builds, so it cannot be
  // the control). Neutralized URLs land on an inert data: URL — the request
  // never leaves the page and the loader surfaces a normal parse error; a
  // console.warn records what was blocked. Same guard in podest.html.
  if (!xr) {
    // Sandboxed stage: everything it legitimately loads through THREE's
    // loading managers is a blob: URL minted inside the iframe or a data:
    // URI — allowlist exactly those.
    lines.push(`  <script>try{if(window.THREE&&THREE.DefaultLoadingManager&&THREE.DefaultLoadingManager.setURLModifier){THREE.DefaultLoadingManager.setURLModifier(function(u){var s=String(u);if(/^(blob:|data:)/i.test(s))return s;try{console.warn("[FastShaders] blocked non-blob resource URL:",s.slice(0,200));}catch(e){}return "data:application/octet-stream;base64,";});}}catch(e){}<${''}/script>`);
  } else {
    // XR popup: same-origin page with REAL network access — and the dropped
    // custom mesh is exactly as adversarial here as in the sandbox. Allowlist
    // blob:/data: PLUS this origin (the built-in teapot/bunny load by real
    // same-origin URL on this page); everything else is neutralized.
    lines.push(`  <script>try{if(window.THREE&&THREE.DefaultLoadingManager&&THREE.DefaultLoadingManager.setURLModifier){THREE.DefaultLoadingManager.setURLModifier(function(u){var s=String(u);if(/^(blob:|data:)/i.test(s))return s;try{if(new URL(s,window.location.href).origin===window.location.origin)return s;}catch(e){}try{console.warn("[FastShaders] blocked non-origin resource URL:",s.slice(0,200));}catch(e){}return "data:application/octet-stream;base64,";});}}catch(e){}<${''}/script>`);
  }
  lines.push('  <style>');
  // Body background matches the scene bg so the gap between document load
  // and the first WebGPU paint shows the chosen color, not a white flash.
  lines.push(`    html, body { margin: 0; padding: 0; overflow: hidden; width: 100%; height: 100%; background: ${bgColor}; }`);
  lines.push('    #error { position: absolute; top: 8px; left: 8px; right: 8px; color: #ff6b6b; font: 12px/1.4 monospace; white-space: pre-wrap; z-index: 10; pointer-events: none; }');
  if (xr) {
    // Bottom-center, not dead-center: it overlays a live canvas the user can
    // still orbit, so it must not sit on the previewed object.
    lines.push('    #vr-gate { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 11; padding: 14px 30px; font: 600 17px/1 system-ui, sans-serif; color: #fff; background: rgba(0,0,0,0.72); border: 1px solid rgba(255,255,255,0.35); border-radius: 10px; cursor: pointer; }');
    lines.push('    #vr-gate[hidden] { display: none; }');
  }
  lines.push('  </style>');
  lines.push('</head>');
  lines.push('<body>');
  lines.push('<div id="error"></div>');
  if (xr) {
    // Starts HIDDEN so it can't flash the wrong label before capability is
    // known; the auto-entry script reveals it and sets the text to "Enter VR"
    // or "Fullscreen" depending on what this device can actually do.
    lines.push('<button id="vr-gate" type="button" hidden>Enter VR</button>');
  }
  lines.push('');

  // Create shader blob URL before the scene is parsed
  lines.push('<script>');
  lines.push(`  var __shaderCode = ${JSON.stringify(shaderModule)};`);
  lines.push('  var __shaderBlob = new Blob([__shaderCode], { type: "text/javascript" });');
  lines.push('  window.__shaderUrl = URL.createObjectURL(__shaderBlob);');
  lines.push(`<${''}/script>`);
  lines.push('');

  // Register the fit-bounds component used by OBJ-backed previews. Inert for
  // primitive geometries — the component is only attached to OBJ entities.
  lines.push(FIT_BOUNDS_SCRIPT);
  lines.push('');

  // Register the in-headset stats panel. Attached via the <a-scene> attribute
  // below, so it only exists on the XR popup.
  if (xr) {
    lines.push(XR_STATS_SCRIPT);
    lines.push('');
  }

  // Register the weld-verts component used by displaced primitive previews.
  // Only attached (via entityAttrs) when weldPrimitive; inert otherwise.
  if (weldPrimitive) {
    lines.push(WELD_VERTS_SCRIPT);
    lines.push('');
  }

  // The <a-scene> is injected AFTER a WebGPU pre-flight instead of being
  // parsed statically: three r184 picks its WebGPU backend on
  // `navigator.gpu != null` ALONE (no adapter check), and Safari 26 exposes
  // navigator.gpu inside this sandboxed opaque-origin iframe while adapter
  // requests can still fail there — the renderer's async init then dies and
  // the preview stays blank forever, because the WebGL2 fallback only fires
  // when navigator.gpu is absent. Requesting a real adapter first (with a 2s
  // timeout against a hung requestAdapter) and hiding navigator.gpu when it
  // can't deliver makes three fall back to WebGL2 deterministically. Scripts
  // that need the scene run via __fsWhenSceneBooted.
  const sceneLines: string[] = [];
  // vr-mode-ui only in xr mode: A-Frame then renders its own Enter-VR button,
  // which is the immersive entry point for the popup page.
  // fs-xr-stats draws the in-headset frame-time/FPS panel (xr only — the
  // editor's sandboxed preview must not pay for it).
  sceneLines.push(`<a-scene vr-mode-ui="enabled: ${xr ? 'true' : 'false'}"${xr ? ' fs-xr-stats' : ''} loading-screen="enabled: false" background="color: ${bgColor}">`);
  sceneLines.push('  <a-entity camera="fov: 20; active: true" look-controls="enabled: false" orbit-controls="target: 0 0 0; minDistance: 2; maxDistance: 80; initialPosition: 0 0 8; rotateSpeed: 0.5"></a-entity>');
  // Parent holds the spin (so it tweens cleanly 0→360 on world Y/Z), child
  // holds the static tilt and the shader/geometry. The id stays on the child
  // because that's where the shader component lives (the bridge looks it up
  // by id), and `fit-bounds` needs the OBJ entity for `model-loaded`.
  sceneLines.push(`  <a-entity id="spin-parent"${spinAttr}>`);
  sceneLines.push(`    <a-entity id="preview-entity" ${entityAttrs} material="color: #808080" position="0 0 0" rotation="${rotationAttr}"></a-entity>`);
  sceneLines.push('  </a-entity>');

  // Emit the light rig from LIGHT_PRESETS so the initial HTML and the
  // postMessage hot-update path read the same source of truth.
  for (const light of LIGHT_PRESETS[lighting] ?? LIGHT_PRESETS.studio) {
    const attrs = [
      `type="${light.type}"`,
      `color="${light.color}"`,
      light.position ? `position="${light.position}"` : null,
      `intensity="${light.intensity}"`,
    ].filter(Boolean).join(' ');
    sceneLines.push(`  <a-light ${attrs}></a-light>`);
  }

  sceneLines.push('</a-scene>');

  lines.push('<div id="scene-slot"></div>');
  lines.push('<script>');
  lines.push(`  var __fsSceneHTML = ${JSON.stringify(sceneLines.join('\n'))};`);
  lines.push('  window.__fsSceneBooted = false;');
  lines.push('  window.__fsWhenSceneBooted = function (fn) {');
  lines.push('    if (window.__fsSceneBooted) { fn(); return; }');
  lines.push('    window.addEventListener("fs:scene-booted", fn, { once: true });');
  lines.push('  };');
  lines.push('  (function () {');
  lines.push('    function boot() {');
  lines.push('      document.getElementById("scene-slot").innerHTML = __fsSceneHTML;');
  lines.push('      window.__fsSceneBooted = true;');
  lines.push('      window.dispatchEvent(new Event("fs:scene-booted"));');
  lines.push('      // Watchdog: a WebGPU DEVICE-level failure (healthy adapter, dead');
  lines.push('      // device) still white-screens — surface it instead of staying silent.');
  lines.push('      setTimeout(function () {');
  lines.push('        var s = document.querySelector("a-scene");');
  lines.push('        if (s && !s.renderStarted) {');
  lines.push('          __fsShowStickyError("3D preview failed to start: the " + (navigator.gpu ? "WebGPU" : "WebGL2") + " renderer never began rendering. Reload to retry.");');
  lines.push('        }');
  lines.push('      }, 6000);');
  lines.push('    }');
  lines.push('    function hideGpu() {');
  lines.push('      try { Object.defineProperty(Navigator.prototype, "gpu", { get: function () { return undefined; }, configurable: true }); } catch (e) {}');
  lines.push('      try { Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true }); } catch (e) {}');
  lines.push('    }');
  // three r184's WebGPU backend does not paint reliably on Apple's WebKit: an
  // adapter can be granted (so the pre-flight below keeps WebGPU) yet no frame
  // ever renders — a flat-color pane with no error, exactly the reported
  // symptom. WebKit's WebGL2 path (GLSLNodeBuilder) is solid and compiles TSL
  // identically, so force it there — the same move the XR popup makes. This must
  // cover ALL WebKit, not just desktop Safari: every browser on iOS/iPadOS is
  // WKWebView (Chrome/Firefox/Edge for iOS included), and iPadOS 13+ desktop-
  // mode reports as Macintosh. Vendor can be blanked by privacy settings, so
  // desktop Safari is matched by UA shape (WebKit, no Chromium/Gecko token).
  lines.push('    function __fsForceWebGL2() {');
  lines.push('      var ua = navigator.userAgent || "";');
  lines.push('      if (/iPad|iPhone|iPod/.test(ua)) return true;');
  lines.push('      if (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1) return true;');
  lines.push('      if (/Chrome|Chromium|CriOS|FxiOS|Edg|EdgiOS|OPR|OPiOS|SamsungBrowser|Firefox|Android/.test(ua)) return false;');
  lines.push('      return /Safari|AppleWebKit/.test(ua);');
  lines.push('    }');
  lines.push('    if (__fsForceWebGL2()) { hideGpu(); boot(); return; }');
  lines.push('    if (!navigator.gpu) { boot(); return; }');
  lines.push('    var settled = false;');
  lines.push('    function go(adapter) {');
  lines.push('      if (settled) return;');
  lines.push('      settled = true;');
  lines.push('      if (!adapter) hideGpu();');
  lines.push('      boot();');
  lines.push('    }');
  lines.push('    try {');
  lines.push('      Promise.resolve(navigator.gpu.requestAdapter()).then(go, function () { go(null); });');
  lines.push('    } catch (e) { go(null); }');
  lines.push('    setTimeout(function () { go(null); }, 2000);');
  lines.push('  })();');
  lines.push(`<${''}/script>`);
  lines.push('');

  if (isModel && !xr) {
    // Model feed for the sandboxed preview. The parent supplies the model
    // (built-in OBJs are fetched same-origin — CORS never applies to it;
    // dropped meshes come from the store's bytes) and posts fs:obj-model
    // after this iframe's load event; a blob: URL is same-origin inside the
    // sandbox (and allowed by connect-src blob:), so THREE's loader can fetch
    // it. The listener registers at TOP level — the parent's post can land
    // before the async WebGPU pre-flight boots the scene, so the payload is
    // held and applied via __fsWhenSceneBooted once the entity exists.
    // Rapid geometry switching rebuilds the iframe per model, so each
    // document accepts ONLY the model key it was built for (built-ins key on
    // the geometry name, dropped meshes on their custom:<id> identity) — a
    // late-resolving feed for the previous model can never apply here.
    lines.push('<script>');
    lines.push(`  var __fsExpectedObj = ${JSON.stringify(customKey ?? geometry)};`);
    lines.push(`  var __fsExpectedLabel = ${JSON.stringify(isCustom ? 'custom model' : geometry)};`);
    lines.push('  (function () {');
    lines.push('    var applied = false;');
    lines.push('    function apply(kind, payload) {');
    lines.push('      if (applied) return;');
    lines.push('      var entity = document.getElementById("preview-entity");');
    lines.push('      if (!entity) return;');
    lines.push('      applied = true;');
    lines.push('      // A model that fails to PARSE (corrupt bytes, DRACO/meshopt-compressed');
    lines.push('      // glTF — no decoder is bundled) must surface, not die in the console.');
    lines.push('      entity.addEventListener("model-error", function () {');
    lines.push('        __fsShowStickyError("Failed to load 3D model (" + __fsExpectedLabel + "): the file could not be parsed (corrupt, or a DRACO/meshopt-compressed glTF — not supported).");');
    lines.push('      });');
    lines.push('      var blob = kind === "glb" ? new Blob([payload], { type: "model/gltf-binary" }) : new Blob([payload]);');
    lines.push('      var url = URL.createObjectURL(blob);');
    lines.push('      if (kind === "glb" || kind === "gltf") entity.setAttribute("gltf-model", "url(" + url + ")");');
    lines.push('      else entity.setAttribute("obj-model", "obj: url(" + url + ")");');
    lines.push('    }');
    lines.push('    window.addEventListener("message", function (e) {');
    lines.push('      if (e.source !== window.parent) return;');
    lines.push('      var msg = e.data;');
    lines.push('      if (!msg || msg.geometry !== __fsExpectedObj) return;');
    lines.push('      if (msg.type === "fs:obj-model-error") {');
    lines.push('        // Sticky, like a vendored-script 404: a later successful shader');
    lines.push('        // apply must not clear it — there is still no mesh to shade.');
    lines.push('        __fsShowStickyError("Failed to load 3D model (" + __fsExpectedLabel + "): " + msg.message);');
    lines.push('        return;');
    lines.push('      }');
    lines.push('      if (msg.type !== "fs:obj-model") return;');
    lines.push('      // obj/gltf ride as text; glb as binary. Anything else is dropped.');
    lines.push('      var kind = msg.kind === "glb" || msg.kind === "gltf" ? msg.kind : "obj";');
    lines.push('      var payload = kind === "glb" ? msg.bytes : msg.text;');
    lines.push('      if (kind === "glb") {');
    lines.push('        if (!(payload instanceof ArrayBuffer) && !ArrayBuffer.isView(payload)) return;');
    lines.push('      } else if (typeof payload !== "string") return;');
    lines.push('      window.__fsWhenSceneBooted(function () { apply(kind, payload); });');
    lines.push('    });');
    lines.push('  })();');
    lines.push(`<${''}/script>`);
    lines.push('');
  }

  // Immersive entry. The VR button's promise is "press it and you're in VR",
  // and this gets as close as the platform allows: requestSession needs
  // transient user activation, and this document was produced by
  // window.open + document.write, so whether the opening click's activation
  // carries into it is browser-dependent (NOT verified on a headset here).
  //
  // So: attempt entry automatically, and keep a real in-document button as the
  // fallback — a gesture originating inside this document is what Quest
  // Browser reliably accepts (the same reason ShaderCarousel's bench-inout
  // keeps its start gate inside the iframe rather than adopting it into the
  // parent). The button stays visible until a session actually starts, so a
  // silently-never-resolving enterVR() can't strand the user with no way in.
  if (xr) {
    lines.push('<script>');
    lines.push('  __fsWhenSceneBooted(function () {');
    lines.push('    var scene = document.querySelector("a-scene");');
    lines.push('    var gate = document.getElementById("vr-gate");');
    lines.push('    if (!scene || !gate) return;');
    lines.push('    // One button, two meanings — whichever "as immersive as this');
    lines.push('    // device gets" means here: a headset enters an immersive session,');
    lines.push('    // a desktop goes fullscreen. Resolved once from real capability');
    lines.push('    // rather than a UA sniff, and the label always says which it is.');
    lines.push('    var supportsVR = false;');
    lines.push('    function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }');
    lines.push('    function refresh() { gate.textContent = supportsVR ? "Enter VR" : (isFullscreen() ? "Exit fullscreen" : "Fullscreen"); }');
    lines.push('    function enter() { try { return scene.enterVR(); } catch (e) { return null; } }');
    lines.push('    function toggleFullscreen() {');
    lines.push('      try {');
    lines.push('        if (isFullscreen()) {');
    lines.push('          var exit = document.exitFullscreen || document.webkitExitFullscreen;');
    lines.push('          if (exit) exit.call(document);');
    lines.push('        } else {');
    lines.push('          var el = document.documentElement;');
    lines.push('          var req = el.requestFullscreen || el.webkitRequestFullscreen;');
    lines.push('          if (req) req.call(el);');
    lines.push('        }');
    lines.push('      } catch (e) { /* denied (no activation / policy) — label is unchanged */ }');
    lines.push('    }');
    lines.push('    scene.addEventListener("enter-vr", function () { gate.hidden = true; });');
    lines.push('    scene.addEventListener("exit-vr", function () { gate.hidden = false; refresh(); });');
    lines.push('    document.addEventListener("fullscreenchange", refresh);');
    lines.push('    document.addEventListener("webkitfullscreenchange", refresh);');
    lines.push('    gate.addEventListener("click", function () { if (supportsVR) enter(); else toggleFullscreen(); });');
    lines.push('    // Only ever call enterVR when a REAL immersive-vr session is');
    lines.push('    // available. With no headset A-Frame falls into its magic-window');
    lines.push('    // fallback, which hides the entry affordances and leaves the page');
    lines.push('    // in a pseudo-VR state the user cannot get out of — worse than');
    lines.push('    // simply staying flat. Where that check fails the button stays,');
    lines.push('    // as the fullscreen toggle.');
    lines.push('    function autoEnter() {');
    lines.push('      var xr = navigator.xr;');
    lines.push('      gate.hidden = false;');
    lines.push('      if (!xr || typeof xr.isSessionSupported !== "function") { refresh(); return; }');
    lines.push('      xr.isSessionSupported("immersive-vr").then(function (ok) {');
    lines.push('        supportsVR = !!ok;');
    lines.push('        refresh();');
    lines.push('        if (!ok) return;');
    lines.push('        var p = enter();');
    lines.push('        // Rejected = no transient activation carried into this');
    lines.push('        // document; the button is showing, which is the way in.');
    lines.push('        if (p && typeof p.catch === "function") p.catch(function () {});');
    lines.push('      }).catch(function () { supportsVR = false; refresh(); });');
    lines.push('    }');
    lines.push('    refresh();');
    lines.push('    if (scene.hasLoaded) autoEnter();');
    lines.push('    else scene.addEventListener("loaded", autoEnter, { once: true });');
    lines.push('  });');
    lines.push(`<${''}/script>`);
    lines.push('');
  }

  // Set shader attribute once the scene (and thus the entity) exists.
  lines.push('<script>');
  lines.push('  __fsWhenSceneBooted(function () {');
  lines.push('    try {');
  lines.push('      document.getElementById("preview-entity").setAttribute("shader", "src: " + window.__shaderUrl);');
  lines.push('    } catch (e) {');
  lines.push('      console.error("[FastShaders Preview]", e);');
  lines.push('      var errEl = document.getElementById("error");');
  lines.push('      if (errEl) errEl.textContent = String(e);');
  lines.push('    }');
  lines.push('  });');
  lines.push(`<${''}/script>`);
  lines.push('');

  // Bridge: shader uniform overlay + camera/rotation persistence across iframe rebuilds.
  const savedCamLiteral = initialCameraPosition
    ? JSON.stringify({ x: initialCameraPosition.x, y: initialCameraPosition.y, z: initialCameraPosition.z })
    : 'null';

  // Seed each hot-update handler's last-applied key with the value baked
  // into the initial HTML. The parent posts these same values from its
  // mount useEffects (plus a duplicate under React StrictMode), and the
  // iframe must recognise them as no-ops so the geometry attribute, the
  // <a-light> list, etc. don't get rebuilt right while the shader's
  // first applyTSLShader is still mid-fetch.
  const lights = LIGHT_PRESETS[lighting] ?? LIGHT_PRESETS.studio;
  const initialBgKey = JSON.stringify(String(bgColor));
  const initialLightingKey = JSON.stringify(JSON.stringify(lights));
  const initialPlayingKey = JSON.stringify(JSON.stringify({ p: !!animate, f: animFrom, t: animTo }));
  const initialGeometryKey = JSON.stringify(JSON.stringify(
    isModel
      ? {
          o: true,
          // Dropped meshes key on their custom:<id> identity — the parent
          // never hot-swaps models (any model change rebuilds the iframe),
          // so the key only needs to be unique per document.
          m: isCustom
            ? customKey
            : `obj: url(${getModelUrl(geometry as 'teapot' | 'bunny')})`,
          g: null,
          r: rotationAttr,
        }
      : {
          o: false,
          m: null,
          g: buildGeoAttr(geometry as 'sphere' | 'cube' | 'plane', subdivision),
          r: rotationAttr,
        },
  ));

  lines.push(
    BRIDGE_SCRIPT_TEMPLATE
      .replace('__SAVED_CAM__', savedCamLiteral)
      .replace('__INITIAL_BG_KEY__', initialBgKey)
      .replace('__INITIAL_LIGHTING_KEY__', initialLightingKey)
      .replace('__INITIAL_PLAYING_KEY__', initialPlayingKey)
      .replace('__INITIAL_GEOMETRY_KEY__', initialGeometryKey),
  );
  lines.push('');

  lines.push('</body>');
  lines.push('</html>');
  lines.push('');

  return lines.join('\n');
}
