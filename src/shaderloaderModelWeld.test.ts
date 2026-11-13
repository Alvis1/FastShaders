/**
 * Loader 0.8 header delta 12: a displaced MODEL keeps one skin.
 *
 * Reported 2026-11-09: "Vertex shader — along normal does not work for the
 * imported Blender cube, merge vertices also enabled". A glTF cube from Blender
 * has 24 corners — each face its own four, with its own flat normal — so a
 * displacement along the normal pushes the six faces apart, and the weld that
 * keeps a primitive box closed is primitives-only (it rebuilds with
 * position/uv/index, which would drop a model's skin weights, morph targets
 * and vertex colours). The model weld changes ONLY the normal attribute of a
 * cloned geometry: corners at one point get one normal, so they move together.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { evalLoader, loaderAvailable } from './shaderloaderHarness';

interface Internals {
  syncWeld: (state: Record<string, unknown>, mesh: unknown) => void;
  shouldWeld: (r: unknown, m: unknown, p: unknown, isPrimitive: boolean, idx: unknown) => boolean;
  smoothModelNormals: (g: THREE.BufferGeometry) => THREE.BufferGeometry | null;
  buildMaterial: (spec: Record<string, unknown>, parent?: Record<string, unknown>) => THREE.Material;
}
const internals = (): Internals =>
  (evalLoader('0.8', { THREE }).FastShaders as unknown as { internals: Internals }).internals;

/** A Blender-style cube: BoxGeometry is exactly that — 24 corners, flat normals. */
const blenderCube = () => {
  const g = new THREE.BoxGeometry(2, 2, 2);
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(24 * 3).fill(0.5), 3));
  return g;
};
/** Corner positions after pushing each along its normal by `d`, keyed by original position. */
const displaced = (g: THREE.BufferGeometry, d: number) => {
  const p = g.attributes.position, n = g.attributes.normal;
  const at = new Map<string, Set<string>>();
  for (let i = 0; i < p.count; i++) {
    const k = [p.getX(i), p.getY(i), p.getZ(i)].map((v) => v.toFixed(4)).join(',');
    const moved = [p.getX(i) + d * n.getX(i), p.getY(i) + d * n.getY(i), p.getZ(i) + d * n.getZ(i)].map((v) => v.toFixed(4)).join(',');
    if (!at.has(k)) at.set(k, new Set());
    at.get(k)!.add(moved);
  }
  return [...at.values()].map((s) => s.size);
};

