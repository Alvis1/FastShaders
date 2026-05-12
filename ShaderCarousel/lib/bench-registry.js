/* bench-registry — canonical shader corpus for all three benches.
 *
 * Three groups in display order:
 *   • presets — 8 procedural texture reconstructions (polkaDots, grid,
 *     tigerFur, staticNoise, crumpledFabric, gasGiant, marble, wood).
 *     Ported verbatim from the editor's src/registry/builtinTextures.ts
 *     so the corpus tracks what FastShaders actually ships.
 *   • noises — the 8 MaterialX noise atomics the editor exposes as Noise
 *     nodes (perlin/perlinVec3/fbm/fbmVec3/cellNoise/voronoi/voronoiVec2/
 *     voronoiVec3). These are the "atomic" shaders MicroPlane defaults to.
 *   • savedGroups — names read from localStorage['fs:savedGroups'], the
 *     same key the editor's saveGroupToLibrary writes. The current editor
 *     stores graph snapshots, not TSL strings, so without a compile step
 *     these can only be listed — see note at end of this file. The bench
 *     surfaces them with a disabled checkbox and a hint pointing at the
 *     editor; once the editor learns to persist `tslCode` on SavedGroup
 *     this loader picks it up automatically via the `tslCode` field check.
 *
 * The first registry entry is always the baseline (flat color) — both for
 * cycling-start visual consistency and so annotateMarginalCost() can find
 * it via id === 'ref_baseline'. */

/**
 * Build the corpus against a given TSL namespace.
 *   • bench.js (WebGPU)     passes `import * as TSL from 'three/tsl'`
 *   • bench-aframe variants pass `THREE.TSL`
 *
 * Returns a flat list of `{ id, label, category, group, build }` entries.
 * `group` is one of 'baseline' | 'noise' | 'preset' | 'saved'.
 */
