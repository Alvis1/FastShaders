/**
 * shaderloader 0.6's vertex WELD, executed for real.
 *
 * The weld moved OUT of the editor preview (an inline `weld-verts` component)
 * and INTO the loader on 2026-08-31, because the editor was the only surface
 * that had it: podest, the copy-ready A-Frame page and every page embedding an
 * exported module all rendered a displaced `<a-box>` as six separated faces.
 * The loader is the one layer all of them already load.
 *
 * That move made the blast radius bigger, not smaller — one defect here now
 * shows up on every surface at once, and on already-exported shaders, which
 * fetch this file from jsdelivr. Hence this suite runs the REAL vendored file
 * against the REAL three, rather than pinning a copy against a copy.
 *
 * The sandbox is `perMeshMaterials.test.ts`'s (a plain-script loader under the
 * `node` vitest env needs `vm`), with `THREE` bound to the actual library so
 * the geometry maths is exercised rather than stubbed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as THREE from 'three';

const repoRoot = path.resolve(__dirname, '..');
// The copy the app actually serves; vendorSync.test.ts pins it to the submodule.
const LOADER = path.join(repoRoot, 'public/js/a-frame-shaderloader-0.6.js');

interface Comp {
  init: () => void;
  shouldWeld: (r: unknown, m: unknown, p: unknown) => boolean;
  syncWeld: () => void;
  unweld: () => void;
  el: unknown;
  _weldWanted: boolean;
  _welded: THREE.BufferGeometry | null;
  _weldSource: THREE.BufferGeometry | null;
  _weldScanned: THREE.BufferGeometry | null;
  _weldUvDriven: boolean;
  [k: string]: unknown;
}

function loadComponent(): Comp {
  let def: Comp | null = null;
  const sandbox: Record<string, unknown> = {
    console: { log() {}, error() {}, warn() {} },
    URL,
    THREE,
    location: { href: 'https://example.test/index.html' },
    AFRAME: {
      registerComponent(_n: string, d: Comp) { def = d; },
      registerShader() {},
      utils: {},
    },
    window: { THREE },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(LOADER, 'utf8'), sandbox);
  if (!def) throw new Error('the shader component never registered');
  return def;
}

/** A component instance wearing `geom`, as an A-Frame PRIMITIVE by default. */
function instance(geom: THREE.BufferGeometry, opts: { primitive?: boolean } = {}): Comp {
  const def = loadComponent();
  const ctx = Object.create(def) as Comp;
  const mesh = { geometry: geom };
  ctx.el = {
    components: opts.primitive === false ? {} : { geometry: {} },
    addEventListener() {},
    removeEventListener() {},
    getObject3D: (k: string) => (k === 'mesh' ? mesh : null),
  };
  ctx.init();
  return ctx;
}

const meshOf = (c: Comp) =>
  (c.el as { getObject3D: (k: string) => { geometry: THREE.BufferGeometry } }).getObject3D('mesh');

interface FakeMaterial { positionNode: object | null }
/** A material that displaces, as three really builds it. */
const displacing = (): FakeMaterial => ({ positionNode: {} });
/** three's NodeMaterial sets positionNode = NULL, not undefined — see below. */
const plain = (): FakeMaterial => ({ positionNode: null });

describe('shouldWeld — the three gates', () => {
  it('welds a displacing shader on a primitive', () => {
    const c = instance(new THREE.BoxGeometry(1, 1, 1));
    expect(c.shouldWeld({}, displacing(), null)).toBe(true);
  });

  /**
   * The gate MUST be `!= null`, not `!== undefined`. three's NodeMaterial
   * constructor assigns `this.positionNode = null`, so an `undefined` test is
   * true for every material ever built and would weld every primitive shader —
   * the exact opposite of a displacement gate, and it fails silently (spheres
   * and planes look right; only a non-displacing cube gives it away, by
   * rendering smooth).
   */
  it('does NOT weld a shader that only sets colour (positionNode === null)', () => {
    const c = instance(new THREE.BoxGeometry(1, 1, 1));
    expect(c.shouldWeld({}, plain(), null)).toBe(false);
    // Guard the reason, not just the result.
    expect(new THREE.MeshPhysicalMaterial()).not.toHaveProperty('positionNode', undefined);
  });

  it('honours an explicit mergeVertices: false from the module', () => {
    const c = instance(new THREE.BoxGeometry(1, 1, 1));
    expect(c.shouldWeld({ mergeVertices: false }, displacing(), null)).toBe(false);
    // ABSENT means weld — that is what keeps every already-exported module,
    // which carries no such key, behaving as the author expects.
    expect(c.shouldWeld({}, displacing(), null)).toBe(true);
    // An explicit `true` is what the settings menu writes on re-tick.
    expect(c.shouldWeld({ mergeVertices: true }, displacing(), null)).toBe(true);
  });

  it('never welds a MODEL, however it displaces', () => {
    // weldByPosition rebuilds with position/uv/index only, so welding a model
    // would drop vertex colours, skin weights and morph targets.
    const c = instance(new THREE.BoxGeometry(1, 1, 1), { primitive: false });
    expect(c.shouldWeld({}, displacing(), null)).toBe(false);
  });

  it('welds when only a PART material displaces', () => {
    const c = instance(new THREE.BoxGeometry(1, 1, 1));
    const parts = new Map([['Body', plain()], ['Glass', displacing()]]);
    expect(c.shouldWeld({}, null, parts)).toBe(true);
    expect(c.shouldWeld({}, null, new Map([['Body', plain()]]))).toBe(false);
  });
});

