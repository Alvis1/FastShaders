/**
 * The camera FRAME, stage side (BRIDGE_SCRIPT_TEMPLATE in tslToPreviewHTML.ts),
 * executed.
 *
 * A dropped model keeps its own size (fit-bounds `keepScale`, owner
 * 2026-11-16), so a 180-unit statue is 112.5x the 1.6 box every built-in is
 * normalized to. fit-bounds sets that ratio on `window.__fsFrame` and fires
 * `fs-frame`; the bridge then scales the orbit camera with it — position,
 * target, reset home, zoom range and clipping planes — so the model is framed
 * exactly as a built-in is. Every camera value that crosses to or from the
 * parent (`fs:camera`, `fs:fly-pose`, the baked restores) is in FRAME units,
 * so the parent's stored view frames whatever model is shown next.
 *
 * The bridge script is extracted from the generated document and run against
 * a stub camera, orbit controls and parent (the previewCameraTarget.test.ts
 * technique), with real three vectors.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { tslToPreviewHTML, type PreviewOptions } from './tslToPreviewHTML';

const TSL = "import { vec3 } from 'three/tsl';\nconst shader = Fn(() => { return vec3(1); });\nexport default shader;\n";

function bridgeBody(html: string): string {
  const at = html.indexOf('var __lastGeometryKey');
  expect(at, 'bridge script missing from the document').toBeGreaterThan(-1);
  const open = html.lastIndexOf('<script>', at);
  const close = html.indexOf('</script>', at);
  return html.slice(open + '<script>'.length, close);
}

type Listener = (e?: unknown) => void;

function runBridge(options: PreviewOptions, { frame = 1, topLevel = false } = {}) {
  const posted: Record<string, unknown>[] = [];
  const intervals: (() => void)[] = [];
  const listeners: Record<string, Listener[]> = {};
  const cam = Object.assign(new THREE.PerspectiveCamera(20, 1, 0.005, 10000), {});
  cam.position.set(0, 0, 8);
  const controls = {
    target: new THREE.Vector3(),
    position0: new THREE.Vector3(0, 0, 8),
    target0: new THREE.Vector3(),
    minDistance: 2,
    maxDistance: 80,
    enabled: true,
    updates: 0,
    update() { this.updates++; },
  };
  const data = { minDistance: 2, maxDistance: 80 };
  const camEl = {
    components: { 'orbit-controls': { controls, data } },
    getObject3D: (name: string) => (name === 'camera' ? cam : null),
  };
  const entity = { components: {}, getObject3D: () => null, addEventListener() {}, removeEventListener() {} };
  const spinEl = { object3D: { rotation: { x: 0, y: 0, z: 0 } } };
  const sceneEl = { hasLoaded: true, resize() {}, addEventListener() {} };
  const win: Record<string, unknown> = { __fsFrame: frame };
  const parent = topLevel ? win : { postMessage: (m: Record<string, unknown>) => { posted.push(m); } };
  Object.assign(win, {
    parent,
    postMessage: (m: Record<string, unknown>) => { posted.push(m); },
    addEventListener: (type: string, fn: Listener) => { (listeners[type] ??= []).push(fn); },
    dispatchEvent() {},
  });
  const doc = {
    getElementById: (id: string) => (id === 'preview-entity' ? entity : id === 'spin-parent' ? spinEl : null),
    querySelector: (sel: string) => (sel === '[camera]' ? camEl : sel === 'a-scene' ? sceneEl : null),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'document', '__fsWhenSceneBooted', 'setTimeout', 'setInterval', 'requestAnimationFrame', bridgeBody(tslToPreviewHTML(TSL, options)))(
    win,
    doc,
    (fn: () => void) => fn(),
    () => 0,
    (fn: () => void) => { intervals.push(fn); return 0; },
    () => 0,
  );
  const fire = (type: string, e?: unknown) => { for (const fn of listeners[type] ?? []) fn(e); };
  return {
    cam, controls, data,
    /** What fit-bounds' setFrame does: store the frame, fire fs-frame. */
    setFrame(k: number) { win.__fsFrame = k; fire('fs-frame'); },
    /** A parent message, as the stage's message listener receives it. */
    message(data: Record<string, unknown>) { fire('message', { source: parent, data }); },
    poll() { for (const fn of intervals) fn(); },
    reports: (type: string) => posted.filter((m) => m.type === type),
  };
}

const xyz = (v: THREE.Vector3) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e6) / 1e6);

