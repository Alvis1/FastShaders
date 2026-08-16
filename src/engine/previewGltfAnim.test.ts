/**
 * Pins the `gltf-anim` component — the preview's glTF animation mixer.
 *
 * Like `fit-bounds`, it lives inside a template string destined for the preview
 * iframe, so nothing normally executes it: `tslToPreviewHTML.test.ts` can only
 * assert that the attribute and the script are PRESENT, which leaves the whole
 * body free to be rewritten or broken without a failure. Here the script is
 * evaluated against a real `three` and a stub AFRAME, so the clip maths runs.
 *
 * What matters, and why:
 *  - The in-place variant is the one piece of real logic. It must freeze the
 *    root translation and NOTHING else — freezing a rotation track would kill
 *    a turning character, and freezing a descendant's position would collapse
 *    the rig it is meant to leave alone.
 *  - It must not mutate the authored clip: both variants are held at once and
 *    the toggle swaps between them, so a mutation would make "in place" a
 *    one-way door for the rest of the session.
 *  - A clip with no root translation must report that fact rather than
 *    silently producing an identical twin — the parent disables the toggle on
 *    it, and a button that does nothing reads as broken.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTF_ANIM_SCRIPT } from './tslToPreviewHTML';

interface ComponentDef {
  schema: Record<string, unknown>;
  init: () => void;
  remove: () => void;
  onModel: () => void;
  bind: (time: number) => void;
  update: (oldData: unknown) => void;
  tick: (t: number, dt: number) => void;
  post: (msg: unknown) => void;
  report: (has: boolean, names?: string[]) => void;
  onMessage: (e: { source: unknown; data: unknown }) => void;
  seek: (time: number) => void;
}

interface Loaded {
  inPlaceClip: (clip: THREE.AnimationClip, root: THREE.Object3D) => THREE.AnimationClip | null;
  depthOf: (root: THREE.Object3D, obj: THREE.Object3D | null) => number;
  def: ComponentDef;
}

/** Evaluate a component script body with a stub AFRAME and hand back its internals. */
function evalScript(body: string): Loaded {
  const registry: Record<string, ComponentDef> = {};
  const AFRAME = {
    components: {} as Record<string, unknown>,
    registerComponent: (name: string, def: ComponentDef) => { registry[name] = def; },
  };
  const win = { AFRAME, addEventListener: () => {}, removeEventListener: () => {} };
  const out = new Function(
    'THREE', 'window', 'AFRAME',
    `${body}\nreturn { inPlaceClip: __inPlaceClip, depthOf: __depthOf };`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  )(THREE, win, AFRAME) as any;
  expect(registry['gltf-anim'], 'gltf-anim was not registered').toBeTruthy();
  return { inPlaceClip: out.inPlaceClip, depthOf: out.depthOf, def: registry['gltf-anim'] };
}

function loadScript(): Loaded {
  return evalScript(GLTF_ANIM_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, ''));
}

/**
 * `public/podest.html` carries a hand-minified twin (pushGltfAnim), covered by
 * NO sync plugin — exactly like its `fit-bounds` twin, and drift there would be
 * invisible until an exhibit stood still on a pedestal. Extracted the same way
 * previewFitBounds.test.ts extracts its own: each helper is one `L.push('…')`
 * line whose payload quotes with `"`, so the single-quoted host needs no
 * unescaping.
 */
function loadPodestScript(): Loaded {
  const html = readFileSync(new URL('../../public/podest.html', import.meta.url), 'utf8');
  const wanted = ['function __depthOf', 'function __inPlaceClip', 'AFRAME.registerComponent("gltf-anim"'];
  const parts = wanted.map((needle) => {
    const line = html.split('\n').find((l) => l.trim().startsWith(`L.push('  ${needle}`));
    expect(line, `podest.html is missing its ${needle} push`).toBeTruthy();
    const body = line!.trim().replace(/^L\.push\('/, '').replace(/'\);$/, '');
    expect(body).not.toContain("\\'");
    return body;
  });
  return evalScript(parts.join('\n'));
}

const track = (name: string, times: number[], values: number[]) =>
  new THREE.VectorKeyframeTrack(name, times, values);

/** A named object3D, so PropertyBinding.findNode can resolve a track to it. */
function named(name: string): THREE.Object3D {
  const o = new THREE.Object3D();
  o.name = name;
  return o;
}

/** Sample one track's value at `time` by running a real mixer over the clip. */
function poseAt(root: THREE.Object3D, clip: THREE.AnimationClip, time: number): THREE.Vector3 {
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();
  action.time = time;
  mixer.update(0);
  const target = root.getObjectByName('Cube') ?? root.children[0];
  return target.position.clone();
}

