/**
 * The 3D view's backdrop (STAGE_SCRIPT, tslToPreviewHTML.ts): which documents
 * carry it, and what the component draws — evaluated against the real three
 * with a stub A-Frame and a few-line DOM, so the measuring, the grid step,
 * the ruler text and the message gate are pinned rather than eyeballed.
 */
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import * as THREE from 'three/webgpu';
import {
  PREVIEW_STAGES,
  STAGE_MESSAGE,
  STAGE_SCRIPT,
  UPRIGHT_TILT,
  isPreviewStage,
  nextPreviewStage,
  tslToPreviewHTML,
  uprightTilt,
} from './tslToPreviewHTML';

const TSL = `import { Fn, vec3 } from 'three/tsl';
const shader = Fn(() => vec3(1, 0, 0));
export default shader;
`;

describe('the backdrop setting', () => {
  it('steps room → grid → none → room, and knows only those three', () => {
    expect(PREVIEW_STAGES).toEqual(['none', 'room', 'grid']);
    expect(nextPreviewStage('none')).toBe('room');
    expect(nextPreviewStage('room')).toBe('grid');
    expect(nextPreviewStage('grid')).toBe('none');
    for (const v of ['none', 'room', 'grid']) expect(isPreviewStage(v)).toBe(true);
    for (const v of ['', 'Room', 'constructor', null, 1, undefined]) expect(isPreviewStage(v)).toBe(false);
  });
});

describe('which documents carry it', () => {
  it('every sandboxed document registers it; only a drawn mode names it on the scene', () => {
    const plain = tslToPreviewHTML(TSL, { geometry: 'sphere' });
    expect(plain).toContain(STAGE_SCRIPT);
    expect(plain).not.toContain('fs-stage=');
    const grid = tslToPreviewHTML(TSL, { geometry: 'sphere', stage: 'grid' });
    expect(grid).toContain('fs-stage=\\"mode: grid\\"');
    const junk = tslToPreviewHTML(TSL, { geometry: 'sphere', stage: 'mode: x" onload="' as never });
    expect(junk).not.toContain('fs-stage=');
  });

  it('the XR popup has none of it', () => {
    const xr = tslToPreviewHTML(TSL, { geometry: 'sphere', xr: true, stage: 'room' });
    expect(xr).not.toContain('fs-stage');
    expect(xr).not.toContain('__fsStageWords');
  });

  it('a drawn backdrop bakes the object UPRIGHT and keeps its resting tilt on the entity', () => {
    const entityLine = (html: string) => html.match(/<a-entity id=\\"preview-entity\\"[^>]*>/)?.[0] ?? '';
    expect(entityLine(tslToPreviewHTML(TSL, { geometry: 'sphere' })))
      .toContain('rotation=\\"45 45 0\\" data-fs-tilt=\\"45 45 0\\">');
    for (const stage of ['room', 'grid'] as const) {
      expect(entityLine(tslToPreviewHTML(TSL, { geometry: 'cube', stage })))
        .toContain('rotation=\\"0 0 0\\" data-fs-tilt=\\"45 45 0\\">');
      expect(entityLine(tslToPreviewHTML(TSL, { geometry: 'teapot', stage })))
        .toContain('rotation=\\"0 0 0\\" data-fs-tilt=\\"15 35 0\\">');
    }
    // No tilt to keep: the plane's line is what it always was.
    expect(entityLine(tslToPreviewHTML(TSL, { geometry: 'plane', stage: 'grid' })))
      .toMatch(/rotation=\\"0 0 0\\">$/);
    // The XR popup has no backdrop: tilted as ever, and nothing to restore.
    const xr = entityLine(tslToPreviewHTML(TSL, { geometry: 'sphere', xr: true, stage: 'grid' }));
    expect(xr).toContain('rotation=\\"45 45 0\\"');
    expect(xr).not.toContain('data-fs-tilt');
    expect(uprightTilt('45 45 0', 'none')).toBe('45 45 0');
    expect(uprightTilt('45 45 0', 'room')).toBe(UPRIGHT_TILT);
    expect(uprightTilt('15 35 0', 'grid')).toBe(UPRIGHT_TILT);
  });

  it('bakes the readout words as data, escaped, with a fallback for junk', () => {
    const html = tslToPreviewHTML(TSL, { stage: 'grid', stageWords: { cell: '</script><b>', size: 'x'.repeat(41) } });
    expect(html).toContain('window.__fsStageWords = {"cell":"\\u003C/script>\\u003Cb>","size":"Size"};');
  });
});

