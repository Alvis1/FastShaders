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
    const wanted = ['function mergeByPosition', 'function sphericalUVs', 'function flipWinding', 'AFRAME.registerComponent("fit-bounds"'];
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
