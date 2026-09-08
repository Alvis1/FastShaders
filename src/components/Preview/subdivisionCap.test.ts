/**
 * The preview panel's subdivision plumbing.
 *
 * The LADDER itself is pure and lives in `subdivisionSteps.ts`, so it is called
 * here rather than grepped. What still has to be grepped is how ShaderPreview
 * WIRES it: that file is a React component and the vitest env is `node` (the
 * idiom `evalHooks.test.ts` and `trackpadScroll.test.ts` use for the same
 * reason).
 *
 * What is pinned, and why each is a real regression:
 *  - the ladder's ceiling IS the engine's `SUBDIVISION_CAP` (128): a literal
 *    would let the slider offer a value the teapot clamps silently;
 *  - the stops are POWERS OF TWO and the slider's value is their INDEX, which
 *    is what makes the sections equal on the track — binding the input to the
 *    segment count instead would restore the linear track, where the useful
 *    1…16 range is the first 12% and the top half costs a 25 ms / 6.2 MB
 *    re-tessellation per pixel of travel;
 *  - a persisted out-of-range value is CLAMPED and SNAPPED, never reset;
 *  - the hot-swap effect has a teapot branch: without it a slider tick on the
 *    teapot posts `buildGeoAttr`, whose default case is a SPHERE;
 *  - the slider is gated on `isModelGeometry`, which excludes the teapot — so
 *    it shows for the teapot, the whole point of tessellating it live.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SUBDIVISION_CAP, buildTeapotAttr, isModelGeometry, isTeapotGeometry } from '@/engine/tslToPreviewHTML';
import { TEAPOT_RES_MAX } from '@/engine/teapotGeometry';
import {
  SUBDIVISION_DEFAULT,
  SUBDIVISION_MAX,
  SUBDIVISION_MIN,
  SUBDIVISION_STEPS,
  snapSubdivision,
  subdivisionAt,
  subdivisionIndex,
  validateSubdivision,
} from './subdivisionSteps';

const src = readFileSync(new URL('./ShaderPreview.tsx', import.meta.url), 'utf8');
const stepsSrc = readFileSync(new URL('./subdivisionSteps.ts', import.meta.url), 'utf8');

describe('subdivision cap', () => {
  it('is 128 everywhere — the Utah Teapot page\'s own limit', () => {
    expect(SUBDIVISION_CAP).toBe(128);
    expect(TEAPOT_RES_MAX).toBe(SUBDIVISION_CAP);
    expect(SUBDIVISION_MAX).toBe(SUBDIVISION_CAP);
    expect(stepsSrc).toContain('export const SUBDIVISION_MAX = SUBDIVISION_CAP;');
    expect(stepsSrc).not.toMatch(/SUBDIVISION_MAX = \d/);
  });

  it('the teapot resolution attribute honours the cap and the floor', () => {
    expect(buildTeapotAttr(64)).toBe('resolution: 64');
    expect(buildTeapotAttr(1000)).toBe('resolution: 128');
    expect(buildTeapotAttr(0)).toBe('resolution: 1');
    expect(buildTeapotAttr(NaN)).toBe('resolution: 1');
    expect(buildTeapotAttr(7.6)).toBe('resolution: 8');
  });
});

describe('the power-of-two ladder', () => {
  it('is every doubling from the floor to the cap, and is derived from the cap', () => {
    expect(SUBDIVISION_STEPS).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
    expect(SUBDIVISION_STEPS[0]).toBe(SUBDIVISION_MIN);
    expect(SUBDIVISION_STEPS[SUBDIVISION_STEPS.length - 1]).toBe(SUBDIVISION_MAX);
    for (const v of SUBDIVISION_STEPS) expect(Number.isInteger(Math.log2(v))).toBe(true);
  });

  it('contains the default, so the slider has a stop to rest on at boot', () => {
    expect(SUBDIVISION_STEPS).toContain(SUBDIVISION_DEFAULT);
  });

  it('snaps in doublings, not in segments — 96 is nearer 128 than 64', () => {
    expect(snapSubdivision(96)).toBe(128); // linear distance would say 64
    expect(snapSubdivision(3)).toBe(4); // log2(3) = 1.58 -> 2 -> 4
    expect(snapSubdivision(5)).toBe(4);
    expect(snapSubdivision(64)).toBe(64);
    expect(snapSubdivision(100)).toBe(128);
  });

  it('clamps at both ends instead of wrapping or throwing', () => {
    expect(snapSubdivision(0)).toBe(1);
    expect(snapSubdivision(-9)).toBe(1);
    expect(snapSubdivision(1e9)).toBe(128);
    expect(snapSubdivision(NaN)).toBe(SUBDIVISION_DEFAULT);
    expect(snapSubdivision(Infinity)).toBe(SUBDIVISION_DEFAULT);
  });

  it('index and value are inverses across every stop', () => {
    SUBDIVISION_STEPS.forEach((v, i) => {
      expect(subdivisionIndex(v)).toBe(i);
      expect(subdivisionAt(i)).toBe(v);
    });
  });

  it('a junk slider index cannot escape the ladder', () => {
    expect(subdivisionAt(-1)).toBe(SUBDIVISION_MIN);
    expect(subdivisionAt(999)).toBe(SUBDIVISION_MAX);
    expect(subdivisionAt(NaN)).toBe(SUBDIVISION_DEFAULT);
  });

  it('bounds the re-tessellations a full drag can trigger', () => {
    // A linear 1..128 track emits up to 127 distinct values, each a full
    // rebuild of the mesh. The ladder emits at most one per section.
    expect(SUBDIVISION_STEPS.length - 1).toBeLessThanOrEqual(8);
  });
});

describe('validateSubdivision', () => {
  it('clamps and snaps a persisted value rather than resetting it', () => {
    expect(validateSubdivision('256')).toBe(128); // the old ceiling
    expect(validateSubdivision('100')).toBe(128);
    expect(validateSubdivision('64')).toBe(64);
    expect(validateSubdivision('3')).toBe(4);
    expect(validateSubdivision('0')).toBe(1);
    expect(validateSubdivision('-5')).toBe(1);
  });

  it('falls back to the default only when there is no number to read', () => {
    expect(validateSubdivision(null)).toBe(SUBDIVISION_DEFAULT);
    expect(validateSubdivision('')).toBe(SUBDIVISION_DEFAULT);
    expect(validateSubdivision('nonsense')).toBe(SUBDIVISION_DEFAULT);
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

  it('the slider is bound to the stop INDEX, so the sections are equal', () => {
    expect(src).toContain('max={SUBDIVISION_STEPS.length - 1}');
    expect(src).toContain('value={subdivisionIndex(subdivision)}');
    expect(src).toContain('onChange={(e) => setSubdivision(subdivisionAt(parseInt(e.target.value, 10)))}');
    // The real segment count still has to reach a screen reader.
    expect(src).toContain('aria-valuetext={String(subdivision)}');
  });

  it('only the bunny is still fetched as a model file', () => {
    expect(src).toContain("function fetchObjText(geometry: 'bunny')");
    expect(src).not.toContain("'teapot' | 'bunny'");
  });
});
