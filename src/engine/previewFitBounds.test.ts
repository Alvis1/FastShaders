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
 *  - The bake writes back into each attribute's OWN typed array, so a
 *    KHR_mesh_quantization mesh (Int8/Int16 position/normal/tangent,
 *    gltfpack's default output alongside meshopt) must be widened to Float32
 *    first, or unnormalized positions truncate to integers and normalized
 *    ones wrap.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FIT_BOUNDS_SCRIPT } from './tslToPreviewHTML';
import { bareObjArrays } from './builtinModelObj';

interface FitComponent {
  fit: (this: { el: { getObject3D: () => THREE.Object3D | null }; data: { size: number; regen: boolean } }) => void;
}

/**
 * Evaluate a fit-bounds script with a stub AFRAME and hand back what it
 * registered. `win` hands the script a `window` parameter (the editor's copy
 * takes one, podest's does not); `aframeThree` becomes AFRAME.THREE.
 */
function evalFit(body: string, win: boolean, aframeThree?: object): FitComponent {
  const registry: Record<string, FitComponent> = {};
  const AFRAME = {
    ...(aframeThree ? { THREE: aframeThree } : {}),
    components: {} as Record<string, unknown>,
    registerComponent: (name: string, def: FitComponent) => { registry[name] = def; },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  if (win) new Function('THREE', 'window', 'AFRAME', body)(THREE, { AFRAME }, AFRAME);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  else new Function('THREE', 'AFRAME', body)(THREE, AFRAME);
  return registry['fit-bounds'];
}

const editorFitBody = (): string => FIT_BOUNDS_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');

/** Evaluate the iframe script with a stub AFRAME and capture the component. */
function loadComponent(): FitComponent {
  const comp = evalFit(editorFitBody(), true);
  expect(comp, 'fit-bounds was not registered').toBeTruthy();
  return comp;
}

/** podest.html's fit-bounds twin: each helper is one `L.push('  <needle>…');` line. */
const PODEST_FIT_PUSHES = ['function mergeByPosition', 'function rawComponent', 'function expandAttribute', 'function splitUVSeam', 'function splitByAuthored', 'function sphericalUVs', 'function flipWinding', 'function dequantize', 'AFRAME.registerComponent("fit-bounds"'];

/** The payloads of those lines, each passed through `payload`, joined into one script. */
function podestPushes(needles: string[], payload: (body: string) => string): string {
  const html = readFileSync(new URL('../../public/podest.html', import.meta.url), 'utf8');
  return needles
    .map((needle) => {
      const line = html.split('\n').find((l) => l.includes(`L.push('  ${needle}`));
      expect(line, `podest.html is missing its ${needle} push`).toBeTruthy();
      return payload(line!.trim().replace(/^L\.push\('/, '').replace(/'\);$/, ''));
    })
    .join('\n');
}

/**
 * A GaussianSplat as the `splat-model` component hands it over: a Mesh whose
 * geometry is ONE instanced ±2 quad (`instanceCount` = splats). Stubbed rather
 * than built — the addon is not part of the node three — with the two facts
 * fit-bounds could trip on: `isMesh` and a real geometry.
 */
function makeSplatStub(splats = 1000): THREE.Mesh {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = splats;
  return Object.assign(new THREE.Mesh(g, new THREE.MeshBasicMaterial()), { isGaussianSplat: true });
}

/** Run `fn` with `Box3.setFromObject` and the splat geometry's `clone` spied on. */
function withSpies(splat: THREE.Mesh, fn: () => void): { setFromObject: number; clone: number } {
  const box = vi.spyOn(THREE.Box3.prototype, 'setFromObject');
  const clone = vi.spyOn(splat.geometry, 'clone');
  try {
    fn();
    return { setFromObject: box.mock.calls.length, clone: clone.mock.calls.length };
  } finally {
    box.mockRestore();
    clone.mockRestore();
  }
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

type FitRunner = (root: THREE.Object3D, regen: boolean) => void;

/**
 * A KHR_mesh_quantization primitive as GLTFLoader hands it over: unnormalized
 * Int16 positions brought back to size by a 1/1000 node scale, normalized Int8
 * normals and normalized Int16 tangents. Paired with a Float32 twin holding the
 * SAME values (read back through three's own denormalizing accessors) and
 * differing in nothing else: the index and the quantized uv are shared, so any
 * difference in the output comes from the three attributes the bake writes.
 */
function quantizedPair(): { quantized: THREE.Object3D; float: THREE.Object3D } {
  const src = new THREE.SphereGeometry(1, 12, 8);
  src.computeTangents();
  const quantize = (name: string, out: Int8Array | Int16Array | Uint16Array, k: number, normalized: boolean) => {
    const a = src.getAttribute(name) as THREE.BufferAttribute;
    for (let i = 0; i < out.length; i++) out[i] = Math.round(a.array[i] * k);
    return new THREE.BufferAttribute(out, a.itemSize, normalized);
  };
  const count = src.attributes.position.count;
  const uv = quantize('uv', new Uint16Array(count * 2), 65535, true);
  const q = new THREE.BufferGeometry();
  q.setIndex(src.index);
  q.setAttribute('position', quantize('position', new Int16Array(count * 3), 1000, false));
  q.setAttribute('normal', quantize('normal', new Int8Array(count * 3), 127, true));
  q.setAttribute('tangent', quantize('tangent', new Int16Array(count * 4), 32767, true));
  q.setAttribute('uv', uv);
  const f = new THREE.BufferGeometry();
  f.setIndex(src.index);
  for (const name of ['position', 'normal', 'tangent']) {
    const a = q.getAttribute(name) as THREE.BufferAttribute;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
    }
    f.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  f.setAttribute('uv', uv);
  const place = (g: THREE.BufferGeometry): THREE.Object3D => {
    const root = new THREE.Object3D();
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    mesh.scale.setScalar(1 / 1000);
    mesh.rotation.set(0.3, 0.7, 0);
    root.add(mesh);
    return root;
  };
  return { quantized: place(q), float: place(f) };
}

/** The quantized mesh must bake to exactly what its Float32 twin bakes to, on both paths. */
function expectQuantizedBakeMatchesFloat(fit: FitRunner): void {
  for (const regen of [false, true]) {
    const { quantized, float } = quantizedPair();
    fit(quantized, regen);
    fit(float, regen);
    const q = (quantized.children[0] as THREE.Mesh).geometry;
    const f = (float.children[0] as THREE.Mesh).geometry;
    // The regen path rebuilds the mesh from position/normal/uv; it carries no tangent.
    const names = regen ? ['position', 'normal'] : ['position', 'normal', 'tangent'];
    for (const name of names) {
      const qa = q.getAttribute(name);
      expect(qa.array, `${name} (regen ${regen})`).toBeInstanceOf(Float32Array);
      expect(qa.normalized, `${name} (regen ${regen})`).toBe(false);
      expect(Array.from(qa.array), `${name} (regen ${regen})`).toEqual(Array.from(f.getAttribute(name).array));
    }
    // Still a sphere, not the -1/0/1 lattice a truncating bake collapses it
    // onto. (Scale-free on purpose: fit-bounds sizes a ROTATED mesh by its
    // transformed AABB, which is loose around a sphere, so 1.6 is not the
    // number here; the Float32 twin's equality above already pins the scale.)
    const pos = q.getAttribute('position');
    const radii = Array.from({ length: pos.count }, (_, i) => Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)));
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    expect(mean).toBeGreaterThan(0.3);
    for (const r of radii) expect(Math.abs(r - mean)).toBeLessThan(2e-3);
    if (!regen) {
      // Nothing in the bake writes uv, so it keeps its quantized form.
      expect(q.attributes.uv.array).toBeInstanceOf(Uint16Array);
      expect(q.attributes.uv.normalized).toBe(true);
    }
  }
}