export function buildBenchRegistry(TSL) {
  const {
    abs, add, clamp, color, cos, div, exp, fract, max, min, mix, mul,
    oneMinus, positionGeometry, pow, round, screenUV, sin, smoothstep, sqrt,
    sub, time, uniform, vec3,
    mx_noise_float, mx_noise_vec3,
    mx_fractal_noise_float, mx_fractal_noise_vec3,
    mx_cell_noise_float,
    mx_worley_noise_float, mx_worley_noise_vec2, mx_worley_noise_vec3,
  } = TSL;

  /** Wrap a build fn so a compile failure shows magenta instead of crashing
   *  the whole run — mirrors the editor's unknown-node fallback. */
  const safeWrap = (label, fn) => () => {
    try { return fn(); }
    catch (e) { console.warn(`[bench-registry] ${label}:`, e); return color(0xff00ff); }
  };

  // ── Baseline ────────────────────────────────────────────────────────────
  const baseline = {
    id: 'ref_baseline', label: 'Flat Color (baseline)',
    category: 'baseline', group: 'baseline',
    build: () => color(0x888888),
  };

  // ── Noise atomics ────────────────────────────────────────────────────────
  // Called the way graphToCode emits them: bare positionGeometry, no scale.
  // Float-output noises are wrapped in vec3() so they land in the color slot;
  // vec2 is padded to vec3 with a zero in z.
  const noiseDefs = [
    ['perlin',      'Perlin',         () => vec3(mx_noise_float(positionGeometry))],
    ['perlinVec3',  'Perlin (vec3)',  () => mx_noise_vec3(positionGeometry)],
    ['fbm',         'fBm',            () => vec3(mx_fractal_noise_float(positionGeometry))],
    ['fbmVec3',     'fBm (vec3)',     () => mx_fractal_noise_vec3(positionGeometry)],
    ['cellNoise',   'Cell Noise',     () => vec3(mx_cell_noise_float(positionGeometry))],
    ['voronoi',     'Voronoi F1',     () => vec3(mx_worley_noise_float(positionGeometry))],
    ['voronoiVec2', 'Voronoi F1/F2',  () => vec3(mx_worley_noise_vec2(positionGeometry), 0)],
    ['voronoiVec3', 'Voronoi F1/F2/F3', () => mx_worley_noise_vec3(positionGeometry)],
  ];
  const noises = noiseDefs.map(([id, label, fn]) => ({
    id: `noise_${id}`, label, category: 'noise', group: 'noise',
    build: safeWrap(label, fn),
  }));

  // ── Preset reconstructions ──────────────────────────────────────────────
  // Direct ports from src/registry/builtinTextures.ts. Kept inline rather
  // than imported so this file works in the launcher iframe without a build
  // step. If the editor's builtinTextures change shape, update here too.

  const polkaDots = () => {
    const scale = uniform(3), size = uniform(0.5), blur = uniform(0.25);
    const pos = positionGeometry;
    const sPos = mul(pos, scale);
    const fx = sub(fract(sPos.x), 0.5);
    const fy = sub(fract(sPos.y), 0.5);
    const fz = sub(fract(sPos.z), 0.5);
    const dist = sqrt(add(add(mul(fx, fx), mul(fy, fy)), mul(fz, fz)));
    const xsize = exp(sub(mul(size, 5), 5));
    const blur2 = mul(blur, blur);
    const xblur = mul(blur2, blur2);
    const k = smoothstep(sub(xsize, xblur), add(xsize, xblur), dist);
    return mix(color(0x262680), color(0xFFF7EB), k);
  };

  const grid = () => {
    const scale = uniform(1), count = uniform(8), thickness = uniform(0.05);
    const sPos = mul(positionGeometry, scale);
    const gx = mul(sPos.x, count), gy = mul(sPos.y, count), gz = mul(sPos.z, count);
    const d = min(min(abs(sub(gx, round(gx))), abs(sub(gy, round(gy)))), abs(sub(gz, round(gz))));
    const k = smoothstep(thickness, add(thickness, 0.01), d);
    return mix(color(0x1A1A1A), color(0xF2F2F2), k);
  };

  const tigerFur = () => {
    const scale = uniform(2), lengths = uniform(4), blur = uniform(0.3), strength = uniform(0.3);
    const pos = positionGeometry;
    const xscale = add(div(scale, 2), 1);
    const eScale = exp(xscale);
    const sX = mul(pos.x, eScale), sY = mul(pos.y, eScale), sZ = mul(pos.z, eScale);
    const lenInv = div(1, add(lengths, 5));
    const stripePos = vec3(mul(sX, xscale), mul(sY, lenInv), mul(sZ, lenInv));
    const stripeNoise = mx_noise_float(stripePos);
    const k = add(stripeNoise, sub(strength, 0.5));
    const pattern = oneMinus(smoothstep(mul(blur, -1), blur, k));
    const bellyT = smoothstep(-1, 0.5, pos.y);
    const baseColor = mix(color(0xFFFFED), color(0xFFAB00), bellyT);
    return mul(baseColor, pattern);
  };

  const staticNoiseShader = () => {
    const scaleU = uniform(80), speed = uniform(30);
    const uv = screenUV;
    const uvX = mul(uv.x, scaleU), uvY = mul(uv.y, scaleU);
    const offset = mul(sin(round(mul(time, speed))), 1000);
    const k = mx_noise_float(vec3(uvX, uvY, offset));
    const kNorm = add(mul(k, 0.5), 0.5);
    return vec3(kNorm, kNorm, kNorm);
  };

  const crumpledFabric = () => {
    const scaleU = uniform(2), pinch = uniform(0.5);
    const mainColor = color(0xB0F0FF), subColor = color(0x4040F0), bgColor = color(0x003000);
    const eScale = exp(sub(scaleU, 0.5));
    const pos0 = mul(positionGeometry, eScale);
    const warp = (p) => {
      const x = mx_noise_float(p);
      const y = mx_noise_float(vec3(p.y, p.z, p.x));
      const z = mx_noise_float(vec3(p.z, p.x, p.y));
      return add(p, mul(vec3(x, y, z), pinch));
    };
    const p4 = warp(warp(warp(warp(pos0))));
    const k = clamp(div(add(mx_noise_float(p4), 1), 2), 0, 1);
    const w1 = oneMinus(abs(sub(mul(k, 2), 1)));
    return add(add(mul(mainColor, w1), mul(subColor, pow(k, 2))), mul(bgColor, pow(oneMinus(k), 2)));
  };

  const gasGiant = () => {
    const scaleU = uniform(2), turbulence = uniform(0.3), blur = uniform(0.6);
    const pos = positionGeometry;
    const xscale = add(div(scaleU, 2), 1);
    const sPos = mul(pos, exp(xscale));
    const yt1 = mx_noise_float(vec3(0, mul(pos.y, 0.5), 0));
    const yt2 = mul(mx_noise_float(vec3(0, pos.y, 0)), 0.5);
    const yt3 = mul(mx_noise_float(vec3(1, mul(pos.y, 2), 1)), 0.25);
    const xturb = mul(abs(mul(add(add(yt1, yt2), yt3), turbulence)), 5);
    const wn1 = mx_noise_float(sPos);
    const wn2 = mx_noise_float(add(sPos, 100));
    const wn3 = mx_noise_float(add(sPos, 200));
    const wPos = add(sPos, mul(vec3(wn1, wn2, wn3), xturb));
    const bandRaw = mx_noise_float(vec3(0, mul(wPos.y, xscale), 0));
    const hfRaw = mx_noise_float(mul(wPos, 15));
    const bandTotal = add(bandRaw, mul(hfRaw, oneMinus(pow(blur, 0.2))));
    const k = oneMinus(smoothstep(-1, 1, sub(bandTotal, 0.5)));
    const yColK = add(mx_noise_float(vec3(0, mul(pos.y, 0.75), 0)), 1);
    const base = mix(color(0xF0E8B0), color(0xFFF8F0), yColK);
    return mul(mix(base, color(0xAFA0D0), mul(xturb, 0.3)), k);
  };

  const marble = () => {
    const scaleU = uniform(3), sharpness = uniform(0.2), detail = uniform(0.3);
    const sPos = mul(positionGeometry, scaleU);
    const n1 = mx_noise_float(sPos);
    const n2 = mul(mx_noise_float(mul(sPos, 2)), 0.5);
    const n3 = mul(mx_noise_float(mul(sPos, 6)), 0.1);
    const veins = oneMinus(pow(abs(add(add(n1, n2), n3)), sharpness));
    const detailPow = pow(abs(mx_noise_float(mul(sPos, 50))), 3);
    return mix(color(0xF0F8FF), color(0x4545D3), add(veins, mul(detailPow, detail)));
  };

  const wood = () => {
    const scaleU = uniform(2.5), rings = uniform(4.5), lengths = uniform(1);
    const angle = uniform(0), fibers = uniform(0.3), fibersDensity = uniform(10);
    const pos = positionGeometry;
    const angleRad = mul(angle, 0.01745329);
    const cosA = cos(angleRad), sinA = sin(angleRad);
    const rotX = sub(mul(pos.x, cosA), mul(pos.y, sinA));
    const rotY = add(mul(pos.x, sinA), mul(pos.y, cosA));
    const scaleE = exp(sub(scaleU, 3));
    const invLen = div(1, max(lengths, 0.01));
    const ringScaleXZ = mul(scaleE, invLen);
    const ringScaleY = mul(scaleE, 4);
    const ringPos = vec3(mul(rotX, ringScaleXZ), mul(rotY, ringScaleY), mul(pos.z, ringScaleXZ));
    const rBase = mul(mul(add(mx_noise_float(ringPos), 1), 10), rings);
    const k = div(add(cos(add(rBase, cos(rBase))), 1), 2);
    const fiberE = exp(sub(scaleU, 2));
    const fiberScaleY = mul(fiberE, fibersDensity);
    const fiberOctave = (s, w) => {
      const sx = mul(fiberE, s);
      const sy = mul(fiberScaleY, s);
      const fPos = vec3(mul(rotX, sx), mul(rotY, sy), mul(pos.z, sx));
      return mul(w, mx_noise_float(fPos));
    };
    const fAcc = add(add(add(fiberOctave(1, 2), fiberOctave(1.8, 1.2)), fiberOctave(3.24, 0.72)), fiberOctave(5.832, 0.432));
    const kk = div(add(sin(mul(fAcc, 11.49)), 1), 2);
    return mix(color(0xCC6600), color(0x661A00), mix(k, kk, fibers));
  };

  const presetDefs = [
    ['polkaDots',      'Polka Dots',      polkaDots],
    ['grid',           'Grid',            grid],
    ['tigerFur',       'Tiger Fur',       tigerFur],
    ['staticNoise',    'Static Noise',    staticNoiseShader],
    ['crumpledFabric', 'Crumpled Fabric', crumpledFabric],
    ['gasGiant',       'Gas Giant',       gasGiant],
    ['marble',         'Marble',          marble],
    ['wood',           'Wood',            wood],
  ];
  const presets = presetDefs.map(([id, label, fn]) => ({
    id: `preset_${id}`, label, category: 'preset', group: 'preset',
    build: safeWrap(label, fn),
  }));

  // ── Saved Groups (from editor localStorage) ─────────────────────────────
  // The editor's saveGroupToLibrary persists graph snapshots, not TSL code.
  // Until it also writes a `tslCode: string` field on SavedGroup, the bench
  // can list groups by name but can't execute them. When the editor learns
  // to persist `tslCode`, the bench picks it up here without further changes.
  const saved = loadSavedGroups(TSL);

  return [baseline, ...presets, ...noises, ...saved];
}

