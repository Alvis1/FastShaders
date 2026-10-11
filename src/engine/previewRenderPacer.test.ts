/**
 * The sandboxed preview's RENDER PACER (RENDER_PACER_SCRIPT in
 * tslToPreviewHTML.ts), executed.
 *
 * A-Frame draws every display frame whether or not anything moved; the pacer
 * replaces the scene's animation loop on `renderstart` with one that draws
 * while the parent says the scene is continuous (fs:render-mode), for
 * RENDER_DIRTY_MS after anything changed, and otherwise at a
 * RENDER_HEARTBEAT_MS floor. The failure modes are all quiet ones — a frozen
 * pane after an edit, an orbit that stops mid-damping, a time-driven shader
 * stepping at 2 Hz — so every input that must reopen the window is driven
 * here against a stub scene and a fake clock, through the shipped bytes.
 *
 * Browser-only, and checked in Chrome against the dev server on 2026-10-11:
 * that A-Frame's loop really is replaced (renderer.setAnimationLoop ordering),
 * and the rendered frame counts at idle, during an orbit drag and with `time`.
 */
import { describe, it, expect } from 'vitest';
import {
  RENDER_DIRTY_MS,
  RENDER_HEARTBEAT_MS,
  RENDER_MODE_MESSAGE,
  tslToPreviewHTML,
} from './tslToPreviewHTML';

const TSL = "import { vec3 } from 'three/tsl';\nconst shader = Fn(() => { return vec3(1); });\nexport default shader;\n";
const MARKER = `m.type === "${RENDER_MODE_MESSAGE}"`;

function extractPacer(html: string): string {
  const at = html.indexOf(MARKER);
  expect(at, 'render pacer missing from the document').toBeGreaterThan(-1);
  const open = html.lastIndexOf('<script>', at);
  const close = html.indexOf('</script>', at);
  return html.slice(open + '<script>'.length, close);
}

type Listener = (ev?: unknown) => void;

function listenerBag() {
  const map = new Map<string, Listener[]>();
  return {
    add: (type: string, fn: Listener) => { (map.get(type) ?? map.set(type, []).get(type)!).push(fn); },
    fire: (type: string, ev?: unknown) => { for (const fn of [...(map.get(type) ?? [])]) fn(ev); },
    count: (type: string) => map.get(type)?.length ?? 0,
  };
}

function makePacer(opts: { renderStarted?: boolean; booted?: boolean } = {}) {
  let now = 10_000;
  let renders = 0;
  let timerUpdates = 0;
  let loop: ((t: number, frame?: unknown) => void) | null = null;
  const winEvents = listenerBag();
  const sceneEvents = listenerBag();

  const makeControls = () => {
    const bag = listenerBag();
    return { addEventListener: (t: string, fn: Listener) => bag.add(t, fn), fire: bag.fire, count: bag.count };
  };
  const orbit: { controls: ReturnType<typeof makeControls> | null } = { controls: makeControls() };
  const camEl = { components: { 'orbit-controls': orbit } };

  const scene = {
    renderStarted: opts.renderStarted ?? false,
    renderer: {
      setAnimationLoop: (fn: (t: number, frame?: unknown) => void) => { loop = fn; return Promise.resolve(); },
    },
    render: () => { renders++; },
    timer: { update: () => { timerUpdates++; } },
    addEventListener: (t: string, fn: Listener) => sceneEvents.add(t, fn),
    querySelector: (sel: string) => (sel === '[orbit-controls]' ? camEl : null),
  };
  const parent = { postMessage() {} };
  const bootQueue: (() => void)[] = [];
  let booted = opts.booted ?? true;
  const win = {
    parent,
    performance: { now: () => now },
    addEventListener: (t: string, fn: Listener) => winEvents.add(t, fn),
    __fsWhenSceneBooted: (fn: () => void) => { if (booted) fn(); else bootQueue.push(fn); },
  };
  const doc = { querySelector: (sel: string) => (sel === 'a-scene' ? scene : null) };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'document', extractPacer(tslToPreviewHTML(TSL, { geometry: 'sphere' })))(win, doc);

  const api = {
    scene, orbit, makeControls, winEvents, sceneEvents,
    renders: () => renders,
    timerUpdates: () => timerUpdates,
    installed: () => loop !== null,
    boot() { booted = true; for (const fn of bootQueue.splice(0)) fn(); },
    startRender() { scene.renderStarted = true; sceneEvents.fire('renderstart'); },
    /** Advance the clock and run `n` display frames of `dt` ms each; returns frames drawn. */
    frames(n: number, dt = 1000 / 120) {
      const before = renders;
      for (let i = 0; i < n; i++) { now += dt; loop!(now); }
      return renders - before;
    },
    /** Let `ms` of display frames pass. */
    idle(ms: number, dt = 1000 / 120) { return api.frames(Math.round(ms / dt), dt); },
    send(data: unknown, source: unknown = parent) { winEvents.fire('message', { source, data }); },
    mode(continuous: unknown) { api.send({ type: RENDER_MODE_MESSAGE, continuous }); },
  };
  return api;
}

