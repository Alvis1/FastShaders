/**
 * Source pins for the preview panel's subdivision plumbing. ShaderPreview is a
 * React component and the vitest env is `node`, so the constants and the
 * effect bodies are grepped from source — the idiom `evalHooks.test.ts` and
 * `trackpadScroll.test.ts` use for the same reason.
 *
 * What is pinned, and why each is a real regression:
 *  - the slider's ceiling IS the engine's `SUBDIVISION_CAP` (128): a literal
 *    here would let the slider offer a value the teapot clamps silently;
 *  - the validator CLAMPS an out-of-range persisted value instead of resetting
 *    it — 256 (the old ceiling) must become 128, not the default;
 *  - the hot-swap effect has a teapot branch: without it a slider tick on the
 *    teapot posts `buildGeoAttr`, whose default case is a SPHERE;
 *  - the slider is gated on `isModelGeometry`, which excludes the teapot — so
 *    it shows for the teapot, the whole point of tessellating it live.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SUBDIVISION_CAP, buildTeapotAttr, isModelGeometry, isTeapotGeometry } from '@/engine/tslToPreviewHTML';
import { TEAPOT_RES_MAX } from '@/engine/teapotGeometry';

const src = readFileSync(new URL('./ShaderPreview.tsx', import.meta.url), 'utf8');

describe('subdivision cap', () => {
  it('is 128 everywhere — the Utah Teapot page\'s own limit', () => {
    expect(SUBDIVISION_CAP).toBe(128);
    expect(TEAPOT_RES_MAX).toBe(SUBDIVISION_CAP);
    expect(src).toContain('const SUBDIVISION_MAX = SUBDIVISION_CAP;');
    expect(src).not.toMatch(/SUBDIVISION_MAX = \d/);
  });

  it('a persisted out-of-range value is clamped, not reset to the default', () => {
    expect(src).toContain('return Math.max(SUBDIVISION_MIN, Math.min(SUBDIVISION_MAX, v));');
  });

  it('the teapot resolution attribute honours the cap and the floor', () => {
    expect(buildTeapotAttr(64)).toBe('resolution: 64');
    expect(buildTeapotAttr(1000)).toBe('resolution: 128');
    expect(buildTeapotAttr(0)).toBe('resolution: 1');
    expect(buildTeapotAttr(NaN)).toBe('resolution: 1');
    expect(buildTeapotAttr(7.6)).toBe('resolution: 8');
  });
});

describe('teapot in the preview panel', () => {
  it('is not a model, so the slider shows and no model feed is expected', () => {
    expect(isTeapotGeometry('teapot')).toBe(true);
    expect(isModelGeometry('teapot')).toBe(false);
    expect(isModelGeometry('bunny')).toBe(true);
    expect(src).toContain('{!isModelGeometry(geometry) && !sdfDrives && (');
  });

  it('a slider tick on the teapot hot-swaps its resolution instead of posting a primitive', () => {
    expect(src).toContain('if (isTeapotGeometry(previewGeometry)) {');
    expect(src).toContain('teapot: buildTeapotAttr(effectiveSubdivision),');
  });

  it('only the bunny is still fetched as a model file', () => {
    expect(src).toContain("function fetchObjText(geometry: 'bunny')");
    expect(src).not.toContain("'teapot' | 'bunny'");
  });
});