/**
 * Every in-place assertion, run over BOTH the editor's script and podest's
 * hand-minified twin. Parameterized rather than duplicated: the twin exists
 * because podest is a standalone vanilla page that cannot import the app's
 * modules, and the only thing keeping the two honest is that they answer the
 * same questions.
 */
function inPlaceSuite(label: string, load: () => Loaded) {
  describe(`gltf-anim in-place clips (${label})`, () => {
  it('freezes the root position to frame 0 on every axis, and leaves rotation alone', () => {
    const { inPlaceClip } = load();
    const root = new THREE.Object3D();
    root.add(named('Cube'));

    const clip = new THREE.AnimationClip('Travel', 2, [
      track('Cube.position', [0, 1, 2], [1, 2, 3, 11, 22, 33, 21, 42, 63]),
      new THREE.QuaternionKeyframeTrack('Cube.quaternion', [0, 2], [0, 0, 0, 1, 0, 1, 0, 0]),
    ]);

    const pinned = inPlaceClip(clip, root);
    expect(pinned).toBeTruthy();

    const pos = pinned!.tracks.find((t) => t.name === 'Cube.position')!;
    // Every keyframe now carries frame 0's value — all three axes, because
    // "in place" means the model does not travel at all.
    expect(Array.from(pos.values)).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3]);

    const rot = pinned!.tracks.find((t) => t.name === 'Cube.quaternion')!;
    expect(Array.from(rot.values)).toEqual([0, 0, 0, 1, 0, 1, 0, 0]);
  });

  it('does not mutate the authored clip — both variants are held at once', () => {
    const { inPlaceClip } = load();
    const root = new THREE.Object3D();
    root.add(named('Cube'));
    const clip = new THREE.AnimationClip('Travel', 1, [
      track('Cube.position', [0, 1], [0, 0, 0, 10, 0, 0]),
    ]);
    const before = Array.from(clip.tracks[0].values);

    inPlaceClip(clip, root);

    expect(Array.from(clip.tracks[0].values)).toEqual(before);
    // And the two really do drive different poses through a real mixer.
    expect(poseAt(root, clip, 0.5).x).toBeCloseTo(5, 5);
  });

  it('the pinned clip holds the model still where the authored one travels', () => {
    const { inPlaceClip } = load();
    const root = new THREE.Object3D();
    root.add(named('Cube'));
    const clip = new THREE.AnimationClip('Travel', 1, [
      track('Cube.position', [0, 1], [0, 0, 0, 10, 0, 0]),
    ]);
    const pinned = inPlaceClip(clip, root)!;

    expect(poseAt(root, clip, 1).x).toBeCloseTo(10, 5);
    expect(poseAt(root, pinned, 1).x).toBeCloseTo(0, 5);
    expect(poseAt(root, pinned, 0.37).x).toBeCloseTo(0, 5);
  });

  it('freezes the TOP-MOST animated node, not a direct child of the root', () => {
    // The rigged-glTF shape: the Armature carries no tracks, root motion lives
    // on the hips several levels down, and a foot is animated deeper still. A
    // "direct child of root" rule would find nothing to freeze here and a
    // "freeze every position track" rule would flatten the whole rig.
    const { inPlaceClip } = load();
    const root = new THREE.Object3D();
    const armature = named('Armature');
    const hips = named('Hips');
    const foot = named('Foot');
    hips.add(foot);
    armature.add(hips);
    root.add(armature);

    const clip = new THREE.AnimationClip('Walk', 1, [
      track('Hips.position', [0, 1], [0, 1, 0, 0, 1, 8]),
      track('Foot.position', [0, 1], [0, 0, 0, 0, 0, 2]),
    ]);
    const pinned = inPlaceClip(clip, root)!;

    const hipsTrack = pinned.tracks.find((t) => t.name === 'Hips.position')!;
    const footTrack = pinned.tracks.find((t) => t.name === 'Foot.position')!;
    expect(Array.from(hipsTrack.values)).toEqual([0, 1, 0, 0, 1, 0]);
    // The foot keeps its own motion — it is not the root.
    expect(Array.from(footTrack.values)).toEqual([0, 0, 0, 0, 0, 2]);
  });

  it('reports "nothing to pin" for a clip with no root translation', () => {
    // A spinning turbine or a morph-only blink. Returning a twin here would
    // give the parent a toggle that visibly does nothing.
    const { inPlaceClip } = load();
    const root = new THREE.Object3D();
    root.add(named('Cube'));
    const clip = new THREE.AnimationClip('Spin', 1, [
      new THREE.QuaternionKeyframeTrack('Cube.quaternion', [0, 1], [0, 0, 0, 1, 0, 1, 0, 0]),
    ]);
    expect(inPlaceClip(clip, root)).toBeNull();
  });

  it('survives a clip whose tracks resolve to nothing in this subtree', () => {
    const { inPlaceClip } = load();
    const root = new THREE.Object3D();
    root.add(named('Cube'));
    const clip = new THREE.AnimationClip('Ghost', 1, [
      track('NotHere.position', [0, 1], [0, 0, 0, 5, 0, 0]),
    ]);
    expect(inPlaceClip(clip, root)).toBeNull();
  });

  it('measures depth from the root, and Infinity for anything outside it', () => {
    const { depthOf } = load();
    const root = new THREE.Object3D();
    const a = named('a');
    const b = named('b');
    a.add(b);
    root.add(a);
    expect(depthOf(root, root)).toBe(0);
    expect(depthOf(root, a)).toBe(1);
    expect(depthOf(root, b)).toBe(2);
    expect(depthOf(root, named('elsewhere'))).toBe(Infinity);
    expect(depthOf(root, null)).toBe(Infinity);
  });
  });
}

