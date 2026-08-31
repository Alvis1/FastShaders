/**
 * Pins podest's immersive locomotion layer (`vr-nav`).
 *
 * The component lives inside `buildXrDoc`'s string builder in
 * `public/podest.html`, so it only ever executes inside a headset — the one
 * device with no reachable console, on a page nobody can step through. Every
 * number in it is a judgement about a physical space (how far back a visitor
 * stands, how closed a fist has to be, where the leash ends), and all of them
 * are silently wrong-able. Here the generated script is evaluated against a
 * real `three` and synthetic WebXR frames, so the maths runs for real.
 *
 * What these assertions are actually protecting:
 *  - **Entry framing.** A local-floor session puts the visitor at the
 *    reference-space origin, which is where the artwork is — fit-bounds
 *    normalizes every mesh to 1.6 units, so the first thing a headset showed
 *    was the inside of the sphere. Moving the ART instead cannot fix it:
 *    local-floor's yaw comes from the guardian, so "in front" is unknown until
 *    a pose arrives. The recenter therefore has to be measured from the first
 *    tracked frame, which is also why it reads the head from the FRAME and not
 *    from the camera object3D (tick runs before render, so on the session's
 *    first tick the camera still carries its flat orbit-controls transform —
 *    an entry framing measured off it is metres wrong).
 *  - **The bound is an annulus, and a clamp is not a refusal.** Aiming past
 *    the edge must still land you at the edge: a marker that vanishes reads as
 *    a broken button, which is how the 60 m ray cap (removed) put a dead zone
 *    exactly where "aim at the far edge" lives.
 *  - **The gesture is ours, not Meta's.** The microgesture recognizer is an
 *    OpenXR extension WebXR does not expose, so the fist/thumb button is
 *    classified here from raw joint poses. The thresholds are fractions of the
 *    wearer's own hand, and the arm delay + press/release hysteresis exist
 *    because the thumb is self-occluded by the fist at exactly the moment it
 *    is pressed.
 *  - **The visitor lands where the marker was**, not where the rig origin
 *    goes — someone who has physically walked two steps would otherwise
 *    arrive two steps off the ring they aimed at.
 *  - **The exhibit recovers itself.** A visitor who teleports across the room
 *    and hands the headset back must not strand the next one; idleness is
 *    measured on the HEAD, so it can only fire when the headset is off a face.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

const PODEST = new URL('../public/podest.html', import.meta.url);

/** Pull `pushVrNav` out of the page by brace-matching its body. */
function generatedScript(): string {
  const html = readFileSync(PODEST, 'utf8');
  const start = html.indexOf('  function pushVrNav(L) {');
  expect(start, 'podest.html is missing pushVrNav').toBeGreaterThan(-1);
  let depth = 0;
  let end = -1;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const source = html.slice(start, end);
  // The terminator MUST be escaped in the source: the HTML parser ends a
  // <script> element on that byte sequence wherever it appears.
  expect(source.includes("'<\\/script>'"), 'unescaped </script> in pushVrNav').toBe(true);
  const lines: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (new Function(`${source}; return pushVrNav;`) as () => (l: string[]) => void)()(lines);
  expect(lines[0]).toBe('<script>');
  expect(lines[lines.length - 1]).toBe('</script>');
  return lines.slice(1, -1).join('\n');
}

interface Rig { object3D: THREE.Object3D }
interface Overlay { visible: boolean; material: { opacity: number; color: THREE.Color } }
interface Nav {
  el: unknown;
  data: { radius: number; inner: number; home: number; target: { x: number; y: number; z: number } };
  head: THREE.Vector3;
  fwd: THREE.Vector3;
  marker: Overlay & { position: THREE.Vector3 };
  floor: Overlay;
  shell: Overlay;
  arc: Overlay & { count: number; parent: THREE.Object3D | null; getMatrixAt: (i: number, m: THREE.Matrix4) => void };
  handMesh: (THREE.Object3D & { getMatrixAt: (i: number, m: THREE.Matrix4) => void }) | null;
  aimSrc: unknown;
  aimMode: string;
  valid: boolean;
  needRecenter: boolean;
  pending: unknown;
  fadeDir: number;
  init(): void;
  onEnter(): void;
  onExit(): void;
  onSelStart(evt: unknown): void;
  onSelEnd(evt: unknown): void;
  tick(time: number, dt: number): void;
  cancel(): void;
  getRig(): Rig;
}