/** Put a pacer into the idle state: non-continuous, the dirty window expired. */
function idlePacer() {
  const p = makePacer({ renderStarted: true });
  p.mode(false);
  p.idle(RENDER_DIRTY_MS + 100);
  return p;
}

describe('render pacer: where it is emitted', () => {
  it('rides every sandboxed preview document', () => {
    for (const geometry of ['sphere', 'cube', 'plane', 'teapot', 'bunny', 'marchSphere'] as const) {
      expect(tslToPreviewHTML(TSL, { geometry })).toContain(MARKER);
    }
    expect(tslToPreviewHTML(TSL, { geometry: 'custom', customModel: { kind: 'glb', id: 3 } })).toContain(MARKER);
    expect(tslToPreviewHTML(TSL, { geometry: 'custom', customModel: { kind: 'spz', id: 4 } })).toContain(MARKER);
  });

  it('is absent from the XR popup, which keeps A-Frame’s own loop', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere', xr: true });
    expect(html).not.toContain(RENDER_MODE_MESSAGE);
    expect(html).not.toContain('setAnimationLoop');
  });

  it('leaves the 6 s renderStarted watchdog in the boot script', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'sphere' });
    expect(html).toContain('if (s && !s.renderStarted) {');
    expect(html).toContain('}, 6000);');
  });
});

describe('render pacer: installing', () => {
  it('replaces the loop on renderstart, not before', () => {
    const p = makePacer({ renderStarted: false });
    expect(p.installed()).toBe(false);
    p.startRender();
    expect(p.installed()).toBe(true);
  });

  it('installs at once when rendering already started, and waits for the scene to boot', () => {
    expect(makePacer({ renderStarted: true }).installed()).toBe(true);
    const p = makePacer({ renderStarted: true, booted: false });
    expect(p.installed()).toBe(false);
    p.boot();
    expect(p.installed()).toBe(true);
  });
});

describe('render pacer: when it draws', () => {
  it('draws every frame until the first fs:render-mode arrives', () => {
    const p = makePacer({ renderStarted: true });
    expect(p.idle(5000)).toBe(600);
  });

  it('continuous: false draws through the dirty window, then only at the heartbeat', () => {
    const p = makePacer({ renderStarted: true });
    p.mode(false);
    // The message itself is a change: the window is open for RENDER_DIRTY_MS.
    const inWindow = p.idle(RENDER_DIRTY_MS - 20);
    expect(inWindow).toBeGreaterThan(110);
    // Ten idle seconds at 120 Hz: about two frames a second.
    p.idle(100);
    const idle = p.idle(10_000);
    expect(idle).toBeGreaterThanOrEqual(18);
    expect(idle).toBeLessThanOrEqual(21);
  });

  it('never leaves more than a heartbeat (plus one frame) between two drawn frames', () => {
    const p = idlePacer();
    let gap = 0;
    let worst = 0;
    for (let i = 0; i < 1200; i++) {
      if (p.frames(1)) { worst = Math.max(worst, gap); gap = 0; } else gap += 1000 / 120;
    }
    expect(worst).toBeLessThanOrEqual(RENDER_HEARTBEAT_MS + 1000 / 120);
  });

  it('a skipped frame still advances A-Frame’s clock, so ticks never see the idle stretch as one delta', () => {
    const p = idlePacer();
    const drawnBefore = p.renders();
    const updatesBefore = p.timerUpdates();
    p.idle(2000);
    const skipped = 240 - (p.renders() - drawnBefore);
    expect(p.timerUpdates() - updatesBefore).toBe(skipped);
  });

  it('continuous: true draws every frame again, and a malformed mode is ignored', () => {
    const p = idlePacer();
    p.mode(true);
    expect(p.idle(5000)).toBe(600);
    p.mode('false');
    p.mode(0);
    expect(p.idle(5000)).toBe(600);
  });
});

