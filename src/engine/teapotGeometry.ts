/**
 * The Utah Teapot as a RUNTIME tessellation, so the preview's subdivision
 * slider is real for it: N×N quads per Bézier patch, exactly the resolution
 * control the official Utah Teapot page offers (1–128), generated from the
 * authentic 1976 control points in `teapotData.ts` with that page's bijective
 * texture layout. Before this the teapot was a fixed 6320-triangle OBJ with
 * no texture coordinates at all — `uv()` on it was a spherical projection,
 * and the slider hid itself the moment the teapot was selected.
 *
 * Shape of the module, and why:
 *  - `TEAPOT_SCRIPT` is a self-contained JS script string, the `FIT_BOUNDS_SCRIPT`
 *    precedent: the preview iframe evaluates it (it registers the `teapot-mesh`
 *    A-Frame component there), and `loadTeapot()` evaluates the SAME text in
 *    node for the tests and for `scripts/gen-teapot-obj.mjs`. One tessellator,
 *    three consumers, no hand-mirrored twin to drift.
 *  - The mesh is built INSIDE the iframe rather than posted in as OBJ text. The
 *    built-in models ride the `fs:obj-model` feed as text and that was the
 *    obvious route, but at the default resolution the teapot is 118k vertices /
 *    229k triangles — ~15 MB of OBJ text to serialize, post and re-parse on
 *    every slider tick, 60 MB at 128. The control points are 1.3 KB; the
 *    tessellation is ~10 ms. So the slider is a tiny `fs:geometry` message and
 *    the XR popup, which is built from the same HTML, gets the teapot for free.
 *  - Positions come out in the preview's own frame — y up, bounding box centred
 *    at the origin, longest axis exactly 1.6 — the convention the pre-normalized
 *    built-in OBJs follow, so `positionGeometry` ranges stay comparable across
 *    every geometry and `fit-bounds` bakes a near-identity.
 */
import { TEAPOT_PATCHES, TEAPOT_RAW_BBOX } from './teapotData.ts';

/** The resolution range — the official generator's own slider limits. */
export const TEAPOT_RES_MIN = 1;
export const TEAPOT_RES_MAX = 128;

/**
 * The resolution `public/models/teapot.obj` is generated at (podest and the
 * copy-ready surfaces load that static file; the editor tessellates live).
 * 16 gives 14,272 triangles — the count the Utah page reports at 16, since the
 * tessellation is identical — at ~1 MB, a third of the bunny.
 */
export const STATIC_TEAPOT_RESOLUTION = 16;

/**
 * Raw Utah frame (z up, spout toward +x) → preview frame: X = x, Y = z, Z = -y
 * (a rotation, so winding and normals carry over unchanged), then centre the
 * bounding box and scale the longest axis to 1.6. Derived from the res-64
 * bounding box in the data module so it is independent of the live resolution.
 */
const [bx0, by0, bz0, bx1, by1, bz1] = TEAPOT_RAW_BBOX;
export const TEAPOT_FRAME = {
  cx: (bx0 + bx1) / 2,
  cy: (bz0 + bz1) / 2,
  cz: -(by0 + by1) / 2,
  scale: 1.6 / Math.max(bx1 - bx0, bz1 - bz0, by1 - by0),
} as const;