type Joints = [number, number, number][];
interface Source { hand?: { values: () => unknown[] }; handedness: string; targetRaySpace: unknown }

/** Scene + XR-frame stubs thin enough that the component's own maths is what runs. */
function makeNav() {
  const registry: Record<string, unknown> = {};
  const rig: Rig = { object3D: new THREE.Object3D() };
  const AFRAME = {
    components: {} as Record<string, unknown>,
    registerComponent: (name: string, def: unknown) => { registry[name] = def; },
  };
  const doc = { getElementById: (id: string) => (id === 'rig' ? rig : null) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'AFRAME', 'THREE', 'document', generatedScript())({ AFRAME }, AFRAME, THREE, doc);
  const def = registry['vr-nav'];
  expect(def, 'vr-nav was not registered').toBeTruthy();

  const root = new THREE.Object3D();
  root.add(rig.object3D);
  const ref = {};
  const state: { viewer: unknown; ray: unknown; joints: Joints | null } = { viewer: null, ray: null, joints: null };
  const session = { inputSources: [] as Source[], addEventListener() {}, removeEventListener() {} };
  const frame = {
    getViewerPose: () => state.viewer,
    getPose: () => state.ray,
    fillPoses: (_it: unknown, _r: unknown, arr: Float32Array) => {
      if (!state.joints) return false;
      for (let i = 0; i < 25; i++) {
        const [x, y, z] = state.joints[i];
        arr.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1], i * 16);
      }
      return true;
    },
    fillJointRadii: (_it: unknown, arr: Float32Array) => { arr.fill(0.008); return true; },
  };
  const sceneEl = {
    object3D: root,
    camera: { add() {} },
    frame,
    xrSession: session,
    renderer: { xr: { getReferenceSpace: () => ref } },
    is: () => true,
    addEventListener() {},
  };

  const nav = Object.create(def as object) as Nav;
  nav.el = sceneEl;
  nav.data = { radius: 30, inner: 1.2, home: 2.5, target: { x: 0, y: 1.4, z: 0 } };
  nav.init();
  nav.onEnter();

  const pose = (x: number, y: number, z: number, q: THREE.Quaternion = new THREE.Quaternion()) =>
    ({ transform: { position: { x, y, z }, orientation: { x: q.x, y: q.y, z: q.z, w: q.w } } });

  return {
    nav,
    rig,
    session,
    /** Head pose in the reference space, looking down -Z after `yawDeg`. */
    setViewer(x: number, y: number, z: number, yawDeg = 0) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(yawDeg));
      state.viewer = pose(x, y, z, q);
    },
    /** Aim ray: `pitchDeg` is negative for "pointing at the floor". */
    setRay(x: number, y: number, z: number, pitchDeg: number, yawDeg = 0) {
      const e = new THREE.Euler(THREE.MathUtils.degToRad(pitchDeg), THREE.MathUtils.degToRad(yawDeg), 0, 'YXZ');
      state.ray = pose(x, y, z, new THREE.Quaternion().setFromEuler(e));
    },
    setJoints(j: Joints | null) { state.joints = j; },
    tick(n = 1, dt = 16) { for (let i = 0; i < n; i++) nav.tick(0, dt); },
    /** Distance from the artwork's axis, in the ground plane. */
    headRadius() { return Math.hypot(nav.head.x - 0, nav.head.z - 0); },
    markerRadius() { return Math.hypot(nav.marker.position.x, nav.marker.position.z); },
  };
}

