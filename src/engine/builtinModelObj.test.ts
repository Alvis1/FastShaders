import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import {
  BUILTIN_MODEL_FILE,
  PREVIEW_FRAME_SIZE,
  bareObjArrays,
  boxArrays,
  builtinModelObj,
  planeArrays,
  sphereArrays,
  writeObj,
  type MeshArrays,
} from './builtinModelObj';
import { STATIC_TEAPOT_RESOLUTION } from './teapotGeometry';

/**
 * The built-in preview shapes as exported `.obj` files (the EXPORT popover's
 * "Export model" row). The primitives are PORTS of three's generators — the
 * parent bundle carries no three — so they are held to three's own output
 * vertex for vertex; the teapot to the served file; the bunny to what the
 * preview's fit-bounds does with the served scan.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function expectSameAs(m: MeshArrays, g: THREE.BufferGeometry): void {
  expect(Array.from(m.indices)).toEqual(Array.from(g.index!.array));
  const close = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-6);
  };
  close(m.positions, g.attributes.position.array);
  close(m.normals, g.attributes.normal.array);
  close(m.uvs!, g.attributes.uv.array);
}

describe('the primitives are three’s own geometry', () => {
  it('sphere (the preview’s radius 1, and the Raymarch window’s 48×32)', () => {
    expectSameAs(sphereArrays(1, 8, 8), new THREE.SphereGeometry(1, 8, 8));
    expectSameAs(sphereArrays(1.3, 48, 32), new THREE.SphereGeometry(1.3, 48, 32));
    // three's own floors: at least 3×2 segments.
    expectSameAs(sphereArrays(1, 1, 1), new THREE.SphereGeometry(1, 1, 1));
  });

  it('box (the preview’s 1.4 cube) and plane (2×2)', () => {
    expectSameAs(boxArrays(1.4, 1.4, 1.4, 3, 3, 3), new THREE.BoxGeometry(1.4, 1.4, 1.4, 3, 3, 3));
    expectSameAs(boxArrays(1, 2, 3, 1, 2, 4), new THREE.BoxGeometry(1, 2, 3, 1, 2, 4));
    expectSameAs(planeArrays(2, 2, 5, 5), new THREE.PlaneGeometry(2, 2, 5, 5));
  });
});

describe('writeObj', () => {
  it('reads back through three’s OBJLoader with its normals and texture coordinates', () => {
    const m = sphereArrays(1, 6, 4);
    const group = new OBJLoader().parse(writeObj(m, 'test'));
    const g = (group.children[0] as THREE.Mesh).geometry;
    // OBJLoader de-indexes: one vertex per triangle corner.
    expect(g.attributes.position.count).toBe(m.indices.length);
    expect(g.attributes.normal).toBeTruthy();
    expect(g.attributes.uv).toBeTruthy();
  });
});

describe('builtinModelObj', () => {
  const p = { subdivision: 8, marchWindow: 1.5, bunnyText: null };

  it('writes each shape at the preview’s own parameters', () => {
    expect(builtinModelObj('sphere', p)).toContain('# Sphere, radius 1, 8×8 segments');
    expect(builtinModelObj('cube', p)).toContain('# Cube, 1.4 units, 8 segments per side');
    expect(builtinModelObj('plane', p)).toContain('# Plane, 2×2 units, 8×8 segments');
    // The window ignores the slider, like buildGeoAttr's marchSphere.
    expect(builtinModelObj('marchSphere', p)).toContain('radius 1.5');
    expect((builtinModelObj('marchSphere', p)!.match(/^v /gm) ?? []).length).toBe(49 * 33);
    expect(Object.values(BUILTIN_MODEL_FILE).every((f) => /^[a-z-]+\.obj$/.test(f))).toBe(true);
  });

  it('the teapot IS the served file at the static resolution', () => {
    expect(builtinModelObj('teapot', { ...p, subdivision: STATIC_TEAPOT_RESOLUTION })).toBe(read('../../public/models/teapot.obj'));
  });

  it('the bunny waits for the preview’s fetch rather than throwing', () => {
    expect(builtinModelObj('bunny', p)).toBeNull();
  });
});

describe('bareObjArrays (the served bunny, as the preview shows it)', () => {
  const bunny = bareObjArrays(read('../../public/models/stanford-bunny.obj'))!;

  it('is welded: no two vertices share a position except the UV seam’s copies', () => {
    const count = bunny.positions.length / 3;
    const seen = new Map<string, number>();
    let shared = 0;
    for (let i = 0; i < count; i++) {
      const k = `${Math.round(bunny.positions[i * 3] * 1e4)}_${Math.round(bunny.positions[i * 3 + 1] * 1e4)}_${Math.round(bunny.positions[i * 3 + 2] * 1e4)}`;
      const j = seen.get(k);
      if (j === undefined) { seen.set(k, i); continue; }
      shared++;
      // A seam copy: same normal, u one period higher.
      for (let c = 0; c < 3; c++) expect(bunny.normals[i * 3 + c]).toBeCloseTo(bunny.normals[j * 3 + c], 6);
      expect(Math.abs(Math.abs(bunny.uvs![i * 2] - bunny.uvs![j * 2]) - 1)).toBeLessThan(1e-6);
    }
    expect(shared).toBeLessThan(count * 0.05);
  });

  it('sits in the preview frame, facing outward (the scan is wound clockwise)', () => {
    const box = new THREE.Box3().setFromArray(bunny.positions);
    const size = box.getSize(new THREE.Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(PREVIEW_FRAME_SIZE, 5);
    const c = box.getCenter(new THREE.Vector3());
    expect(c.length()).toBeLessThan(1e-5);
    let outward = 0;
    const n = bunny.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const dot = bunny.positions[i * 3] * bunny.normals[i * 3] + bunny.positions[i * 3 + 1] * bunny.normals[i * 3 + 1] + bunny.positions[i * 3 + 2] * bunny.normals[i * 3 + 2];
      if (dot > 0) outward++;
    }
    expect(outward / n).toBeGreaterThan(0.8);
    // …and three agrees about the WINDING: its own normals face the same way
    // (the same hemisphere — a seam copy recomputed from half its faces
    // differs in direction, which is exactly why the export keeps the welded one).
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(bunny.positions, 3));
    g.setIndex(new THREE.BufferAttribute(bunny.indices, 1));
    g.computeVertexNormals();
    let agree = 0;
    for (let i = 0; i < n; i++) {
      const d = g.attributes.normal.getX(i) * bunny.normals[i * 3] + g.attributes.normal.getY(i) * bunny.normals[i * 3 + 1] + g.attributes.normal.getZ(i) * bunny.normals[i * 3 + 2];
      if (d > 0) agree++;
    }
    expect(agree / n).toBeGreaterThan(0.999);
  });

  it('refuses text with no usable triangle', () => {
    expect(bareObjArrays('')).toBeNull();
    expect(bareObjArrays('v 0 0 0\nv 1 0 0\n')).toBeNull();
    expect(bareObjArrays('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n')).toBeNull();
  });
});
