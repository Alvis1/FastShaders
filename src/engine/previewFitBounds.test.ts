/**
 * Pins the `fit-bounds` normalization maths.
 *
 * The component lives inside a template string destined for the preview iframe,
 * so it never runs under vitest normally — `tslToPreviewHTML.test.ts` only
 * asserts the emitted ATTRIBUTE string, which means the whole function body
 * could be rewritten (or broken) without a single test failing. Here the script
 * is evaluated against a real `three` and a stub AFRAME, so the maths is
 * exercised for real.
 *
 * What matters, and why:
 *  - `positionGeometry` is three's RAW position attribute, so normalizing the
 *    Object3D (which is what this used to do) is invisible to the shader. Every
 *    position-driven preset, built-in texture and noise-node default is tuned
 *    for the ±0.8 the pre-normalized built-in OBJs deliver, so a dropped model
 *    must be normalized in its ATTRIBUTES or it feeds the shader its authored
 *    units — a 180-unit statue turned Vertex Wave's `sin(pos.y * 8)` into
 *    hundreds of radians per vertex.
 *  - The measurement must happen in the entity's own frame. The preview nests
 *    the mesh under `#preview-entity` (resting tilt) and `#spin-parent` (a live
 *    360° animation), and a world-axis-aligned box would scale the model by its
 *    ROTATED hull — which is why the teapot rendered ~19% undersized and a
 *    dropped model's centring depended on the spin phase it loaded at.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FIT_BOUNDS_SCRIPT } from './tslToPreviewHTML';

interface FitComponent {
  fit: (this: { el: { getObject3D: () => THREE.Object3D | null }; data: { size: number; regen: boolean } }) => void;
}

/** Evaluate the iframe script with a stub AFRAME and capture the component. */
function loadComponent(): FitComponent {
  const body = FIT_BOUNDS_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const registry: Record<string, FitComponent> = {};
  const AFRAME = {
    components: {} as Record<string, unknown>,
    registerComponent: (name: string, def: FitComponent) => { registry[name] = def; },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('THREE', 'window', 'AFRAME', body)(THREE, { AFRAME }, AFRAME);
  const comp = registry['fit-bounds'];
  expect(comp, 'fit-bounds was not registered').toBeTruthy();
  return comp;
}

function runFit(root: THREE.Object3D, { size = 1.6, regen = true } = {}): void {
  const comp = loadComponent();
  comp.fit.call({ el: { getObject3D: () => root }, data: { size, regen } });
}

/** Axis-aligned box (12 triangles) spanning [-1,1]³, scaled by `s`, centred at `c`. */
function makeBoxMesh(s = 1, c: [number, number, number] = [0, 0, 0]): THREE.Mesh {
  const g = new THREE.BoxGeometry(2 * s, 2 * s, 2 * s);
  g.translate(c[0], c[1], c[2]);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial());
}

/** Union bbox of every mesh in the subtree, in the subtree ROOT's local frame. */
function localBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3();
  root.traverse((n) => {
    const mesh = n as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = mesh.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
    g.computeBoundingBox();
    if (g.boundingBox) box.union(g.boundingBox);
  });
  return box;
}

/** Bounds of the raw position ATTRIBUTES — what `positionGeometry` actually reads. */
function attributeBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  root.traverse((n) => {
    const mesh = n as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox) box.union(mesh.geometry.boundingBox);
  });
  return box;
}

/**
 * Triangles whose u corners span more than half the range — i.e. that straddle
 * the atan2 wrap and so interpolate the whole texture backwards across
 * themselves. That IS the defect, so it is the only honest thing to count.
 *
 * Each offender is reported with how polar it is (the largest |y| among its
 * corners, on the same normalized direction the projection used), because the
 * SEAM and the POLE are two different singularities: the seam is repairable by
 * splitting vertices and the pole is not, so a test that lumped them together
 * could only ever assert a magic number.
 */