/**
 * A synthetic right hand ~9 cm across (wrist → middle metacarpal is the scale
 * every threshold is expressed in).
 *   open  — fingers extended, thumb out
 *   fist  — fingertips folded onto the palm, thumb standing up
 *   press — same fist, thumb folded down onto the index finger (the "button")
 */
function hand(mode: 'open' | 'fist' | 'press'): Joints {
  const wrist: [number, number, number] = [0, 1.2, 0];
  const palm: [number, number, number] = [0, 1.29, 0];            // 9 cm from the wrist = the hand scale
  const j: Joints = Array.from({ length: 25 }, () => [...palm] as [number, number, number]);
  j[0] = [...wrist];
  j[10] = [...palm];
  j[6] = [palm[0], palm[1] + 0.03, palm[2] + 0.01];                // index proximal (the knuckle)
  const tip: [number, number, number] = mode === 'open'
    ? [palm[0], palm[1] + 0.18, palm[2]]
    : [palm[0], palm[1] + 0.05, palm[2] + 0.02];
  for (const t of [9, 14, 19, 24]) j[t] = [...tip];
  // Thumb tip. "up" is (thumbTip.y − indexProximal.y) / handScale:
  //   open  → +0.55   fist(up) → +0.89   press → −0.11
  j[4] = mode === 'press' ? [palm[0] + 0.01, palm[1] + 0.02, palm[2] + 0.01]
    : mode === 'open' ? [palm[0] + 0.06, palm[1] + 0.08, palm[2]]
      : [palm[0], palm[1] + 0.11, palm[2]];
  return j;
}

const HAND_SRC: Source = { hand: { values: () => [] }, handedness: 'right', targetRaySpace: {} };
const CONTROLLER_SRC: Source = { handedness: 'left', targetRaySpace: {} };

describe('podest vr-nav — entry framing', () => {
  it('puts the head NAV_HOME back from the artwork, with the piece dead ahead', () => {
    const h = makeNav();
    h.setViewer(0, 1.6, 0);
    h.tick(2);                       // the recenter measures the PRE-move head
    expect(h.headRadius()).toBeCloseTo(2.5, 2);
    expect(h.nav.head.x + h.nav.fwd.x * 2.5).toBeCloseTo(0, 2);
    expect(h.nav.head.z + h.nav.fwd.z * 2.5).toBeCloseTo(0, 2);
  });

  it('frames from ANY start pose — local-floor yaw comes from the guardian', () => {
    const h = makeNav();
    h.setViewer(1.0, 1.6, -0.7, -90);   // standing off-centre, looking +X
    h.tick(2);
    expect(h.headRadius()).toBeCloseTo(2.5, 2);
    expect(h.nav.head.x + h.nav.fwd.x * 2.5).toBeCloseTo(0, 2);
    expect(h.nav.head.z + h.nav.fwd.z * 2.5).toBeCloseTo(0, 2);
  });
});

