/**
 * The BUILT-IN preview shapes as `.obj` files, for the EXPORT popover's
 * "Export model" row: the sphere, cube, plane, the Raymarch window, the Utah
 * teapot and the Stanford bunny, each written as the preview DRAWS it, so the
 * shader looks the same on the exported file in any A-Frame page.
 *
 *  - The primitives are A-Frame's, which are three's `SphereGeometry` /
 *    `BoxGeometry` / `PlaneGeometry` with the parameters `buildGeoAttr` gives
 *    them (tslToPreviewHTML.ts) — ported here, because the parent bundle does
 *    not carry three. Primitives are not normalised in the preview, so neither
 *    are these.
 *  - The teapot is the runtime tessellator's own mesh at the preview's
 *    resolution; the bunny is the served scan processed EXACTLY as the
 *    preview's `fit-bounds` regen path processes a normal-less OBJ (weld by
 *    position, smooth normals, winding repaired, spherical UVs with the seam
 *    split). Both are then baked into the preview's ±0.8 frame — the frame
 *    every position-driven preset is tuned for, since `positionGeometry` reads
 *    the raw attribute.
 *
 * Pure, synchronous and three-free: the export must stay inside the click's
 * task (Safari's transient activation), so nothing here awaits.
 */
import { loadTeapot, TEAPOT_RES_MAX, TEAPOT_RES_MIN, type TeapotApi } from './teapotGeometry';

export type BuiltinShape = 'sphere' | 'cube' | 'plane' | 'marchSphere' | 'teapot' | 'bunny';

/** The file each shape ships as under models/. English, like every file name. */
export const BUILTIN_MODEL_FILE: { readonly [S in BuiltinShape]: string } = {
  sphere: 'sphere.obj',
  cube: 'cube.obj',
  plane: 'plane.obj',
  marchSphere: 'raymarch-window.obj',
  teapot: 'utah-teapot.obj',
  bunny: 'stanford-bunny.obj',
};

export function isBuiltinShape(g: unknown): g is BuiltinShape {
  return typeof g === 'string' && Object.prototype.hasOwnProperty.call(BUILTIN_MODEL_FILE, g);
}

/** Indexed triangles; `uvs` optional. */
export interface MeshArrays {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array | null;
  indices: Uint32Array;
}

/** The preview's `fit-bounds` size: the longest extent of a baked model. */
export const PREVIEW_FRAME_SIZE = 1.6;

// ── three's primitives, ported ────────────────────────────────────────────────

/** THREE.SphereGeometry(radius, w, h) with the default full sweep. */
export function sphereArrays(radius: number, widthSegments: number, heightSegments: number): MeshArrays {
  const ws = Math.max(3, Math.floor(widthSegments));
  const hs = Math.max(2, Math.floor(heightSegments));
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const grid: number[][] = [];
  let index = 0;
  for (let iy = 0; iy <= hs; iy++) {
    const row: number[] = [];
    const v = iy / hs;
    const uOffset = iy === 0 ? 0.5 / ws : iy === hs ? -0.5 / ws : 0;
    for (let ix = 0; ix <= ws; ix++) {
      const u = ix / ws;
      const x = -radius * Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI);
      const y = radius * Math.cos(v * Math.PI);
      const z = radius * Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI);
      positions.push(x, y, z);
      const len = Math.hypot(x, y, z) || 1;
      normals.push(x / len, y / len, z / len);
      uvs.push(u + uOffset, 1 - v);
      row.push(index++);
    }
    grid.push(row);
  }
  for (let iy = 0; iy < hs; iy++) {
    for (let ix = 0; ix < ws; ix++) {
      const a = grid[iy][ix + 1];
      const b = grid[iy][ix];
      const c = grid[iy + 1][ix];
      const d = grid[iy + 1][ix + 1];
      if (iy !== 0) indices.push(a, b, d);
      if (iy !== hs - 1) indices.push(b, c, d);
    }
  }
  return pack(positions, normals, uvs, indices);
}

/** THREE.PlaneGeometry(w, h, sx, sy). */
export function planeArrays(width: number, height: number, sx: number, sy: number): MeshArrays {
  const gx = Math.floor(sx);
  const gy = Math.floor(sy);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let iy = 0; iy <= gy; iy++) {
    const y = (iy * height) / gy - height / 2;
    for (let ix = 0; ix <= gx; ix++) {
      positions.push((ix * width) / gx - width / 2, -y, 0);
      normals.push(0, 0, 1);
      uvs.push(ix / gx, 1 - iy / gy);
    }
  }
  for (let iy = 0; iy < gy; iy++) {
    for (let ix = 0; ix < gx; ix++) {
      const a = ix + (gx + 1) * iy;
      const b = ix + (gx + 1) * (iy + 1);
      const c = ix + 1 + (gx + 1) * (iy + 1);
      const d = ix + 1 + (gx + 1) * iy;
      indices.push(a, b, d, b, c, d);
    }
  }
  return pack(positions, normals, uvs, indices);
}

