/**
 * The preview's `{x, y, z}` guard (finiteVec3.ts), and the three places in
 * ShaderPreview that must go through it: the live `fs:camera` and `fs:rotation`
 * reports, and the stored copies read back by `loadVec3`.
 *
 * The bug (review 2026-10-11): `typeof x === 'number'` let NaN and Infinity
 * through. A forged `fs:rotation` NaN was baked into the next cold rebuild and
 * the model vanished until Play or a reload; a stored `{"x":1e999}` parsed to
 * Infinity and the turntable's mod360 made it NaN.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_CAMERA_TARGET_RADIUS, cameraTarget, cameraTooClose, finiteVec3 } from './finiteVec3';
import { safeJsonReviver } from '@/utils/safeJson';

const SRC = readFileSync(resolve(__dirname, 'ShaderPreview.tsx'), 'utf8');

describe('finiteVec3', () => {
  it('passes three finite numbers through as a FRESH object holding only them', () => {
    const report = { type: 'fs:rotation', x: 10, y: -20.5, z: 0, extra: 'kept out' };
    const v = finiteVec3(report);
    expect(v).toEqual({ x: 10, y: -20.5, z: 0 });
    expect(v).not.toBe(report);
    expect(Object.keys(v!)).toEqual(['x', 'y', 'z']);
  });

  it('refuses NaN and ±Infinity on any axis — what typeof let through', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(finiteVec3({ x: bad, y: 0, z: 0 })).toBeNull();
      expect(finiteVec3({ x: 0, y: bad, z: 0 })).toBeNull();
      expect(finiteVec3({ x: 0, y: 0, z: bad })).toBeNull();
    }
  });

  it('a stored {"x":1e999} is Infinity after the parse, and is refused', () => {
    const parsed: unknown = JSON.parse('{"x":1e999,"y":0,"z":0}', safeJsonReviver);
    expect((parsed as { x: number }).x).toBe(Infinity);
    expect(finiteVec3(parsed)).toBeNull();
  });

  it('validates, never coerces: strings, booleans, null, missing axes and non-objects are refused', () => {
    expect(finiteVec3({ x: '1', y: 0, z: 0 })).toBeNull();
    expect(finiteVec3({ x: true, y: 0, z: 0 })).toBeNull();
    expect(finiteVec3({ x: null, y: 0, z: 0 })).toBeNull();
    expect(finiteVec3({ x: 1, y: 2 })).toBeNull();
    for (const p of [null, undefined, 3, 'x', [1, 2, 3]]) expect(finiteVec3(p)).toBeNull();
  });
});

describe('cameraTooClose', () => {
  it('is the reload rule: inside radius 1 is not a place the orbit controls (minDistance 2) can reach', () => {
    expect(cameraTooClose({ x: 0, y: 0, z: 0 })).toBe(true);
    expect(cameraTooClose({ x: 0.5, y: 0.5, z: 0.5 })).toBe(true);
    expect(cameraTooClose({ x: 0, y: 0, z: 8 })).toBe(false);
    expect(cameraTooClose({ x: 0, y: 2, z: 0 })).toBe(false);
  });
});

describe('cameraTarget: the orbit target an fs:camera report carries', () => {
  it('takes tx/ty/tz as three finite numbers, into a fresh {x, y, z}', () => {
    const report = { type: 'fs:camera', x: 1, y: 2, z: 8, tx: -1.29, ty: 0, tz: 0.5, extra: 1 };
    const t = cameraTarget(report);
    expect(t).toEqual({ x: -1.29, y: 0, z: 0.5 });
    expect(Object.keys(t!)).toEqual(['x', 'y', 'z']);
  });

  it('refuses a non-finite, missing or coercible axis, and a non-object', () => {
    for (const bad of [NaN, Infinity, -Infinity, '1', null, undefined, true]) {
      expect(cameraTarget({ tx: bad, ty: 0, tz: 0 })).toBeNull();
      expect(cameraTarget({ tx: 0, ty: 0, tz: bad })).toBeNull();
    }
    // An older stage reports no target at all: the origin, as before.
    expect(cameraTarget({ type: 'fs:camera', x: 0, y: 0, z: 8 })).toBeNull();
    for (const p of [null, undefined, 3, 'x']) expect(cameraTarget(p)).toBeNull();
  });

  it('refuses a target no pan put there: past MAX_CAMERA_TARGET_RADIUS (forgeable, and it would aim every later document at nothing)', () => {
    expect(cameraTarget({ tx: MAX_CAMERA_TARGET_RADIUS, ty: 0, tz: 0 })).not.toBeNull();
    expect(cameraTarget({ tx: MAX_CAMERA_TARGET_RADIUS + 1, ty: 0, tz: 0 })).toBeNull();
    expect(cameraTarget({ tx: 1e300, ty: 0, tz: 0 })).toBeNull();
  });
});

describe('ShaderPreview reads every vector through it (source)', () => {
  /** The handler branch from `marker` to the next `} else if` / end of chain. */
  function branch(marker: string, end: string): string {
    const at = SRC.indexOf(marker);
    expect(at, `${marker} is gone`).toBeGreaterThan(-1);
    const stop = SRC.indexOf(end, at + marker.length);
    expect(stop).toBeGreaterThan(at);
    return SRC.slice(at, stop);
  }

  it('the live fs:camera report: finite, and never inside radius 1', () => {
    const cam = branch("} else if (data.type === 'fs:camera') {", "} else if (data.type === 'fs:rotation') {");
    expect(cam).toContain('const pos = finiteVec3(data);');
    expect(cam).toContain('if (pos && !cameraTooClose(pos)) {');
    expect(cam).not.toContain("typeof data.x === 'number'");
  });

  it('the orbit target is kept WITH its position, session-only, and cleared wherever the position is', () => {
    // A pan moves the target; the retained-memory budget's quiet rebuild used
    // to restore the position alone, turning the view to face the origin
    // (review 2026-10-11, real Chrome: target (-1.29, 0, 0) → (0, 0, 0)).
    const cam = branch("} else if (data.type === 'fs:camera') {", "} else if (data.type === 'fs:rotation') {");
    const guard = cam.indexOf('if (pos && !cameraTooClose(pos)) {');
    const pair = cam.indexOf('cameraTargetRef.current = cameraTarget(data);');
    expect(pair).toBeGreaterThan(guard);
    expect(cam.indexOf('cameraPosRef.current = pos;')).toBeGreaterThan(guard);
    // Never stored.
    expect(SRC).not.toMatch(/localStorage\.setItem\([^)]*[Tt]arget/);
    // Both documents bake it beside the position: the pane's and the XR popup's.
    const bakes = SRC.match(/initialCameraPosition: cameraPosRef\.current,\n\s*initialCameraTarget: cameraTargetRef\.current,/g);
    expect(bakes).toHaveLength(2);
    // Every place that forgets the position forgets the target too.
    expect(SRC.match(/cameraPosRef\.current = (?:null|loadCameraPos\(\));/g)).toHaveLength(2);
    expect(SRC.match(/cameraTargetRef\.current = null;/g)).toHaveLength(2);
  });

  it('the live fs:rotation report: finite', () => {
    const rot = branch("} else if (data.type === 'fs:rotation') {", "window.addEventListener('message', handler);");
    expect(rot).toContain('const rot = finiteVec3(data);');
    expect(rot).toContain('rotationRef.current = rot;');
    expect(rot).not.toContain("typeof data.x === 'number'");
  });

  it('the stored copies on reload (loadVec3), the camera with the same radius rule', () => {
    const load = branch('function loadVec3(', 'function loadRotation(');
    expect(load).toContain('const p = finiteVec3(JSON.parse(raw, safeJsonReviver));');
    expect(load).not.toContain("typeof p.x === 'number'");
    expect(load).toContain("return loadVec3('fs:previewCameraPos', cameraTooClose);");
  });

  it('no other spelling of the old check survives anywhere in the file', () => {
    expect(SRC).not.toMatch(/typeof (?:data|p)\.[xyz] === 'number'/);
  });
});