describe('podest vr-nav — hand gesture', () => {
  function armed() {
    const h = makeNav();
    h.session.inputSources = [HAND_SRC];
    h.setViewer(0, 1.6, 0);
    h.setRay(0, 1.3, 0, -45);
    h.tick(2);
    return h;
  }

  it('never arms on an open hand', () => {
    const h = armed();
    h.setJoints(hand('open'));
    h.tick(6);
    expect(h.nav.aimSrc).toBeNull();
  });

  it('arms on a held fist, not on a passing one', () => {
    const h = armed();
    h.setJoints(hand('fist'));
    h.tick(3);
    expect(h.nav.aimSrc).toBeNull();      // 4-frame arm
    h.tick(2);
    expect(h.nav.aimSrc).toBe(HAND_SRC);
    expect(h.nav.aimMode).toBe('fist');
    expect(h.nav.marker.visible).toBe(true);
    expect(h.nav.floor.visible).toBe(true);   // the floor guide is aim-only
  });

  it('commits on the thumb press and lands the HEAD on the marker', () => {
    const h = armed();
    h.setJoints(hand('fist'));
    h.tick(5);
    const target = h.nav.marker.position.clone();
    const before = h.nav.head.clone();
    h.setJoints(hand('press'));
    h.tick(2);                                 // never on the arming frame
    expect(h.nav.pending).toBeTruthy();
    expect(h.nav.fadeDir).toBe(1);            // the jump happens at full black
    h.tick(8);
    expect(h.nav.head.x).toBeCloseTo(target.x, 2);
    expect(h.nav.head.z).toBeCloseTo(target.z, 2);
    expect(before.distanceTo(h.nav.head)).toBeGreaterThan(0.5);
    h.tick(14);
    expect(h.nav.fadeDir).toBe(0);
    expect(h.nav.shell.material.opacity).toBe(0);
  });

  it('does not read a held thumbs-up fist as a press (the on-device latch bug)', () => {
    // The first build measured thumb→knuckle DISTANCE with press < 0.55 and
    // release > 0.85 of the hand scale — a thumbs-up fist sits inside that
    // band, so the button latched pressed on the arming frame, commit() no-op'd
    // (no target computed yet), and it could never release. Nothing teleported
    // again, and the pinch path died with it because a fist-owned hand ignores
    // `select`.
    const h = armed();
    h.setJoints(hand('fist'));
    h.tick(30);                                  // half a second of holding it
    expect(h.nav.pending, 'a thumbs-up fist fired a teleport').toBeFalsy();
    // …and the button still works afterwards.
    h.setJoints(hand('press'));
    h.tick(2);
    expect(h.nav.pending).toBeTruthy();
  });

  it('fires again after the thumb comes back up', () => {
    const h = armed();
    h.setJoints(hand('fist'));
    h.tick(5);
    h.setJoints(hand('press'));
    h.tick(2);
    const first = h.nav.pending;
    expect(first).toBeTruthy();
    h.tick(10);                                  // ride the blink out
    h.setJoints(hand('fist'));                   // thumb back up = button released
    h.tick(2);
    h.setJoints(hand('press'));
    h.tick(2);
    expect(h.nav.pending, 'the button only worked once').toBeTruthy();
  });

  it('cancels when the fist opens, and hides the guides', () => {
    const h = armed();
    h.setJoints(hand('fist'));
    h.tick(5);
    h.setJoints(hand('open'));
    h.tick(1);
    expect(h.nav.aimSrc).toBeNull();
    expect(h.nav.marker.visible).toBe(false);
  });

  it('ignores select from a hand the fist gesture owns (a tight fist reads as a pinch)', () => {
    const h = armed();
    h.setJoints(hand('fist'));
    h.tick(5);
    h.nav.cancel();                            // gesture still held, aim released
    h.nav.onSelStart({ inputSource: HAND_SRC });
    expect(h.nav.aimSrc).toBeNull();
  });
});

describe('podest vr-nav — controller / pinch select', () => {
  it('aims while held and commits on release', () => {
    const h = makeNav();
    h.session.inputSources = [CONTROLLER_SRC];
    h.setViewer(0, 1.6, 0);
    h.tick(2);
    h.setRay(0, 1.3, 0, -40);
    h.nav.onSelStart({ inputSource: CONTROLLER_SRC });
    expect(h.nav.aimMode).toBe('select');
    h.tick(1);
    expect(h.nav.marker.visible).toBe(true);
    const target = h.nav.marker.position.clone();
    h.nav.onSelEnd({ inputSource: CONTROLLER_SRC });
    expect(h.nav.aimSrc).toBeNull();
    h.tick(10);
    expect(h.nav.head.x).toBeCloseTo(target.x, 2);
    expect(h.nav.head.z).toBeCloseTo(target.z, 2);
  });
});

