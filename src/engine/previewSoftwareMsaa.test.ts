/**
 * MSAA off on SOFTWARE renderers, in the sandboxed preview only (owner
 * decision 2026-10-11; SANDBOX_SOFTWARE_RENDERER_ATTR in tslToPreviewHTML.ts).
 *
 * A-Frame asks three for antialias on every non-mobile device, and three then
 * draws the scene into a 4-sample HalfFloat target. On SwiftShader that halved
 * a large pane's frame rate; on a GPU it is cheap and stays. The sandboxed
 * boot decides inside the frame — from the WebGL2 probe's unmasked renderer
 * name, or from the WebGPU pre-flight's adapter — and swaps the scene's
 * renderer attribute in the markup BEFORE injecting it, because A-Frame reads
 * the attribute once, in setupRenderer, while the markup connects.
 *
 * The boot script is executed here against stub canvases and adapters. Checked
 * in Chrome on 2026-10-11: SwiftShader (--use-angle=swiftshader) gets a
 * renderer with 0 samples, the GPU path keeps 4.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SANDBOX_RENDERER_ATTR,
  SANDBOX_SOFTWARE_RENDERER_ATTR,
  SOFTWARE_RENDERER_PATTERN,
  tslToPreviewHTML,
} from './tslToPreviewHTML';

const TSL = "import { vec3 } from 'three/tsl';\nconst shader = Fn(() => { return vec3(1); });\nexport default shader;\n";
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const UNMASKED_RENDERER_WEBGL = 0x9246;
const RENDERER = 0x1f01;

const esc = (s: string) => JSON.stringify(s).slice(1, -1);

function extractBoot(html: string): string {
  const at = html.indexOf('<div id="scene-slot"></div>');
  expect(at).toBeGreaterThan(-1);
  const open = html.indexOf('<script>', at);
  const close = html.indexOf('</script>', open);
  return html.slice(open + '<script>'.length, close);
}

interface GlStub {
  /** What the unmasked (or, without the extension, the plain) RENDERER reads. */
  renderer?: string;
  debugExt?: boolean;
  throws?: boolean;
}

interface BootRun {
  slot: { innerHTML: string };
  probes: number;
  errors: string[];
}

/**
 * Run a document's scene-boot script. `gl` describes the WebGL2 context the
 * probe gets (null: none); `adapter` makes navigator.gpu present and is what
 * requestAdapter resolves to.
 */
async function boot(html: string, gl: GlStub | null, adapter?: unknown): Promise<BootRun> {
  const slot = { innerHTML: '' };
  const errors: string[] = [];
  let probes = 0;
  const ctx = gl && {
    RENDERER,
    getExtension: (name: string) => {
      if (name === 'WEBGL_debug_renderer_info') return gl.debugExt === false ? null : { UNMASKED_RENDERER_WEBGL };
      if (name === 'WEBGL_lose_context') return { loseContext() {} };
      return null;
    },
    getParameter: (p: number) => {
      if (gl.throws) throw new Error('blocked');
      if (p === UNMASKED_RENDERER_WEBGL) return gl.renderer;
      if (p === RENDERER) return gl.debugExt === false ? gl.renderer : 'WebKit WebGL';
      return null;
    },
  };
  const doc = {
    createElement: () => ({ getContext: (kind: string) => { probes++; return kind === 'webgl2' ? ctx : null; } }),
    getElementById: (id: string) => (id === 'scene-slot' ? slot : null),
    querySelector: () => null,
  };
  const navigator: Record<string, unknown> = { userAgent: CHROME_UA, platform: 'MacIntel', maxTouchPoints: 0 };
  if (adapter !== undefined) navigator.gpu = { requestAdapter: () => Promise.resolve(adapter) };
  const win = { addEventListener() {}, dispatchEvent() {} };
  class EventStub { constructor(public type: string) {} }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'document', 'navigator', 'Navigator', 'parent', 'setTimeout', 'Event', '__fsShowStickyError', extractBoot(html))(
    win, doc, navigator, { prototype: {} }, { postMessage() {} }, () => 0, EventStub, (m: string) => errors.push(m),
  );
  // The WebGPU pre-flight settles on a resolved promise.
  await new Promise((r) => setTimeout(r, 0));
  return { slot, probes, errors };
}

const sandbox = () => tslToPreviewHTML(TSL, { geometry: 'sphere' });

const SOFTWARE = [
  'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'llvmpipe (LLVM 15.0.7, 256 bits)',
  'softpipe',
  'Apple Software Renderer',
];
const HARDWARE = [
  'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'Mali-G78',
  'Adreno (TM) 740',
];