inPlaceSuite('editor preview', loadScript);
inPlaceSuite('podest twin', loadPodestScript);

describe('gltf-anim component', () => {
  interface Posted { type: string; [k: string]: unknown }

  /** Instantiate the registered component against a stub element + scene. */
  function mount(
    root: THREE.Object3D | null,
    data: { playing: boolean; inPlace: boolean; clip?: number },
    load: () => Loaded = loadScript,
  ) {
    const { def } = load();
    const posts: Posted[] = [];
    const modelListeners: (() => void)[] = [];
    const comp = Object.create(def) as ComponentDef & {
      el: unknown; data: typeof data; mixer: THREE.AnimationMixer | null;
      action: THREE.AnimationAction | null; duration: number; clipInPlace: unknown;
    };
    comp.el = {
      addEventListener: (_t: string, fn: () => void) => { modelListeners.push(fn); },
      getObject3D: () => root,
      setAttribute: () => {},
    };
    comp.data = { clip: 0, ...data };
    // `post` is the component's only outbound edge — replacing it is simpler
    // and more honest than faking a cross-document window.parent.
    comp.post = (msg: unknown) => { posts.push(msg as Posted); };
    comp.init();
    // init() registered the model-loaded handler; fire it as A-Frame would.
    for (const fn of modelListeners) fn();
    return { comp, posts };
  }

  function walkScene() {
    const root = new THREE.Object3D();
    root.add(named('Cube'));
    const clip = new THREE.AnimationClip('Walk', 2, [
      track('Cube.position', [0, 2], [0, 0, 0, 20, 0, 0]),
    ]);
    (root as THREE.Object3D & { animations: THREE.AnimationClip[] }).animations = [clip];
    return root;
  }

  /**
   * Two clips that differ in EVERY per-clip fact: length, and whether there is
   * any root translation to pin. That is the whole reason a clip change
   * re-reports rather than just changing an index.
   */
  function twoClipScene() {
    const root = walkScene();
    (root as THREE.Object3D & { animations: THREE.AnimationClip[] }).animations.push(
      new THREE.AnimationClip('Idle', 0.5, [
        new THREE.QuaternionKeyframeTrack('Cube.quaternion', [0, 0.5], [0, 0, 0, 1, 0, 1, 0, 0]),
      ]),
    );
    return root;
  }

  it('reports the clip, its length and that it can be pinned', () => {
    const root = walkScene();
    (root as THREE.Object3D & { animations: THREE.AnimationClip[] }).animations.push(
      new THREE.AnimationClip('Idle', 1, [
        track('Cube.position', [0, 1], [0, 0, 0, 0, 0, 0]),
      ]),
    );
    const { posts } = mount(root, { playing: true, inPlace: false });
    const report = posts.find((p) => p.type === 'fs:anim')!;
    expect(report.has).toBe(true);
    expect(report.duration).toBe(2);
    expect(report.canInPlace).toBe(true);
    expect(report.name).toBe('Walk');
    // Every clip name rides along so the parent can say "clip 1 of N".
    expect(report.clips).toEqual(['Walk', 'Idle']);
  });

  it('reports has:false for a model with no clips, so the controls never appear', () => {
    const root = new THREE.Object3D();
    root.add(named('Cube'));
    const { posts } = mount(root, { playing: true, inPlace: false });
    expect(posts.find((p) => p.type === 'fs:anim')!.has).toBe(false);
  });

  it('advances the pose on tick while playing, and holds it while paused', () => {
    const { comp } = mount(walkScene(), { playing: true, inPlace: false });
    const cube = () => (comp.el as { getObject3D: () => THREE.Object3D }).getObject3D().getObjectByName('Cube')!;

    comp.tick(16, 1000); // one second of a two-second, 0→20 traverse
    expect(cube().position.x).toBeCloseTo(10, 4);

    comp.data.playing = false;
    comp.update({ playing: true, inPlace: false });
    comp.tick(1016, 1000);
    expect(cube().position.x).toBeCloseTo(10, 4);
  });

  it('swapping to in-place mid-playback keeps the playhead and pins the model', () => {
    const { comp } = mount(walkScene(), { playing: true, inPlace: false });
    const cube = () => (comp.el as { getObject3D: () => THREE.Object3D }).getObject3D().getObjectByName('Cube')!;

    comp.tick(16, 1000);
    expect(cube().position.x).toBeCloseTo(10, 4);

    comp.data.inPlace = true;
    comp.update({ playing: true, inPlace: false });

    // Same moment in the clip, no travel.
    expect(comp.action!.time).toBeCloseTo(1, 4);
    expect(cube().position.x).toBeCloseTo(0, 4);
  });

  it('clamps a seek to the clip and echoes the landed time', () => {
    const { comp, posts } = mount(walkScene(), { playing: false, inPlace: false });
    comp.seek(99);
    expect(comp.action!.time).toBe(2);
    const echo = posts.filter((p) => p.type === 'fs:anim-time').pop()!;
    expect(echo.time).toBe(2);

    comp.seek(-5);
    expect(comp.action!.time).toBe(0);
  });

  it('ignores messages that did not come from the parent window', () => {
    const { comp } = mount(walkScene(), { playing: false, inPlace: false });
    comp.onMessage({ source: {}, data: { type: 'fs:anim-seek', time: 1 } });
    expect(comp.action!.time).toBe(0);
  });

  it('ignores a non-finite seek rather than poisoning the mixer clock', () => {
    const { comp } = mount(walkScene(), { playing: false, inPlace: false });
    comp.seek(NaN);
    expect(Number.isFinite(comp.action!.time)).toBe(true);
  });

  it('re-derives duration AND canInPlace on a clip change, not just the index', () => {
    // The trap this guards: reporting only the new index would leave the
    // scrubber measuring a 2 s clip while a 0.5 s one plays, and leave the
    // in-place toggle live on a clip with no root motion to remove.
    const { comp, posts } = mount(twoClipScene(), { playing: true, inPlace: false });
    const first = posts.filter((p) => p.type === 'fs:anim').pop()!;
    expect(first.duration).toBe(2);
    expect(first.canInPlace).toBe(true);
    expect(first.clip).toBe(0);
    expect(first.clips).toEqual(['Walk', 'Idle']);

    comp.data.clip = 1;
    comp.update({ playing: true, inPlace: false, clip: 0 });

    const second = posts.filter((p) => p.type === 'fs:anim').pop()!;
    expect(second.duration).toBe(0.5);
    expect(second.canInPlace).toBe(false);
    expect(second.clip).toBe(1);
    expect(second.name).toBe('Idle');
    // A clip change restarts at 0 — a playhead is a position in THIS clip, and
    // carrying 1.9 s into a 0.5 s idle would land on a clamp that reads as the
    // picker having chosen the end of the animation.
    expect(comp.action!.time).toBe(0);
  });

  it('clamps an out-of-range clip index to 0 instead of playing nothing', () => {
    // Reachable for real: the parent replays a remembered index onto a fresh
    // stage, and after a model swap that index may no longer exist.
    const { comp, posts } = mount(twoClipScene(), { playing: true, inPlace: false, clip: 7 });
    expect(posts.find((p) => p.type === 'fs:anim')!.clip).toBe(0);
    expect(comp.duration).toBe(2);
  });

  it('podest twin: same reports, same clamp', () => {
    const { posts } = mount(twoClipScene(), { playing: true, inPlace: false, clip: 99 }, loadPodestScript);
    const r = posts.find((p) => p.type === 'fs:anim')!;
    expect(r.has).toBe(true);
    expect(r.duration).toBe(2);
    expect(r.canInPlace).toBe(true);
    expect(r.clip).toBe(0);
    expect(r.clips).toEqual(['Walk', 'Idle']);
  });

  it('podest twin: advances the pose on tick exactly like the editor copy', () => {
    for (const load of [loadScript, loadPodestScript]) {
      const { comp } = mount(walkScene(), { playing: true, inPlace: false }, load);
      comp.tick(16, 1000);
      const cube = (comp.el as { getObject3D: () => THREE.Object3D }).getObject3D().getObjectByName('Cube')!;
      expect(cube.position.x).toBeCloseTo(10, 4);
    }
  });
});