describe('podest vr-nav — the 30-unit bound', () => {
  function aiming() {
    const h = makeNav();
    h.setViewer(0, 1.6, 0);
    h.tick(2);
    h.rig.object3D.position.set(0, 0, 0);
    h.rig.object3D.updateMatrixWorld(true);
    h.nav.aimSrc = CONTROLLER_SRC;
    h.nav.aimMode = 'select';
    return h;
  }

  it('clamps a far aim to the edge instead of refusing it', () => {
    const h = aiming();
    h.setRay(0, 1.3, 0, -1.2);                 // near-horizontal: ~62 m out
    h.tick(1);
    expect(h.nav.valid).toBe(true);
    expect(h.markerRadius()).toBeCloseTo(30, 1);
    expect(h.nav.marker.material.color.getHex()).toBe(0xffb020);   // clamped reads amber
  });

  it('keeps the visitor out of the artwork', () => {
    const h = aiming();
    h.setRay(0.15, 1.3, 0.15, -89);            // straight down at its foot
    h.tick(1);
    expect(h.markerRadius()).toBeGreaterThanOrEqual(1.2 - 1e-6);
  });

  it('leaves an in-range aim untouched', () => {
    const h = aiming();
    h.setRay(0, 1.3, 4, -30);
    h.tick(1);
    const r = h.markerRadius();
    expect(r).toBeGreaterThan(1.2);
    expect(r).toBeLessThan(30);
    expect(h.nav.marker.material.color.getHex()).toBe(0x4ea1ff);
  });

  it('offers no target when the ray points at the sky', () => {
    const h = aiming();
    h.setRay(0, 1.3, 3, +20);
    h.tick(1);
    expect(h.nav.valid).toBe(false);
    expect(h.nav.marker.visible).toBe(false);
  });
});

describe('podest vr-nav — hands and the aim arc', () => {
  function aiming() {
    const h = makeNav();
    h.session.inputSources = [HAND_SRC];
    h.setViewer(0, 1.6, 0);
    h.setRay(0, 1.3, 0, -45);
    h.tick(2);
    h.setJoints(hand('fist'));
    h.tick(5);
    return h;
  }

  it('parents the hand joints to the RIG, so they follow a teleport', () => {
    // A-Frame's hand-tracking-controls hangs its joints off a wristObject3D
    // added to the SCENE ROOT, so they ignore the rig entirely — measured on
    // a headset as hands sitting metres from the real ones. Drawing them here
    // is the fix, and this is the assertion that keeps them in the rig.
    const h = aiming();
    expect(h.nav.handMesh, 'no hand mesh was built').toBeTruthy();
    expect(h.nav.handMesh!.parent).toBe(h.rig.object3D);
  });

  it('tracks the joints, and drops them when the hand is lost', () => {
    const h = aiming();
    const m = new THREE.Matrix4();
    h.nav.handMesh!.getMatrixAt(24 + 1, m);                   // first joint of the right hand
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect(p.length()).toBeGreaterThan(0.5);                  // a real wrist, not the origin
    h.setJoints(null);
    h.tick(1);
    h.nav.handMesh!.getMatrixAt(24 + 1, m);
    expect(new THREE.Vector3().setFromMatrixScale(m).length()).toBe(0);
  });

  it('draws the arc while aiming and lands its last bead on the marker', () => {
    const h = aiming();
    expect(h.nav.arc.visible).toBe(true);
    const m = new THREE.Matrix4();
    h.nav.arc.getMatrixAt(h.nav.arc.count - 1, m);
    const last = new THREE.Vector3().setFromMatrixPosition(m);
    expect(last.distanceTo(h.nav.marker.position)).toBeLessThan(0.35);
  });

  it('lifts the arc off the straight line, so it reads as an arc', () => {
    const h = aiming();
    const m = new THREE.Matrix4();
    const mid = new THREE.Vector3();
    h.nav.arc.getMatrixAt(Math.floor(h.nav.arc.count / 2), m);
    mid.setFromMatrixPosition(m);
    const chord = new THREE.Vector3().addVectors(h.nav.marker.position, new THREE.Vector3(0, 0.02, 0));
    // The midpoint bead must sit above the straight hand→marker chord.
    const straightY = (1.3 + chord.y) / 2;
    expect(mid.y).toBeGreaterThan(straightY + 0.05);
  });

  it('hides the arc when the aim is released', () => {
    const h = aiming();
    h.setJoints(hand('open'));
    h.tick(1);
    expect(h.nav.arc.visible).toBe(false);
    expect(h.nav.marker.visible).toBe(false);
  });
});

