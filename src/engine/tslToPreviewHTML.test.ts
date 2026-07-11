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
    expect(html).toContain(esc('fit-bounds="size: 1.6"'));
    // Stale-model guard: each rebuilt iframe accepts only its own geometry.
    expect(html).toContain('var __fsExpectedObj = "teapot";');
    expect(html).toContain('msg.type === "fs:obj-model-error"');
    expect(html).toContain('URL.createObjectURL(new Blob([text]))');
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