/** A minimal element: what the script reads and writes. */
function el(tag = 'div') {
  const node: Record<string, unknown> & { children: unknown[]; style: Record<string, string>; attrs: Record<string, string> } = {
    tagName: tag,
    style: {},
    children: [],
    textContent: '',
    parentNode: null,
    attrs: {},
    setAttribute(k: string, v: unknown) { node.attrs[k] = String(v); },
    appendChild(c: { parentNode: { children: unknown[] } | null }) {
      if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
      node.children.push(c);
      c.parentNode = node as never;
      return c;
    },
    removeChild(c: { parentNode: unknown }) { node.children.splice(node.children.indexOf(c), 1); c.parentNode = null; return c; },
    getContext: () => ({ fillRect() {}, fillText() {}, measureText: (t: string) => ({ width: t.length * 22 }) }),
  };
  Object.defineProperty(node.style, 'cssText', { set() {}, get: () => '' });
  return node;
}

type Fake = ReturnType<typeof el>;

interface StageComponent {
  el: unknown;
  data: { mode: string };
  m: { step: number; minor: number; half: number; room: number };
  world: THREE.Group;
  readout: { textContent: string; style: Record<string, string> };
  gizmo: { root: Fake; parts: { g: Fake; dot: Fake; depth: number }[] };
  init(): void;
  update(): void;
  tick(): void;
  tock(): void;
}

/** Runs STAGE_SCRIPT once against `object` (the preview entity's content) and
 *  hands back the component, already ticked in `mode`. */
function stage(object: THREE.Object3D, mode: string, opts: { spinDeg?: [number, number, number]; restTilt?: string } = {}) {
  let def: Record<string, unknown> | null = null;
  const listeners: Record<string, (e: unknown) => void> = {};
  const parentWin = {};
  const sceneObj = new THREE.Scene();
  const spin = new THREE.Group();
  sceneObj.add(spin);
  const entityObj = new THREE.Group();
  entityObj.add(object);
  // The turntable's turn, on the spin parent as in the document.
  const [rx, ry, rz] = (opts.spinDeg ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180);
  spin.rotation.set(rx, ry, rz);
  spin.add(entityObj);
  // The entity's rotation writes, as A-Frame's rotation component would apply them.
  const rotations: string[] = [];
  const entityEl = {
    object3D: entityObj,
    isConnected: true,
    getAttribute: (k: string) => (k === 'data-fs-tilt' ? opts.restTilt ?? null : null),
    setAttribute: (k: string, v: string) => {
      if (k !== 'rotation') return;
      rotations.push(v);
      const [x, y, z] = v.split(' ').map((d) => (Number(d) * Math.PI) / 180);
      entityObj.rotation.set(x, y, z);
    },
  };
  const camera = new THREE.PerspectiveCamera(20, 1, 0.005, 10000);
  camera.position.set(0, 0, 8);
  camera.updateMatrixWorld();
  const setAttributes: unknown[][] = [];
  const sceneEl = {
    object3D: sceneObj,
    camera,
    components: {} as Record<string, unknown>,
    getAttribute: (k: string) => (k === 'background' ? { color: '#808080' } : null),
    setAttribute: (...a: unknown[]) => { setAttributes.push(a); },
  };
  const document = {
    body: el('body'),
    createElement: (t: string) => el(t),
    createElementNS: (_ns: string, t: string) => el(t),
    getElementById: (id: string) => (id === 'preview-entity' ? entityEl : null),
    querySelector: (s: string) => (s === 'a-scene' ? sceneEl : null),
  };
  const win: Record<string, unknown> = {
    THREE,
    __fsFrame: 1,
    parent: parentWin,
    __fsWhenSceneBooted: (f: () => void) => f(),
    addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; },
  };
  win.AFRAME = { THREE, components: {}, registerComponent: (_n: string, d: Record<string, unknown>) => { def = d; } };
  win.window = win;
  win.document = document;
  vm.runInNewContext(STAGE_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, ''), win);
  expect(def).not.toBeNull();
  const comp = Object.create(def) as StageComponent;
  comp.el = sceneEl;
  comp.data = { mode };
  comp.init();
  comp.update();
  comp.tick();
  comp.tock();
  const send = (data: unknown) => listeners.message({ source: parentWin, data });
  sceneEl.components['fs-stage'] = comp;
  /** Switch the mode as A-Frame would: new data, then update(). */
  const setMode = (m: string) => { comp.data = { mode: m }; comp.update(); comp.tick(); comp.tock(); };
  const shownTilt = win.__fsShownTilt as (t: string) => string;
  return { comp, entityObj, sceneObj, setAttributes, send, rotations, setMode, shownTilt };
}

