/**
 * The text of the PLAIN-JS module helpers (`kind: 'js'` rows of
 * engine/moduleHelpers.ts — the ONE helper table imports these arrays). They
 * are not TSL `Fn`s: `fsLut` runs ONCE at module load inside the preview, the
 * export, podest and the XR popup, bakes a 257×1 half-float RGBA DataTexture
 * per distinct key (two nodes with identical settings share ONE texture and
 * ONE binding) and hands back the TSL sample node.
 *
 * Constraints every line obeys (pinned by moduleHelpers.test.ts,
 * lutHelpers.test.ts, lutHelperLoaders.test.ts and codeToGraphJsHelper.test.ts):
 *   - exactly ONE top-level `const <name> = …;` per helper — codeToGraph skips
 *     the declarator BY NAME, and `path.skip()` keeps its inner returns,
 *     assignments and calls from ever reading as graph content;
 *   - no identifier-like token (strings INCLUDED — loader 0.8's
 *     `autoInjectTSLImports` scans them) that is a three/tsl export outside the
 *     row's `imports`. `typeof x !== 'string'` would inject a spurious `string`
 *     import (`string` IS an export), which is why `rows` tests `.split`;
 *   - no `import {`, `params.<ident>`, `const X = uniform(`, `Fn(() => {`,
 *     regex literal, `uv(` or geometry global (the splat sweep), no declared
 *     `THREE`, and three is reached only as `globalThis.THREE.*`, which
 *     buildShaderModule rewrites to the imported namespace like the Colormap
 *     setup lines;
 *   - no SHORTHAND object property: loader `fixTSLShadowing` renames value
 *     references with a regex that also hits a shorthand key, so a future
 *     three/tsl export named `half` would silently turn `fsLut.half` into
 *     `undefined`. Always `{ half: half }`;
 *   - only single quotes inside the text: each entry is a double-quoted TS
 *     string, one emitted line per entry.
 *
 * `unit`/`hex`/`word`/`rows` are utils/pointListCodec.ts's grammar,
 * char-for-char; `half` is binaryCodec `toHalfFloat` transcribed; `at` samples
 * through the half-texel inset (u·256/257 + 0.5/257 over 257 texels, Blender's
 * CM_TABLE + 1) with `.level(0)`, which keeps Firefox's WebGPU uniformity
 * analysis happy inside non-uniform control flow (no mips exist, so the
 * picture is identical). The TS twins (utils/lutTable.ts) are held to this text
 * BIT-EXACTLY by lutHelpers.test.ts, which evaluates it.
 */

/** The shared LUT core: emitted only through another helper's `requires`. */
export const FS_LUT_LINES: readonly string[] = [
  "const fsLut = (() => {",
  "  const made = new Map();",
  "  const f32 = new Float32Array(1);",
  "  const i32 = new Int32Array(f32.buffer);",
  "  const half = (v) => {",
  "    f32[0] = v;",
  "    const w = i32[0];",
  "    let bits = (w >> 16) & 0x8000;",
  "    let man = (w >> 12) & 0x07ff;",
  "    const ex = (w >> 23) & 0xff;",
  "    if (ex < 103) return bits;",
  "    if (ex > 142) return bits | 0x7c00 | (ex === 255 && (w & 0x007fffff) !== 0 ? 0x0200 : 0);",
  "    if (ex < 113) {",
  "      man |= 0x0800;",
  "      return bits | ((man >> (114 - ex)) + ((man >> (113 - ex)) & 1));",
  "    }",
  "    bits |= ((ex - 112) << 10) | (man >> 1);",
  "    return bits + (man & 1);",
  "  };",
  "  const unit = (s) => {",
  "    let dots = 0;",
  "    let digits = 0;",
  "    for (let i = 0; i < s.length; i++) {",
  "      const k = s.charCodeAt(i);",
  "      if (k === 46) dots++;",
  "      else if (k >= 48 && k <= 57) digits++;",
  "      else return null;",
  "    }",
  "    if (dots > 1 || digits === 0 || s.length > 12) return null;",
  "    const num = Number(s);",
  "    return num > 1 ? 1 : num;",
  "  };",
  "  const hex = (s) => {",
  "    if (s.length !== 7 || s.charCodeAt(0) !== 35) return null;",
  "    for (let i = 1; i < 7; i++) {",
  "      const k = s.charCodeAt(i);",
  "      if (!((k >= 48 && k <= 57) || (k >= 65 && k <= 70) || (k >= 97 && k <= 102))) return null;",
  "    }",
  "    return [1, 3, 5].map((o) => {",
  "      const cv = parseInt(s.slice(o, o + 2), 16) / 255;",
  "      return cv <= 0.04045 ? cv / 12.92 : Math.pow((cv + 0.055) / 1.055, 2.4);",
  "    });",
  "  };",
  "  const word = (s) => {",
  "    if (s.length < 1 || s.length > 12) return false;",
  "    for (let i = 0; i < s.length; i++) {",
  "      const k = s.charCodeAt(i);",
  "      if (k < 97 || k > 122) return false;",
  "    }",
  "    return true;",
  "  };",
  "  const rows = (str, lo, hi) => {",
  "    if (!str || str.split === undefined || str.length === 0 || str.length > 1024) return null;",
  "    const recs = str.split(',');",
  "    if (recs.length < lo || recs.length > hi) return null;",
  "    return recs.map((rec) => rec.trim().split(' ').filter((tok) => tok !== ''));",
  "  };",
  "  const make = (key, nearest, bake) => {",
  "    let hit = made.get(key);",
  "    if (hit) return hit;",
  "    const baked = bake();",
  "    const data = new Uint16Array(baked.vals.length);",
  "    for (let i = 0; i < baked.vals.length; i++) data[i] = half(baked.vals[i]);",
  "    const tex = new globalThis.THREE.DataTexture(data, baked.vals.length / 4, 1, globalThis.THREE.RGBAFormat, globalThis.THREE.HalfFloatType);",
  "    tex.minFilter = nearest ? globalThis.THREE.NearestFilter : globalThis.THREE.LinearFilter;",
  "    tex.magFilter = tex.minFilter;",
  "    tex.wrapS = globalThis.THREE.ClampToEdgeWrapping;",
  "    tex.wrapT = globalThis.THREE.ClampToEdgeWrapping;",
  "    tex.needsUpdate = true;",
  "    hit = { tex: tex, slopes: baked.slopes };",
  "    made.set(key, hit);",
  "    return hit;",
  "  };",
  "  const at = (tex, u) => texture(tex, vec2(float(u).mul(256 / 257).add(0.5 / 257), 0.5)).level(0);",
  "  return { half: half, unit: unit, hex: hex, word: word, rows: rows, make: make, at: at };",
  "})();",
];

