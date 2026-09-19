import { describe, it, expect, afterEach } from 'vitest';
import { MARCH_WINDOW_GEOMETRY, decoderAssetUrl, tslToPreviewHTML } from './tslToPreviewHTML';
import { LOADER_FILE } from './tslToShaderModule';
import { DECODER_FILES, MAX_DECODER_FILE_BYTES } from '@/utils/meshDecoders';
import { safeJsonReviver } from '@/utils/safeJson';
import vm from 'node:vm';
import { LoadingManager } from 'three/webgpu';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { loaderAvailable, makeLoaderSandbox, runLoaderIn } from '../shaderloaderHarness';

const TSL = `import { Fn, vec3 } from 'three/tsl';

const shader = Fn(() => {
  return vec3(1, 0, 0);
});

export default shader;
`;

// The <a-scene> markup is embedded as a JSON string literal (__fsSceneHTML),
// so attribute quotes appear escaped (\") in the emitted document.
const esc = (s: string) => s.replace(/"/g, '\\"');

describe('tslToPreviewHTML — sandboxed preview vs XR popup emission', () => {
  it('sandboxed sphere: no XR UI, navigator.xr hidden, no obj feed', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere' });
    expect(html).toContain(esc('vr-mode-ui="enabled: false"'));
    expect(html).toContain('Object.defineProperty(navigator,"xr"');
    expect(html).not.toContain('fs:obj-model');
    expect(html).not.toContain('obj-model=');
  });

  it('sandboxed bunny: NO network obj-model (opaque-origin CORS trap), postMessage feed instead', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'bunny' });
    // The broken deploy path: obj-model="obj: url(https://…)" fetched from the
    // sandbox's opaque origin is a CORS request generic hosts don't answer.
    expect(html).not.toContain(esc('obj-model="obj: url('));
    // regen is explicit (podest's fit-bounds twin defaults the OPPOSITE way).
    expect(html).toContain(esc('fit-bounds="size: 1.6; regen: true"'));
    // Stale-model guard: each rebuilt iframe accepts only its own geometry.
    expect(html).toContain('var __fsExpectedObj = "bunny";');
    expect(html).toContain('msg.type === "fs:obj-model-error"');
    expect(html).toContain('URL.createObjectURL(blob)');
  });

  it('teapot: tessellated in-document by teapot-mesh at the slider resolution — no model feed at all', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'teapot', subdivision: 24 });
    expect(html).toContain(esc('teapot-mesh="resolution: 24"'));
    // fit-bounds only BAKES: the mesh already carries analytic normals and the
    // Utah atlas, and the regen path's spherical projection would overwrite it.
    expect(html).toContain(esc('fit-bounds="size: 1.6; regen: false"'));
    expect(html).toContain('registerComponent("teapot-mesh"');
    // Attribute-level: the entity carries no model loader (the scripts still
    // MENTION obj-model, since a hot-swap away from a model removes it).
    expect(html).not.toContain(esc('obj-model="'));
    expect(html).not.toContain('fs:obj-model');
    expect(html).not.toContain('__fsExpectedObj');
    // The default subdivision is the teapot's default resolution.
    expect(tslToPreviewHTML(TSL, { geometry: 'teapot' })).toContain(esc('teapot-mesh="resolution: 64"'));
    // The app-wide ceiling, and the floor, hold for the teapot too.
    expect(tslToPreviewHTML(TSL, { geometry: 'teapot', subdivision: 300 })).toContain(esc('teapot-mesh="resolution: 128"'));
    expect(tslToPreviewHTML(TSL, { geometry: 'teapot', subdivision: 0 })).toContain(esc('teapot-mesh="resolution: 1"'));
  });

  it('the teapot script is in EVERY document, so a primitive can hot-swap into the teapot', () => {
    for (const geometry of ['sphere', 'cube', 'plane', 'bunny'] as const) {
      expect(tslToPreviewHTML(TSL, { geometry })).toContain('registerComponent("teapot-mesh"');
    }
  });

  it('primitive segments are clamped to the same 128 ceiling as the slider', () => {
    expect(tslToPreviewHTML(TSL, { geometry: 'sphere', subdivision: 256 })).toContain('segmentsWidth: 128; segmentsHeight: 128');
    expect(tslToPreviewHTML(TSL, { geometry: 'cube', subdivision: 999 })).toContain('segmentsDepth: 128');
  });

  it('sandboxed custom glb: gltf-model feed keyed on the mesh id, regen off, loader URL allowlist on', () => {
    const html = tslToPreviewHTML(TSL, {
      geometry: 'custom',
      customModel: { kind: 'glb', id: 7 },
    });
    expect(html).toContain(esc('fit-bounds="size: 1.6; regen: false"'));
    expect(html).toContain('var __fsExpectedObj = "custom:7";');
    expect(html).toContain('entity.setAttribute("gltf-model"');
    // No network model URL — bytes arrive via the postMessage feed only.
    expect(html).not.toContain(esc('gltf-model="url('));
    // SECURITY: hostile .gltf external-URI refs are neutralized at the loader.
    expect(html).toContain('setURLModifier');
  });

  it('sandboxed custom obj: keeps the regen path of the built-ins', () => {
    const html = tslToPreviewHTML(TSL, {
      geometry: 'custom',
      customModel: { kind: 'obj', id: 3 },
    });
    expect(html).toContain(esc('fit-bounds="size: 1.6; regen: true"'));
    expect(html).toContain('var __fsExpectedObj = "custom:3";');
  });

  it('custom without a mesh descriptor degrades to a sphere document', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'custom' });
    expect(html).toContain(esc('geometry="primitive: sphere'));
    expect(html).not.toContain('__fsExpectedObj');
  });

  it('every MODEL geometry carries the animation mixer; no primitive does', () => {
    // A-Frame core ships no animation-mixer, so without this component a glTF's
    // clips are parsed by gltf-model and then simply never read — the model
    // loads in its rest pose and looks broken rather than static-by-choice.
    for (const opts of [
      { geometry: 'bunny' as const },
      { geometry: 'custom' as const, customModel: { kind: 'glb' as const, id: 7 } },
      { geometry: 'custom' as const, customModel: { kind: 'obj' as const, id: 3 } },
      { geometry: 'custom' as const, customModel: { kind: 'glb' as const, id: 9 }, xr: true, url: '' },
    ]) {
      const html = tslToPreviewHTML(TSL, opts);
      expect(html).toContain('AFRAME.registerComponent("gltf-anim"');
      expect(html).toContain(esc('gltf-anim'));
    }
    // Primitives never load a model, so they pay for none of it — and neither
    // does the teapot, which is tessellated in-document and has no clips.
    for (const geometry of ['sphere', 'cube', 'plane', 'teapot'] as const) {
      const html = tslToPreviewHTML(TSL, { geometry });
      expect(html).not.toContain('gltf-anim');
    }
  });

  it('xr custom glb: direct gltf-model blob url, no feed, origin-widened URL allowlist', () => {
    const html = tslToPreviewHTML(TSL, {
      geometry: 'custom',
      customModel: { kind: 'glb', id: 2, url: 'blob:https://example/abc' },
      xr: true,
    });
    expect(html).toContain(esc('gltf-model="url(blob:https://example/abc)"'));
    expect(html).not.toContain('fs:obj-model');
    // SECURITY: the dropped mesh is adversarial in the XR popup too — it runs
    // at the app's REAL origin with network access, so the loader allowlist
    // must be present (blob:/data: plus same-origin for built-in models).
    expect(html).toContain('setURLModifier');
    expect(html).toContain('window.location.origin');
  });

  it('xr teapot: the same in-document teapot-mesh the pane shows — the popup renders what the pane renders', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'teapot', xr: true, subdivision: 40 });
    expect(html).toContain(esc('teapot-mesh="resolution: 40"'));
    expect(html).toContain('registerComponent("teapot-mesh"');
    expect(html).not.toContain(esc('obj-model="'));
  });

  it('xr bunny: direct obj-model url, backend forced via renderer attribute, xr NOT hidden, VR UI on, escaped title', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'bunny', xr: true, title: 'My <"Shader">' });
    expect(html).toContain(esc('obj-model="obj: url('));
    expect(html).toContain(esc('vr-mode-ui="enabled: true"'));
    expect(html).not.toContain('Object.defineProperty(navigator,"xr"');
    expect(html).not.toContain('fs:obj-model');
    expect(html).toContain('<title>My &lt;&quot;Shader&quot;&gt;</title>');
    // The backend is forced DECLARATIVELY: the scene tag carries the bundle's
    // aframe#5847 backend property (aframeBackendProperty.test.ts guards the
    // patch and its exact spelling). The old gpu-hiding script and the
    // adapter pre-flight must both be gone — the popup boots immediately.
    expect(html).toContain(esc('renderer="backend: webgl"'));
    expect(html).not.toContain('Navigator.prototype');
    expect(html).not.toContain('requestAdapter');
  });

  /**
   * The parent bridge is emitted into BOTH documents, but in the XR popup
   * `window.parent === window`, so its reporting half has nobody to talk to:
   * the handshake, both 200 ms pollers and the hot-update listener would post
   * to the popup's own queue — and the listener's `e.source !== window.parent`
   * check cannot filter a self-post, because it genuinely passes. In a session
   * three decomposes the XR pose into camera.position every frame, so the
   * camera poller alone reports on essentially every tick.
   *
   * Two blocks must SURVIVE in the popup: the saved-camera restore (it is what
   * frames the view) and the resize kicks.
   */
  it('xr: the bridge reports nothing to itself, but keeps the restore and resize kicks', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere', xr: true, initialCameraPosition: { x: 1, y: 2, z: 3 } });
    // All four self-post sites guarded on being a real child document.
    expect(html).toContain('if (window.parent !== window) checkShaderReady();');
    expect(html).toContain('if (window.parent === window) return;');
    expect(html).toContain('if (window.parent !== window) setInterval(function() {');
    expect(html).toContain('if (window.parent !== window) window.addEventListener("message"');
    // The survivors.
    expect(html).toContain('function scheduleResizeKicks()');
    expect(html).toContain('cam.position.set(saved.x, saved.y, saved.z);');
    expect(html).toContain('window.__savedCameraPos = {"x":1,"y":2,"z":3};');
  });

  it('sandbox: the same guards are present and are all satisfied there', () => {
    // The sandboxed preview IS a child document, so every guard evaluates true
    // and its behaviour is unchanged — the guards are emitted identically.
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere' });
    expect(html).toContain('if (window.parent !== window) checkShaderReady();');
    expect(html).toContain('if (window.parent !== window) window.addEventListener("message"');
  });

  it('sandbox (non-xr): keeps the gpu pre-flight and never spells the backend attribute', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere' });
    // The sandbox preview deliberately KEEPS hideGpu + the adapter pre-flight:
    // its gpu-hiding serves Safari-no-paint / adapter-failure / the WGSL-GLSL
    // toggle, and the fs:backend report reads navigator.gpu as the truth —
    // renderer="backend: webgl" would silently break that label.
    expect(html).toContain('function hideGpu()');
    expect(html).toContain('requestAdapter');
    expect(html).not.toContain(esc('renderer="backend: webgl"'));
  });

  it('xr: emits the head-locked stats panel + the immersive entry gate', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere', xr: true });
    expect(html).toContain('fs-xr-stats');
    expect(html).toContain('AFRAME.registerComponent("fs-xr-stats"');
    // Head-locked ONLY via the camera OBJECT — a child entity world-locks in XR.
    expect(html).toContain('getObject3D("camera")');
    // Offline: canvas texture, never A-Frame text (which fetches a CDN font).
    expect(html).toContain('CanvasTexture');
    expect(html).not.toContain('<a-text');
    // Auto-enter with a real in-document button as the activation fallback.
    expect(html).toContain('id="vr-gate"');
    expect(html).toContain('scene.enterVR()');
  });

  it('xr: the entry button falls back to fullscreen when immersive-vr is unsupported', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere', xr: true });
    // Capability-resolved, never a UA sniff.
    expect(html).toContain('isSessionSupported("immersive-vr")');
    expect(html).toContain('requestFullscreen');
    expect(html).toContain('webkitRequestFullscreen');
    // The label must state which of the two the click will do.
    expect(html).toContain('"Enter VR"');
    expect(html).toContain('"Fullscreen"');
    expect(html).toContain('"Exit fullscreen"');
  });

  it('non-xr preview carries neither the stats panel nor the VR gate', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere' });
    expect(html).not.toContain('fs-xr-stats');
    expect(html).not.toContain('vr-gate');
  });

  it('xr sphere: keeps the primitive geometry attribute', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere', xr: true });
    expect(html).toContain(esc('geometry="primitive: sphere'));
    expect(html).toContain(esc('vr-mode-ui="enabled: true"'));
  });
});

