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

  it('xr sphere: keeps the primitive geometry attribute', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere', xr: true });
    expect(html).toContain(esc('geometry="primitive: sphere'));
    expect(html).toContain(esc('vr-mode-ui="enabled: true"'));
  });
});