/** Blender's Color Ramp (BKE_colorband_evaluate, colorband.cc — all five interpolations, RGB colour mode) baked
 *  over the stops in LINEAR light. `stops`/`interp` are the canonical strings graphToCode re-formats from
 *  utils/colorRamp.ts; anything unreadable bakes the default black→white ramp. The cache key is the strings
 *  themselves, so equal ramps share one texture. utils/colorRamp.ts `evaluateRamp` is this `ev`, operation for
 *  operation (lutHelpers.test.ts holds the two half tables bit-exact). */
export const FS_COLOR_RAMP_LINES: readonly string[] = [
  "const fsColorRamp = (fac, stops, interp) => {",
  "  const mode = ['constant', 'ease', 'bspline', 'cardinal'].includes(interp) ? interp : 'linear';",
  "  const bake = () => {",
  "    let list = [{ p: 0, c: [0, 0, 0, 1] }, { p: 1, c: [1, 1, 1, 1] }];",
  "    const recs = fsLut.rows(stops, 1, 32);",
  "    const read = recs && recs.map((rec) => {",
  "      if (rec.length !== 3) return null;",
  "      const p = fsLut.unit(rec[0]);",
  "      const rgb = fsLut.hex(rec[1]);",
  "      const al = fsLut.unit(rec[2]);",
  "      return p === null || rgb === null || al === null ? null : { p: p, c: [rgb[0], rgb[1], rgb[2], al] };",
  "    });",
  "    if (read && read.every((s) => s !== null)) list = read.sort((s1, s2) => s1.p - s2.p);",
  "    const cnt = list.length;",
  "    const spline = mode === 'bspline' || mode === 'cardinal';",
  "    const ev = (x) => {",
  "      if (cnt === 1) return list[0].c;",
  "      if (x <= list[0].p && !spline) return list[0].c;",
  "      let at1 = 0;",
  "      while (at1 < cnt && !(list[at1].p > x)) at1++;",
  "      let rt;",
  "      let lf;",
  "      if (at1 === cnt) { lf = list[cnt - 1]; rt = { p: 1, c: lf.c }; }",
  "      else if (at1 === 0) { rt = list[0]; lf = { p: 0, c: rt.c }; }",
  "      else { rt = list[at1]; lf = list[at1 - 1]; }",
  "      if (at1 === cnt && !spline) return lf.c;",
  "      if (mode === 'constant') return lf.c;",
  "      let f = lf.p !== rt.p ? (x - rt.p) / (lf.p - rt.p) : (at1 !== cnt ? 0 : 1);",
  "      if (spline) {",
  "        const r0 = at1 >= cnt - 1 ? rt : list[at1 + 1];",
  "        const l3 = at1 < 2 ? lf : list[at1 - 2];",
  "        f = f < 0 ? 0 : f > 1 ? 1 : f;",
  "        const t2 = f * f;",
  "        const t3 = t2 * f;",
  "        let w0;",
  "        let w1;",
  "        let w2;",
  "        let w3;",
  "        if (mode === 'cardinal') {",
  "          const fc = 0.71;",
  "          w0 = -fc * t3 + 2 * fc * t2 - fc * f;",
  "          w1 = (2 - fc) * t3 + (fc - 3) * t2 + 1;",
  "          w2 = (fc - 2) * t3 + (3 - 2 * fc) * t2 + fc * f;",
  "          w3 = fc * t3 - fc * t2;",
  "        } else {",
  "          w0 = -0.16666666 * t3 + 0.5 * t2 - 0.5 * f + 0.16666666;",
  "          w1 = 0.5 * t3 - t2 + 0.66666666;",
  "          w2 = -0.5 * t3 + 0.5 * t2 + 0.5 * f + 0.16666666;",
  "          w3 = 0.16666666 * t3;",
  "        }",
  "        return [0, 1, 2, 3].map((k) => {",
  "          const o = w3 * l3.c[k] + w2 * lf.c[k] + w1 * rt.c[k] + w0 * r0.c[k];",
  "          return o < 0 ? 0 : o > 1 ? 1 : o;",
  "        });",
  "      }",
  "      if (mode === 'ease') { const f2 = f * f; f = 3 * f2 - 2 * f2 * f; }",
  "      const mf = 1 - f;",
  "      return [0, 1, 2, 3].map((k) => mf * rt.c[k] + f * lf.c[k]);",
  "    };",
  "    const vals = new Float32Array(257 * 4);",
  "    for (let i = 0; i <= 256; i++) vals.set(ev(i / 256), i * 4);",
  "    return { vals: vals, slopes: null };",
  "  };",
  "  return fsLut.at(fsLut.make('ramp ' + mode + ' ' + stops, mode === 'constant', bake).tex, fac);",
  "};",
];