function uvSeamSpans(g: THREE.BufferGeometry): { span: number; polar: number }[] {
  const uv = g.attributes.uv;
  if (!uv) return [];
  const pos = g.attributes.position;
  const idx = g.index;
  const corners = idx
    ? Array.from({ length: idx.count }, (_, i) => idx.getX(i))
    : Array.from({ length: uv.count }, (_, i) => i);
  const out: { span: number; polar: number }[] = [];
  const v = new THREE.Vector3();
  for (let t = 0; t + 2 < corners.length; t += 3) {
    const tri = [corners[t], corners[t + 1], corners[t + 2]];
    const us = tri.map((i) => uv.getX(i));
    const span = Math.max(...us) - Math.min(...us);
    if (span <= 0.5) continue;
    out.push({
      span,
      polar: Math.max(...tri.map((i) => Math.abs(v.fromBufferAttribute(pos, i).normalize().y))),
    });
  }
  return out;
}

/** Offenders the pole singularity does NOT excuse — this must always be zero. */
const seamSpansOffPole = (g: THREE.BufferGeometry): number =>
  uvSeamSpans(g).filter((s) => s.polar < 0.98).length;

/** Strip a three primitive of its authored uv + normals: what a bare OBJ looks like. */
function bare(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  return g;
}

/** The regenerated built-in teapot as OBJLoader hands it over (non-indexed, v/vt/vn). */
function loadTeapotObj(): THREE.BufferGeometry {
  const src = readFileSync(new URL('../../public/models/teapot.obj', import.meta.url), 'utf8');
  let geo: THREE.BufferGeometry | null = null;
  new OBJLoader().parse(src).traverse((n) => {
    const m = n as THREE.Mesh;
    if (m.isMesh && !geo) geo = m.geometry;
  });
  if (!geo) throw new Error('teapot.obj produced no mesh');
  return geo;
}

const longestAxis = (b: THREE.Box3): number => {
  const s = new THREE.Vector3();
  b.getSize(s);
  return Math.max(s.x, s.y, s.z);
};