describe('render pacer: what reopens the window', () => {
  /** Frames drawn in the 900 ms after `poke`, from idle. */
  function afterPoke(poke: (p: ReturnType<typeof makePacer>) => void) {
    const p = idlePacer();
    poke(p);
    return p.idle(900);
  }
  const IDLE = afterPoke(() => {});

  it('idle baseline: only heartbeat frames', () => {
    expect(IDLE).toBeLessThanOrEqual(2);
  });

  it('any message from the parent, of any type', () => {
    for (const type of ['fs:shader', 'fs:uniform', 'fs:geometry', 'fs:image-assets', 'fs:bg-color', 'fs:lighting',
      'fs:playing', 'fs:anim-set', 'fs:highlight-mesh', 'fs:obj-model', 'fs:stats-on', 'fs:shot', 'fs:reset-camera', 'fs:new-thing']) {
      expect(afterPoke((p) => p.send({ type })), type).toBeGreaterThan(100);
    }
  });

  it('but not a message from another window, which also cannot set the mode', () => {
    expect(afterPoke((p) => p.send({ type: 'fs:uniform' }, { other: true }))).toBe(IDLE);
    const p = idlePacer();
    p.send({ type: RENDER_MODE_MESSAGE, continuous: true }, { other: true });
    expect(p.idle(2000)).toBeLessThan(10);
  });

  it('the entity’s apply and load events, which bubble to the window, and a window resize', () => {
    // A splat's runtime emits model-loaded too.
    for (const type of ['shader-applied', 'shader-error', 'model-loaded', 'model-error', 'resize']) {
      expect(afterPoke((p) => p.winEvents.fire(type)), type).toBeGreaterThan(100);
    }
  });

  it('the scene’s rendererresize (which the bridge’s resize kicks emit)', () => {
    expect(afterPoke((p) => p.sceneEvents.fire('rendererresize'))).toBeGreaterThan(100);
  });

  it('pointer, wheel and key input in the frame — a pointermove only while a button is down', () => {
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'wheel', 'keydown', 'keyup']) {
      expect(afterPoke((p) => p.winEvents.fire(type, {})), type).toBeGreaterThan(100);
    }
    expect(afterPoke((p) => p.winEvents.fire('pointermove', { buttons: 1 }))).toBeGreaterThan(100);
    expect(afterPoke((p) => p.winEvents.fire('pointermove', { buttons: 0 }))).toBe(IDLE);
  });

  it('the orbit controls’ change, re-extending the window while damping settles', () => {
    const p = idlePacer();
    // The controls are hooked from inside the loop, so one frame has passed.
    expect(p.orbit.controls!.count('change')).toBe(1);
    // Damping: `change` fires from inside each drawn frame for 3 s.
    let drawn = 0;
    for (let i = 0; i < 360; i++) {
      if (p.frames(1)) drawn++;
      if (i === 0 || drawn > 0) p.orbit.controls!.fire('change');
    }
    expect(drawn).toBeGreaterThan(350);
  });

  it('a NEW controls object (orbit-controls rebuilds it on play) is hooked too', () => {
    const p = idlePacer();
    const fresh = p.makeControls();
    p.orbit.controls = fresh;
    p.frames(1);
    expect(fresh.count('change')).toBe(1);
    fresh.fire('change');
    expect(p.idle(900)).toBeGreaterThan(100);
  });
});