describe('the orbit camera scales with the model it frames', () => {
  it('a model 100x the preview box puts the whole view 100x out: position, target, home, zoom range, clipping', () => {
    const b = runBridge({ geometry: 'custom', customModel: { kind: 'glb', id: 1 }, initialCameraPosition: { x: 1, y: 2, z: 8 }, initialCameraTarget: { x: 1, y: 0, z: 0 } });
    expect(xyz(b.cam.position)).toEqual([1, 2, 8]);
    b.setFrame(100);
    expect(xyz(b.cam.position)).toEqual([100, 200, 800]);
    expect(xyz(b.controls.target)).toEqual([100, 0, 0]);
    expect(xyz(b.controls.position0)).toEqual([0, 0, 800]);
    expect([b.controls.minDistance, b.controls.maxDistance]).toEqual([200, 8000]);
    // On the component's data too: orbit-controls rebuilds its controls from it on play().
    expect([b.data.minDistance, b.data.maxDistance]).toEqual([200, 8000]);
    expect(b.cam.near).toBeCloseTo(0.5, 9);
    expect(b.cam.far).toBeCloseTo(1e6, 3);
  });

  it('reports the view in FRAME units, so the stored view is the same for any model', () => {
    const b = runBridge({ geometry: 'custom', customModel: { kind: 'glb', id: 1 } });
    b.setFrame(100);
    b.poll();
    const r = b.reports('fs:camera').slice(-1)[0];
    expect([r.x, r.y, r.z, r.tx, r.ty, r.tz]).toEqual([0, 0, 8, 0, 0, 0]);
  });

  it('a frame set BEFORE the controls were ready is applied right after the restore', () => {
    const b = runBridge({ geometry: 'custom', customModel: { kind: 'glb', id: 1 }, initialCameraPosition: { x: 0, y: 0, z: 6 } }, { frame: 10 });
    expect(xyz(b.cam.position)).toEqual([0, 0, 60]);
  });

  it('a second model re-frames from the CURRENT frame, and frame 1 puts it all back', () => {
    const b = runBridge({ geometry: 'custom', customModel: { kind: 'glb', id: 1 } });
    b.setFrame(10);
    b.setFrame(0.5);
    expect(xyz(b.cam.position)).toEqual([0, 0, 4]);
    b.setFrame(1);
    expect(xyz(b.cam.position)).toEqual([0, 0, 8]);
    expect([b.controls.minDistance, b.controls.maxDistance]).toEqual([2, 80]);
    expect(b.cam.near).toBeCloseTo(0.005, 12);
  });

  it('the fly-through takes and reports its pose in frame units, and flies at the model\'s scale', () => {
    const b = runBridge({ geometry: 'custom', customModel: { kind: 'glb', id: 1 } }, { frame: 10 });
    b.message({ type: 'fs:fly', on: true, pose: { x: 1, y: 0, z: 5, yaw: 0, pitch: 0 } });
    expect(xyz(b.cam.position)).toEqual([10, 0, 50]);
    b.poll();
    const r = b.reports('fs:fly-pose').slice(-1)[0];
    expect([r.x, r.y, r.z]).toEqual([1, 0, 5]);
    // A new model while flying: the flyer keeps its place in the frame, and
    // the orbit controls are left alone until the flyer lands.
    const updates = b.controls.updates;
    b.setFrame(20);
    expect(xyz(b.cam.position)).toEqual([20, 0, 100]);
    expect(b.controls.updates).toBe(updates);
    // Landing returns to the orbit view, scaled with the rest.
    b.message({ type: 'fs:fly', on: false });
    expect(xyz(b.cam.position)).toEqual([0, 0, 160]);
  });

  it('the XR popup frames its flat camera too (it applies before the top-level return)', () => {
    const b = runBridge({ geometry: 'custom', customModel: { kind: 'glb', id: 1, url: 'blob:x' }, xr: true }, { frame: 5, topLevel: true });
    expect(xyz(b.cam.position)).toEqual([0, 0, 40]);
  });

  it('a built-in shape never moves the camera (its frame stays 1)', () => {
    const b = runBridge({ geometry: 'sphere', initialCameraPosition: { x: 0, y: 0, z: 8 } });
    expect(xyz(b.cam.position)).toEqual([0, 0, 8]);
    expect([b.controls.minDistance, b.controls.maxDistance]).toEqual([2, 80]);
  });
});