/** THREE.BoxGeometry(w, h, d, sx, sy, sz): six grids, each face its own vertices. */
export function boxArrays(width: number, height: number, depth: number, sx: number, sy: number, sz: number): MeshArrays {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let base = 0;
  type Axis = 0 | 1 | 2;
  const face = (u: Axis, v: Axis, w: Axis, udir: number, vdir: number, fw: number, fh: number, fd: number, gx: number, gy: number) => {
    gx = Math.floor(gx);
    gy = Math.floor(gy);
    const vec = [0, 0, 0];
    for (let iy = 0; iy <= gy; iy++) {
      const y = (iy * fh) / gy - fh / 2;
      for (let ix = 0; ix <= gx; ix++) {
        const x = (ix * fw) / gx - fw / 2;
        vec[u] = x * udir;
        vec[v] = y * vdir;
        vec[w] = fd / 2;
        positions.push(vec[0], vec[1], vec[2]);
        vec[u] = 0;
        vec[v] = 0;
        vec[w] = fd > 0 ? 1 : -1;
        normals.push(vec[0], vec[1], vec[2]);
        uvs.push(ix / gx, 1 - iy / gy);
      }
    }
    for (let iy = 0; iy < gy; iy++) {
      for (let ix = 0; ix < gx; ix++) {
        const a = base + ix + (gx + 1) * iy;
        const b = base + ix + (gx + 1) * (iy + 1);
        const c = base + ix + 1 + (gx + 1) * (iy + 1);
        const d = base + ix + 1 + (gx + 1) * iy;
        indices.push(a, b, d, b, c, d);
      }
    }
    base += (gx + 1) * (gy + 1);
  };
  face(2, 1, 0, -1, -1, depth, height, width, sz, sy); // px
  face(2, 1, 0, 1, -1, depth, height, -width, sz, sy); // nx
  face(0, 2, 1, 1, 1, width, depth, height, sx, sz); // py
  face(0, 2, 1, 1, -1, width, depth, -height, sx, sz); // ny
  face(0, 1, 2, 1, -1, width, height, depth, sx, sy); // pz
  face(0, 1, 2, -1, -1, width, height, -depth, sx, sy); // nz
  return pack(positions, normals, uvs, indices);
}

function pack(positions: number[], normals: number[], uvs: number[] | null, indices: number[]): MeshArrays {
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: uvs ? new Float32Array(uvs) : null,
    indices: new Uint32Array(indices),
  };
}

// ── the preview's frame and fit-bounds' regen path ────────────────────────────

/**
 * Centre the positions and scale their longest extent to `size`, in place
 * (fit-bounds' bake). `measured` limits the bounds to the vertices a face
 * uses — what OBJLoader hands fit-bounds.
 */
export function bakeToPreviewFrame(positions: Float32Array, size = PREVIEW_FRAME_SIZE, measured?: Uint8Array): void {
  if (positions.length < 3) return;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    if (measured && !measured[i / 3]) continue;
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], positions[i + k]);
      hi[k] = Math.max(hi[k], positions[i + k]);
    }
  }
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const s = size / (Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1);
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) positions[i + k] = (positions[i + k] - c[k]) * s;
  }
}

/** three's computeVertexNormals on an indexed mesh: area-weighted face normals, normalised. */
function vertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const n = new Float32Array(positions.length);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const cbx = positions[c] - positions[b], cby = positions[c + 1] - positions[b + 1], cbz = positions[c + 2] - positions[b + 2];
    const abx = positions[a] - positions[b], aby = positions[a + 1] - positions[b + 1], abz = positions[a + 2] - positions[b + 2];
    const nx = cby * abz - cbz * aby, ny = cbz * abx - cbx * abz, nz = cbx * aby - cby * abx;
    for (const v of [a, b, c]) {
      n[v] += nx;
      n[v + 1] += ny;
      n[v + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= len;
    n[i + 1] /= len;
    n[i + 2] /= len;
  }
  return n;
}

/**
 * A bare `v`/`f` OBJ (the served bunny) the way the preview shows it: faces
 * fanned into triangles, baked into the preview frame, welded at fit-bounds'
 * 1e-4 quantisation, smooth normals, winding flipped when most normals point
 * at the centre (the bunny is wound clockwise), spherical UVs with the seam
 * split. Null for text with no usable triangle. Only ever handed the app's own
 * served file, never a dropped one.
 */