describe('fit-bounds normalization', () => {
  it('bakes a huge authored model down into ±size/2 position ATTRIBUTES', () => {
    // A 180-unit statue parked far from the origin — the shape of the bug
    // report: scaling the Object3D left positionGeometry in these units.
    const root = new THREE.Object3D();
    root.add(makeBoxMesh(90, [500, 90, -200]));

    runFit(root);

    const attrs = attributeBounds(root);
    expect(longestAxis(attrs)).toBeCloseTo(1.6, 5);
    const centre = new THREE.Vector3();
    attrs.getCenter(centre);
    expect(centre.length()).toBeLessThan(1e-5);
    expect(attrs.max.x).toBeLessThanOrEqual(0.8 + 1e-5);
    expect(attrs.min.x).toBeGreaterThanOrEqual(-0.8 - 1e-5);
  });

  it('normalizes a tiny model up as well as a huge one down', () => {
    const root = new THREE.Object3D();
    root.add(makeBoxMesh(0.005));
    runFit(root);
    expect(longestAxis(attributeBounds(root))).toBeCloseTo(1.6, 5);
  });

  it('is unaffected by an ancestor rotation (the resting tilt + live spin)', () => {
    // The regression that made the teapot ~19% undersized: a world-axis-aligned
    // Box3 measured the model's ROTATED hull, so the scale depended on the tilt
    // and — for a model that loaded mid-animation — on the spin phase.
    const results: number[] = [];
    for (const angle of [0, Math.PI / 4, Math.PI / 3, 1.9]) {
      const spinParent = new THREE.Object3D();
      spinParent.rotation.set(angle * 0.5, angle, 0);
      const root = new THREE.Object3D();
      spinParent.add(root);
      root.add(makeBoxMesh(3, [7, -2, 1]));
      spinParent.updateMatrixWorld(true);

      runFit(root);
      results.push(longestAxis(attributeBounds(root)));
    }
    for (const r of results) expect(r).toBeCloseTo(1.6, 5);
  });

  it('flattens nested child transforms into the vertex data', () => {
    const root = new THREE.Object3D();
    const pivot = new THREE.Object3D();
    pivot.position.set(40, 0, 0);
    pivot.rotation.set(0, Math.PI / 3, 0.4);
    pivot.scale.setScalar(2.5);
    const mesh = makeBoxMesh(10);
    pivot.add(mesh);
    root.add(pivot);

    runFit(root);

    // Every local matrix in the subtree is identity — the transform now lives
    // in the attributes, so leaving it would apply it a second time.
    root.traverse((n) => {
      expect(n.position.length()).toBeLessThan(1e-6);
      expect(n.scale.x).toBeCloseTo(1, 6);
      expect(Math.abs(n.quaternion.w)).toBeCloseTo(1, 6);
    });
    expect(longestAxis(attributeBounds(root))).toBeCloseTo(1.6, 5);
  });

  it('handles a glTF-style shared geometry reachable from two nodes', () => {
    // A glTF may reference ONE BufferGeometry from several nodes with different
    // transforms. Mutating in place would bake the first node's matrix into the
    // buffer the second node still needs.
    const shared = new THREE.BoxGeometry(2, 2, 2);
    const root = new THREE.Object3D();
    const a = new THREE.Mesh(shared, new THREE.MeshBasicMaterial());
    a.position.set(-5, 0, 0);
    const b = new THREE.Mesh(shared, new THREE.MeshBasicMaterial());
    b.position.set(5, 0, 0);
    root.add(a, b);

    runFit(root);

    expect(a.geometry).not.toBe(b.geometry);
    const ba = attributeBounds(a);
    const bb = attributeBounds(b);
    // The two nodes stay on opposite sides — neither inherited the other's bake.
    expect(ba.max.x).toBeLessThan(0);
    expect(bb.min.x).toBeGreaterThan(0);
    expect(longestAxis(attributeBounds(root))).toBeCloseTo(1.6, 5);
  });

  it('keeps the rendered result in the same place it measured', () => {
    // Baked attributes + identity transforms must frame the model exactly as
    // the primitives are framed: centred at the entity origin, longest axis 1.6.
    const root = new THREE.Object3D();
    root.add(makeBoxMesh(12, [30, 5, 5]));
    runFit(root);

    const world = localBounds(root);
    expect(longestAxis(world)).toBeCloseTo(1.6, 5);
    const centre = new THREE.Vector3();
    world.getCenter(centre);
    expect(centre.length()).toBeLessThan(1e-5);
  });

  it('synthesizes normals for a GLB primitive that ships without them', () => {
    // regen:false preserves authored data, but a glTF primitive may legally
    // omit NORMAL and GLTFLoader does not compute one — an absent normal reads
    // as garbage in normalLocal/normalWorld and blows out every fresnel shader.
    const g = new THREE.BoxGeometry(2, 2, 2);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    const root = new THREE.Object3D();
    root.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()));

    runFit(root, { regen: false });

    const mesh = root.children[0] as THREE.Mesh;
    expect(mesh.geometry.attributes.normal).toBeTruthy();
    expect(mesh.geometry.attributes.uv).toBeTruthy();
    expect(longestAxis(attributeBounds(root))).toBeCloseTo(1.6, 5);
  });

  it('splits the spherical-UV SEAM so no triangle spans the wrap', () => {
    // atan2 steps u from 1 back to 0 across the -X half-plane. Share one vertex
    // between the two sides and every straddling triangle interpolates u
    // backwards over the whole range — the entire texture crushed and mirrored
    // into a band one triangle wide, which is what "the handle-side UVs are
    // rotated and squashed" looked like on the teapot.
    // A BARE source — no uv, no normals — so this exercises the projection
    // path. (A source that ships its own texture coordinates keeps them now;
    // that is the test further down.)
    const root = new THREE.Object3D();
    root.add(new THREE.Mesh(bare(new THREE.SphereGeometry(1, 24, 16)), new THREE.MeshBasicMaterial()));

    runFit(root);

    const g = (root.children[0] as THREE.Mesh).geometry;
    expect(seamSpansOffPole(g)).toBe(0);
    // The repair is vertex duplication, so positions and normals must stay
    // paired with their UVs — a mismatched count renders as scrambled geometry.
    expect(g.attributes.normal.count).toBe(g.attributes.position.count);
    expect(g.attributes.uv.count).toBe(g.attributes.position.count);
    // And the duplicates must be COPIES: a split vertex sits exactly on its
    // original with the same normal, which is what keeps a displaced surface
    // welded across the seam instead of tearing open along it.
    expect(g.index).toBeTruthy();
    const uv = g.attributes.uv;
    const posAttr = g.attributes.position;
    const seen = new Map<string, number[]>();
    for (let i = 0; i < posAttr.count; i++) {
      const key = [posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)].map((n) => n.toFixed(5)).join(',');
      const bucket = seen.get(key) ?? [];
      bucket.push(i);
      seen.set(key, bucket);
    }
    let raised = 0;
    for (const bucket of seen.values()) {
      if (bucket.length < 2) continue;
      const us = bucket.map((i) => uv.getX(i)).sort((a, b) => a - b);
      // Co-located vertices exist only because of the split, so their u values
      // differ by whole periods — never by an arbitrary amount.
      for (let k = 1; k < us.length; k++) expect(us[k] - us[k - 1]).toBeCloseTo(1, 5);
      raised += bucket.length - 1;
    }
    expect(raised, 'the seam split produced no duplicates at all').toBeGreaterThan(0);
  });

  it('leaves a seam-free mesh byte-identical (the split is opt-in by defect)', () => {
    // A cube's spherical UVs happen to straddle the seam, so use the half that
    // cannot: a mesh whose every triangle already sits inside one u period must
    // come back with no duplicated vertices at all.
    const g = bare(new THREE.PlaneGeometry(2, 2));
    g.rotateY(Math.PI / 2); // face +X, i.e. as far from the -X seam as possible
    const root = new THREE.Object3D();
    root.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()));

    runFit(root);

    const out = (root.children[0] as THREE.Mesh).geometry;
    expect(seamSpansOffPole(out)).toBe(0);
    expect(out.attributes.position.count).toBe(4);
  });

  it('KEEPS an OBJ\'s authored texture coordinates and normals on the regen path', () => {
    // Until 2026-09-05 the weld discarded both and every OBJ was re-projected,
    // whatever the file said. The regenerated teapot ships the Utah bijective
    // atlas and analytic normals, so after the fit every vertex must still
    // carry a (uv, normal) pair the FILE authored for that position — and the
    // atlas has no atan2 seam, so nothing may span.
    const src = loadTeapotObj();
    // fit-bounds re-bakes even this pre-normalized file by a hair (the spout
    // tip sits between samples at resolution 16, so the longest axis is a
    // touch under 1.6), so the authored positions are keyed AFTER the same
    // centre-and-scale it applies.
    src.computeBoundingBox();
    const box = src.boundingBox!;
    const centre = new THREE.Vector3();
    box.getCenter(centre);
    const scale = 1.6 / longestAxis(box);
    const authored = new Map<string, Set<string>>();
    const key = (x: number, y: number, z: number) => [x, y, z].map((n) => n.toFixed(3)).join(',');
    for (let i = 0; i < src.attributes.position.count; i++) {
      const p = src.attributes.position, u = src.attributes.uv, n = src.attributes.normal;
      const k = key((p.getX(i) - centre.x) * scale, (p.getY(i) - centre.y) * scale, (p.getZ(i) - centre.z) * scale);
      const set = authored.get(k) ?? new Set();
      set.add(`${u.getX(i).toFixed(4)},${u.getY(i).toFixed(4)}|${n.getX(i).toFixed(3)},${n.getY(i).toFixed(3)},${n.getZ(i).toFixed(3)}`);
      authored.set(k, set);
    }
    const root = new THREE.Object3D();
    root.add(new THREE.Mesh(src, new THREE.MeshBasicMaterial()));

    runFit(root); // regen: true — the built-in path

    const g = (root.children[0] as THREE.Mesh).geometry;
    const p = g.attributes.position, u = g.attributes.uv, n = g.attributes.normal;
    expect(u.count).toBe(p.count);
    expect(n.count).toBe(p.count);
    // Welded: far fewer vertices than the 3-per-face OBJLoader output, but
    // more than the tessellator's grid (chart boundaries stay split).
    expect(p.count).toBeLessThan(src.attributes.position.count / 2);
    let matched = 0;
    for (let i = 0; i < p.count; i++) {
      const set = authored.get(key(p.getX(i), p.getY(i), p.getZ(i)));
      const tag = `${u.getX(i).toFixed(4)},${u.getY(i).toFixed(4)}|${n.getX(i).toFixed(3)},${n.getY(i).toFixed(3)},${n.getZ(i).toFixed(3)}`;
      if (set?.has(tag)) matched++;
      expect(u.getX(i)).toBeGreaterThanOrEqual(0);
      expect(u.getX(i)).toBeLessThanOrEqual(1);
      expect(u.getY(i)).toBeGreaterThanOrEqual(0);
      expect(u.getY(i)).toBeLessThanOrEqual(1);
    }
    // Every output vertex is an authored (uv, normal) at its own position —
    // allow a rounding-boundary handful, never a re-projection.
    expect(matched / p.count).toBeGreaterThan(0.995);
    expect(uvSeamSpans(g).length).toBe(0);
  });

  it('splits the seam on an INTERLEAVED geometry without scrambling it', () => {
    // The preserve path synthesizes UVs for a GLB that ships none, and a glTF
    // primitive is free to interleave its attributes — a shape the regen path
    // never produces, so nothing else here exercises it. Duplicating a vertex
    // out of an interleaved buffer means reading through the stride/offset
    // rather than a flat array; get that wrong and the copies are silently
    // someone else's vertex, which renders as shredded geometry near the seam.
    // Rotated by HALF a segment on purpose: SphereGeometry's own duplicated
    // seam column sits exactly where atan2 wraps, so an unrotated one straddles
    // nothing and the split never runs — the test would pass without executing
    // a line of the code it exists to cover.
    const src = new THREE.SphereGeometry(1, 24, 16).rotateY(Math.PI / 24);
    const pos = src.attributes.position;
    const nrm = src.attributes.normal;
    const stride = 6;
    const packed = new Float32Array(pos.count * stride);
    for (let i = 0; i < pos.count; i++) {
      packed.set([pos.getX(i), pos.getY(i), pos.getZ(i), nrm.getX(i), nrm.getY(i), nrm.getZ(i)], i * stride);
    }
    const buf = new THREE.InterleavedBuffer(packed, stride);
    const g = new THREE.BufferGeometry();
    g.setIndex(src.index);
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(buf, 3, 0));
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(buf, 3, 3));
    const root = new THREE.Object3D();
    root.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()));

    runFit(root, { regen: false });

    const out = (root.children[0] as THREE.Mesh).geometry;
    expect(seamSpansOffPole(out)).toBe(0);
    expect(out.attributes.position.count).toBeGreaterThan(pos.count); // it split
    // Every vertex must still be a unit sphere point carrying its own outward
    // normal — the exact property a mis-strided copy destroys.
    const p = out.attributes.position;
    const n = out.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const r = Math.hypot(p.getX(i), p.getY(i), p.getZ(i));
      expect(r).toBeCloseTo(0.8, 4); // fit-bounds normalizes the diameter to 1.6
      const dot = (p.getX(i) * n.getX(i) + p.getY(i) * n.getY(i) + p.getZ(i) * n.getZ(i)) / r;
      expect(dot).toBeCloseTo(1, 4);
    }
  });

  it('repairs the seam on the SHIPPED bunny, and the teapot never has one', () => {
    // The bunny is the one built-in still PROJECTED (a bare `f a b c` OBJ) — the
    // seam defect was first reported on the teapot, whose seam plane ran through
    // its handle, but that file now ships the Utah atlas and takes the
    // authored-UV path (the test below). Both are pre-normalized, so this is
    // the real geometry the preview renders.
    for (const name of ['teapot.obj', 'stanford-bunny.obj']) {
      const src = readFileSync(new URL(`../../public/models/${name}`, import.meta.url), 'utf8');
      const obj = new OBJLoader().parse(src);
      const root = new THREE.Object3D();
      root.add(obj);

      runFit(root);

      let meshes = 0;
      root.traverse((n) => {
        const m = n as THREE.Mesh;
        if (!m.isMesh) return;
        meshes++;
        const spans = uvSeamSpans(m.geometry);
        expect(seamSpansOffPole(m.geometry), `${name} still has SEAM triangles`).toBe(0);
        // The pole residue is real but tiny and confined to the axis; a bound
        // here is what would catch the seam pass silently regressing into it.
        expect(spans.length, `${name} pole residue grew`).toBeLessThan(10);
        for (const s of spans) expect(s.polar).toBeGreaterThan(0.98);
      });
      expect(meshes, `${name} produced no mesh`).toBeGreaterThan(0);
    }
  });

  it('preserves authored normals on the regen:false path', () => {
    const g = new THREE.BoxGeometry(2, 2, 2);
    const root = new THREE.Object3D();
    root.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()));

    runFit(root, { regen: false });

    const mesh = root.children[0] as THREE.Mesh;
    const n = mesh.geometry.attributes.normal;
    // A box's normals are axis-aligned units; a uniform scale + translation
    // bake must leave them exactly that.
    for (let i = 0; i < n.count; i++) {
      const len = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
      expect(len).toBeCloseTo(1, 5);
    }
  });

  it('falls back to Object3D scaling for a skinned mesh instead of mis-baking it', () => {
    // Baking would desync the bind matrices, so a rigged model keeps the legacy
    // behaviour (authored units in the shader) rather than rendering wrong.
    const root = new THREE.Object3D();
    const geo = new THREE.BoxGeometry(20, 20, 20);
    // A real rigged glTF primitive carries these; without them three cannot
    // even compute the mesh's own bounds.
    const vcount = geo.attributes.position.count;
    const idx = new Uint16Array(vcount * 4);
    const wts = new Float32Array(vcount * 4);
    for (let i = 0; i < vcount; i++) wts[i * 4] = 1;
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
    const skinned = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
    const bone = new THREE.Bone();
    skinned.add(bone);
    skinned.bind(new THREE.Skeleton([bone]));
    root.add(skinned);

    runFit(root);

    expect(root.scale.x).toBeCloseTo(1.6 / 20, 5);
    // Attributes deliberately untouched.
    expect(longestAxis(attributeBounds(root))).toBeCloseTo(20, 5);
  });

  it('falls back to Object3D scaling for an ANIMATED model instead of baking it', () => {
    // The bake moves each node's world matrix into its vertex data and then
    // flattens every local matrix to identity — which is precisely the state an
    // AnimationMixer overwrites, so a node-TRS clip would apply its keyframes a
    // SECOND time on top of geometry that already carries them. (Morph clips
    // break by a different route: applyMatrix4 transforms `position` and
    // `normal` but NOT `morphAttributes`, so the deltas would stay in authored
    // units while the base mesh shrank into the preview box.)
    const root = new THREE.Object3D();
    root.add(makeBoxMesh(10));
    (root as THREE.Object3D & { animations: THREE.AnimationClip[] }).animations = [
      new THREE.AnimationClip('Walk', 1, [
        new THREE.VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 5, 0, 0]),
      ]),
    ];

    runFit(root);

    // Normalized on the Object3D, exactly like the skinned path above…
    expect(root.scale.x).toBeCloseTo(1.6 / 20, 5);
    // …and the attributes are deliberately left in the model's authored units,
    // which is the known cost: position-driven shaders are mis-scaled on an
    // animated model. Nothing renders inconsistently.
    expect(longestAxis(attributeBounds(root))).toBeCloseTo(20, 5);
    // Local transforms are NOT flattened — they are the animation's targets.
    expect(root.children[0].position.length()).toBeLessThan(1e-9);
  });

  it('scales an ANIMATED model by the WORLD box, tilt and spin included', () => {
    // Pins the known flaw rather than the fix, because the fix was worse. The
    // fallback measures with Box3.setFromObject, so an ancestor rotation
    // inflates the box and the model comes out smaller — up to ~1.7x, and it
    // depends on the spin phase the model happened to load at.
    //
    // Measuring the meshes' own geometry boxes in the entity frame removes
    // that, and was REVERTED: a local AABB is never larger than the world one,
    // so every animated model grew, and the shortfall is NOT bounded by the
    // rotation — setFromObject also expands by `Points`/`Line` primitives and
    // by an InstancedMesh's per-instance spread, which a mesh-geometry union
    // cannot see. A model carrying any of those measured far too small and
    // scaled up hard. Slightly small beats blown up.
    const fitAt = (angle: number) => {
      const spinParent = new THREE.Object3D();
      spinParent.rotation.set(0, angle, 0);
      const root = new THREE.Object3D();
      spinParent.add(root);
      root.add(makeBoxMesh(10));
      (root as THREE.Object3D & { animations: THREE.AnimationClip[] }).animations = [
        new THREE.AnimationClip('Walk', 1, [
          new THREE.VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 5, 0, 0]),
        ]),
      ];
      spinParent.updateMatrixWorld(true);
      runFit(root);
      return root.scale.x;
    };
    // Unrotated: exactly the primitives' framing.
    expect(fitAt(0)).toBeCloseTo(1.6 / 20, 6);
    // Rotated 45°, the box's diagonal is what gets measured, so the model is
    // framed smaller by √2. Documented, not desired — and cheaper than the
    // alternative.
    expect(fitAt(Math.PI / 4)).toBeCloseTo(1.6 / (20 * Math.SQRT2), 5);
  });

  it('still bakes a model whose animations array is present but empty', () => {
    // GLTFLoader always sets `animations`; only a non-empty one means the
    // mixer will be driving these nodes.
    const root = new THREE.Object3D();
    root.add(makeBoxMesh(10));
    (root as THREE.Object3D & { animations: THREE.AnimationClip[] }).animations = [];

    runFit(root);

    expect(longestAxis(attributeBounds(root))).toBeCloseTo(1.6, 5);
  });

  it('leaves an empty subtree alone', () => {
    const root = new THREE.Object3D();
    expect(() => runFit(root)).not.toThrow();
  });
});