describe('tslToPreviewHTML — the WGSL/GLSL backend toggle', () => {
  it('defaults to auto: user-force flag false, ahead of the platform rule', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere' });
    expect(html).toContain('var __FS_USER_FORCE_WEBGL2 = false;');
    // The user branch runs BEFORE the platform rule (a forced document must
    // not depend on UA sniffing) and both precede the adapter pre-flight.
    const user = html.indexOf('if (__FS_USER_FORCE_WEBGL2) { hideGpu(); boot(); return; }');
    const platform = html.indexOf('if (__fsForceWebGL2()) { hideGpu(); boot(); return; }');
    expect(user).toBeGreaterThan(-1);
    expect(platform).toBeGreaterThan(user);
    // …and "precede the pre-flight" is pinned, not just asserted in prose: a
    // forced document must never schedule requestAdapter (double boot() via
    // the settled flag, or a 2s stall if the check moved inside go()).
    expect(platform).toBeLessThan(html.indexOf('requestAdapter'));
  });

  it('forceWebGL2 bakes the flag true without touching the extractable platform rule', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere', forceWebGL2: true });
    expect(html).toContain('var __FS_USER_FORCE_WEBGL2 = true;');
    // The drift-tested platform function must stay flag-free — the feedback
    // report evaluates its extracted source with a bare navigator stub, so a
    // flag reference inside it would throw there.
    const start = html.indexOf('function __fsForceWebGL2() {');
    const end = html.indexOf('\n    }', start);
    expect(html.slice(start, end)).not.toContain('__FS_USER_FORCE_WEBGL2');
  });

  it('the sandboxed document reports its booted backend; the XR popup does not', () => {
    const sandboxed = tslToPreviewHTML(TSL, { geometry: 'sphere' });
    expect(sandboxed).toContain('type: "fs:backend"');
    expect(sandboxed).toContain('backend: navigator.gpu ? "webgpu" : "webgl2"');
    // A top-level popup's parent is itself — the report is sandbox-only.
    const xr = tslToPreviewHTML(TSL, { geometry: 'sphere', xr: true });
    expect(xr).not.toContain('fs:backend');
  });
});

