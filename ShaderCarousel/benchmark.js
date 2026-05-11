/* benchmark — cycles a single inverted-sphere through a shader playlist,
 * records every Nth frame, downloads JSON when the run completes.
 *
 * Pairs with `sphere-mover` (one 10s ping-pong per shader) and `tsl-shader`
 * (the FastShaders TSL loader extended with `side: back`).
 */

/* global AFRAME, THREE */

const PLAYLIST = [
  // 8 noise nodes (FastShaders core: perlin, perlinVec3, fbm, fbmVec3,
  //                cellNoise, voronoi, voronoiVec2, voronoiVec3)
  { name: "perlin",        category: "noise",   src: "./tsl/noise-perlin.js" },
  { name: "perlinVec3",    category: "noise",   src: "./tsl/noise-perlin-vec3.js" },
  { name: "fbm",           category: "noise",   src: "./tsl/noise-fbm.js" },
  { name: "fbmVec3",       category: "noise",   src: "./tsl/noise-fbm-vec3.js" },
  { name: "cellNoise",     category: "noise",   src: "./tsl/noise-cell.js" },
  { name: "voronoi",       category: "noise",   src: "./tsl/noise-voronoi.js" },
  { name: "voronoiVec2",   category: "noise",   src: "./tsl/noise-voronoi-vec2.js" },
  { name: "voronoiVec3",   category: "noise",   src: "./tsl/noise-voronoi-vec3.js" },
  // 8 texture groups (matches FastShaders builtinTextures.ts)
  { name: "polkaDots",      category: "texture", src: "./tsl/polka-dots.js" },
  { name: "grid",           category: "texture", src: "./tsl/grid.js" },
  { name: "tigerFur",       category: "texture", src: "./tsl/tiger-fur.js" },
  { name: "staticNoise",    category: "texture", src: "./tsl/static-noise.js" },
  { name: "crumpledFabric", category: "texture", src: "./tsl/crumpled-fabric.js" },
  { name: "gasGiant",       category: "texture", src: "./tsl/gas-giant.js" },
  { name: "marble",         category: "texture", src: "./tsl/marble.js" },
  { name: "wood",           category: "texture", src: "./tsl/wood.js" },
];

const CAPTURE_EVERY = 10; // record stats every Nth frame
const WARMUP_MS = 200;    // skip frames right after a shader swap (compile cost)

