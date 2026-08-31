import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/**
 * The `backend` renderer property is a PATCH we carry, not something A-Frame
 * ships — so nothing but this test notices if it disappears.
 *
 * WHY IT EXISTS. The vendored bundle is the three r184 WebGPU build, so A-Frame
 * builds a `WebGPURenderer` and takes the WebGPU backend whenever
 * `navigator.gpu` exists — and three's `XRManager.setSession` then refuses:
 * "XR is currently not supported with a WebGPU backend. Use WebGL by passing
 * { forceWebGL: true }". Every page of ours that can enter VR must therefore
 * force the WebGL2 backend. Until now the only lever was hiding `navigator.gpu`
 * with an inline <script> before the bundle loads — a global monkey-patch,
 * repeated per document. `forceWebGL` is a real WebGPURenderer option already
 * present in the bundle; what was missing was A-Frame passing it through.
 *
 * `a-frame-shaderloader/build/build.mjs` carries the two hunks of
 * aframevr/aframe#5847 that do so. That PR is OPEN, and A-Frame 1.8.0 is still
 * the latest release, so the carry stands until it merges — then the plugin is
 * deleted and this test with it.
 *
 * NOTE r185 does not remove the need: it landed native WebGPU XR
 * (`XRGPUBinding`), but a WebGPU backend still throws unless the XR session was
 * granted the `"webgpu"` feature, and A-Frame requests only
 * `local-floor`/`bounded-floor` — nor does Quest Browser implement
 * `XRGPUBinding` at all.
 *
 * MEASURED in headless Chrome with `navigator.gpu` present:
 *   renderer="backend: webgl"  → backend WebGL2
 *   (no renderer attribute)    → backend WebGPU  (default unchanged)
 */
describe('the A-Frame `backend` renderer property survives a rebuild', () => {
  // Both artefacts, as esbuild emits them after its own re-minification —
  // which renames the config object, so these are NOT the strings written in
  // build.mjs. Checking the source alone would pass on a bundle that was never
  // rebuilt.
  const SCHEMA_KEY = 'backend:{default:"auto",oneOf:["auto","webgl"]}';
  const MAPPING = 'forceWebGL=t.backend==="webgl"';

  const COPIES = [
    '../public/js/a-frame-180-a-01.min.js',
    '../ShaderCarousel/components/three/a-frame-180-a-01.min.js',
    '../a-frame-shaderloader/js/a-frame-180-a-01.min.js',
  ];

  it.each(COPIES)('%s carries the schema key and the forceWebGL mapping', (rel) => {
    const src = read(rel);
    expect(src, 'the `backend` schema key is missing — was the bundle rebuilt without build.mjs\'s patchAframeRenderer plugin?').toContain(SCHEMA_KEY);
    expect(src, 'the forceWebGL mapping is missing — the schema key alone does nothing').toContain(MAPPING);
  });

  it('the build plugin fails loudly rather than emitting an unpatched bundle', () => {
    // The failure mode this guards is silent: an A-Frame upgrade that re-minifies
    // either anchor would drop the property, and the only symptom would be
    // `renderer="backend: webgl"` quietly doing nothing — i.e. VR throwing again,
    // on a headset, much later. The plugin therefore throws on a missing or
    // non-unique anchor, and again if the dist file was never loaded at all.
    const build = read('../a-frame-shaderloader/build/build.mjs');
    expect(build).toContain('patchAframeRenderer');
    expect(build).toMatch(/hits !== 1/);
    expect(build).toMatch(/throw new Error/);
    expect(build).toMatch(/if \(!patched\)/);
  });

  it('three still refuses XR on a WebGPU backend, so the property is still needed', () => {
    // The day this assertion fails is the day the whole carry can go: it means
    // the bundle was rebuilt on a three that no longer hard-refuses.
    const src = read('../public/js/a-frame-180-a-01.min.js');
    expect(src).toContain('XR is currently not supported with a WebGPU backend');
  });
});

/**
 * The consumers: every VR-entry document must SPELL the attribute, and the
 * spelling is load-bearing — the patched branch runs only when the raw
 * `renderer` attribute contains `backend:` and forces only on the exact value
 * `webgl`, so a typo silently does nothing and Enter VR throws on a headset,
 * much later. The editor emitters have their own pins (tslToAFrameHTML.test.ts,
 * tslToPreviewHTML.test.ts); podest is a hand-written standalone page nothing
 * else guards, so its XR popup is pinned here at the source level.
 */
describe('podest XR popup rides the backend property', () => {
  const podest = read('../public/podest.html');

  it('buildXrDoc spells renderer="backend: webgl" on its a-scene', () => {
    const xrScene = podest.match(/<a-scene[^>]*vr-nav[^>]*>/);
    expect(xrScene, 'buildXrDoc no longer emits its vr-nav a-scene?').not.toBeNull();
    expect(xrScene![0]).toContain('renderer="backend: webgl"');
  });

  it('buildXrDoc no longer hides navigator.gpu (the STAGE doc still may)', () => {
    // The XR popup's document is assembled between these two markers; the
    // stage doc's conditional pre-flight (which legitimately hides gpu when
    // no adapter is granted) lies outside them.
    const start = podest.indexOf('function buildXrDoc');
    const end = podest.indexOf('function buildStageDoc');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(podest.slice(start, end)).not.toContain('Navigator.prototype,"gpu"');
  });
});
