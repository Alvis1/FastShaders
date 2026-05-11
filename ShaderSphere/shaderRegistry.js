// ShaderSphere v3 — Shader Registry
//
// Factory module shared by both benchmark modes.
//   - bench.js (TSL/WebGPU)    passes `import * as TSL from 'three/tsl'`
//   - bench-aframe.js (A-Frame) passes `THREE.TSL` (IIFE global namespace)
//
// Two groups of shaders are registered:
//
//   1. Noise atomics — one entry per FastShaders noise registry node
//      (perlin, perlinVec3, fbm, fbmVec3, cellNoise, voronoi, voronoiVec2,
//       voronoiVec3). Each is a single MaterialX call on positionGeometry,
//      mirroring the default emission of a Noise node with scale=1.
//
//   2. Texture node groups — direct ports of the eight built-in texture
//      groups defined in src/registry/builtinTextures.ts (polkaDots, grid,
//      tigerFur, staticNoise, crumpledFabric, gasGiant, marble, wood).

export function buildShaderRegistry(TSL) {
  const {
    abs, add, clamp, color, cos, div, exp, fract, max, min, mix, mul,
    oneMinus, positionGeometry, pow, round, screenUV, sin, smoothstep, sqrt,
    sub, time, uniform, vec3,
    mx_noise_float, mx_noise_vec3,
    mx_fractal_noise_float, mx_fractal_noise_vec3,
    mx_cell_noise_float,
    mx_worley_noise_float, mx_worley_noise_vec2, mx_worley_noise_vec3,
  } = TSL;

  const safeWrap = (label, fn) => () => {
    try { return fn(); }
    catch (e) { console.warn(`[ShaderSphere] ${label}:`, e); return color(0xff00ff); }
  };

  // ── Reference baseline ────────────────────────────────────────────────────
  const refs = [
    { id: 'ref_flat_color', label: 'Flat Color (baseline)', category: 'reference', build: () => color(0x888888) },
  ];

  // ── Noise atomics (one per noise registry entry, scale=1 default) ─────────
  const noiseEntries = [
    { id: 'noise_perlin',      label: 'Perlin Noise',        build: () => vec3(mx_noise_float(positionGeometry)) },
    { id: 'noise_perlinVec3',  label: 'Perlin Noise (vec3)', build: () => mx_noise_vec3(positionGeometry) },
    { id: 'noise_fbm',         label: 'fBm',                 build: () => vec3(mx_fractal_noise_float(positionGeometry)) },
    { id: 'noise_fbmVec3',     label: 'fBm (vec3)',          build: () => mx_fractal_noise_vec3(positionGeometry) },
    { id: 'noise_cellNoise',   label: 'Cell Noise',          build: () => vec3(mx_cell_noise_float(positionGeometry)) },
    { id: 'noise_voronoi',     label: 'Voronoi',             build: () => vec3(mx_worley_noise_float(positionGeometry)) },
    { id: 'noise_voronoiVec2', label: 'Voronoi (F1/F2)',     build: () => vec3(mx_worley_noise_vec2(positionGeometry), 0) },
    { id: 'noise_voronoiVec3', label: 'Voronoi (F1/F2/F3)',  build: () => mx_worley_noise_vec3(positionGeometry) },
  ];
  const noises = noiseEntries.map(s => ({
    id: s.id, label: s.label, category: 'noise',
    build: safeWrap(s.label, s.build),
  }));

  // ── Texture node groups (ports of src/registry/builtinTextures.ts) ────────

  // Polka Dots — 3D dot lattice via fract() + per-cell distance to centre
  const polkaDots = () => {
    const scale = uniform(3);
    const size = uniform(0.5);
    const blur = uniform(0.25);
    const pos = positionGeometry;

    const sPos = mul(pos, scale);
    const fx = sub(fract(sPos.x), 0.5);
    const fy = sub(fract(sPos.y), 0.5);
    const fz = sub(fract(sPos.z), 0.5);
    const distSq = add(add(mul(fx, fx), mul(fy, fy)), mul(fz, fz));
    const dist = sqrt(distSq);

    const xsize = exp(sub(mul(size, 5), 5));
    const blur2 = mul(blur, blur);
    const xblur = mul(blur2, blur2);
    const k = smoothstep(sub(xsize, xblur), add(xsize, xblur), dist);
    return mix(color(0x262680), color(0xFFF7EB), k);
  };

  // Grid — distance-to-nearest line on three orthogonal planes
  const grid = () => {
    const scale = uniform(1);
    const count = uniform(8);
    const thickness = uniform(0.05);
    const pos = positionGeometry;

    const sPos = mul(pos, scale);
    const gx = mul(sPos.x, count);
    const gy = mul(sPos.y, count);
    const gz = mul(sPos.z, count);
    const distX = abs(sub(gx, round(gx)));
    const distY = abs(sub(gy, round(gy)));
    const distZ = abs(sub(gz, round(gz)));
    const d = min(min(distX, distY), distZ);

    const k = smoothstep(thickness, add(thickness, 0.01), d);
    return mix(color(0x1A1A1A), color(0xF2F2F2), k);
  };

  // Tiger Fur — noise stripes blended over a belly gradient
  const tigerFur = () => {
    const scale = uniform(2);
    const lengths = uniform(4);
    const blur = uniform(0.3);
    const strength = uniform(0.3);
    const pos = positionGeometry;

    const xscale = add(div(scale, 2), 1);
    const eScale = exp(xscale);
    const sX = mul(pos.x, eScale);
    const sY = mul(pos.y, eScale);
    const sZ = mul(pos.z, eScale);

    const lenInv = div(1, add(lengths, 5));
    const stripePos = vec3(mul(sX, xscale), mul(sY, lenInv), mul(sZ, lenInv));
    const stripeNoise = mx_noise_float(stripePos);

    const k = add(stripeNoise, sub(strength, 0.5));
    const stripes = smoothstep(mul(blur, -1), blur, k);
    const pattern = oneMinus(stripes);

    const bellyT = smoothstep(-1, 0.5, pos.y);
    const baseColor = mix(color(0xFFFFED), color(0xFFAB00), bellyT);
    return mul(baseColor, pattern);
  };

  // Static Noise — animated TV static in screen space
  const staticNoiseShader = () => {
    const scaleU = uniform(80);
    const speed = uniform(30);
    const uv = screenUV;

    const uvX = mul(uv.x, scaleU);
    const uvY = mul(uv.y, scaleU);
    const offset = mul(sin(round(mul(time, speed))), 1000);

    const k = mx_noise_float(vec3(uvX, uvY, offset));
    const kNorm = add(mul(k, 0.5), 0.5);
    return vec3(kNorm, kNorm, kNorm);
  };

  // Crumpled Fabric — 4 iterations of domain-warped noise
  const crumpledFabric = () => {
    const scaleU = uniform(2);
    const pinch = uniform(0.5);
    const mainColor = color(0xB0F0FF);
    const subColor = color(0x4040F0);
    const bgColor = color(0x003000);
    const pos = positionGeometry;

    const eScale = exp(sub(scaleU, 0.5));
    const pos0 = mul(pos, eScale);

    const warp = (p) => {
      const x = mx_noise_float(p);
      const y = mx_noise_float(vec3(p.y, p.z, p.x));
      const z = mx_noise_float(vec3(p.z, p.x, p.y));
      return add(p, mul(vec3(x, y, z), pinch));
    };
    const pos1 = warp(pos0);
    const pos2 = warp(pos1);
    const pos3 = warp(pos2);
    const pos4 = warp(pos3);

    const k = clamp(div(add(mx_noise_float(pos4), 1), 2), 0, 1);
    const w1 = oneMinus(abs(sub(mul(k, 2), 1)));
    const c1 = mul(mainColor, w1);
    const c2 = mul(subColor, pow(k, 2));
    const c3 = mul(bgColor, pow(oneMinus(k), 2));
    return add(add(c1, c2), c3);
  };

  // Gas Giant — banded planet with multi-octave turbulence
  const gasGiant = () => {
    const scaleU = uniform(2);
    const turbulence = uniform(0.3);
    const blur = uniform(0.6);
    const pos = positionGeometry;

    const xscale = add(div(scaleU, 2), 1);
    const eScale = exp(xscale);
    const sPos = mul(pos, eScale);

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
    const hfScaled = mul(hfRaw, oneMinus(pow(blur, 0.2)));
    const bandTotal = add(bandRaw, hfScaled);
    const k = oneMinus(smoothstep(-1, 1, sub(bandTotal, 0.5)));

    const yColK = add(mx_noise_float(vec3(0, mul(pos.y, 0.75), 0)), 1);
    const colorA = color(0xFFF8F0);
    const colorB = color(0xF0E8B0);
    const colorC = color(0xAFA0D0);
    const base = mix(colorB, colorA, yColK);
    const withStorm = mix(base, colorC, mul(xturb, 0.3));
    return mul(withStorm, k);
  };

  // Marble — multi-octave veins + sparkle detail
  const marble = () => {
    const scaleU = uniform(3);
    const sharpness = uniform(0.2);
    const detail = uniform(0.3);
    const sPos = mul(positionGeometry, scaleU);

    const n1 = mx_noise_float(sPos);
    const n2 = mul(mx_noise_float(mul(sPos, 2)), 0.5);
    const n3 = mul(mx_noise_float(mul(sPos, 6)), 0.1);
    const veins = oneMinus(pow(abs(add(add(n1, n2), n3)), sharpness));

    const detailPow = pow(abs(mx_noise_float(mul(sPos, 50))), 3);
    const withDetail = add(veins, mul(detailPow, detail));
    return mix(color(0xF0F8FF), color(0x4545D3), withDetail);
  };

  // Wood — ring noise + four-octave fibre noise
  const wood = () => {
    const scaleU = uniform(2.5);
    const rings = uniform(4.5);
    const lengths = uniform(1);
    const angle = uniform(0);
    const fibers = uniform(0.3);
    const fibersDensity = uniform(10);
    const pos = positionGeometry;

    const angleRad = mul(angle, 0.01745329);
    const cosA = cos(angleRad);
    const sinA = sin(angleRad);
    const rotX = sub(mul(pos.x, cosA), mul(pos.y, sinA));
    const rotY = add(mul(pos.x, sinA), mul(pos.y, cosA));

    const scaleE = exp(sub(scaleU, 3));
    const invLen = div(1, max(lengths, 0.01));
    const ringScaleXZ = mul(scaleE, invLen);
    const ringScaleY = mul(scaleE, 4);
    const ringPos = vec3(mul(rotX, ringScaleXZ), mul(rotY, ringScaleY), mul(pos.z, ringScaleXZ));

    const rBase = mul(mul(add(mx_noise_float(ringPos), 1), 10), rings);
    const rNorm = add(cos(add(rBase, cos(rBase))), 1);
    const k = div(rNorm, 2);

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

    const blended = mix(k, kk, fibers);
    return mix(color(0xCC6600), color(0x661A00), blended);
  };

  const textureEntries = [
    { id: 'tex_polkaDots',      label: 'Polka Dots',      build: polkaDots },
    { id: 'tex_grid',           label: 'Grid',            build: grid },
    { id: 'tex_tigerFur',       label: 'Tiger Fur',       build: tigerFur },
    { id: 'tex_staticNoise',    label: 'Static Noise',    build: staticNoiseShader },
    { id: 'tex_crumpledFabric', label: 'Crumpled Fabric', build: crumpledFabric },
    { id: 'tex_gasGiant',       label: 'Gas Giant',       build: gasGiant },
    { id: 'tex_marble',         label: 'Marble',          build: marble },
    { id: 'tex_wood',           label: 'Wood',            build: wood },
  ];
  const textures = textureEntries.map(s => ({
    id: s.id, label: s.label, category: 'texture',
    build: safeWrap(s.label, s.build),
  }));

  return [...refs, ...noises, ...textures];
}