describe('podest vr-nav — unattended exhibit', () => {
  it('returns a stranded visitor to the artwork after 90 s of a motionless head', () => {
    const h = makeNav();
    h.setViewer(0, 1.6, 0);
    h.tick(2);
    h.rig.object3D.position.set(0, 0, 18);     // teleported across the room
    h.rig.object3D.updateMatrixWorld(true);
    h.tick(2);                                  // stillness baseline
    h.tick(902, 100);                           // 90 s of nobody wearing it
    h.tick(20);                                 // ride the blink
    expect(h.headRadius()).toBeCloseTo(2.5, 1);
  });

  it('does not blink an empty room every 90 s once it is already home', () => {
    const h = makeNav();
    h.setViewer(0, 1.6, 0);
    h.tick(2);
    h.tick(902, 100);
    h.tick(20);
    const settled = h.rig.object3D.position.clone();
    h.tick(902, 100);
    h.tick(20);
    expect(h.rig.object3D.position.distanceTo(settled)).toBeLessThan(0.36);
  });

  it('restores the flat framing on exit-vr', () => {
    const h = makeNav();
    h.setViewer(0, 1.6, 0);
    h.tick(2);
    expect(h.rig.object3D.position.length()).toBeGreaterThan(0);
    h.nav.onExit();
    expect(h.rig.object3D.position.length()).toBe(0);
    expect(h.nav.marker.visible).toBe(false);
    expect(h.nav.floor.visible).toBe(false);
    expect(h.nav.shell.visible).toBe(false);
  });
});

describe('podest vr-nav — offline + wiring', () => {
  it("does not use A-Frame's hand-tracking-controls", () => {
    // It parents its joint dots to a wristObject3D on the SCENE ROOT, so they
    // can never follow a camera rig — the on-device symptom was hands sitting
    // metres away from the real ones. vr-nav draws them instead.
    const html = readFileSync(PODEST, 'utf8');
    const used = html.split('\n').filter((l) => l.includes('hand-tracking-controls=') && !l.trimStart().startsWith('//'));
    expect(used).toEqual([]);
    // Nothing requests the feature for us any more, so the scene must.
    expect(html).toContain('optionalFeatures: hand-tracking');
    // Offline rule: nothing in the VR document may reach a CDN.
    const cdn = html.split('\n').filter((l) => l.includes('cdn.aframe.io') && !l.trimStart().startsWith('//'));
    expect(cdn).toEqual([]);
  });

  it('requests hand-tracking on the scene and wraps the camera in the rig', () => {
    const html = readFileSync(PODEST, 'utf8');
    // Matched by vr-nav rather than by the tag's leading attribute: the scene
    // also carries renderer="backend: webgl" (the WebXR backend force — see
    // aframeBackendProperty.test.ts), and attribute order is not this test's
    // business.
    const scene = html.split('\n').find((l) => l.includes('<a-scene') && l.includes('vr-nav='));
    expect(scene).toBeTruthy();
    expect(scene).toContain('optionalFeatures: hand-tracking');
    expect(scene).toContain('vr-mode-ui="enabled: true"');
    const rig = html.indexOf(`L.push('  <a-entity id="rig"`);
    const cam = html.indexOf('orbit-controls="target');
    expect(rig).toBeGreaterThan(-1);
    expect(cam).toBeGreaterThan(rig);   // the camera is INSIDE the rig, or teleport moves nothing
  });
});
