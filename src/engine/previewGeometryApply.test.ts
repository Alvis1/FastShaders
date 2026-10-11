/**
 * The preview bridge's GEOMETRY hot-update, driven for real.
 *
 * `fs:geometry` changes the preview mesh in place (a Subdivision step, a
 * Raymarch Window step, sphere/cube/plane, the teapot). Two contracts live in
 * BRIDGE_SCRIPT_TEMPLATE (tslToPreviewHTML.ts) and nothing else pinned them:
 *
 *  - The shader is re-applied ONLY when the mesh itself changed. A-Frame 1.8's
 *    geometry component reuses the mesh and swaps only `mesh.geometry`, and
 *    loader 0.8 re-welds and rebuilds the bary corners on that
 *    componentchanged, so a re-apply there only re-imported and recompiled the
 *    module, reset every tuned uniform and leaked one copy of each image
 *    texture per step (2026-10-11 audit: 7 applies for a 7-stop drag).
 *  - A re-apply that does still happen (a primitive replacing the teapot, the
 *    teapot's own model-loaded, a model arriving) is followed by an UNTAGGED
 *    fs:preview-ready once its shader-applied fires, so the parent re-pushes
 *    the tuned uniform values the fresh schema reset. Untagged, because only a
 *    gen-tagged ack may clear the parent's hot-swap watchdog.
 *
 * And the KEY MIRROR: each handler skips a payload equal to the state baked
 * into the document, and the parent posts that same state from its mount
 * effects. If the baked key and the key the handler computes from the
 * parent's message ever drift, every document load re-applies its geometry
 * (and, before the guard above, re-imported the shader mid-boot). The parent's
 * message shapes are restated below from ShaderPreview.tsx's geometry and
 * playing effects, built with the same exported builders it uses.
 *
 * The script is extracted from the generated document verbatim and executed
 * against a stub entity (the previewHotSwap.test.ts technique). What stays
 * browser-only: that A-Frame really keeps the mesh across a geometry change
 * (checked in Chrome on 2026-10-11 against the dev server).
 */
import { describe, it, expect } from 'vitest';
import {
  GEOMETRY_ROTATIONS,
  buildGeoAttr,
  buildTeapotAttr,
  tslToPreviewHTML,
} from './tslToPreviewHTML';
import type { GeometryType } from './tslToPreviewHTML';

const TSL = "import { vec3 } from 'three/tsl';\nconst shader = Fn(() => { return vec3(1); });\nexport default shader;\n";

/** Pull the bridge script's body out of a generated document. */
function extractBridge(html: string): string {
  const at = html.indexOf('var __lastGeometryKey');
  expect(at, 'bridge script missing from the document').toBeGreaterThan(-1);
  const open = html.lastIndexOf('<script>', at);
  const close = html.indexOf('</script>', at);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return html.slice(open + '<script>'.length, close);
}

type Listener = (ev: unknown) => void;
type Primitive = 'sphere' | 'cube' | 'plane' | 'marchSphere';

interface BootState {
  /** What the document was built with — decides the stub's starting mesh. */
  teapot: boolean;
  /** Act as the top-level XR popup (window.parent === window). */
  topLevel?: boolean;
}

/**
 * A stand-in for the sandboxed document: `#preview-entity` with a minimal
 * model of how A-Frame and the teapot component treat its mesh, a spin parent,
 * a camera and a scene, a parent that records every post, and a timer queue
 * the test flushes by hand.
 */
