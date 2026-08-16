/**
 * Pins `fs-stats` — the preview stage's FPS / frame-time reporter.
 *
 * Like `fit-bounds` and `gltf-anim`, it lives inside a template string destined
 * for the sandboxed iframe, so nothing normally runs it: an HTML test can only
 * assert the script is PRESENT, which leaves the body free to be rewritten into
 * something that never posts. A readout that silently stays on its placeholder
 * is indistinguishable from "the toggle is broken", so the maths and the gating
 * are executed here against a stub AFRAME.
 *
 * What matters, and why:
 *  - It must be SILENT until asked. The iframe is rebuilt on every shader edit,
 *    and an always-on 4x/s feed would be pure cost for a number nobody enabled.
 *  - The reported pair must be self-consistent (fps === 1000 / ms), because the
 *    two are read side by side and a mismatch is unfalsifiable by eye.
 *  - A backgrounded-tab gap must be DROPPED, not averaged in: one 30 s stall
 *    folded into the mean would peg the readout at a fictional 0.03 FPS long
 *    after the tab came back.
 *  - Switching off and on again must not treat the OFF interval as a frame.
 */

import { describe, it, expect } from 'vitest';
import { STATS_REPORT_SCRIPT, tslToPreviewHTML } from './tslToPreviewHTML';

interface StatsDef {
  init: () => void;
  remove: () => void;
  onMessage: (e: { source: unknown; data: unknown }) => void;
  tick: () => void;
}

interface Harness {
  def: StatsDef;
  posted: Array<{ type: string; fps: number; ms: number }>;
  /** Advance the fake clock and run one tick. */
  frame: (dtMs: number) => void;
  setOn: (on: boolean) => void;
}

/** Evaluate the component script with a stub AFRAME + a controllable clock. */
function load(): Harness {
  const body = STATS_REPORT_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const registry: Record<string, StatsDef> = {};
  const posted: Array<{ type: string; fps: number; ms: number }> = [];
  let now = 1000;

  const parent = { name: 'parent' };
  const win = {
    AFRAME: undefined as unknown,
    parent,
    performance: { now: () => now },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const AFRAME = {
    components: {} as Record<string, unknown>,
    registerComponent: (name: string, def: StatsDef) => { registry[name] = def; },
  };
  win.AFRAME = AFRAME;
  // The component posts via window.parent.postMessage.
  (parent as unknown as { postMessage: (m: unknown) => void }).postMessage = (m) => {
    posted.push(m as { type: string; fps: number; ms: number });
  };

  new Function('window', 'AFRAME', body)(win, AFRAME);
  const def = registry['fs-stats'];
  expect(def, 'fs-stats must register').toBeDefined();

  // `this` is the component instance; A-Frame calls these as methods.
  const inst = Object.create(def) as StatsDef;
  inst.init();

  return {
    def: inst,
    posted,
    frame: (dtMs: number) => { now += dtMs; inst.tick(); },
    setOn: (on: boolean) => inst.onMessage({ source: parent, data: { type: 'fs:stats-on', on } }),
  };
}

describe('fs-stats — the preview stage FPS reporter', () => {
  it('posts nothing until the parent switches it on', () => {
    const h = load();
    for (let i = 0; i < 120; i++) h.frame(16.7); // ~2 s of frames
    expect(h.posted).toHaveLength(0);
  });

  it('reports roughly 4x/s once enabled, and fps agrees with the frame period', () => {
    const h = load();
    h.setOn(true);
    // 1 s of perfect 60 Hz. The first tick only seeds `last`, so 61 frames
    // produce 60 measured deltas = 1002 ms of accumulation.
    for (let i = 0; i < 61; i++) h.frame(16.7);

    // 1002 ms / 250 ms window ≈ 4 reports.
    expect(h.posted.length).toBeGreaterThanOrEqual(3);
    expect(h.posted.length).toBeLessThanOrEqual(5);

    for (const p of h.posted) {
      expect(p.type).toBe('fs:stats');
      expect(p.ms).toBeCloseTo(16.7, 5);
      expect(p.fps).toBeCloseTo(1000 / 16.7, 5);
      // The pair is read side by side — they must describe one measurement.
      expect(p.fps).toBeCloseTo(1000 / p.ms, 9);
    }
  });

  it('drops a backgrounded-tab gap instead of averaging it into the mean', () => {
    const h = load();
    h.setOn(true);
    h.frame(16.7);          // seed
    h.frame(30_000);        // tab was hidden for 30 s — must not count
    for (let i = 0; i < 20; i++) h.frame(16.7);

    expect(h.posted.length).toBeGreaterThan(0);
    // Had the 30 s gap been folded in, the mean period would be in the
    // thousands of ms and fps far below 1.
    for (const p of h.posted) {
      expect(p.ms).toBeCloseTo(16.7, 5);
      expect(p.fps).toBeGreaterThan(30);
    }
  });

  it('stops posting when switched off, and the off-interval is not a frame', () => {
    const h = load();
    h.setOn(true);
    for (let i = 0; i < 40; i++) h.frame(16.7);
    const afterOn = h.posted.length;
    expect(afterOn).toBeGreaterThan(0);

    h.setOn(false);
    for (let i = 0; i < 40; i++) h.frame(16.7);
    expect(h.posted).toHaveLength(afterOn);

    // Re-enable after a long silent stretch: the very first report must not
    // carry the gap that elapsed while it was off.
    h.setOn(true);
    for (let i = 0; i < 40; i++) h.frame(16.7);
    expect(h.posted.length).toBeGreaterThan(afterOn);
    for (const p of h.posted.slice(afterOn)) expect(p.ms).toBeCloseTo(16.7, 5);
  });

  it('ignores messages that are not from the parent window', () => {
    const h = load();
    h.def.onMessage({ source: { some: 'other frame' }, data: { type: 'fs:stats-on', on: true } });
    for (let i = 0; i < 60; i++) h.frame(16.7);
    expect(h.posted).toHaveLength(0);
  });
});

describe('fs-stats wiring in the generated preview document', () => {
  const code = 'const color = vec3(1.0, 0.0, 0.0);\nreturn { color };';

  it('the editor preview registers and attaches fs-stats, not the XR panel', () => {
    const html = tslToPreviewHTML(code, { geometry: 'sphere' });
    expect(html).toContain('AFRAME.registerComponent("fs-stats"');
    expect(html).toContain(' fs-stats ');
    expect(html).not.toContain('fs-xr-stats');
  });

  it('the XR popup keeps its head-locked panel and does not carry the reporter', () => {
    const html = tslToPreviewHTML(code, { geometry: 'sphere', xr: true });
    expect(html).toContain('fs-xr-stats');
    // The popup is top-level: there is no parent to report to, so shipping the
    // reporter there would post into its own window 4x/s forever.
    expect(html).not.toContain('AFRAME.registerComponent("fs-stats"');
  });
});
