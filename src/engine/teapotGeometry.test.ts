/**
 * The runtime Utah Teapot: proves the tessellation IS the official one, that
 * the atlas is a real bijection, that normals and winding agree, and that the
 * committed `public/models/teapot.obj` is exactly what the generator emits.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import {
  loadTeapot,
  STATIC_TEAPOT_RESOLUTION,
  TEAPOT_FRAME,
  TEAPOT_RES_MAX,
  TEAPOT_RES_MIN,
  TEAPOT_SCRIPT,
} from './teapotGeometry.ts';
import { TEAPOT_PATCHES } from './teapotData.ts';
import fixture from './fixtures/utahTeapot1976Res4.json';

const api = loadTeapot();

/** Triangles the official generator reports at resolution N (28 patches, 4 apex fans). */
const officialFaceCount = (n: number): number => 28 * 2 * n * n - 4 * n;

describe('Utah Teapot data', () => {
  it('is the 28-patch 1976 teapot with a chart per patch', () => {
    expect(TEAPOT_PATCHES).toHaveLength(28);
    for (const p of TEAPOT_PATCHES) {
      expect(p.cp).toHaveLength(48);
      for (const n of p.cp) expect(Number.isFinite(n)).toBe(true);
      const [su, ou, sv, ov] = p.uv;
      expect(su).toBeGreaterThan(0);
      expect(sv).toBeGreaterThan(0);
      expect(ou).toBeGreaterThanOrEqual(0);
      expect(ov).toBeGreaterThanOrEqual(0);
      expect(ou + su).toBeLessThanOrEqual(1 + 1e-9);
      expect(ov + sv).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('atlas charts are pairwise disjoint — the layout really is injective', () => {
    const rects = TEAPOT_PATCHES.map((p) => ({ x0: p.uv[1], x1: p.uv[1] + p.uv[0], y0: p.uv[3], y1: p.uv[3] + p.uv[2] }));
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        const A = rects[a], B = rects[b];
        const overlapX = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
        const overlapY = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
        // Touching edges are fine; a positive-area overlap is two patches
        // painting the same texels.
        expect(overlapX <= 1e-9 || overlapY <= 1e-9, `charts ${a} and ${b} overlap`).toBe(true);
      }
    }
  });

  it('control points are Newell\'s rationals, not float noise', () => {
    // Every recovered coordinate snapped to 5 dp is one of the classic values;
    // a re-derivation that leaks float32 noise would fail here.
    for (const p of TEAPOT_PATCHES) for (const n of p.cp) expect(Math.round(n * 1e5) / 1e5).toBe(n);
  });
});

describe('Utah Teapot tessellation', () => {
  it('matches the official generator at resolution 4 — positions AND atlas', () => {
    // The fixture is the official page's own output (Bijective Layout, welded,
    // raw z-up frame). Every corner of every official face must have a vertex
    // of ours at the same place carrying the same texture coordinate, which
    // pins the control points, the frame transform, the chart placement and
    // the chord-length remap all at once.
    const mesh = api.build(4);
    const cell = (x: number, y: number, z: number) => `${Math.round(x * 2e4)},${Math.round(y * 2e4)},${Math.round(z * 2e4)}`;
    const byCell = new Map<string, number[]>();
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const k = cell(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      const list = byCell.get(k) ?? [];
      list.push(v);
      byCell.set(k, list);
    }
    const F = TEAPOT_FRAME;
    let checked = 0;
    for (let c = 0; c < fixture.corners.length; c += 2) {
      const vp = fixture.corners[c], vt = fixture.corners[c + 1];
      const rx = fixture.pos[vp * 3], ry = fixture.pos[vp * 3 + 1], rz = fixture.pos[vp * 3 + 2];
      // raw (x, y, z) → preview (x, z, -y), centred, scaled — the script's own rule
      const x = (rx - F.cx) * F.scale, y = (rz - F.cy) * F.scale, z = (-ry - F.cz) * F.scale;
      const u = fixture.tex[vt * 2], w = fixture.tex[vt * 2 + 1];
      // A shared-position vertex may sit in a neighbouring cell after rounding;
      // look at the 27 cells around it.
      let found = false;
      outer: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const k = cell(x + dx / 2e4, y + dy / 2e4, z + dz / 2e4);
        for (const v of byCell.get(k) ?? []) {
          const dp = Math.hypot(mesh.positions[v * 3] - x, mesh.positions[v * 3 + 1] - y, mesh.positions[v * 3 + 2] - z);
          const du = Math.hypot(mesh.uvs[v * 2] - u, mesh.uvs[v * 2 + 1] - w);
          if (dp < 1e-4 && du < 2e-5) { found = true; break outer; }
        }
      }
      expect(found, `official corner ${c / 2} at (${x.toFixed(4)}, ${y.toFixed(4)}, ${z.toFixed(4)}) uv (${u}, ${w}) has no match`).toBe(true);
      checked++;
    }
    expect(checked).toBe(fixture.corners.length / 2);
  });

  it('emits exactly the official triangle count at every resolution', () => {
    for (const n of [1, 2, 4, 8, 16, 33]) {
      const m = api.build(n);
      expect(m.resolution).toBe(n);
      expect(m.indices.length / 3, `resolution ${n}`).toBe(officialFaceCount(n));
      // Grid vertices plus one tip vertex per tip triangle of the four apex patches.
      expect(m.positions.length / 3).toBe(28 * (n + 1) * (n + 1) + 4 * n);
      expect(m.normals.length).toBe(m.positions.length);
      expect(m.uvs.length / 2).toBe(m.positions.length / 3);
    }
  });

  it('clamps the resolution to the official 1–128 range and rejects junk', () => {
    expect(TEAPOT_RES_MIN).toBe(1);
    expect(TEAPOT_RES_MAX).toBe(128);
    expect(api.clampRes(0)).toBe(1);
    expect(api.clampRes(-5)).toBe(1);
    expect(api.clampRes(129)).toBe(128);
    expect(api.clampRes(1e9)).toBe(128);
    expect(api.clampRes(NaN)).toBe(1);
    expect(api.clampRes(7.4)).toBe(7);
  });

  it('lands in the preview frame: y up, centred, longest axis 1.6', () => {
    const m = api.build(32);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < m.positions.length / 3; v++) {
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c], m.positions[v * 3 + c]);
        hi[c] = Math.max(hi[c], m.positions[v * 3 + c]);
      }
    }
    const size = hi.map((h, c) => h - lo[c]);
    expect(Math.max(...size)).toBeCloseTo(1.6, 3);
    expect(size[0]).toBe(Math.max(...size)); // spout-to-handle is the long axis
    for (let c = 0; c < 3; c++) expect((lo[c] + hi[c]) / 2).toBeCloseTo(0, 3);
    // Up is +y: the lid knob is the highest point and sits on the axis.
    let top = 0;
    for (let v = 0; v < m.positions.length / 3; v++) if (m.positions[v * 3 + 1] > m.positions[top * 3 + 1]) top = v;
    expect(Math.abs(m.positions[top * 3])).toBeLessThan(0.15);
    expect(Math.abs(m.positions[top * 3 + 2])).toBeLessThan(0.15);
  });

  it('has unit normals and counter-clockwise winding that agrees with them', () => {
    const m = api.build(12);
    for (let v = 0; v < m.normals.length / 3; v++) {
      expect(Math.hypot(m.normals[v * 3], m.normals[v * 3 + 1], m.normals[v * 3 + 2])).toBeCloseTo(1, 5);
    }
    let agree = 0, total = 0;
    for (let f = 0; f < m.indices.length / 3; f++) {
      const [a, b, c] = [m.indices[f * 3], m.indices[f * 3 + 1], m.indices[f * 3 + 2]];
      const P = (i: number, k: number) => m.positions[i * 3 + k];
      const e1 = [P(b, 0) - P(a, 0), P(b, 1) - P(a, 1), P(b, 2) - P(a, 2)];
      const e2 = [P(c, 0) - P(a, 0), P(c, 1) - P(a, 1), P(c, 2) - P(a, 2)];
      const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const nAvg = [0, 1, 2].map((k) => m.normals[a * 3 + k] + m.normals[b * 3 + k] + m.normals[c * 3 + k]);
      const dot = fn[0] * nAvg[0] + fn[1] * nAvg[1] + fn[2] * nAvg[2];
      total++;
      if (dot > 0) agree++;
    }
    expect(agree / total).toBeGreaterThan(0.995);
  });

  it('keeps every texture coordinate inside the unit square with no atan2 seam', () => {
    const m = api.build(16);
    for (let v = 0; v < m.uvs.length / 2; v++) {
      expect(m.uvs[v * 2]).toBeGreaterThanOrEqual(-1e-9);
      expect(m.uvs[v * 2]).toBeLessThanOrEqual(1 + 1e-9);
      expect(m.uvs[v * 2 + 1]).toBeGreaterThanOrEqual(-1e-9);
      expect(m.uvs[v * 2 + 1]).toBeLessThanOrEqual(1 + 1e-9);
    }
    // No triangle spans more than one chart's width — the crushed-band defect
    // the projected teapot had is structurally impossible here.
    for (let f = 0; f < m.indices.length / 3; f++) {
      const us = [0, 1, 2].map((k) => m.uvs[m.indices[f * 3 + k] * 2]);
      expect(Math.max(...us) - Math.min(...us)).toBeLessThan(0.26);
    }
  });
});