function makeBridge(html: string, boot: BootState) {
  const posted: Record<string, unknown>[] = [];
  const entityCalls: unknown[][] = [];
  const spinCalls: unknown[][] = [];
  const timers: (() => void)[] = [];
  let applies = 0;

  let meshSeq = 0;
  let mesh: { id: number } | null = { id: ++meshSeq };
  let teapotOn = boot.teapot;
  const listeners = new Map<string, Set<Listener>>();
  const shaderComp: { _propertyUniforms: Record<string, unknown> | null; applyShader: () => void } = {
    _propertyUniforms: { tint: 1 },
    applyShader: () => { applies++; },
  };
  const emit = (type: string, detail?: unknown) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn({ detail });
  };
  const entity = {
    components: { shader: shaderComp },
    getObject3D: (name: string) => (name === 'mesh' ? mesh : null),
    setAttribute: (...args: unknown[]) => {
      entityCalls.push(['set', ...args]);
      if (args[0] === 'geometry') {
        // A-Frame 1.8: an existing mesh only gets its .geometry swapped.
        if (!mesh) mesh = { id: ++meshSeq };
      } else if (args[0] === 'teapot-mesh') {
        // teapot-mesh's update: a NEW mesh, then model-loaded, synchronously.
        teapotOn = true;
        mesh = { id: ++meshSeq };
        emit('model-loaded', { format: 'teapot' });
      }
    },
    removeAttribute: (name: string) => {
      entityCalls.push(['remove', name]);
      // teapot-mesh's remove() drops its mesh; the geometry component's leaves it.
      if (name === 'teapot-mesh' && teapotOn) { teapotOn = false; mesh = null; }
    },
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => { listeners.get(type)?.delete(fn); },
  };
  const spinEl = {
    object3D: { rotation: { x: 0, y: 0, z: 0 } },
    setAttribute: (...args: unknown[]) => { spinCalls.push(['set', ...args]); },
    removeAttribute: (...args: unknown[]) => { spinCalls.push(['remove', ...args]); },
  };
  const camEl = { components: {}, getObject3D: () => null };
  const sceneEl = { hasLoaded: true, resize: () => {}, addEventListener: () => {} };

  const messageListeners: Listener[] = [];
  const win: Record<string, unknown> = {};
  const parent = boot.topLevel ? win : { postMessage: (m: Record<string, unknown>) => { posted.push(m); } };
  Object.assign(win, {
    parent,
    postMessage: (m: Record<string, unknown>) => { posted.push(m); },
    addEventListener: (type: string, fn: Listener) => { if (type === 'message') messageListeners.push(fn); },
  });
  const doc = {
    getElementById: (id: string) => (id === 'preview-entity' ? entity : id === 'spin-parent' ? spinEl : null),
    querySelector: (sel: string) => (sel === '[camera]' ? camEl : sel === 'a-scene' ? sceneEl : null),
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'document', '__fsWhenSceneBooted', 'setTimeout', 'setInterval', extractBridge(html))(
    win,
    doc,
    (fn: () => void) => fn(),
    (fn: () => void, ms?: number) => { if (!ms) timers.push(fn); },
    () => 0,
  );
  // The boot handshake (checkShaderReady) has already posted its ready; the
  // tests below are about what comes AFTER boot.
  posted.length = 0;

  return {
    posted, entityCalls, spinCalls, emit, shaderComp,
    applies: () => applies,
    entityListeners: (type: string) => listeners.get(type)?.size ?? 0,
    /** Run every zero-delay timer queued so far (the deferred re-apply). */
    flush() { for (const fn of timers.splice(0)) fn(); },
    send(data: unknown) { for (const fn of messageListeners) fn({ source: parent, data }); },
  };
}

/** ShaderPreview.tsx's primitive fs:geometry post, field for field. */
function primitiveMsg(geometry: Primitive, subdivision: number, marchWindow = 1) {
  return {
    type: 'fs:geometry',
    isObj: false,
    geometry: buildGeoAttr(geometry, subdivision, marchWindow),
    rotation: GEOMETRY_ROTATIONS[geometry] ?? '45 45 0',
  };
}

/** ShaderPreview.tsx's teapot fs:geometry post, field for field. */
function teapotMsg(subdivision: number) {
  return { type: 'fs:geometry', isObj: false, teapot: buildTeapotAttr(subdivision), rotation: GEOMETRY_ROTATIONS.teapot };
}

/** ShaderPreview.tsx's fs:playing post, field for field. */
function playingMsg(geometry: GeometryType, playing: boolean, rot: { x: number; y: number; z: number } | null) {
  const raw = rot ?? { x: 0, y: 0, z: 0 };
  const mod360 = (v: number) => ((v % 360) + 360) % 360;
  const r = { x: mod360(raw.x), y: mod360(raw.y), z: mod360(raw.z) };
  const from = `${r.x} ${r.y} ${r.z}`;
  const to = geometry === 'plane' ? `${r.x} ${r.y} ${r.z + 360}` : `${r.x} ${r.y + 360} ${r.z}`;
  return { type: 'fs:playing', playing, from, to };
}