describe('software-renderer MSAA: the attribute', () => {
  it('the software attribute is the sandboxed one plus antialias off — the canvas ceiling stays', () => {
    expect(SANDBOX_SOFTWARE_RENDERER_ATTR).toBe(SANDBOX_RENDERER_ATTR.replace(/"$/, '; antialias: false"'));
    expect(SANDBOX_RENDERER_ATTR).toContain('maxCanvasWidth: 3840; maxCanvasHeight: 2160');
  });

  it('neither spells backend: — the only token the aframe#5847 carry acts on', () => {
    expect(SANDBOX_RENDERER_ATTR).not.toContain('backend');
    expect(SANDBOX_SOFTWARE_RENDERER_ATTR).not.toContain('backend');
    // (The document does say `backend:` once — the fs:backend report's field.)
    // Every renderer attribute in the document, escaped (scene markup, the
    // boot's swap) or not, up to its closing quote.
    const attrs = sandbox().match(/renderer=\\?"[^"]*"/g) ?? [];
    expect(attrs.length).toBeGreaterThanOrEqual(3);
    for (const a of attrs) expect(a).not.toContain('backend');
  });

  it('the sandboxed scene is built with the GPU attribute; the swap lives only in its boot', () => {
    const html = sandbox();
    expect(html).toContain(`<a-scene ${esc(SANDBOX_RENDERER_ATTR)} vr-mode-ui`);
    expect(html).toContain('__fsSoftwareRaster');
  });

  it('the XR popup carries none of it', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere', xr: true });
    expect(html).not.toContain('antialias');
    expect(html).not.toContain('__fsSoftwareRaster');
    expect(html).not.toContain('WEBGL_debug_renderer_info');
  });

  it('the vendored A-Frame really maps `antialias: false` onto the renderer option', () => {
    const bundle = readFileSync(
      fileURLToPath(new URL('../../a-frame-shaderloader/js/a-frame-180-a-01.min.js', import.meta.url)),
      'utf8',
    );
    // setupRenderer: non-mobile default ON, and the attribute's string value
    // overrides it unless it is "auto".
    expect(bundle).toContain('antialias:!eO');
    expect(bundle).toContain('t.antialias&&t.antialias!=="auto"&&(i.antialias=t.antialias==="true")');
  });

  it('the pattern names software rasterizers and no common GPU', () => {
    for (const name of SOFTWARE) expect(SOFTWARE_RENDERER_PATTERN.test(name), name).toBe(true);
    for (const name of HARDWARE) expect(SOFTWARE_RENDERER_PATTERN.test(name), name).toBe(false);
  });
});

describe('software-renderer MSAA: the boot decides from the frame’s own renderer (WebGL2 path)', () => {
  it('a software renderer gets the scene with MSAA off', async () => {
    for (const renderer of SOFTWARE) {
      const run = await boot(sandbox(), { renderer });
      expect(run.slot.innerHTML, renderer).toContain(SANDBOX_SOFTWARE_RENDERER_ATTR);
      expect(run.slot.innerHTML).not.toContain('backend:');
    }
  });

  it('a GPU keeps the scene exactly as built', async () => {
    const html = sandbox();
    for (const renderer of HARDWARE) {
      const run = await boot(html, { renderer });
      expect(run.slot.innerHTML, renderer).toContain(SANDBOX_RENDERER_ATTR);
      expect(run.slot.innerHTML).not.toContain('antialias');
      expect(run.errors).toEqual([]);
    }
  });

  it('without the debug extension it reads the plain RENDERER (Firefox reports the real name there)', async () => {
    const run = await boot(sandbox(), { renderer: 'llvmpipe (LLVM 15.0.7, 256 bits)', debugExt: false });
    expect(run.slot.innerHTML).toContain(SANDBOX_SOFTWARE_RENDERER_ATTR);
  });

  it('a renderer query that throws still boots, as a GPU', async () => {
    const run = await boot(sandbox(), { renderer: 'SwiftShader', throws: true });
    expect(run.slot.innerHTML).toContain(SANDBOX_RENDERER_ATTR);
    expect(run.errors).toEqual([]);
  });

  it('no WebGL2 at all is still the hard-floor error, and nothing is injected', async () => {
    const run = await boot(sandbox(), null);
    expect(run.slot.innerHTML).toBe('');
    expect(run.errors[0]).toMatch(/no WebGL2 context is available/);
  });
});

describe('software-renderer MSAA: the WebGPU pre-flight decides from its adapter', () => {
  it('a fallback adapter, or one naming a software rasterizer, gets MSAA off', async () => {
    for (const adapter of [
      { isFallbackAdapter: true },
      { info: { isFallbackAdapter: true } },
      { info: { vendor: 'google', architecture: 'swiftshader', device: '', description: '' } },
      { info: { vendor: 'microsoft', architecture: '', device: '', description: 'Microsoft Basic Render Driver' } },
    ]) {
      const run = await boot(sandbox(), { renderer: 'unused' }, adapter);
      expect(run.slot.innerHTML, JSON.stringify(adapter)).toContain(SANDBOX_SOFTWARE_RENDERER_ATTR);
      // A WebGPU document runs no WebGL2 probe at all.
      expect(run.probes).toBe(0);
    }
  });

  it('a hardware adapter keeps MSAA, and an adapter whose info throws does too', async () => {
    const throwing = { get info() { throw new Error('nope'); } };
    for (const adapter of [{ info: { vendor: 'apple', architecture: 'metal-3', device: '', description: '' } }, {}, throwing]) {
      const run = await boot(sandbox(), { renderer: 'unused' }, adapter);
      expect(run.slot.innerHTML).toContain(SANDBOX_RENDERER_ATTR);
      expect(run.slot.innerHTML).not.toContain('antialias');
    }
  });

  it('no adapter falls back to WebGL2, where the probe decides', async () => {
    const run = await boot(sandbox(), { renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)' }, null);
    expect(run.probes).toBe(1);
    expect(run.slot.innerHTML).toContain(SANDBOX_SOFTWARE_RENDERER_ATTR);
  });
});