/**
 * WHICH groups merge, which is the correctness of the weld rather than an
 * optimisation. A group is merged when its members could displace APART:
 * their normals differ, or — for a shader that reads uv() — their UVs do.
 *
 * MEASURED against three r184 (and pinned below): a-sphere(36,18) has 19
 * coincident groups, ZERO with differing normals and all 19 with differing UVs
 * — the largest a 37-vertex pole fan. So for a POSITION-driven shader, welding
 * a sphere repairs nothing (every member moves by the same amount) and
 * destroys the pole caps and the u-seam, because a welded vertex keeps only
 * ONE representative uv. For a UV-driven one those same vertices really do
 * separate, and welding is the lesser evil against a cracked surface — which
 * is what the editor's old always-weld component did, and why dropping to a
 * normals-only rule would have regressed it.
 */
describe('weld geometry — welds the box, leaves the sphere alone', () => {
  it('welds a box down to its shared corners', () => {
    const c = instance(new THREE.BoxGeometry(1, 1, 1));
    c._weldWanted = true;
    c.syncWeld();
    const g = meshOf(c).geometry;
    expect(g).toBe(c._welded);
    // 24 per-face vertices collapse to the cube's 8 real corners.
    expect(g.attributes.position.count).toBe(8);
    expect(g.index).not.toBeNull();
  });

  it('leaves a sphere untouched for a POSITION-driven shader — the merge would be pure loss', () => {
    const sphere = new THREE.SphereGeometry(1, 36, 18);
    const c = instance(sphere);
    c._weldWanted = true;
    c._weldUvDriven = false;
    c.syncWeld();
    // Not merely "same vertex count" — the SAME OBJECT, so no attribute was
    // rebuilt and computeVertexNormals never replaced the analytic normals.
    expect(meshOf(c).geometry).toBe(sphere);
    expect(c._welded).toBeNull();
    expect(c._weldScanned).toBe(sphere);
  });

  /**
   * The case a normals-only rule would have broken. A uv-driven height moves
   * the u=0 and u=1 copies of a seam vertex by DIFFERENT amounts (measured
   * ~0.2 world units apart on a radius-1 sphere for `uv().x.mul(0.2)`), so the
   * surface cracks down the seam and across the pole fans unless they weld —
   * exactly what the editor's old component did before this moved here.
   */
  it('DOES weld a sphere for a uv-driven shader, where the seam really separates', () => {
    const sphere = new THREE.SphereGeometry(1, 36, 18);
    const c = instance(sphere);
    c._weldWanted = true;
    c._weldUvDriven = true;
    c.syncWeld();
    expect(meshOf(c).geometry).toBe(c._welded);
    // 703 → 614: the 19 coincident groups collapse, matching what the old
    // always-weld component produced on this geometry.
    expect(sphere.attributes.position.count).toBe(703);
    expect(c._welded!.attributes.position.count).toBe(614);
  });

  it('leaves a plane untouched (it has no coincident vertices at all)', () => {
    const plane = new THREE.PlaneGeometry(2, 2, 64, 64);
    const c = instance(plane);
    c._weldWanted = true;
    c.syncWeld();
    expect(meshOf(c).geometry).toBe(plane);
  });

  /** The measurement the normals-differ rule rests on, pinned as fact. */
  it('the sphere really has no normal split to repair, and the box is all split', () => {
    const groupsOf = (geom: THREE.BufferGeometry) => {
      const pos = geom.attributes.position, nor = geom.attributes.normal;
      const map = new Map<string, number[]>();
      for (let i = 0; i < pos.count; i++) {
        const k = `${Math.round(pos.getX(i) * 1e4)}_${Math.round(pos.getY(i) * 1e4)}_${Math.round(pos.getZ(i) * 1e4)}`;
        (map.get(k) ?? map.set(k, []).get(k)!).push(i);
      }
      let groups = 0, normDiff = 0;
      for (const ids of map.values()) {
        if (ids.length < 2) continue;
        groups++;
        for (let a = 1; a < ids.length; a++) {
          const i = ids[0], j = ids[a];
          if (Math.abs(nor.getX(i) - nor.getX(j)) > 1e-6
            || Math.abs(nor.getY(i) - nor.getY(j)) > 1e-6
            || Math.abs(nor.getZ(i) - nor.getZ(j)) > 1e-6) { normDiff++; break; }
        }
      }
      return { groups, normDiff };
    };
    expect(groupsOf(new THREE.SphereGeometry(1, 36, 18))).toEqual({ groups: 19, normDiff: 0 });
    expect(groupsOf(new THREE.SphereGeometry(1, 64, 64))).toEqual({ groups: 65, normDiff: 0 });
    expect(groupsOf(new THREE.BoxGeometry(1, 1, 1))).toEqual({ groups: 8, normDiff: 8 });
  });
});