function loadSavedGroups(TSL) {
  let raw;
  try { raw = localStorage.getItem('fs:savedGroups'); } catch { return []; }
  if (!raw) return [];

  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(g => g && typeof g.id === 'string').map(g => {
    const compiled = compileSavedGroup(g, TSL);
    return {
      id: `saved_${g.id}`,
      label: g.name || 'Saved Group',
      category: 'saved',
      group: 'saved',
      // `disabled` is true if we can't execute it — picker greys it out
      // and exposes a hint pointing at the editor.
      disabled: !compiled.runnable,
      disabledReason: compiled.reason,
      build: compiled.runnable ? compiled.build : null,
    };
  });
}

function compileSavedGroup(g, TSL) {
  if (typeof g.tslCode === 'string' && g.tslCode.trim().length) {
    try {
      const fn = new Function('TSL', `with (TSL) { ${g.tslCode}\nreturn (typeof __build === 'function') ? __build() : null; }`);
      const result = fn(TSL);
      if (result) return { runnable: true, build: () => fn(TSL) };
    } catch (e) {
      console.warn(`[bench-registry] saved group '${g.name}' compile failed:`, e);
      return { runnable: false, reason: 'compile failed — open in editor and re-save' };
    }
  }
  return {
    runnable: false,
    reason: 'editor needs to export TSL — re-save group in FastShaders v0.1.14+',
  };
}