export function bareObjArrays(text: string): MeshArrays | null {
  const raw: number[] = [];
  const tris: number[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) {
      raw.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (parts[0] === 'f' && parts.length >= 4) {
      const count = raw.length / 3;
      const ids = parts.slice(1).map((p) => {
        const i = parseInt(p, 10);
        return i < 0 ? count + i : i - 1;
      });
      for (let k = 1; k + 1 < ids.length; k++) tris.push(ids[0], ids[k], ids[k + 1]);
    }
  }
  const vcount = raw.length / 3;
  if (vcount === 0 || tris.length === 0 || tris.some((i) => !(i >= 0 && i < vcount)) || raw.some((x) => !Number.isFinite(x))) {
    return null;
  }
  const baked = new Float32Array(raw);
  const referenced = new Uint8Array(vcount);
  for (const i of tris) referenced[i] = 1;
  bakeToPreviewFrame(baked, PREVIEW_FRAME_SIZE, referenced);

  // mergeByPosition
  const lookup = new Map<string, number>();
  const remap = new Uint32Array(vcount);
  const welded: number[] = [];
  for (let i = 0; i < vcount; i++) {
    const x = baked[i * 3], y = baked[i * 3 + 1], z = baked[i * 3 + 2];
    const key = `${Math.round(x * 1e4)}_${Math.round(y * 1e4)}_${Math.round(z * 1e4)}`;
    let id = lookup.get(key);
    if (id === undefined) {
      id = welded.length / 3;
      lookup.set(key, id);
      welded.push(x, y, z);
    }
    remap[i] = id;
  }
  // Keep only the vertices a face uses: the zippered scan carries 1,113 that
  // none does, which would ship as zero-normal strays.
  const slot = new Int32Array(welded.length / 3).fill(-1);
  const kept: number[] = [];
  const indices = new Uint32Array(tris.length);
  for (let t = 0; t < tris.length; t++) {
    const w = remap[tris[t]];
    if (slot[w] < 0) {
      slot[w] = kept.length / 3;
      kept.push(welded[w * 3], welded[w * 3 + 1], welded[w * 3 + 2]);
    }
    indices[t] = slot[w];
  }
  const positions = new Float32Array(kept);
  let normals = vertexNormals(positions, indices);

  // The winding check: the welded box's centre, 200 sampled vertices.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], positions[i + k]);
      hi[k] = Math.max(hi[k], positions[i + k]);
    }
  }
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const count = positions.length / 3;
  const step = Math.max(1, Math.floor(count / 200));
  let inward = 0, sampled = 0;
  for (let v = 0; v < count; v += step) {
    const dot = (positions[v * 3] - c[0]) * normals[v * 3] + (positions[v * 3 + 1] - c[1]) * normals[v * 3 + 1] + (positions[v * 3 + 2] - c[2]) * normals[v * 3 + 2];
    if (dot < 0) inward++;
    sampled++;
  }
  if (sampled > 0 && inward * 2 > sampled) {
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const b = indices[t + 1];
      indices[t + 1] = indices[t + 2];
      indices[t + 2] = b;
    }
    normals = vertexNormals(positions, indices);
  }
  return splitUvSeam({ positions, normals, uvs: sphericalUvs(positions, c), indices });
}

/** fit-bounds' `sphericalUVs`: each vertex's direction from `c`. */
function sphericalUvs(positions: Float32Array, c: number[]): Float32Array {
  const uvs = new Float32Array((positions.length / 3) * 2);
  for (let i = 0; i < positions.length / 3; i++) {
    let x = positions[i * 3] - c[0], y = positions[i * 3 + 1] - c[1], z = positions[i * 3 + 2] - c[2];
    const len = Math.hypot(x, y, z);
    if (len > 0) {
      x /= len;
      y /= len;
      z /= len;
    }
    uvs[i * 2] = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
    uvs[i * 2 + 1] = Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI + 0.5;
  }
  return uvs;
}

