import { describe, it, expect } from 'vitest';
import { tslToPreviewHTML } from './tslToPreviewHTML';

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

  it('sandboxed teapot: NO network obj-model (opaque-origin CORS trap), postMessage feed instead', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'teapot' });
    // The broken deploy path: obj-model="obj: url(https://…)" fetched from the
    // sandbox's opaque origin is a CORS request generic hosts don't answer.
    expect(html).not.toContain(esc('obj-model="obj: url('));
    // regen is explicit (podest's fit-bounds twin defaults the OPPOSITE way).
    expect(html).toContain(esc('fit-bounds="size: 1.6; regen: true"'));
    // Stale-model guard: each rebuilt iframe accepts only its own geometry.
    expect(html).toContain('var __fsExpectedObj = "teapot";');
    expect(html).toContain('msg.type === "fs:obj-model-error"');
    expect(html).toContain('URL.createObjectURL(blob)');
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
      { geometry: 'teapot' as const },
      { geometry: 'custom' as const, customModel: { kind: 'glb' as const, id: 7 } },
      { geometry: 'custom' as const, customModel: { kind: 'obj' as const, id: 3 } },
      { geometry: 'custom' as const, customModel: { kind: 'glb' as const, id: 9 }, xr: true, url: '' },
    ]) {
      const html = tslToPreviewHTML(TSL, opts);
      expect(html).toContain('AFRAME.registerComponent("gltf-anim"');
      expect(html).toContain(esc('gltf-anim'));
    }
    // Primitives never load a model, so they pay for none of it.
    for (const geometry of ['sphere', 'cube', 'plane'] as const) {
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

  it('xr teapot: direct obj-model url, gpu hider first, xr NOT hidden, VR UI on, escaped title', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'teapot', xr: true, title: 'My <"Shader">' });
    expect(html).toContain(esc('obj-model="obj: url('));
    expect(html).toContain(esc('vr-mode-ui="enabled: true"'));
    expect(html).not.toContain('Object.defineProperty(navigator,"xr"');
    expect(html).not.toContain('fs:obj-model');
    expect(html).toContain('<title>My &lt;&quot;Shader&quot;&gt;</title>');
    // The gpu hider must run before the vendored bundles can read navigator.gpu.
    const gpuIdx = html.indexOf('Object.defineProperty(Navigator.prototype,"gpu"');
    const bundleIdx = html.indexOf('a-frame-180-a-01.min.js');
    expect(gpuIdx).toBeGreaterThan(-1);
    expect(gpuIdx).toBeLessThan(bundleIdx);
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