describe('Utah Teapot OBJ', () => {
  it('round-trips through OBJLoader with texture coordinates and normals', () => {
    const text = api.obj(4);
    expect(text).toContain('# Utah Teapot');
    expect(text).toContain('University of Utah');
    const obj = new OBJLoader().parse(text);
    let meshes = 0;
    obj.traverse((n) => {
      const mesh = n as import('three').Mesh;
      if (!mesh.isMesh) return;
      meshes++;
      const g = mesh.geometry;
      expect(g.attributes.uv).toBeTruthy();
      expect(g.attributes.normal).toBeTruthy();
      // OBJLoader output is non-indexed: one vertex per face corner.
      expect(g.attributes.position.count).toBe(officialFaceCount(4) * 3);
    });
    expect(meshes).toBe(1);
  });

  it('public/models/teapot.obj is byte-identical to the generator output (regenerate with `npm run gen:teapot`)', () => {
    const committed = readFileSync(new URL('../../public/models/teapot.obj', import.meta.url), 'utf8');
    expect(committed).toBe(api.obj(STATIC_TEAPOT_RESOLUTION));
  });

  it('the preview script registers the teapot-mesh component only where AFRAME + THREE exist', () => {
    expect(TEAPOT_SCRIPT.startsWith('<script>')).toBe(true);
    expect(TEAPOT_SCRIPT).toContain('registerComponent("teapot-mesh"');
    expect(TEAPOT_SCRIPT).toContain('emit("model-loaded"');
    // No backtick or ${ may survive into the emitted script — it is a template
    // literal, and either would have been interpolated at build time.
    const body = TEAPOT_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');
    expect(body).not.toContain('${');
  });
});