const sphereDoc = (subdivision = 64) => tslToPreviewHTML(TSL, { geometry: 'sphere', subdivision });
const teapotDoc = (subdivision = 64) => tslToPreviewHTML(TSL, { geometry: 'teapot', subdivision });

describe('preview geometry hot-update: the shader is re-applied only for a new mesh', () => {
  it('a Subdivision step on a sphere keeps the mesh and re-applies nothing', () => {
    const b = makeBridge(sphereDoc(64), { teapot: false });
    for (const s of [8, 16, 32, 128]) b.send(primitiveMsg('sphere', s));
    b.flush();
    // Each step really reached the geometry component…
    expect(b.entityCalls.filter((c) => c[0] === 'set' && c[1] === 'geometry')).toHaveLength(4);
    // …and none of them re-imported the module.
    expect(b.applies()).toBe(0);
    expect(b.posted).toEqual([]);
  });

  it('a sphere/cube/plane switch and a Raymarch Window step re-apply nothing', () => {
    const b = makeBridge(sphereDoc(), { teapot: false });
    b.send(primitiveMsg('cube', 64));
    b.send(primitiveMsg('plane', 64));
    b.send(primitiveMsg('marchSphere', 64, 1));
    for (const w of [1.5, 2, 2.5]) b.send(primitiveMsg('marchSphere', 64, w));
    b.flush();
    expect(b.applies()).toBe(0);
    expect(b.posted).toEqual([]);
  });

  it('a primitive replacing the teapot (a NEW mesh) re-applies once, deferred, and reports ready untagged', () => {
    const b = makeBridge(teapotDoc(), { teapot: true });
    b.send(primitiveMsg('sphere', 64));
    // Deferred a task, as before: nothing has run yet.
    expect(b.applies()).toBe(0);
    b.flush();
    expect(b.applies()).toBe(1);
    // Nothing is posted until THAT apply lands…
    expect(b.posted).toEqual([]);
    b.shaderComp._propertyUniforms = { tint: 1, speed: 2 };
    b.emit('shader-applied');
    // …and then it is the boot handshake's shape, with NO gen: it must not
    // pass for a hot-swap ack.
    expect(b.posted).toEqual([{ type: 'fs:preview-ready', uniforms: ['tint', 'speed'] }]);
    expect(b.posted[0]).not.toHaveProperty('hot');
    // One-shot: a later apply (a hot swap's, which acks for itself) adds nothing.
    b.emit('shader-applied');
    expect(b.posted).toHaveLength(1);
  });

  it('sphere → teapot and a teapot Subdivision step: model-loaded re-applies, and each reports ready once', () => {
    const b = makeBridge(sphereDoc(), { teapot: false });
    b.send(teapotMsg(64));
    b.flush();
    // The loader re-applies on model-loaded by itself; the bridge does not add one.
    expect(b.applies()).toBe(0);
    b.emit('shader-applied');
    expect(b.posted).toEqual([{ type: 'fs:preview-ready', uniforms: ['tint'] }]);

    b.send(teapotMsg(16));
    b.emit('shader-applied');
    expect(b.posted).toHaveLength(2);
    expect(b.posted[1]).toEqual({ type: 'fs:preview-ready', uniforms: ['tint'] });
  });

  it('a failed re-apply posts nothing and stops waiting', () => {
    const b = makeBridge(teapotDoc(), { teapot: true });
    b.send(teapotMsg(32));
    b.emit('shader-error', { message: 'boom' });
    expect(b.posted).toEqual([]);
    expect(b.entityListeners('shader-applied')).toBe(0);
    b.emit('shader-applied');
    expect(b.posted).toEqual([]);
  });

  it('a shader-applied with no geometry re-apply pending (an ordinary hot swap) posts nothing here', () => {
    const b = makeBridge(sphereDoc(), { teapot: false });
    b.emit('shader-applied');
    expect(b.posted).toEqual([]);
  });

  it('re-applies started before the first lands are EACH answered, so the last reset is undone too', () => {
    // A quick teapot Subdivision drag: every step re-emits model-loaded, and
    // each apply rebuilds the uniform map from the schema. Answering only the
    // first left the later applies' defaults standing (review 2026-10-11, real
    // Chrome: five steps 0-4 ms apart, the tuned value lost in the frame).
    const b = makeBridge(sphereDoc(), { teapot: false });
    for (const s of [8, 16, 32, 64, 128]) b.send(teapotMsg(s));
    // One listener pair, however many are pending.
    expect(b.entityListeners('shader-applied')).toBe(1);
    expect(b.entityListeners('shader-error')).toBe(1);
    for (let i = 1; i <= 5; i++) {
      b.emit('shader-applied');
      expect(b.posted, `apply ${i}`).toHaveLength(i);
      expect(b.posted[i - 1]).toEqual({ type: 'fs:preview-ready', uniforms: ['tint'] });
    }
    // All answered: the wait is over, and a later (hot-swap) apply adds nothing.
    expect(b.entityListeners('shader-applied')).toBe(0);
    expect(b.entityListeners('shader-error')).toBe(0);
    b.emit('shader-applied');
    expect(b.posted).toHaveLength(5);
  });

  it('a failure among several pending re-applies is skipped, and the rest still report', () => {
    const b = makeBridge(sphereDoc(), { teapot: false });
    b.send(teapotMsg(16));
    b.send(teapotMsg(32));
    b.send(teapotMsg(64));
    b.emit('shader-applied');
    b.emit('shader-error', { message: 'boom' });
    b.emit('shader-applied');
    expect(b.posted).toHaveLength(2);
    expect(b.entityListeners('shader-applied')).toBe(0);
  });

  it('the pending count is bounded: applies that never report cannot grow it without limit', () => {
    const b = makeBridge(sphereDoc(), { teapot: false });
    // 100 model-loaded events (each arms) with no apply landing.
    for (let i = 0; i < 100; i++) b.emit('model-loaded');
    for (let i = 0; i < 100; i++) b.emit('shader-applied');
    expect(b.posted).toHaveLength(32);
    expect(b.entityListeners('shader-applied')).toBe(0);
  });

  it('the XR popup (top level) registers no model-loaded wait and posts nothing', () => {
    const html = tslToPreviewHTML(TSL, { geometry: 'teapot', xr: true });
    const b = makeBridge(html, { teapot: true, topLevel: true });
    expect(b.entityListeners('model-loaded')).toBe(0);
    b.emit('model-loaded');
    b.emit('shader-applied');
    expect(b.posted).toEqual([]);
  });
});

