/**
 * The orbit TARGET across a cold rebuild, stage side (BRIDGE_SCRIPT_TEMPLATE in
 * tslToPreviewHTML.ts), executed.
 *
 * The preview's orbit controls pan (right-drag), which moves the target with
 * the camera. A cold rebuild restored the camera POSITION alone, so the camera
 * stayed where the pan left it and turned to face the origin. Rare while only
 * the user caused cold rebuilds; the retained-memory budget now runs one at a
 * quiet moment (components/Preview/previewMemoryBudget.ts), and in the real app
 * a pan to target (-1.29, 0, 0) came back as (0, 0, 0) after it (review
 * 2026-10-11). Now every `fs:camera` report carries the target (tx, ty, tz),
 * the parent keeps it beside the position for the session, and the next
 * document restores both.
 *
 * The bridge script is extracted from the generated document and run against
 * a stub camera, orbit controls and parent (the previewGeometryApply.test.ts
 * technique).
 */
import { describe, it, expect } from 'vitest';
import { tslToPreviewHTML, type PreviewOptions } from './tslToPreviewHTML';

const TSL = "import { vec3 } from 'three/tsl';\nconst shader = Fn(() => { return vec3(1); });\nexport default shader;\n";

function extractBridge(html: string): { head: string; body: string } {
  const at = html.indexOf('var __lastGeometryKey');
  expect(at, 'bridge script missing from the document').toBeGreaterThan(-1);
  const open = html.lastIndexOf('<script>', at);
  const close = html.indexOf('</script>', at);
  return { head: html.slice(open, open + 400), body: html.slice(open + '<script>'.length, close) };
}

type V = { x: number; y: number; z: number };
const vec = (x = 0, y = 0, z = 0) => ({ x, y, z, set(a: number, b: number, c: number) { this.x = a; this.y = b; this.z = c; } });

function runBridge(options: PreviewOptions, topLevel = false) {
  const posted: Record<string, unknown>[] = [];
  const intervals: (() => void)[] = [];
  const cam = { position: vec(0, 0, 8) };
  let updates = 0;
  const controls = { target: vec(), update: () => { updates++; } };
  const camEl = {
    components: { 'orbit-controls': { controls } },
    getObject3D: (name: string) => (name === 'camera' ? cam : null),
  };
  const entity = { components: {}, getObject3D: () => null, addEventListener() {}, removeEventListener() {} };
  const spinEl = { object3D: { rotation: { x: 0, y: 0, z: 0 } } };
  const sceneEl = { hasLoaded: true, resize() {}, addEventListener() {} };
  const win: Record<string, unknown> = {};
  const parent = topLevel ? win : { postMessage: (m: Record<string, unknown>) => { posted.push(m); } };
  Object.assign(win, { parent, postMessage: (m: Record<string, unknown>) => { posted.push(m); }, addEventListener() {} });
  const doc = {
    getElementById: (id: string) => (id === 'preview-entity' ? entity : id === 'spin-parent' ? spinEl : null),
    querySelector: (sel: string) => (sel === '[camera]' ? camEl : sel === 'a-scene' ? sceneEl : null),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'document', '__fsWhenSceneBooted', 'setTimeout', 'setInterval', extractBridge(tslToPreviewHTML(TSL, options)).body)(
    win,
    doc,
    (fn: () => void) => fn(),
    () => 0,
    (fn: () => void) => { intervals.push(fn); return 0; },
  );
  return {
    saved: () => ({ pos: win.__savedCameraPos as V | null, target: win.__savedCameraTarget as V | null }),
    cam, controls, updates: () => updates,
    /** Run every poller once (the camera one and the rotation one). */
    poll() { for (const fn of intervals) fn(); },
    cameraReports: () => posted.filter((m) => m.type === 'fs:camera'),
  };
}

describe('the orbit target is restored WITH the position', () => {
  it('a baked target is set on the controls before their update, beside the restored position', () => {
    const b = runBridge({ geometry: 'sphere', initialCameraPosition: { x: -1.29, y: 0, z: 8 }, initialCameraTarget: { x: -1.29, y: 0, z: 0 } });
    expect(b.saved()).toEqual({ pos: { x: -1.29, y: 0, z: 8 }, target: { x: -1.29, y: 0, z: 0 } });
    expect([b.cam.position.x, b.cam.position.y, b.cam.position.z]).toEqual([-1.29, 0, 8]);
    expect([b.controls.target.x, b.controls.target.y, b.controls.target.z]).toEqual([-1.29, 0, 0]);
    expect(b.updates()).toBe(1);
  });

  it('no target, or a target with no position, leaves the controls facing the origin (today’s behaviour)', () => {
    const none = runBridge({ geometry: 'sphere', initialCameraPosition: { x: 0, y: 2, z: 8 } });
    expect(none.saved().target).toBeNull();
    expect([none.controls.target.x, none.controls.target.y, none.controls.target.z]).toEqual([0, 0, 0]);
    const orphan = runBridge({ geometry: 'sphere', initialCameraTarget: { x: 5, y: 0, z: 0 } });
    expect(orphan.saved()).toEqual({ pos: null, target: null });
    expect([orphan.controls.target.x, orphan.controls.target.y, orphan.controls.target.z]).toEqual([0, 0, 0]);
  });

  it('a non-finite target is never baked (JSON would spell it null; the literal is null outright)', () => {
    for (const bad of [NaN, Infinity]) {
      const html = tslToPreviewHTML(TSL, { geometry: 'sphere', initialCameraPosition: { x: 0, y: 0, z: 8 }, initialCameraTarget: { x: bad, y: 0, z: 0 } });
      expect(html).toContain('window.__savedCameraTarget = null;');
    }
  });

  it('the XR popup restores it too (it renders what the pane renders) and reports nothing', () => {
    const b = runBridge({ geometry: 'sphere', xr: true, initialCameraPosition: { x: 1, y: 0, z: 8 }, initialCameraTarget: { x: 1, y: 0, z: 0 } }, true);
    expect([b.controls.target.x, b.controls.target.y, b.controls.target.z]).toEqual([1, 0, 0]);
    b.cam.position.set(2, 0, 8);
    b.poll();
    expect(b.cameraReports()).toEqual([]);
  });
});

describe('every fs:camera report carries the target', () => {
  it('the poller posts the position and the CURRENT controls’ target', () => {
    const b = runBridge({ geometry: 'sphere' });
    b.cam.position.set(-1.29, 0, 8);
    b.controls.target.set(-1.29, 0, 0);
    b.poll();
    expect(b.cameraReports()).toEqual([{ type: 'fs:camera', x: -1.29, y: 0, z: 8, tx: -1.29, ty: 0, tz: 0 }]);
    // Unchanged position: no new report (a pan always moves the position too).
    b.poll();
    expect(b.cameraReports()).toHaveLength(1);
  });
});