/**
 * `public/podest.html` carries a hand-minified twin of this component and is
 * covered by NO sync plugin (fs-vendor-sync only covers public/js/), so the two
 * can drift silently — and a drifted podest would frame and scale dropped models
 * differently from the editor preview for the same shader. These run the podest
 * copy through the same maths.
 *
 * The `animated` branch is in BOTH now: podest carries its own `gltf-anim`
 * twin (pushGltfAnim), so an animated model there is driven by a mixer and must
 * not be baked either. It was deliberately absent while only the editor could
 * animate — skipping the bake with no mixer would have cost podest the
 * attribute normalization and bought nothing.
 */
describe('podest fit-bounds twin', () => {
  function loadPodestComponent(): FitComponent {
    const html = readFileSync(
      new URL('../../public/podest.html', import.meta.url),
      'utf8',
    );
    // Each helper is one `L.push('…');` line; the payloads quote with " so the
    // single-quoted host string needs no unescaping.
    const wanted = ['function mergeByPosition', 'function rawComponent', 'function expandAttribute', 'function splitUVSeam', 'function splitByAuthored', 'function sphericalUVs', 'function flipWinding', 'AFRAME.registerComponent("fit-bounds"'];
    const parts = wanted.map((needle) => {
      const line = html.split('\n').find((l) => l.includes(`L.push('  ${needle}`));
      expect(line, `podest.html is missing its ${needle} push`).toBeTruthy();
      const body = line!.trim().replace(/^L\.push\('/, '').replace(/'\);$/, '');
      expect(body).not.toContain("\\'");
      return body;
    });
    const registry: Record<string, FitComponent> = {};
    const AFRAME = {
      components: {} as Record<string, unknown>,
      registerComponent: (name: string, def: FitComponent) => { registry[name] = def; },
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('THREE', 'AFRAME', parts.join('\n'))(THREE, AFRAME);
    const comp = registry['fit-bounds'];
    expect(comp, 'podest fit-bounds was not registered').toBeTruthy();
    return comp;
  }

  const runPodestFit = (root: THREE.Object3D, regen = true) =>
    loadPodestComponent().fit.call({ el: { getObject3D: () => root }, data: { size: 1.6, regen } });

  it('splits the UV seam exactly like the editor preview does', () => {
    // A dropped model is textured on both surfaces, so a podest that kept the
    // shared seam vertex would show the crushed band the editor no longer has —
    // the same shader rendering differently depending which page opened it.
    const build = () => {
      const r = new THREE.Object3D();
      r.add(new THREE.Mesh(bare(new THREE.SphereGeometry(1, 24, 16)), new THREE.MeshBasicMaterial()));
      return r;
    };
    const editorRoot = build();
    const podestRoot = build();
    runFit(editorRoot);
    runPodestFit(podestRoot);

    const editorGeo = (editorRoot.children[0] as THREE.Mesh).geometry;
    const podestGeo = (podestRoot.children[0] as THREE.Mesh).geometry;
    expect(seamSpansOffPole(podestGeo)).toBe(0);
    // Same vertex count and the same UVs, not merely "also repaired somehow".
    expect(podestGeo.attributes.position.count).toBe(editorGeo.attributes.position.count);
    const eu = editorGeo.attributes.uv;
    const pu = podestGeo.attributes.uv;
    for (let i = 0; i < eu.count; i++) {
      expect(pu.getX(i)).toBeCloseTo(eu.getX(i), 6);
      expect(pu.getY(i)).toBeCloseTo(eu.getY(i), 6);
    }
  });

  it('keeps an OBJ\'s authored texture coordinates exactly like the editor preview does', () => {
    // podest loads public/models/teapot.obj with regen: true, so if its twin
    // still threw authored UVs away the pedestal would show the spherical
    // projection while the editor showed the atlas — for the same shader.
    const editorRoot = new THREE.Object3D();
    editorRoot.add(new THREE.Mesh(loadTeapotObj(), new THREE.MeshBasicMaterial()));
    const podestRoot = new THREE.Object3D();
    podestRoot.add(new THREE.Mesh(loadTeapotObj(), new THREE.MeshBasicMaterial()));
    runFit(editorRoot);
    runPodestFit(podestRoot);

    const e = (editorRoot.children[0] as THREE.Mesh).geometry;
    const p = (podestRoot.children[0] as THREE.Mesh).geometry;
    expect(p.attributes.position.count).toBe(e.attributes.position.count);
    expect(p.attributes.uv.count).toBe(e.attributes.uv.count);
    for (let i = 0; i < e.attributes.uv.count; i++) {
      expect(p.attributes.uv.getX(i)).toBeCloseTo(e.attributes.uv.getX(i), 6);
      expect(p.attributes.uv.getY(i)).toBeCloseTo(e.attributes.uv.getY(i), 6);
      expect(p.attributes.normal.getX(i)).toBeCloseTo(e.attributes.normal.getX(i), 6);
    }
    expect(uvSeamSpans(p).length).toBe(0);
  });

  it('bakes into the attributes exactly like the editor preview does', () => {
    const build = () => {
      const r = new THREE.Object3D();
      const pivot = new THREE.Object3D();
      pivot.position.set(120, -8, 4);
      pivot.rotation.set(0.3, 1.1, 0);
      pivot.scale.setScalar(3);
      pivot.add(makeBoxMesh(25));
      r.add(pivot);
      return r;
    };
    const editorRoot = build();
    const podestRoot = build();
    runFit(editorRoot);
    runPodestFit(podestRoot);

    const a = attributeBounds(editorRoot);
    const b = attributeBounds(podestRoot);
    expect(longestAxis(b)).toBeCloseTo(1.6, 5);
    expect(b.min.toArray()).toEqual(a.min.toArray().map((v) => expect.closeTo(v, 5)));
    expect(b.max.toArray()).toEqual(a.max.toArray().map((v) => expect.closeTo(v, 5)));
  });

  it('refuses to bake an ANIMATED model, exactly like the editor copy', () => {
    // podest has a mixer of its own now (pushGltfAnim), so the two surfaces
    // must agree: baking would be double-applied by every animation frame.
    const build = () => {
      const r = new THREE.Object3D();
      r.add(makeBoxMesh(10));
      (r as THREE.Object3D & { animations: THREE.AnimationClip[] }).animations = [
        new THREE.AnimationClip('Walk', 1, [
          new THREE.VectorKeyframeTrack('.position', [0, 1], [0, 0, 0, 5, 0, 0]),
        ]),
      ];
      return r;
    };
    const editorRoot = build();
    const podestRoot = build();
    runFit(editorRoot);
    runPodestFit(podestRoot);

    expect(podestRoot.scale.x).toBeCloseTo(editorRoot.scale.x, 6);
    expect(podestRoot.scale.x).toBeCloseTo(1.6 / 20, 5);
    expect(longestAxis(attributeBounds(podestRoot))).toBeCloseTo(20, 5);
  });

  it('is likewise immune to an ancestor rotation', () => {
    const spin = new THREE.Object3D();
    spin.rotation.set(0.4, 1.2, 0.1);
    const root = new THREE.Object3D();
    spin.add(root);
    root.add(makeBoxMesh(9, [3, 3, 3]));
    spin.updateMatrixWorld(true);

    runPodestFit(root);
    expect(longestAxis(attributeBounds(root))).toBeCloseTo(1.6, 5);
  });
});