describe('preview hot-update keys: the baked state mirrors the parent’s mount-time posts', () => {
  const PRIMITIVES: Primitive[] = ['sphere', 'cube', 'plane', 'marchSphere'];
  const ROTATIONS = [null, { x: 10, y: 370, z: -5 }, { x: 0, y: 45.5, z: 720 }];

  for (const geometry of [...PRIMITIVES, 'teapot'] as const) {
    it(`${geometry}: fs:geometry and fs:playing at mount are recognised as no-ops`, () => {
      for (const subdivision of [1, 16, 64, 128]) {
        for (const marchWindow of geometry === 'marchSphere' ? [1, 2.5] : [1]) {
          for (const animate of [false, true]) {
            for (const initialRotation of ROTATIONS) {
              const html = tslToPreviewHTML(TSL, { geometry, subdivision, marchWindow, animate, initialRotation });
              const b = makeBridge(html, { teapot: geometry === 'teapot' });
              const label = `${geometry} subd ${subdivision} window ${marchWindow} animate ${animate} rot ${JSON.stringify(initialRotation)}`;
              b.send(geometry === 'teapot' ? teapotMsg(subdivision) : primitiveMsg(geometry, subdivision, marchWindow));
              b.send(playingMsg(geometry, animate, initialRotation));
              b.flush();
              expect(b.entityCalls, label).toEqual([]);
              expect(b.spinCalls, label).toEqual([]);
            }
          }
        }
      }
    });
  }

  it('the harness does see a mismatch (the mirror tests above are not vacuous)', () => {
    const b = makeBridge(sphereDoc(64), { teapot: false });
    b.send(primitiveMsg('sphere', 32));
    b.send(playingMsg('sphere', true, null));
    expect(b.entityCalls.length).toBeGreaterThan(0);
    expect(b.spinCalls.length).toBeGreaterThan(0);
  });
});