/**
 * A quantized primitive with NO uv: the preserve path projects UVs and splits
 * their seam, which rebuilds EVERY attribute through expandAttribute. Only
 * position/normal/tangent are dequantized, so a quantized COLOR_0 must come out
 * of the split in its own normalized Uint8 form, each duplicate carrying its
 * original's colour.
 */
function expectQuantizedColourSurvivesSeamSplit(fit: FitRunner): void {
  // Half a segment off, so a seam really straddles (see the interleaved case).
  const src = new THREE.SphereGeometry(1, 24, 16).rotateY(Math.PI / 24);
  const count = src.attributes.position.count;
  const pos = new Int16Array(count * 3);
  for (let i = 0; i < pos.length; i++) pos[i] = Math.round(src.attributes.position.array[i] * 1000);
  const colour = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) colour.set([i & 255, (i >> 8) & 255, 200], i * 3);
  const g = new THREE.BufferGeometry();
  g.setIndex(src.index);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colour, 3, true));
  const root = new THREE.Object3D();
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  mesh.scale.setScalar(1 / 1000);
  root.add(mesh);

  fit(root, false);

  const out = (root.children[0] as THREE.Mesh).geometry;
  const p = out.attributes.position;
  const c = out.attributes.color;
  expect(p.count).toBeGreaterThan(count); // it split
  expect(seamSpansOffPole(out)).toBe(0);
  expect(c.array).toBeInstanceOf(Uint8Array);
  expect(c.normalized).toBe(true);
  expect(Array.from(c.array.subarray(0, count * 3))).toEqual(Array.from(colour));
  // A duplicate is a copy of an original: the same point, and a colour found there.
  const key = (i: number) => [p.getX(i), p.getY(i), p.getZ(i)].join(',');
  const rgb = (i: number) => [c.getX(i), c.getY(i), c.getZ(i)].join(',');
  const at = new Map<string, Set<string>>();
  for (let i = 0; i < count; i++) {
    if (!at.has(key(i))) at.set(key(i), new Set());
    at.get(key(i))!.add(rgb(i));
  }
  for (let i = count; i < p.count; i++) expect(at.get(key(i))?.has(rgb(i)), `duplicate ${i}`).toBe(true);
}

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

  it('projects three\'s OWN SphereGeometry uv: u right and v up seen from outside, so a picture reads the right way round', () => {
    // Until 2026-10-08 the projection ran u the other way (atan2(z, x)/2π + ½),
    // so every bare OBJ was textured MIRRORED — the reason the Image node once
    // baked a 1-u into every picture, which mirrored it on every primitive
    // instead. podest's twin and the exported bunny OBJ are held equal to this
    // copy (below), so the three move together.
    const sphere = new THREE.SphereGeometry(1, 32, 16);
    const authored = new Map<string, number[][]>();
    const key = (x: number, y: number, z: number) => [x, y, z].map((n) => n.toFixed(4)).join(',');
    const sp = sphere.attributes.position;
    const su = sphere.attributes.uv;
    for (let i = 0; i < sp.count; i++) {
      const k = key(sp.getX(i), sp.getY(i), sp.getZ(i));
      authored.set(k, [...(authored.get(k) ?? []), [su.getX(i), su.getY(i)]]);
    }
    const root = new THREE.Object3D();
    root.add(new THREE.Mesh(bare(sphere.clone()), new THREE.MeshBasicMaterial()));
    runFit(root);
    const g = (root.children[0] as THREE.Mesh).geometry;
    const p = g.attributes.position;
    const uv = g.attributes.uv;
    // The very values, away from the poles (three offsets a pole row's u): the
    // sphere's own uv at that point, u modulo the seam's whole period.
    let compared = 0;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / 0.8;
      if (Math.abs(y) > 0.999) continue;
      const own = authored.get(key(p.getX(i) / 0.8, y, p.getZ(i) / 0.8));
      expect(own, `no sphere vertex at ${i}`).toBeTruthy();
      const du = uv.getX(i) - own![0][0];
      expect(Math.abs(du - Math.round(du)), `u at ${i}`).toBeLessThan(1e-5);
      expect(Math.abs(uv.getY(i) - own![0][1]), `v at ${i}`).toBeLessThan(1e-5);
      compared++;
    }
    expect(compared).toBeGreaterThan(400);
    // Handedness, triangle by triangle: (∂P/∂u × ∂P/∂v) points OUT of the
    // surface, i.e. seen from outside u runs right and v up, never mirrored.
    const idx = g.index!;
    const P = [0, 1, 2].map(() => new THREE.Vector3());
    let right = 0;
    let mirrored = 0;
    for (let t = 0; t + 2 < idx.count; t += 3) {
      const c = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
      c.forEach((v, k) => P[k].fromBufferAttribute(p, v));
      if (P.some((q) => Math.abs(q.y / 0.8) > 0.95)) continue;
      const n = new THREE.Vector3().subVectors(P[1], P[0]).cross(new THREE.Vector3().subVectors(P[2], P[0]));
      const out = n.dot(P[0]) > 0 ? 1 : -1;
      const du1 = uv.getX(c[1]) - uv.getX(c[0]);
      const dv1 = uv.getY(c[1]) - uv.getY(c[0]);
      const du2 = uv.getX(c[2]) - uv.getX(c[0]);
      const dv2 = uv.getY(c[2]) - uv.getY(c[0]);
      if (out * (du1 * dv2 - du2 * dv1) > 0) right++;
      else mirrored++;
    }
    expect(mirrored).toBe(0);
    expect(right).toBeGreaterThan(300);
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

  // Real geometry, so real work: parsing the 1.26 MB teapot OBJ and the 69k-
  // triangle bunny, then welding and seam-splitting both. ~1-2 s alone, but it
  // measured 5.6 s twice in the full suite (isolate: false puts it beside the
  // other heavy engine files), so the default 5 s timeout failed it for load.
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
  }, 60_000);

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

  it('dequantizes a KHR_mesh_quantization mesh before baking it', () => {
    // applyMatrix4 writes back into the attribute's OWN typed array. Without
    // the widening, unnormalized Int16 positions under a 1/1000 node scale were
    // truncated to the integers -1/0/1 (the model collapsed onto a lattice) and
    // normalized ones wrapped (0.5 x 3 came back as -0.5), measured on r184.
    // gltfpack emits exactly this shape alongside meshopt.
    expectQuantizedBakeMatchesFloat((root, regen) => runFit(root, { regen }));
  });

  it('leaves every other quantized attribute quantized, through the seam split too', () => {
    expectQuantizedColourSurvivesSeamSplit((root, regen) => runFit(root, { regen }));
  });

  it('leaves an empty subtree alone', () => {
    const root = new THREE.Object3D();
    expect(() => runFit(root)).not.toThrow();
  });

  it('leaves a Gaussian splat exactly as splat-model built it — never cloned, baked or scaled', () => {
    const splat = makeSplatStub();
    splat.position.set(0.3, -0.2, 0.1);
    const geometry = splat.geometry;
    const before = Array.from(geometry.attributes.position.array as Float32Array);
    const calls = withSpies(splat, () => runFit(splat, { regen: false }));
    expect(calls).toEqual({ setFromObject: 0, clone: 0 });
    expect(splat.geometry).toBe(geometry);
    expect(Array.from(geometry.attributes.position.array as Float32Array)).toEqual(before);
    expect(splat.position.toArray()).toEqual([0.3, -0.2, 0.1]);
    expect(splat.scale.toArray()).toEqual([1, 1, 1]);
    expect((splat.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1000);
  });

  it('returns early for a splat ANYWHERE in the subtree — the mesh beside it is not baked either', () => {
    const root = new THREE.Group();
    root.scale.setScalar(3);
    const splat = makeSplatStub();
    const box = makeBoxMesh(50);
    const boxGeometry = box.geometry;
    root.add(box, splat);
    const calls = withSpies(splat, () => runFit(root));
    expect(calls).toEqual({ setFromObject: 0, clone: 0 });
    expect(box.geometry).toBe(boxGeometry);
    expect(root.scale.toArray()).toEqual([3, 3, 3]);
  });

  it('never measures a splat by its world box, even on the animated (Object3D-scaling) path', () => {
    const root = new THREE.Group();
    root.animations = [new THREE.AnimationClip('spin', 1, [])];
    const splat = makeSplatStub();
    root.add(splat);
    const calls = withSpies(splat, () => runFit(root));
    expect(calls.setFromObject).toBe(0);
    expect(root.scale.toArray()).toEqual([1, 1, 1]);
    expect(root.position.toArray()).toEqual([0, 0, 0]);
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
    // The payloads quote with " so the single-quoted host string needs no
    // unescaping.
    const script = podestPushes(PODEST_FIT_PUSHES, (body) => {
      expect(body).not.toContain("\\'");
      return body;
    });
    const comp = evalFit(script, false);
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

  it('dequantizes a KHR_mesh_quantization mesh exactly like the editor preview does', () => {
    expectQuantizedBakeMatchesFloat(runPodestFit);
    // And to the same numbers as the editor copy, not merely "also Float32".
    const editor = quantizedPair().quantized;
    const podest = quantizedPair().quantized;
    runFit(editor, { regen: false });
    runPodestFit(podest, false);
    const e = (editor.children[0] as THREE.Mesh).geometry;
    const p = (podest.children[0] as THREE.Mesh).geometry;
    for (const name of ['position', 'normal', 'tangent']) {
      expect(Array.from(p.getAttribute(name).array), name).toEqual(Array.from(e.getAttribute(name).array));
    }
  });

  it('leaves other quantized attributes quantized exactly like the editor preview does', () => {
    expectQuantizedColourSurvivesSeamSplit(runPodestFit);
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

  /*
   * The Gaussian-splat early return, twinned. Podest's stage and VR popup put
   * fit-bounds beside splat-model exactly as the editor does, so a twin that
   * kept baking would clone the one instanced ±2 quad and scale the already
   * normalised scene (or measure the quad with a Box3) on the pedestal only.
   */
  it('leaves a Gaussian splat exactly as splat-model built it, like the editor copy', () => {
    const run = (fit: (r: THREE.Object3D) => void) => {
      const splat = makeSplatStub();
      splat.position.set(0.3, -0.2, 0.1);
      const geometry = splat.geometry;
      const before = Array.from(geometry.attributes.position.array as Float32Array);
      const calls = withSpies(splat, () => fit(splat));
      expect(splat.geometry).toBe(geometry);
      expect(Array.from(geometry.attributes.position.array as Float32Array)).toEqual(before);
      expect((geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1000);
      return { calls, position: splat.position.toArray(), scale: splat.scale.toArray() };
    };
    const podest = run((r) => runPodestFit(r, false));
    expect(podest).toEqual({ calls: { setFromObject: 0, clone: 0 }, position: [0.3, -0.2, 0.1], scale: [1, 1, 1] });
    expect(podest).toEqual(run((r) => runFit(r, { regen: false })));
  });

  it('returns early for a splat ANYWHERE in the subtree — the mesh beside it is not baked either', () => {
    for (const regen of [true, false]) {
      const root = new THREE.Group();
      root.scale.setScalar(3);
      const splat = makeSplatStub();
      const box = makeBoxMesh(50);
      const boxGeometry = box.geometry;
      root.add(box, splat);
      const calls = withSpies(splat, () => runPodestFit(root, regen));
      expect(calls).toEqual({ setFromObject: 0, clone: 0 });
      expect(box.geometry).toBe(boxGeometry);
      expect(root.scale.toArray()).toEqual([3, 3, 3]);
    }
  });

  it('never measures a splat by its world box, even on the animated (Object3D-scaling) path', () => {
    const root = new THREE.Group();
    root.animations = [new THREE.AnimationClip('spin', 1, [])];
    const splat = makeSplatStub();
    root.add(splat);
    const calls = withSpies(splat, () => runPodestFit(root));
    expect(calls.setFromObject).toBe(0);
    expect(root.scale.toArray()).toEqual([1, 1, 1]);
    expect(root.position.toArray()).toEqual([0, 0, 0]);
  });

  it('spells the guard the way the editor copy does (one check in the traverse, one return after it)', () => {
    const html = readFileSync(new URL('../../public/podest.html', import.meta.url), 'utf8');
    const line = html.split('\n').find((l) => l.includes('L.push(\'  AFRAME.registerComponent("fit-bounds"'))!;
    expect(line).toContain('root.traverse(function(node){if(node.isGaussianSplat){splatSeen=true;return;}if(!node.isMesh||!node.geometry)return;');
    expect(line).toContain('});if(splatSeen)return;if(skinned||animated){');
    expect(FIT_BOUNDS_SCRIPT).toContain('if (node.isGaussianSplat) { splatSeen = true; return; }');
    expect(FIT_BOUNDS_SCRIPT).toContain('if (splatSeen) return;');
  });
});

/**
 * A bare OBJ — `v` and `f` lines, no `vn` — is what the built-in Stanford
 * bunny is. three's OBJLoader INVENTS a flat per-face normal for every face
 * without a `vn` index, the regen path took those for authored normals, and
 * `splitByAuthored` split every corner apart again: measured in the browser,
 * 208,567 vertices for 34,834 positions, so any displacement tore the bunny
 * into loose triangles and "Merge Vertices" could not reach it (the loader
 * welds primitives only). Both twins now drop the invented normals at the
 * parse. Evaluated with an OBJLoader SUBCLASS, so the patch lands on the
 * subclass's prototype and cannot leak into another suite (`isolate: false`).
 */
describe('a bare OBJ is welded, not split by invented normals', () => {
  const BUNNY = readFileSync(new URL('../../public/models/stanford-bunny.obj', import.meta.url), 'utf8');

  // As in the vendored bundle: the loader obj-model builds hangs off
  // AFRAME.THREE, which is NOT window.THREE (that one has no OBJLoader) — the
  // first cut patched window.THREE's, a no-op the browser caught.
  function editorWithLoader() {
    class ProbeOBJLoader extends OBJLoader {}
    return { comp: evalFit(editorFitBody(), true, { OBJLoader: ProbeOBJLoader }), Loader: ProbeOBJLoader };
  }

  function podestWithLoader() {
    class ProbeOBJLoader extends OBJLoader {}
    // The host string is single-quoted JS: undo its one escape (\\ → \), as
    // the runtime does when it writes the line into the document.
    const script = podestPushes(['function patchObjNormals', 'patchObjNormals();', ...PODEST_FIT_PUSHES], (body) =>
      body.replace(/\\\\/g, '\\'),
    );
    return { comp: evalFit(script, false, { OBJLoader: ProbeOBJLoader }), Loader: ProbeOBJLoader };
  }

  /** Coincident vertices whose normals differ — a crack under displacement. */
  function splitGroups(g: THREE.BufferGeometry): number {
    const pos = g.attributes.position, nor = g.attributes.normal;
    const first = new Map<string, number>();
    let split = 0;
    for (let i = 0; i < pos.count; i++) {
      const k = `${Math.round(pos.getX(i) * 1e4)}_${Math.round(pos.getY(i) * 1e4)}_${Math.round(pos.getZ(i) * 1e4)}`;
      const j = first.get(k);
      if (j === undefined) { first.set(k, i); continue; }
      if (Math.abs(nor.getX(i) - nor.getX(j)) + Math.abs(nor.getY(i) - nor.getY(j)) + Math.abs(nor.getZ(i) - nor.getZ(j)) > 1e-5) split++;
    }
    return split;
  }

  const fitted = (w: { comp: FitComponent; Loader: typeof OBJLoader }, text: string): THREE.BufferGeometry => {
    const root = w.Loader.prototype.parse.call(new w.Loader(), text) as THREE.Group;
    w.comp.fit.call({ el: { getObject3D: () => root }, data: { size: 1.6, regen: true } });
    return (root.children[0] as THREE.Mesh).geometry;
  };

  it('drops only the INVENTED normals at the parse, and patches only the loader it was handed', () => {
    const { Loader } = editorWithLoader();
    const bare = new Loader().parse('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    expect((bare.children[0] as THREE.Mesh).geometry.attributes.normal).toBeUndefined();
    const authored = new Loader().parse('v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nf 1//1 2//1 3//1\n');
    expect((authored.children[0] as THREE.Mesh).geometry.attributes.normal).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(OBJLoader.prototype, '__fsBareObjNormals')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(OBJLoader.prototype, 'parse')).toBe(true);
  });

  it('the bunny comes out one skin in the editor preview and in podest', () => {
    const editor = fitted(editorWithLoader(), BUNNY);
    const podest = fitted(podestWithLoader(), BUNNY);
    expect(splitGroups(editor)).toBe(0);
    expect(splitGroups(podest)).toBe(0);
    expect(podest.attributes.position.count).toBe(editor.attributes.position.count);
    // Welded: near the scan's own vertex count, not one vertex per corner.
    expect(editor.attributes.position.count).toBeLessThan(36000);
  });

  it('an OBJ that carries vn keeps its creases', () => {
    // A flat-shaded quad pair folded at x=0: two authored normals at the fold.
    const text = 'v -1 0 0\nv 0 0 0\nv 0 1 0\nv 1 0 1\nvn 0 0 1\nvn 1 0 0\nf 1//1 2//1 3//1\nf 2//2 4//2 3//2\n';
    const g = fitted(editorWithLoader(), text);
    expect(splitGroups(g)).toBeGreaterThan(0);
  });

  it('the exported bunny IS the bunny the preview shows', () => {
    const editor = fitted(editorWithLoader(), BUNNY);
    const exported = bareObjArrays(BUNNY)!;
    expect(exported.positions.length / 3).toBe(editor.attributes.position.count);
    for (let i = 0; i < editor.attributes.position.count; i += 97) {
      expect(exported.positions[i * 3]).toBeCloseTo(editor.attributes.position.getX(i), 4);
      expect(exported.positions[i * 3 + 1]).toBeCloseTo(editor.attributes.position.getY(i), 4);
      expect(exported.normals[i * 3 + 2]).toBeCloseTo(editor.attributes.normal.getZ(i), 4);
      expect(exported.uvs![i * 2]).toBeCloseTo(editor.attributes.uv.getX(i), 4);
    }
  });
});