export const TEAPOT_SCRIPT = `<script>
  (function (root) {
    var PATCHES = ${JSON.stringify(TEAPOT_PATCHES)};
    var FRAME = ${JSON.stringify(TEAPOT_FRAME)};
    var RES_MIN = ${TEAPOT_RES_MIN}, RES_MAX = ${TEAPOT_RES_MAX};

    function bern(t, out) {
      var u = 1 - t;
      out[0] = u * u * u; out[1] = 3 * t * u * u; out[2] = 3 * t * t * u; out[3] = t * t * t;
    }
    function dbern(t, out) {
      var u = 1 - t;
      out[0] = -3 * u * u; out[1] = 3 * u * (1 - 3 * t); out[2] = 3 * t * (2 - 3 * t); out[3] = 3 * t * t;
    }
    var Bs = [0, 0, 0, 0], Bt = [0, 0, 0, 0], dBs = [0, 0, 0, 0], dBt = [0, 0, 0, 0];
    // Position and both partials of one patch at (s, t).
    function evalPatch(cp, s, t, p, ds, dt) {
      bern(s, Bs); bern(t, Bt); dbern(s, dBs); dbern(t, dBt);
      p[0] = p[1] = p[2] = ds[0] = ds[1] = ds[2] = dt[0] = dt[1] = dt[2] = 0;
      for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 4; j++) {
          var w = Bs[i] * Bt[j], ws = dBs[i] * Bt[j], wt = Bs[i] * dBt[j], k = (i * 4 + j) * 3;
          for (var c = 0; c < 3; c++) {
            var v = cp[k + c];
            p[c] += w * v; ds[c] += ws * v; dt[c] += wt * v;
          }
        }
      }
    }
    var tp = [0, 0, 0], tds = [0, 0, 0], tdt = [0, 0, 0];
    // cross(dP/ds, dP/dt) — the orientation the official generator's own normals
    // use (it agreed at 1372 of 1372 sampled interior points). A collapsed patch
    // edge (the four lid patches meet at the apex in ONE point) has a zero
    // partial along it, so the normal there is the limit from just inside.
    function normalAt(cp, s, t, n) {
      var e = 1e-3;
      var tries = [[s, t], [s, t - e], [s, t + e], [s - e, t], [s + e, t], [s - e, t - e], [s + e, t + e]];
      for (var k = 0; k < tries.length; k++) {
        var ss = tries[k][0], tt = tries[k][1];
        if (ss < 0 || ss > 1 || tt < 0 || tt > 1) continue;
        evalPatch(cp, ss, tt, tp, tds, tdt);
        var nx = tds[1] * tdt[2] - tds[2] * tdt[1];
        var ny = tds[2] * tdt[0] - tds[0] * tdt[2];
        var nz = tds[0] * tdt[1] - tds[1] * tdt[0];
        var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (L > 1e-9) { n[0] = nx / L; n[1] = ny / L; n[2] = nz / L; return; }
      }
      n[0] = 0; n[1] = 0; n[2] = 1;
    }
    function clampRes(res) {
      var n = Math.round(Number(res));
      if (!(n >= RES_MIN)) n = RES_MIN;
      if (n > RES_MAX) n = RES_MAX;
      return n;
    }

    // The official layout's texture t is NOT the patch parameter: it is a cubic
    // Bézier in t whose control values (0, k1, k2, 1) are the normalized
    // cumulative chord lengths of this column's CONTROL POLYGON — the four
    // points Q_b(s) = Σ_a B_a(s)·cp[a][b] — measured in the ORIGINAL 1975 frame,
    // i.e. with z scaled back by 4/3 before Blinn's 3/4 (the generator derives
    // texture coordinates from the unscaled data and scales positions after).
    // Recovered by fitting: per column the remap is an exact 1D cubic Bézier
    // (residual 6e-8), and this polygon rule reproduces its control values to
    // 7e-7 across all 252 sampled columns; arc length, chord length at any
    // resolution, and a bicubic texture patch were each 0.03–0.13 off. It is
    // resolution-independent, so a coarser teapot's texture coordinates are a
    // subset of a finer one's.
    var Q0 = [0, 0, 0], Q1 = [0, 0, 0], Q2 = [0, 0, 0], Q3 = [0, 0, 0], Bcol = [0, 0, 0, 0];
    function columnRemap(cp, s, out) {
      bern(s, Bcol);
      var Q = [Q0, Q1, Q2, Q3];
      for (var b = 0; b < 4; b++) {
        Q[b][0] = Q[b][1] = Q[b][2] = 0;
        for (var a = 0; a < 4; a++) {
          var w = Bcol[a], k = (a * 4 + b) * 3;
          Q[b][0] += w * cp[k]; Q[b][1] += w * cp[k + 1]; Q[b][2] += w * cp[k + 2];
        }
      }
      var L1 = seg(Q0, Q1), L2 = seg(Q1, Q2), L3 = seg(Q2, Q3), L = L1 + L2 + L3;
      if (L > 1e-12) { out[0] = L1 / L; out[1] = (L1 + L2) / L; } else { out[0] = 1 / 3; out[1] = 2 / 3; }
    }
    function seg(a, b) {
      var dx = b[0] - a[0], dy = b[1] - a[1], dz = (b[2] - a[2]) * (4 / 3);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    // Tessellate every patch on a uniform (N+1)×(N+1) grid. Vertices are per
    // patch — shared patch edges are duplicated, which is what lets each patch
    // keep its own chart of the atlas; they carry identical positions and, where
    // the surface is smooth across the edge, identical normals, so a displaced
    // teapot stays closed there.
    function build(res) {
      var N = clampRes(res);
      var per = (N + 1) * (N + 1), np = PATCHES.length;
      // Grid vertices, plus room for one tip vertex per triangle of a collapsed
      // patch edge (see the face loop) — trimmed to what was used at the end.
      var cap = np * per + np * 2 * N;
      var positions = new Float32Array(cap * 3);
      var normals = new Float32Array(cap * 3);
      var uvs = new Float32Array(cap * 2);
      var indices = new Uint32Array(np * N * N * 6);
      var ic = 0, vc = np * per;
      var p = [0, 0, 0], ds = [0, 0, 0], dt = [0, 0, 0], n = [0, 0, 0], kk = [0, 0];
      for (var pi = 0; pi < np; pi++) {
        var cp = PATCHES[pi].cp, chart = PATCHES[pi].uv, base = pi * per;
        for (var i = 0; i <= N; i++) {
          var s = i / N;
          columnRemap(cp, s, kk);
          for (var j = 0; j <= N; j++) {
            var t = j / N, v = base + i * (N + 1) + j;
            evalPatch(cp, s, t, p, ds, dt);
            // raw (x, y, z) → preview (x, z, -y), centred, scaled
            positions[v * 3] = (p[0] - FRAME.cx) * FRAME.scale;
            positions[v * 3 + 1] = (p[2] - FRAME.cy) * FRAME.scale;
            positions[v * 3 + 2] = (-p[1] - FRAME.cz) * FRAME.scale;
            normalAt(cp, s, t, n);
            normals[v * 3] = n[0]; normals[v * 3 + 1] = n[2]; normals[v * 3 + 2] = -n[1];
            // u is affine in s; v is affine in the remapped t (chart = [su, ou, sv, ov])
            var u1 = 1 - t;
            var tr = 3 * t * u1 * u1 * kk[0] + 3 * t * t * u1 * kk[1] + t * t * t;
            uvs[v * 2] = chart[1] + chart[0] * s;
            uvs[v * 2 + 1] = chart[3] + chart[2] * tr;
          }
        }
        // Two triangles per quad, counter-clockwise against the normal above. A
        // quad on a COLLAPSED patch edge (the four lid patches meet at the apex
        // in one point) is one triangle, not two, which is why the count matches
        // the official generator's exactly — and that triangle gets its own tip
        // vertex whose u sits at the MIDPOINT of the quad's two columns, the
        // generator's "triangulate tips" convention (its res-4 output pins it:
        // the grid corner's u was off by exactly su/2N on every tip).
        for (i = 0; i < N; i++) {
          for (j = 0; j < N; j++) {
            var a = base + i * (N + 1) + j, b = a + (N + 1), c2 = b + 1, d = a + 1;
            var sMid = (i + 0.5) / N;
            if (same(positions, c2, d)) {
              // top edge collapsed: (a, b, tip)
              var tipTop = tip(positions, normals, uvs, vc++, c2, chart[1] + chart[0] * sMid, uvs[c2 * 2 + 1]);
              indices[ic++] = a; indices[ic++] = b; indices[ic++] = tipTop;
            } else if (same(positions, a, b)) {
              // bottom edge collapsed: (tip, c2, d)
              var tipBottom = tip(positions, normals, uvs, vc++, a, chart[1] + chart[0] * sMid, uvs[a * 2 + 1]);
              indices[ic++] = tipBottom; indices[ic++] = c2; indices[ic++] = d;
            } else {
              if (!same(positions, b, c2) && !same(positions, c2, a)) {
                indices[ic++] = a; indices[ic++] = b; indices[ic++] = c2;
              }
              if (!same(positions, a, c2) && !same(positions, d, a)) {
                indices[ic++] = a; indices[ic++] = c2; indices[ic++] = d;
              }
            }
          }
        }
      }
      return {
        positions: positions.subarray(0, vc * 3),
        normals: normals.subarray(0, vc * 3),
        uvs: uvs.subarray(0, vc * 2),
        indices: indices.subarray(0, ic),
        resolution: N,
      };
    }
    // A tip vertex: the collapsed corner's position and normal with its own u.
    function tip(positions, normals, uvs, v, from, u, w) {
      positions[v * 3] = positions[from * 3]; positions[v * 3 + 1] = positions[from * 3 + 1]; positions[v * 3 + 2] = positions[from * 3 + 2];
      normals[v * 3] = normals[from * 3]; normals[v * 3 + 1] = normals[from * 3 + 1]; normals[v * 3 + 2] = normals[from * 3 + 2];
      uvs[v * 2] = u; uvs[v * 2 + 1] = w;
      return v;
    }
    function same(pos, a, b) {
      return Math.abs(pos[a * 3] - pos[b * 3]) < 1e-9
        && Math.abs(pos[a * 3 + 1] - pos[b * 3 + 1]) < 1e-9
        && Math.abs(pos[a * 3 + 2] - pos[b * 3 + 2]) < 1e-9;
    }

    function num(x) {
      var s = String(Number(x.toFixed(6)));
      return s === "-0" ? "0" : s;
    }
    // Wavefront OBJ with v / vt / vn and one index per corner for all three.
    function obj(res) {
      var g = build(res), N = g.resolution;
      var nv = g.positions.length / 3, nf = g.indices.length / 3;
      var L = [];
      L.push("# Utah Teapot — 1976 version (Jim Blinn's 3/4 scaling of Martin Newell's 1975 patches)");
      L.push("# Origin: the historic Utah Teapot developed at the University of Utah.");
      L.push("#   Model data freely available for any use — https://graphics.cs.utah.edu/teapot/");
      L.push("# Texture coordinates: the Bijective Layout of the official Utah Teapot page (Cem Yuksel, 2026).");
      L.push("# Tessellated by FastShaders (scripts/gen-teapot-obj.mjs) at resolution " + N + ": " + N + "x" + N + " quads per patch, " + nf + " triangles.");
      L.push("# Y up; bounding box centred at the origin; longest axis 1.6 (the FastShaders preview convention).");
      L.push("o Utah Teapot");
      L.push("");
      for (var i = 0; i < nv; i++) L.push("v " + num(g.positions[i * 3]) + " " + num(g.positions[i * 3 + 1]) + " " + num(g.positions[i * 3 + 2]));
      L.push("");
      for (i = 0; i < nv; i++) L.push("vt " + num(g.uvs[i * 2]) + " " + num(g.uvs[i * 2 + 1]));
      L.push("");
      for (i = 0; i < nv; i++) L.push("vn " + num(g.normals[i * 3]) + " " + num(g.normals[i * 3 + 1]) + " " + num(g.normals[i * 3 + 2]));
      L.push("");
      for (var f = 0; f < nf; f++) {
        var a = g.indices[f * 3] + 1, b = g.indices[f * 3 + 1] + 1, c = g.indices[f * 3 + 2] + 1;
        L.push("f " + a + "/" + a + "/" + a + " " + b + "/" + b + "/" + b + " " + c + "/" + c + "/" + c);
      }
      return L.join("\\n") + "\\n";
    }

    root.fsTeapot = { build: build, obj: obj, clampRes: clampRes, patches: PATCHES, frame: FRAME, RES_MIN: RES_MIN, RES_MAX: RES_MAX };

    // The preview's teapot entity: \`teapot-mesh="resolution: N"\`. It stands in
    // for a model loader — builds the geometry, hangs it on the entity as
    // "mesh" and emits model-loaded, which is what the shader component and
    // fit-bounds listen for, so a resolution change re-applies everything the
    // way a swapped model would.
    if (root.AFRAME && root.THREE && !root.AFRAME.components["teapot-mesh"]) {
      root.AFRAME.registerComponent("teapot-mesh", {
        schema: { resolution: { type: "int", default: 64 } },
        update: function () {
          var THREE = root.THREE;
          var g = build(this.data.resolution);
          var geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(g.positions, 3));
          geo.setAttribute("normal", new THREE.BufferAttribute(g.normals, 3));
          geo.setAttribute("uv", new THREE.BufferAttribute(g.uvs, 2));
          geo.setIndex(new THREE.BufferAttribute(g.indices, 1));
          this.dispose();
          var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x808080 }));
          this.el.setObject3D("mesh", mesh);
          this.el.emit("model-loaded", { format: "teapot", model: mesh });
        },
        dispose: function () {
          var old = this.el.getObject3D("mesh");
          if (!old) return;
          this.el.removeObject3D("mesh");
          if (old.geometry) old.geometry.dispose();
          if (old.material && old.material.dispose) old.material.dispose();
        },
        remove: function () { this.dispose(); }
      });
    }
  })(typeof window !== "undefined" ? window : globalThis);
<${''}/script>`;

export interface TeapotMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  resolution: number;
}

export interface TeapotApi {
  build(res: number): TeapotMesh;
  obj(res: number): string;
  clampRes(res: number): number;
  patches: typeof TEAPOT_PATCHES;
  frame: typeof TEAPOT_FRAME;
  RES_MIN: number;
  RES_MAX: number;
}

/**
 * Evaluate `TEAPOT_SCRIPT` outside a browser (tests, the OBJ generator). The
 * script binds to `window` when one exists, so it is handed a bare object under
 * that name; with no AFRAME on it the component registration is skipped.
 */
export function loadTeapot(): TeapotApi {
  const body = TEAPOT_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const sandbox: { fsTeapot?: TeapotApi } = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', body)(sandbox);
  if (!sandbox.fsTeapot) throw new Error('TEAPOT_SCRIPT did not install fsTeapot');
  return sandbox.fsTeapot;
}