describe.skipIf(!loaderAvailable('0.8'))('shaderloader 0.8 — the model weld (delta 12)', () => {
  it('a cube with flat normals tears under displacement; smoothed, every corner moves as one', () => {
    const cube = blenderCube();
    expect(Math.max(...displaced(cube, 0.3))).toBe(3); // the bug: 3 faces part at each corner
    const s = internals().smoothModelNormals(cube)!;
    expect(s).not.toBeNull();
    expect(Math.max(...displaced(s, 0.3))).toBe(1);
    // A corner's normal is the diagonal.
    expect(s.attributes.normal.getX(0) ** 2 + s.attributes.normal.getY(0) ** 2 + s.attributes.normal.getZ(0) ** 2).toBeCloseTo(1, 6);
  });

  it('changes ONLY the normals: topology, uv, colours and the source geometry are untouched', () => {
    const cube = blenderCube();
    const before = Array.from(cube.attributes.normal.array);
    const s = internals().smoothModelNormals(cube)!;
    expect(s).not.toBe(cube);
    expect(s.attributes.position.count).toBe(24);
    expect(Array.from(s.index!.array)).toEqual(Array.from(cube.index!.array));
    expect(Array.from(s.attributes.uv.array)).toEqual(Array.from(cube.attributes.uv.array));
    expect(s.attributes.color).toBeDefined();
    expect(Array.from(cube.attributes.normal.array)).toEqual(before);
  });

  it('a smooth model has nothing to fix (null — it keeps its own geometry)', () => {
    expect(internals().smoothModelNormals(new THREE.SphereGeometry(1, 16, 8))).toBeNull();
  });

  /** A material that DISPLACES (delta 14: a mesh is smoothed only when the material it wears does). */
  const displacing = (): THREE.Material => {
    const m = new THREE.MeshBasicMaterial();
    (m as unknown as { positionNode: unknown }).positionNode = {};
    return m;
  };

  it('syncWeld on a model ROOT swaps the smoothed copy in, and unweld paths put the model\'s own back', () => {
    const fs = internals();
    const cube = blenderCube();
    const mesh = new THREE.Mesh(cube, displacing());
    const root = new THREE.Group();
    root.add(mesh);
    const state: Record<string, unknown> = { _modelWeldWanted: true, _weldWanted: false };
    fs.syncWeld(state, root);
    expect(mesh.geometry).not.toBe(cube);
    const ours = mesh.geometry;
    fs.syncWeld(state, root); // idempotent: no second copy
    expect(mesh.geometry).toBe(ours);
    state._modelWeldWanted = false;
    fs.syncWeld(state, root);
    expect(mesh.geometry).toBe(cube);
  });

  it('a plain-three MESH target that is not a primitive is smoothed too, and the primitive branch does not undo it', () => {
    const fs = internals();
    const g = blenderCube();
    const asModel = new THREE.BufferGeometry().copy(g); // type BufferGeometry: not a three primitive
    const mesh = new THREE.Mesh(asModel, displacing());
    const state: Record<string, unknown> = { _modelWeldWanted: true, _weldWanted: false };
    fs.syncWeld(state, mesh);
    expect(mesh.geometry).not.toBe(asModel);
    expect(Math.max(...displaced(mesh.geometry, 0.3))).toBe(1);
  });

  it('PER MESH (delta 14): only a mesh whose own material displaces, and does not opt out, is smoothed', () => {
    const fs = internals();
    const moved = new THREE.Mesh(blenderCube(), displacing());
    const still = new THREE.Mesh(blenderCube(), new THREE.MeshBasicMaterial());
    const optedOut = new THREE.Mesh(blenderCube(), fs.buildMaterial({ positionNode: TSL.positionLocal, mergeVertices: false }));
    const own = [moved.geometry, still.geometry, optedOut.geometry];
    const root = new THREE.Group();
    root.add(moved, still, optedOut);
    const state: Record<string, unknown> = { _modelWeldWanted: true, _weldWanted: false };
    fs.syncWeld(state, root);
    expect(moved.geometry).not.toBe(own[0]);
    expect(still.geometry).toBe(own[1]);
    expect(optedOut.geometry).toBe(own[2]);
    // A material change that stops the displacement puts the mesh's own back.
    moved.material = new THREE.MeshBasicMaterial();
    fs.syncWeld(state, root);
    expect(moved.geometry).toBe(own[0]);
  });

  it('a part inherits the top-level mergeVertices unless it says its own', () => {
    const fs = internals();
    const mesh = (spec: Record<string, unknown>, parent?: Record<string, unknown>): THREE.Mesh =>
      new THREE.Mesh(blenderCube(), fs.buildMaterial({ positionNode: TSL.positionLocal, ...spec }, parent));
    const inherits = mesh({}, { mergeVertices: false });
    const closes = mesh({ mergeVertices: true }, { mergeVertices: false });
    const tears = mesh({ mergeVertices: false }, {});
    const root = new THREE.Group();
    const own = [inherits.geometry, closes.geometry, tears.geometry];
    root.add(inherits, closes, tears);
    fs.syncWeld({ _modelWeldWanted: true, _weldWanted: false }, root);
    expect(inherits.geometry).toBe(own[0]);
    expect(closes.geometry).not.toBe(own[1]);
    expect(tears.geometry).toBe(own[2]);
  });

  it('the gate is the primitive weld\'s: a positionNode, and not mergeVertices: false', () => {
    const fs = internals();
    expect(fs.shouldWeld({}, { positionNode: {} }, null, true, null)).toBe(true);
    expect(fs.shouldWeld({ mergeVertices: false }, { positionNode: {} }, null, true, null)).toBe(false);
    expect(fs.shouldWeld({}, { positionNode: null }, null, true, null)).toBe(false);
  });
});