describe('weld lifecycle — ownership and restoration', () => {
  it('unweld puts the system geometry back and never disposes it', () => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const c = instance(box);
    c._weldWanted = true;
    c.syncWeld();
    const ours = c._welded!;
    let sourceDisposed = false;
    box.addEventListener('dispose', () => { sourceDisposed = true; });

    c._weldWanted = false;
    c.syncWeld();
    expect(meshOf(c).geometry).toBe(box);
    expect(c._welded).toBeNull();
    // The geometry SYSTEM refcounts and SHARES a primitive's geometry between
    // entities with identical params — disposing it would corrupt that cache
    // for every other entity using the same primitive.
    expect(sourceDisposed).toBe(false);
    expect(ours).not.toBe(box);
  });

  /**
   * Swapping a weldable primitive for an unweldable one (podest's geometry
   * picker, the preview's subdivision) used to leave OUR geometry undisposed
   * and unreachable, with `_weldSource` pointing at one A-Frame had already
   * disposed — i.e. init()'s stated invariant ("the geometry WE built, and the
   * mesh is wearing it") quietly false on that path.
   */
  it('drops our geometry when the new one turns out to be unweldable', () => {
    const c = instance(new THREE.BoxGeometry(1, 1, 1));
    c._weldWanted = true;
    c.syncWeld();
    const ours = c._welded!;
    let disposed = false;
    ours.addEventListener('dispose', () => { disposed = true; });

    const sphere = new THREE.SphereGeometry(1, 36, 18);
    meshOf(c).geometry = sphere;
    c.syncWeld();

    expect(disposed).toBe(true);
    expect(c._welded).toBeNull();
    expect(c._weldSource).toBeNull();
    expect(meshOf(c).geometry).toBe(sphere);
  });

  it('is idempotent — a re-apply does not rebuild or re-scan', () => {
    const c = instance(new THREE.BoxGeometry(1, 1, 1));
    c._weldWanted = true;
    c.syncWeld();
    const first = c._welded;
    c.syncWeld();
    expect(c._welded).toBe(first);

    const s = instance(new THREE.SphereGeometry(1, 36, 18));
    s._weldWanted = true;
    s.syncWeld();
    const scanned = s._weldScanned;
    s.syncWeld();
    expect(s._weldScanned).toBe(scanned);
  });

  it('declines to restore over a geometry the system has already swapped', () => {
    // A-Frame's geometry remove() puts a shared empty BufferGeometry on the
    // mesh; putting our source back over that would resurrect a disposed one.
    const box = new THREE.BoxGeometry(1, 1, 1);
    const c = instance(box);
    c._weldWanted = true;
    c.syncWeld();
    const replacement = new THREE.BufferGeometry();
    meshOf(c).geometry = replacement;
    c.unweld();
    expect(meshOf(c).geometry).toBe(replacement);
    expect(c._welded).toBeNull();
  });
});