/** fit-bounds' `splitUVSeam` (indexed): a straddling triangle's low-u corners get copies at u + 1. */
function splitUvSeam(m: MeshArrays): MeshArrays {
  const uv = m.uvs!;
  const count = uv.length / 2;
  const dupOf: number[] = [];
  const dupFor = new Map<number, number>();
  const idx = m.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const us = [uv[idx[t] * 2], uv[idx[t + 1] * 2], uv[idx[t + 2] * 2]];
    const top = Math.max(us[0], us[1], us[2]);
    if (top - Math.min(us[0], us[1], us[2]) <= 0.5) continue;
    for (let k = 0; k < 3; k++) {
      if (us[k] >= top - 0.5) continue;
      const src = idx[t + k];
      let dup = dupFor.get(src);
      if (dup === undefined) {
        dup = count + dupOf.length;
        dupOf.push(src);
        dupFor.set(src, dup);
      }
      idx[t + k] = dup;
    }
  }
  if (dupOf.length === 0) return m;
  const grow = (a: Float32Array, size: number) => {
    const out = new Float32Array((count + dupOf.length) * size);
    out.set(a);
    dupOf.forEach((src, d) => {
      for (let k = 0; k < size; k++) out[(count + d) * size + k] = a[src * size + k];
    });
    return out;
  };
  const uvs = grow(uv, 2);
  for (let d = 0; d < dupOf.length; d++) uvs[(count + d) * 2] += 1;
  return { positions: grow(m.positions, 3), normals: grow(m.normals, 3), uvs, indices: idx };
}

// ── writing ───────────────────────────────────────────────────────────────────

const num = (x: number): string => {
  const s = x.toFixed(6);
  return s === '-0.000000' ? '0.000000' : s;
};

/** An OBJ with `v`, `vt` (when present), `vn` and `f a/a/a` (or `a//a`) triangles. */
export function writeObj(m: MeshArrays, header: string): string {
  const out: string[] = [`# ${header}`, '# Exported by FastShaders.'];
  for (let i = 0; i < m.positions.length; i += 3) out.push(`v ${num(m.positions[i])} ${num(m.positions[i + 1])} ${num(m.positions[i + 2])}`);
  if (m.uvs) for (let i = 0; i < m.uvs.length; i += 2) out.push(`vt ${num(m.uvs[i])} ${num(m.uvs[i + 1])}`);
  for (let i = 0; i < m.normals.length; i += 3) out.push(`vn ${num(m.normals[i])} ${num(m.normals[i + 1])} ${num(m.normals[i + 2])}`);
  const corner = m.uvs ? (i: number) => `${i}/${i}/${i}` : (i: number) => `${i}//${i}`;
  for (let t = 0; t + 2 < m.indices.length; t += 3) {
    out.push(`f ${corner(m.indices[t] + 1)} ${corner(m.indices[t + 1] + 1)} ${corner(m.indices[t + 2] + 1)}`);
  }
  out.push('');
  return out.join('\n');
}

let teapotApi: TeapotApi | null = null;

/** What the preview shows, as `ShaderPreview` reports it to the store. */
export interface BuiltinShapeParams {
  subdivision: number;
  /** The Raymarch window radius (marchSphere only). */
  marchWindow: number;
  /** The served bunny's text, once the preview has fetched it; null before. */
  bunnyText: string | null;
}

/**
 * `shape` as an `.obj`, or null when it cannot be written right now (the bunny
 * before the preview fetched it, or a file with no usable triangle). The
 * segment clamp is `buildGeoAttr`'s, the teapot's is `buildTeapotAttr`'s.
 */
export function builtinModelObj(shape: BuiltinShape, p: BuiltinShapeParams): string | null {
  const seg = Math.max(1, Math.min(TEAPOT_RES_MAX, Math.round(p.subdivision) || 1));
  switch (shape) {
    case 'sphere':
      return writeObj(sphereArrays(1, seg, seg), `Sphere, radius 1, ${seg}×${seg} segments`);
    case 'marchSphere': {
      const r = Number.isFinite(p.marchWindow) && p.marchWindow > 0 ? Math.min(500, p.marchWindow) : 1;
      return writeObj(sphereArrays(r, 48, 32), `Raymarch window sphere, radius ${r}`);
    }
    case 'cube':
      return writeObj(boxArrays(1.4, 1.4, 1.4, seg, seg, seg), `Cube, 1.4 units, ${seg} segments per side`);
    case 'plane':
      return writeObj(planeArrays(2, 2, seg, seg), `Plane, 2×2 units, ${seg}×${seg} segments`);
    case 'teapot': {
      // The tessellator already emits the preview frame (Y up, centred,
      // longest axis 1.6) and its own provenance header — the file
      // public/models/teapot.obj is, at STATIC_TEAPOT_RESOLUTION.
      teapotApi ??= loadTeapot();
      const res = Math.max(TEAPOT_RES_MIN, Math.min(TEAPOT_RES_MAX, Math.round(p.subdivision) || TEAPOT_RES_MIN));
      return teapotApi.obj(res);
    }
    case 'bunny': {
      const m = p.bunnyText ? bareObjArrays(p.bunnyText) : null;
      return m
        ? writeObj(m, `Stanford bunny (Stanford 3D Scanning Repository), in the FastShaders preview frame (longest side ${PREVIEW_FRAME_SIZE})`)
        : null;
    }
  }
}