AFRAME.registerComponent("benchmark", {
  schema: {
    sphere: { type: "selector", default: "#sphere" },
    autostart: { type: "boolean", default: true },
  },

  init: function () {
    this.sphere = this.data.sphere;
    if (!this.sphere) {
      console.error("[benchmark] no sphere found via selector", this.data.sphere);
      return;
    }

    this.results = [];
    this.currentIdx = -1;
    this.currentEntry = null;
    this.currentFrames = null;
    this.shaderStartTime = 0;
    this.frameCounter = 0;
    this.lastFrameTime = 0;
    this.running = false;
    this.finished = false;

    this.onCycleComplete = this.onCycleComplete.bind(this);
    this.sphere.addEventListener("cycle-complete", this.onCycleComplete);

    this.createOverlay();

    if (this.data.autostart) {
      // Wait until A-Frame's renderer is up before starting (model-loaded fires
      // after geometry init, which we need for the first applyShader).
      const sceneEl = this.el.sceneEl;
      if (sceneEl.hasLoaded) {
        this.start();
      } else {
        sceneEl.addEventListener("loaded", () => this.start(), { once: true });
      }
    }
  },

  remove: function () {
    this.sphere.removeEventListener("cycle-complete", this.onCycleComplete);
  },

  start: function () {
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.advanceShader();
  },

  advanceShader: function () {
    this.currentIdx += 1;

    if (this.currentIdx >= PLAYLIST.length) {
      this.finish();
      return;
    }

    const entry = PLAYLIST[this.currentIdx];
    this.currentEntry = entry;
    this.currentFrames = [];
    this.shaderStartTime = performance.now();
    this.frameCounter = 0;
    this.lastFrameTime = this.shaderStartTime;

    this.updateOverlay(`[${this.currentIdx + 1}/${PLAYLIST.length}] ${entry.name}`);

    // Swap the shader. tsl-shader's `update` re-applies on src change.
    this.sphere.setAttribute("tsl-shader", { src: entry.src, side: "back" });

    // Kick the sphere mover. The first frame after this is when the cycle
    // begins; warmup window protects against compile/upload spikes.
    this.sphere.emit("start-cycle", null, false);
  },

  tick: function () {
    if (!this.running || !this.currentEntry) return;

    const now = performance.now();
    const elapsedShader = now - this.shaderStartTime;
    const deltaMs = now - this.lastFrameTime;
    this.lastFrameTime = now;
    this.frameCounter += 1;

    if (elapsedShader < WARMUP_MS) return;
    if (this.frameCounter % CAPTURE_EVERY !== 0) return;

    const z = this.sphere.object3D.position.z;
    const t = Math.min(1, elapsedShader / 10000);

    this.currentFrames.push({
      frame: this.frameCounter,
      elapsedMs: +elapsedShader.toFixed(2),
      deltaMs: +deltaMs.toFixed(3),
      fps: deltaMs > 0 ? +(1000 / deltaMs).toFixed(2) : 0,
      t: +t.toFixed(4),
      z: +z.toFixed(3),
    });
  },

  onCycleComplete: function () {
    if (!this.running) return;

    const frames = this.currentFrames ?? [];
    const fpsList = frames.map((f) => f.fps).filter((v) => v > 0);
    const summary = fpsList.length
      ? {
          totalFrames: this.frameCounter,
          capturedFrames: frames.length,
          avgFps: +(fpsList.reduce((a, b) => a + b, 0) / fpsList.length).toFixed(2),
          minFps: +Math.min(...fpsList).toFixed(2),
          maxFps: +Math.max(...fpsList).toFixed(2),
        }
      : { totalFrames: this.frameCounter, capturedFrames: 0 };

    this.results.push({
      name: this.currentEntry.name,
      category: this.currentEntry.category,
      src: this.currentEntry.src,
      durationMs: +(performance.now() - this.shaderStartTime).toFixed(2),
      summary,
      frames,
    });

    this.advanceShader();
  },

  finish: function () {
    this.running = false;
    this.finished = true;
    this.updateOverlay(`Done — ${this.results.length} shaders profiled. Downloading JSON…`);

    const renderer = this.el.sceneEl?.renderer;
    const backend = renderer?.backend;
    const xrEnabled = !!renderer?.xr?.enabled;
    // Cover all three setups the carousel might run under:
    //   - THREE.WebGLRenderer (IIFE bundle, default A-Frame pick) → isWebGLRenderer
    //   - THREE.WebGPURenderer with WebGPUBackend → backend.isWebGPUBackend
    //   - THREE.WebGPURenderer with forceWebGL: true → backend.isWebGLBackend
    const rendererKind = renderer?.isWebGLRenderer ? "WebGL"
                       : backend?.isWebGPUBackend ? "WebGPU"
                       : backend?.isWebGLBackend ? "WebGL"
                       : "unknown";

    const payload = {
      metadata: {
        startedAt: this.startedAt,
        completedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        captureEvery: CAPTURE_EVERY,
        warmupMs: WARMUP_MS,
        cycleDurationMs: 10000,
        sphereStartZ: -10,
        sphereCenterZ: 0,
        sphereRadius: 2.5,
        renderer: rendererKind,
        xrEnabled,
        inXR: !!renderer?.xr?.isPresenting,
        playlistLength: PLAYLIST.length,
      },
      shaders: this.results,
    };

    this.downloadJSON(payload);
    setTimeout(() => this.updateOverlay(`Done — ${this.results.length} shaders. JSON saved.`), 250);
  },

  downloadJSON: function (data) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `shader-carousel-benchmark-${ts}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  createOverlay: function () {
    const el = document.createElement("div");
    el.id = "benchmark-overlay";
    Object.assign(el.style, {
      position: "fixed",
      top: "12px",
      left: "12px",
      padding: "8px 12px",
      background: "rgba(0,0,0,0.6)",
      color: "#fff",
      font: "13px/1.3 -apple-system, system-ui, sans-serif",
      borderRadius: "6px",
      zIndex: "9999",
      pointerEvents: "none",
    });
    el.textContent = "Initializing…";
    document.body.appendChild(el);
    this.overlay = el;
  },

  updateOverlay: function (text) {
    if (this.overlay) this.overlay.textContent = text;
  },
});