const labels = (g: THREE.Group) => g.children.filter((c) => c.name.startsWith('fs-stage-label ')) as THREE.Mesh[];
const labelText = (m: THREE.Object3D) => m.name.slice('fs-stage-label '.length);

describe('what it draws', () => {
  it('grid: through the object’s centre (y = 0), a 0.5 m step for a 1.6 m sphere, numbers lying on it', () => {
    const { comp } = stage(new THREE.Mesh(new THREE.SphereGeometry(0.8, 48, 24)), 'grid', { spinDeg: [45, 45, 0] });
    expect(comp.m.step).toBe(0.5);
    expect(comp.m.minor).toBeCloseTo(0.1);
    expect(comp.readout.textContent).toBe('Grid square 0.1 m · Size 1.6 × 1.6 × 1.6 m');
    // Minor, major and centre lines, every vertex on y = 0.
    const lines = comp.world.children.filter((c) => (c as THREE.LineSegments).isLineSegments) as THREE.LineSegments[];
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      const pos = l.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) expect(pos.getY(i)).toBe(0);
    }
    // No separate ruler: the numbers are flat quads ON the grid, one per
    // major line along each centre line, the unit on the first each way.
    const ls = labels(comp.world);
    expect(ls).toHaveLength(1 + 2 * 20);
    const texts = ls.map(labelText);
    expect(texts.filter((t) => t === '0.5 m')).toHaveLength(2);
    expect(texts).toContain('1');
    expect(texts).toContain('−5');
    for (const q of ls) {
      expect(q.rotation.x).toBeCloseTo(-Math.PI / 2);
      expect(Math.abs(q.position.y)).toBeLessThan(0.01);
      // Small: a sixth of a grid step tall.
      expect((q.geometry as THREE.PlaneGeometry).parameters.height).toBeCloseTo(0.08);
    }
    expect(comp.world.children.some((c) => c.name === 'fs-stage-stick')).toBe(false);
  });

  it('a 10 cm model reads in centimetres; an instanced cloud falls back to the 1.6 box', () => {
    const small = stage(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.04)), 'grid');
    expect(small.comp.m.step).toBeCloseTo(0.05);
    expect(small.comp.readout.textContent).toBe('Grid square 1 cm · Size 10 × 6 × 4 cm');
    expect(labels(small.comp.world).map(labelText)).toContain('5 cm');
    const quad = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(4, 4) as unknown as THREE.InstancedBufferGeometry);
    const cloud = stage(new THREE.Mesh(quad), 'grid');
    expect(cloud.comp.m.step).toBe(0.5);
    expect(cloud.comp.readout.textContent).toBe('Grid square 0.1 m');
  });

  it('room: a checker cube centred on the object, seen from inside, the camera inside it', () => {
    const { comp } = stage(new THREE.Mesh(new THREE.SphereGeometry(0.8, 32, 16)), 'room');
    const box = comp.world.children[0] as THREE.Mesh;
    const p = (box.geometry as THREE.BoxGeometry).parameters;
    expect([p.width, p.height, p.depth]).toEqual([2 * comp.m.room, 2 * comp.m.room, 2 * comp.m.room]);
    expect(box.position.toArray()).toEqual([0, 0, 0]);
    expect(comp.m.room).toBeGreaterThan(8);
    expect((box.material as THREE.Material[])[0].side).toBe(THREE.BackSide);
    expect(comp.readout.style.display).toBe('none');
  });

  it('the gizmo shows the object’s own axes as the camera sees them, nearest on top', () => {
    const dot = (c: StageComponent, i: number) => {
      const a = c.gizmo.parts[2 * i].dot.attrs;
      return [Number(a.cx), Number(a.cy)];
    };
    const flat = stage(new THREE.Mesh(new THREE.SphereGeometry(0.8)), 'grid').comp;
    expect(dot(flat, 0)).toEqual([64, 38]); // X right
    expect(dot(flat, 1)).toEqual([38, 12]); // Y up
    expect(dot(flat, 2)).toEqual([38, 38]); // Z at the camera
    // Drawn last: the +Z dot points straight at the camera.
    const order = flat.gizmo.root.children;
    expect(order[order.length - 1]).toBe(flat.gizmo.parts[4].g);
    // Turned 90° about Y, as the turntable turns it: X now points away, Z right.
    const turned = stage(new THREE.Mesh(new THREE.SphereGeometry(0.8)), 'grid', { spinDeg: [0, 90, 0] }).comp;
    expect(dot(turned, 0)[0]).toBeCloseTo(38);
    expect(dot(turned, 2)).toEqual([64, 38]);
  });

  it('stands the object upright while drawn and gives its tilt back with none — the gizmo’s Y is the grid’s', () => {
    const s = stage(new THREE.Mesh(new THREE.SphereGeometry(0.8)), 'grid', { restTilt: '45 45 0' });
    expect(s.rotations).toEqual(['0 0 0']);
    const yDot = () => s.comp.gizmo.parts[2].dot.attrs;
    expect([Number(yDot().cx), Number(yDot().cy)]).toEqual([38, 12]); // straight up
    s.setMode('none');
    expect(s.rotations).toEqual(['0 0 0', '45 45 0']);
    s.setMode('room');
    expect(s.rotations[s.rotations.length - 1]).toBe('0 0 0');
    // The bridge's fs:geometry asks the same question for a newly shown shape.
    expect(s.shownTilt('15 35 0')).toBe('0 0 0');
    s.setMode('none');
    expect(s.shownTilt('15 35 0')).toBe('15 35 0');
  });

  it('a missing or malformed resting tilt is no tilt, never a string passed through', () => {
    for (const junk of [undefined, '', '45 45', '1 2 3; scale: 9 9 9', '1e3 0 0']) {
      const s = stage(new THREE.Mesh(new THREE.SphereGeometry(0.8)), 'grid', { restTilt: junk });
      s.setMode('none');
      expect(s.rotations).toEqual(['0 0 0', '0 0 0']);
    }
  });

  it('draws nothing inside the object’s own entity, whose subtree the loader walks', () => {
    const { comp, entityObj, sceneObj } = stage(new THREE.Mesh(new THREE.SphereGeometry(0.8)), 'grid');
    expect(comp.world.parent).toBe(sceneObj);
    expect(entityObj.children).toHaveLength(1);
  });

  it('takes from the parent only a known mode', () => {
    const { send, setAttributes } = stage(new THREE.Mesh(new THREE.SphereGeometry(0.8)), 'grid');
    for (const mode of ['constructor', '__proto__', 'Room', 1, null]) send({ type: STAGE_MESSAGE, mode });
    send({ type: 'fs:other', mode: 'room' });
    expect(setAttributes).toEqual([]);
    send({ type: STAGE_MESSAGE, mode: 'room' });
    expect(setAttributes).toEqual([['fs-stage', 'mode', 'room']]);
  });
});