describe('tslToPreviewHTML — mesh decoders (loader 0.8 FastShaders.decoders)', () => {
  const customGlb = () => tslToPreviewHTML(TSL, { geometry: 'custom', customModel: { kind: 'glb', id: 7 } });
  const CONFIGURE = 'FastShaders.decoders.configure(';

  it('a sandboxed model document configures the decoders after the loader and before the scene', () => {
    for (const html of [customGlb(), tslToPreviewHTML(TSL, { geometry: 'bunny' })]) {
      const loader = html.indexOf(`${LOADER_FILE}"`);
      const configure = html.indexOf(CONFIGURE);
      expect(loader).toBeGreaterThan(-1);
      expect(configure).toBeGreaterThan(loader);
      expect(html.indexOf('__fsSceneHTML')).toBeGreaterThan(configure);
      // The resolver reads a NULL-PROTOTYPE table the model feed fills.
      expect(html).toContain('window.__fsDecoderUrls=Object.create(null);');
      expect(html).toContain('return window.__fsDecoderUrls[f]||null;');
      expect(html.split(CONFIGURE)).toHaveLength(2);
    }
  });

  it('primitive, teapot and march documents carry no decoder code at all', () => {
    for (const html of [
      tslToPreviewHTML(TSL, { geometry: 'sphere' }),
      tslToPreviewHTML(TSL, { geometry: 'teapot' }),
      tslToPreviewHTML(TSL, { geometry: MARCH_WINDOW_GEOMETRY, marchWindow: 2 }),
      tslToPreviewHTML(TSL, { geometry: 'sphere', xr: true }),
    ]) {
      expect(html).not.toContain('FastShaders.decoders');
      expect(html).not.toContain('__fsDecoderUrls');
      expect(html).not.toContain('fillDecoders');
    }
  });

  it('the feed fills the table from the message BEFORE it sets gltf-model', () => {
    const html = customGlb();
    const fill = html.indexOf('if (dec) fillDecoders(dec);');
    expect(fill).toBeGreaterThan(-1);
    expect(fill).toBeLessThan(html.indexOf('if (kind === "glb" || kind === "gltf") entity.setAttribute("gltf-model"'));
    expect(html).toContain('var dec = msg.decoders && typeof msg.decoders === "object" ? msg.decoders : null;');
    expect(html).toContain('window.__fsWhenSceneBooted(function () { apply(kind, payload, dec); });');
  });

  it('the feed accepts exactly DECODER_FILES, each with its blob type, under the same cap', () => {
    const html = customGlb();
    const m = /var DEC_FILES = (\[.*?\]);/.exec(html);
    expect(m).toBeTruthy();
    const slots = JSON.parse(m![1], safeJsonReviver) as Array<[string, string]>;
    expect(slots.map((s) => s[0])).toEqual(Object.values(DECODER_FILES));
    expect(Object.fromEntries(slots)).toEqual({
      [DECODER_FILES.dracoWrapper]: 'text/javascript',
      [DECODER_FILES.dracoWasm]: 'application/wasm',
      [DECODER_FILES.meshopt]: 'text/javascript',
      [DECODER_FILES.basisJs]: 'text/javascript',
      [DECODER_FILES.basisWasm]: 'application/wasm',
    });
    // The type follows the SUFFIX, so a name added to DECODER_FILES cannot
    // arrive with the wrong one.
    for (const [name, type] of slots) {
      expect(type, name).toBe(name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    }
    expect(html).toContain(`var DEC_MAX = ${MAX_DECODER_FILE_BYTES};`);
  });

  it('a model-loaded reports the KTX2 transcode counts, once, clamped, to the parent', () => {
    const html = customGlb();
    expect(html).toContain('entity.addEventListener("model-loaded", function () {');
    expect(html).toContain('var st = window.FastShaders && FastShaders.decoders ? FastShaders.decoders.ktx2Stats : null;');
    expect(html).toContain('var fb = Math.min(Math.max(st.fallbacks | 0, 0), 1024);');
    expect(html).toContain('var ms = Math.min(Math.max(st.missing | 0, 0), 1024);');
    expect(html).toContain('if (fb <= 0 && ms <= 0) return;');
    expect(html).toContain(
      'window.parent.postMessage({ type: "fs:model-ktx2", geometry: __fsExpectedObj, fallbacks: fb, missing: ms }, "*");',
    );
    // Once per document, and never a throw out of a listener.
    expect(html).toContain('if (ktx2Reported) return;');
    expect(html).toContain('ktx2Reported = true;');
    // Sphere, teapot and march documents have no model feed at all.
    for (const other of [
      tslToPreviewHTML(TSL, { geometry: 'sphere' }),
      tslToPreviewHTML(TSL, { geometry: 'teapot' }),
      tslToPreviewHTML(TSL, { geometry: MARCH_WINDOW_GEOMETRY, marchWindow: 2 }),
    ]) {
      expect(other).not.toContain('fs:model-ktx2');
    }
  });

  it('a model-error names the decoder\'s own failure, and no longer calls compression unsupported', () => {
    const html = customGlb();
    expect(html).toContain('(decoderError() || "the file could not be parsed (corrupt, or compressed in a way FastShaders cannot decode).")');
    expect(html).toContain('return d && typeof d.lastError === "string" ? d.lastError : "";');
    expect(html).not.toContain('not supported).');
  });

  it('the XR popup configures explicit same-origin decoder URLs', () => {
    for (const customModel of [{ kind: 'glb' as const, id: 2, url: 'blob:https://example/abc' }, null]) {
      const html = tslToPreviewHTML(TSL, customModel
        ? { geometry: 'custom', customModel, xr: true }
        : { geometry: 'bunny', xr: true });
      const m = /var __fsDec=(\{.*?\});FastShaders\.decoders\.configure\(/.exec(html);
      expect(m).toBeTruthy();
      const urls = JSON.parse(m![1], safeJsonReviver) as Record<string, string>;
      expect(urls).toEqual(Object.fromEntries(Object.values(DECODER_FILES).map((f) => [f, decoderAssetUrl(f)])));
      expect(html).toContain('return Object.prototype.hasOwnProperty.call(__fsDec,f)?__fsDec[f]:null;');
      expect(html).not.toContain('__fsDecoderUrls');
      expect(html.indexOf(CONFIGURE)).toBeGreaterThan(html.indexOf(`${LOADER_FILE}"`));
    }
  });

  describe.skipIf(!loaderAvailable('0.8'))('the configure snippets, run against the real loader 0.8', () => {
    /** The inline <script> that follows the loader's <script src> in `html`. */
    function configureScript(html: string): string {
      const at = html.indexOf(CONFIGURE);
      const open = html.lastIndexOf('<script>', at);
      return html.slice(open + '<script>'.length, html.indexOf('</script>', at));
    }
    /** A GLTFLoader stand-in: install() only ever calls these two setters. */
    function fakeGltfLoader() {
      const l: { dracoLoader?: unknown; meshoptDecoder?: unknown; setDRACOLoader(d: unknown): void; setMeshoptDecoder(m: unknown): void } = {
        setDRACOLoader(d) { this.dracoLoader = d; },
        setMeshoptDecoder(m) { this.meshoptDecoder = m; },
      };
      return l;
    }
    function loaderWith(script: string) {
      // DRACOLoader lives on AFRAME.THREE only, as with the real bundle.
      const { sandbox } = makeLoaderSandbox({ aframeThree: { DRACOLoader, LoadingManager } });
      runLoaderIn('0.8', sandbox);
      vm.runInContext(script, sandbox);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return sandbox as any;
    }

    it('sandbox: an empty table installs NO Draco loader (fail fast) and no meshopt', () => {
      const sb = loaderWith(configureScript(customGlb()));
      const gl = fakeGltfLoader();
      sb.FastShaders.decoders.install(gl);
      expect(gl.dracoLoader).toBeNull();
      expect(gl.meshoptDecoder).toBeUndefined();
    });

    it('sandbox: a filled table installs the shared Draco loader and the meshopt shim', () => {
      const sb = loaderWith(configureScript(customGlb()));
      for (const f of Object.values(DECODER_FILES)) sb.window.__fsDecoderUrls[f] = `blob:https://app.test/${f}`;
      const gl = fakeGltfLoader();
      sb.FastShaders.decoders.install(gl);
      expect(gl.dracoLoader).toBeInstanceOf(DRACOLoader);
      expect((gl.meshoptDecoder as { supported?: boolean }).supported).toBe(true);
      // Only the three names ever resolve: an inherited or unknown key answers nothing.
      expect(Object.getPrototypeOf(sb.window.__fsDecoderUrls)).toBeNull();
    });

    it('XR: the baked same-origin map installs both', () => {
      const sb = loaderWith(configureScript(tslToPreviewHTML(TSL, { geometry: 'bunny', xr: true })));
      const gl = fakeGltfLoader();
      sb.FastShaders.decoders.install(gl);
      expect(gl.dracoLoader).toBeInstanceOf(DRACOLoader);
      expect((gl.meshoptDecoder as { supported?: boolean }).supported).toBe(true);
    });
  });

  describe('the feed\'s fillDecoders, executed', () => {
    const html = customGlb();
    const start = html.indexOf('    var DEC_FILES = ');
    const end = html.indexOf('    function decoderError() {');
    const minted: string[] = [];
    afterEach(() => {
      for (const u of minted.splice(0)) URL.revokeObjectURL(u);
    });
    function feed() {
      const table = Object.create(null) as Record<string, string>;
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fill = new Function('window', html.slice(start, end) + '\nreturn fillDecoders;')({ __fsDecoderUrls: table }) as (
        dec: unknown,
      ) => void;
      return { table, fill };
    }

    it('slices out cleanly', () => {
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
    });

    it('mints one blob: URL per valid file', () => {
      const { table, fill } = feed();
      fill({
        [DECODER_FILES.dracoWrapper]: 'self.x = 1;',
        [DECODER_FILES.dracoWasm]: new Uint8Array([0, 97, 115, 109]).buffer,
        [DECODER_FILES.meshopt]: 'export {};',
        [DECODER_FILES.basisJs]: 'self.BASIS = 1;',
        [DECODER_FILES.basisWasm]: new Uint8Array([0, 97, 115, 109]).buffer,
      });
      expect(Object.keys(table).sort()).toEqual(Object.values(DECODER_FILES).sort());
      minted.push(...Object.values(table));
      for (const u of Object.values(table)) expect(u).toMatch(/^blob:/);
    });

    it('refuses wrong types, empty and oversize files, and unknown or inherited keys', () => {
      const { table, fill } = feed();
      fill({
        [DECODER_FILES.dracoWrapper]: new ArrayBuffer(8),
        [DECODER_FILES.dracoWasm]: 'AGFzbQ==',
        [DECODER_FILES.meshopt]: 'x'.repeat(MAX_DECODER_FILE_BYTES + 1),
        // The basis wasm is the largest real file, so its cap matters most.
        [DECODER_FILES.basisWasm]: new ArrayBuffer(MAX_DECODER_FILE_BYTES + 1),
        [DECODER_FILES.basisJs]: new ArrayBuffer(8),
        'evil.js': 'alert(1)',
      });
      fill({ [DECODER_FILES.dracoWrapper]: '', [DECODER_FILES.dracoWasm]: new ArrayBuffer(0) });
      fill(Object.create({ [DECODER_FILES.dracoWrapper]: 'inherited' }));
      fill(null);
      expect(Object.keys(table)).toEqual([]);
    });

    it('keeps a filled slot', () => {
      const { table, fill } = feed();
      fill({ [DECODER_FILES.meshopt]: 'export {};' });
      const first = table[DECODER_FILES.meshopt];
      fill({ [DECODER_FILES.meshopt]: 'export const x = 1;' });
      expect(table[DECODER_FILES.meshopt]).toBe(first);
      minted.push(first);
    });
  });
});
