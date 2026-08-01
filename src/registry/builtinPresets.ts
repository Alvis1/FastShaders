/**
 * Built-in preset definitions for the Presets category in the content browser.
 *
 * Presets are openable teaching material, not black boxes: each is TSL code
 * parsed into a real node graph at startup (same machinery as the built-in
 * textures, via buildCodeGroup), wrapped in a group the user can drop, open,
 * rewire and scrub. Tunable parameters are named uniforms, so they surface in
 * the preview's Uniforms overlay and in the exported shader schema.
 *
 * Three tiers, ordered easy→advanced in PRESET_ENTRIES:
 *   1 — primitives: one concept, instant feedback (gradient, stripes, fresnel…)
 *   2 — composites: two primitives combined (noise mask, toon ramp…)
 *   3 — effect recipes: the classics people come for (dissolve, hologram…)
 *
 * Every snippet is fully flattened (no nested calls) for codeToGraph
 * compatibility; builtinPresets.test.ts asserts each parses with zero errors
 * and zero unknown nodes, and that uniform names are unique ACROSS presets —
 * uniform values persist by name, so a shared name would leak tuned values
 * between presets (and graphToCode would rename the later one).
 *
 * NB presets deliberately do NOT appear in the node-editor.html GraphsPage
 * description/citation editor — its /__nd splice endpoints only know
 * nodeRegistry.ts and builtinTextures.ts. Preset descriptions are edited here,
 * in source.
 */

import { buildCodeGroup, type CodeGroupAsset, type CodeGroupEntry } from '@/registry/codeGroupBuilder';

export interface BuiltinPreset extends CodeGroupAsset {
  /** 1 = primitive, 2 = composite, 3 = effect recipe. */
  tier: 1 | 2 | 3;
}

interface PresetEntry extends CodeGroupEntry {
  tier: 1 | 2 | 3;
}

// ─── Preset TSL code definitions ────────────────────────────────────────

// ── Gradient (UV Mix) ─────────────────────────────────────────────────────────
// The hello-world of shading: the vertical UV coordinate IS the mix factor.
const GRADIENT_CODE = `import { color, Fn, mix, uniform, uv } from "three/tsl";

const shader = Fn(() => {
  const bottomColor = uniform(color(0x1A237E));
  const topColor = uniform(color(0xFF8A65));
  const u = uv();
  const result = mix(bottomColor, topColor, u.y);
  return result;
});
export default shader;`;

// ── Stripes (Sine Threshold) ──────────────────────────────────────────────────
// Rotate the UV axis (wood-style degrees->radians), sin() for periodicity,
// smoothstep for an anti-aliased threshold.
const STRIPES_CODE = `import { color, cos, Fn, max, mix, mul, sin, smoothstep, sub, uniform, uv } from "three/tsl";

const shader = Fn(() => {
  const frequency = uniform(20);
  const angle = uniform(30);
  const stripeSoftness = uniform(0.4);
  const stripeColorA = uniform(color(0x263238));
  const stripeColorB = uniform(color(0xECEFF1));
  const u = uv();

  const angleRad = mul(angle, 0.01745329);
  const cosA = cos(angleRad);
  const sinA = sin(angleRad);
  const xCos = mul(u.x, cosA);
  const ySin = mul(u.y, sinA);
  const rx = sub(xCos, ySin);

  const phase = mul(rx, frequency);
  const s = sin(phase);

  const soft = max(stripeSoftness, 0.001);
  const negSoft = mul(soft, -1);
  const k = smoothstep(negSoft, soft, s);

  const result = mix(stripeColorA, stripeColorB, k);
  return result;
});
export default shader;`;

// ── Checker (Floor + Mod) ─────────────────────────────────────────────────────
// floor() quantizes UVs into tiles; mod(x+y, 2) is the 0/1 parity that
// drives the mix directly.
const CHECKER_CODE = `import { add, color, floor, Fn, mix, mod, mul, uniform, uv } from "three/tsl";

const shader = Fn(() => {
  const count = uniform(8);
  const checkColorA = uniform(color(0xFAFAFA));
  const checkColorB = uniform(color(0x212121));
  const u = uv();

  const cx = mul(u.x, count);
  const cy = mul(u.y, count);
  const fx = floor(cx);
  const fy = floor(cy);
  const s = add(fx, fy);
  const m = mod(s, 2);

  const result = mix(checkColorA, checkColorB, m);
  return result;
});
export default shader;`;

// ── Edge Glow (Fresnel) ───────────────────────────────────────────────────────
// World-space fresnel: dot(normal, view) inverted and sharpened with pow.
//
// The normal MUST be `normalWorld`, not `normalLocal`. The view vector is world
// space, so an object-space normal makes the expression evaluate to
// dot(N_world, R·V) — a correctly-shaped fresnel measured about a view
// direction rotated by the model's own rotation. That is not hypothetical: the
// preview nests the mesh under `#preview-entity` (a resting tilt, 45/45/0 on
// the sphere and cube) inside `#spin-parent` (a full 360° turntable animation
// while playing), so the rim slid off the silhouette and swept across the body,
// clipping to solid glow past ~78° of rotation. Same rule for hologram,
// force-field and stylized-water below.
const EDGE_GLOW_CODE = `import { add, cameraPosition, clamp, color, dot, Fn, mul, normalize, normalWorld, oneMinus, positionWorld, pow, sub, uniform } from "three/tsl";

const shader = Fn(() => {
  const glowPower = uniform(3);
  const intensity = uniform(2);
  const glowColor = uniform(color(0x00E5FF));
  const coreColor = uniform(color(0x0D1B2A));
  const camPos = cameraPosition;
  const wPos = positionWorld;
  const nrm = normalWorld;

  const toCam = sub(camPos, wPos);
  const viewDir = normalize(toCam);
  const ndv = dot(nrm, viewDir);
  const c = clamp(ndv, 0, 1);
  const inv = oneMinus(c);
  const rim = pow(inv, glowPower);
  const rimStrength = mul(rim, intensity);
  const glow = mul(glowColor, rimStrength);
  const result = add(coreColor, glow);
  return result;
});
export default shader;`;

// ── Pulse (Sine Time) ─────────────────────────────────────────────────────────
// The animation primitive: time -> sin -> remap to 0..1 -> mix.
const PULSE_CODE = `import { add, color, Fn, mix, mul, sin, time, uniform } from "three/tsl";

const shader = Fn(() => {
  const pulseSpeed = uniform(2);
  const restColor = uniform(color(0x311B92));
  const pulseColor = uniform(color(0xFFEA00));
  const t = time;

  const ts = mul(t, pulseSpeed);
  const s = sin(ts);
  const sHalf = mul(s, 0.5);
  const k = add(sHalf, 0.5);

  const result = mix(restColor, pulseColor, k);
  return result;
});
export default shader;`;

// ── UV Scroll (Time Offset) ───────────────────────────────────────────────────
// Animate the COORDINATE, not the color: add time to u.x, fract() wraps it.
const UV_SCROLL_CODE = `import { add, color, Fn, fract, mix, mul, time, uniform, uv } from "three/tsl";

const shader = Fn(() => {
  const scrollSpeed = uniform(0.3);
  const scrollColorA = uniform(color(0x004D40));
  const scrollColorB = uniform(color(0xA7FFEB));
  const u = uv();
  const t = time;

  const off = mul(t, scrollSpeed);
  const sx = add(u.x, off);
  const fx = fract(sx);
  const result = mix(scrollColorA, scrollColorB, fx);
  return result;
});
export default shader;`;

// ── Color Ramp (Cosine Palette) ───────────────────────────────────────────────
// Inigo Quilez's cosine palette (c=1): per-channel phase offsets turn one
// scalar ramp into a full-color gradient.
const COLOR_RAMP_CODE = `import { add, clamp, color, cos, Fn, mul, uniform, uv, vec3 } from "three/tsl";

const shader = Fn(() => {
  const baseColor = uniform(color(0x7F7F7F));
  const ampColor = uniform(color(0x7F7F7F));
  const u = uv();

  const phase = vec3(0, 0.33, 0.67);
  const shifted = add(phase, u.x);
  const ang = mul(shifted, 6.2832);
  const cs = cos(ang);
  const wob = mul(ampColor, cs);
  const raw = add(baseColor, wob);
  const result = clamp(raw, 0, 1);
  return result;
});
export default shader;`;

// ── Noise Mask (Threshold) ────────────────────────────────────────────────────
// The organic-mask kernel reused by dissolve/water/etc.: noise -> smoothstep
// band -> mix. The signed noise is remapped to 0..1 (like Dissolve) so the
// threshold's natural scrub range IS the default 0..1 slider.
const NOISE_MASK_CODE = `import { add, color, Fn, mix, mul, mx_noise_float, positionGeometry, smoothstep, sub, uniform } from "three/tsl";

const shader = Fn(() => {
  const maskScale = uniform(3);
  const threshold = uniform(0.5);
  const maskSoftness = uniform(0.2);
  const maskColorA = uniform(color(0x1B5E20));
  const maskColorB = uniform(color(0xFFF9C4));
  const pos = positionGeometry;

  const sPos = mul(pos, maskScale);
  const n = mx_noise_float(sPos);
  const nHalf = mul(n, 0.5);
  const n01 = add(nHalf, 0.5);

  const lo = sub(threshold, maskSoftness);
  const hi = add(threshold, maskSoftness);
  const k = smoothstep(lo, hi, n01);

  const result = mix(maskColorA, maskColorB, k);
  return result;
});
export default shader;`;

// ── Toon Ramp (Quantized Light) ───────────────────────────────────────────────
// Cel shading: N-dot-L lighting posterized with floor(k*steps)/(steps−1) — the
// −1 denominator is what lets the TOP band actually reach litColor (÷steps
// would cap the brightest band at (steps−1)/steps and never show it). The
// max(…, 1) keeps toonSteps = 1 from dividing by zero; the clamp folds the
// overshoot at k = 1 back into range.
const TOON_RAMP_CODE = `import { clamp, color, div, dot, floor, Fn, max, mix, mul, normalize, normalLocal, remap, sub, uniform, vec3 } from "three/tsl";

const shader = Fn(() => {
  const toonSteps = uniform(3);
  const shadowColor = uniform(color(0x4A148C));
  const litColor = uniform(color(0xFFE082));

  const nrm = normalize(normalLocal);
  const lightDir = vec3(0.5, 0.8, 0.4);
  const ln = normalize(lightDir);
  const nl = dot(nrm, ln);
  const k = remap(nl, -1, 1, 0, 1);

  const ks = mul(k, toonSteps);
  const kf = floor(ks);
  const denomRaw = sub(toonSteps, 1);
  const denom = max(denomRaw, 1);
  const kqRaw = div(kf, denom);
  const kq = clamp(kqRaw, 0, 1);

  const result = mix(shadowColor, litColor, kq);
  return result;
});
export default shader;`;

// ── Vertex Wave (Sine Displacement) ───────────────────────────────────────────
// The vertex stage: a travelling sine drives how far each vertex moves.
//
// The Output node's Displacement channel takes the displacement AMOUNT, not a
// finished position — tslCodeProcessor emits
// `positionNode: positionLocal.add(normalLocal.mul(ref))` for it (or
// `positionLocal.add(ref)` when the node's displacement mode is set to Direct,
// where ref is an offset VECTOR). So the preset must return the scalar height
// and let the Output node do the adding. Returning `positionGeometry + normal *
// h` here — which is what this preset used to do — made the emitter compute
// positionLocal + normalLocal * (position + offset), i.e. every vertex pushed
// out by roughly its own coordinates, which tears the model apart. Wired to
// Colour instead, that same absolute position renders as a position-as-RGB
// rainbow.
const VERTEX_WAVE_CODE = `import { Fn, mul, positionGeometry, sin, sub, time, uniform } from "three/tsl";

const shader = Fn(() => {
  const waveFrequency = uniform(8);
  const waveSpeed = uniform(2);
  const waveAmplitude = uniform(0.08);
  const pos = positionGeometry;
  const t = time;

  const a = mul(pos.y, waveFrequency);
  const ts = mul(t, waveSpeed);
  const ph = sub(a, ts);
  const s = sin(ph);
  const height = mul(s, waveAmplitude);

  // The height alone — the Output node pushes each vertex along its normal.
  return { position: height };
});
export default shader;`;

// ── Top Cover (Normal Mask) ───────────────────────────────────────────────────
// Mask by GEOMETRY instead of pattern: smoothstep on normal.y covers only
// up-facing surfaces (snow/moss). World-space normal, so the snow line stays
// level as the preview spins — with normalLocal the "snow" rode the model round
// like paint, teaching the opposite of what the preset is for.
const TOP_COVER_CODE = `import { add, color, Fn, mix, normalWorld, oneMinus, smoothstep, sub, uniform } from "three/tsl";

const shader = Fn(() => {
  const coverage = uniform(0.6);
  const coverSoftness = uniform(0.2);
  const groundColor = uniform(color(0x5D4037));
  const coverColor = uniform(color(0xFAFAFA));

  const nrm = normalWorld;
  const snowLine = oneMinus(coverage);
  const lo = sub(snowLine, coverSoftness);
  const hi = add(snowLine, coverSoftness);
  const k = smoothstep(lo, hi, nrm.y);
  const result = mix(groundColor, coverColor, k);
  return result;
});
export default shader;`;

// ── Dissolve (Noise Cutoff) ───────────────────────────────────────────────────
// The most-tutorialized node effect: noise threshold cuts the body away,
// solid*(1-solid) rings the cutoff with a glowing edge band.
const DISSOLVE_CODE = `import { add, color, Fn, mul, mx_noise_float, oneMinus, positionGeometry, smoothstep, uniform } from "three/tsl";

const shader = Fn(() => {
  const dissolveAmount = uniform(0.45);
  const edgeWidth = uniform(0.08);
  const dissolveScale = uniform(4);
  const edgeColor = uniform(color(0xFF6D00));
  const bodyColor = uniform(color(0x37474F));
  const pos = positionGeometry;

  const sPos = mul(pos, dissolveScale);
  const n = mx_noise_float(sPos);
  const nHalf = mul(n, 0.5);
  const n01 = add(nHalf, 0.5);

  const hi = add(dissolveAmount, edgeWidth);
  const solid = smoothstep(dissolveAmount, hi, n01);
  const invSolid = oneMinus(solid);
  const band = mul(solid, invSolid);
  const band4 = mul(band, 4);

  const glow = mul(edgeColor, band4);
  const body = mul(bodyColor, solid);
  const result = add(body, glow);
  return result;
});
export default shader;`;

// ── Hologram (Fresnel + Scanlines) ────────────────────────────────────────────
// Fresnel rim + travelling sine scanlines, lifted and tinted. Wire to
// Emissive (and lower Opacity) for the classic look.
const HOLOGRAM_CODE = `import { add, cameraPosition, clamp, color, dot, Fn, mul, normalize, normalWorld, oneMinus, positionGeometry, positionWorld, pow, sin, sub, time, uniform } from "three/tsl";

const shader = Fn(() => {
  const holoColor = uniform(color(0x18FFFF));
  const scanDensity = uniform(40);
  const scanSpeed = uniform(5);
  const rimPower = uniform(2);
  const pos = positionGeometry;
  const t = time;
  const nrm = normalWorld;
  const camPos = cameraPosition;
  const wPos = positionWorld;

  const toCam = sub(camPos, wPos);
  const viewDir = normalize(toCam);
  const facing = dot(nrm, viewDir);
  const facingCl = clamp(facing, 0, 1);
  const inverted = oneMinus(facingCl);
  const rim = pow(inverted, rimPower);

  const sy = mul(pos.y, scanDensity);
  const ts = mul(t, scanSpeed);
  const ph = add(sy, ts);
  const s = sin(ph);
  const sHalf = mul(s, 0.5);
  const s01 = add(sHalf, 0.5);
  const scanDim = mul(s01, 0.4);

  const base = add(rim, scanDim);
  const lifted = add(base, 0.15);
  const result = mul(holoColor, lifted);
  return result;
});
export default shader;`;

// ── Force Field (Fresnel + Grid Pulse) ────────────────────────────────────────
// Three primitives layered: fresnel rim + grid-texture-style tiled lines +
// a sine pulse breathing the whole thing.
const FORCE_FIELD_CODE = `import { abs, add, cameraPosition, clamp, color, dot, Fn, min, mul, normalWorld, normalize, oneMinus, positionWorld, pow, remap, round, sin, smoothstep, sub, time, uniform, uv } from "three/tsl";

const shader = Fn(() => {
  const fieldColor = uniform(color(0x7C4DFF));
  const tiling = uniform(12);
  const fieldPulse = uniform(3);

  const pos = positionWorld;
  const nrm = normalWorld;
  const cam = cameraPosition;
  const u = uv();
  const t = time;

  const camVec = sub(cam, pos);
  const viewDir = normalize(camVec);
  const facing = dot(nrm, viewDir);
  const facingCl = clamp(facing, 0, 1);
  const inverse = oneMinus(facingCl);
  const rim = pow(inverse, 2);

  const gx = mul(u.x, tiling);
  const nx = round(gx);
  const dxr = sub(gx, nx);
  const dx = abs(dxr);
  const gy = mul(u.y, tiling);
  const ny = round(gy);
  const dyr = sub(gy, ny);
  const dy = abs(dyr);
  const d = min(dx, dy);
  const sm = smoothstep(0.03, 0.08, d);
  const lines = oneMinus(sm);

  const ts = mul(t, fieldPulse);
  const s = sin(ts);
  const p = remap(s, -1, 1, 0.5, 1);

  const mesh = mul(lines, 0.5);
  const k0 = add(rim, mesh);
  const k = mul(k0, p);
  const result = mul(fieldColor, k);
  return result;
});
export default shader;`;

// ── Stylized Water (Caustic Web) ──────────────────────────────────────────────
// Caustics with NO noise node at all: 49 points where the worley version cost
// 347 (mx_worley_noise_vec2 alone is 235).
//
// Cost is charged per NODE, not per channel, so ONE `sin` evaluates three plane
// waves at once. Cell walls are the set where the LARGEST TWO of those three
// waves tie — the same "two nearest sites are equidistant" structure worley's
// F2−F1 encodes, which is why the topology comes out as convex cells with
// three-way junctions rather than the worm-like contours a plain sum-of-sines
// gives. Six min/max nodes rank the three channels.
//
// The DOMAIN WARP is what stops it reading as a lattice. Three plane waves tile
// periodically no matter how the frequencies are chosen — on a sphere the
// curvature hides it, but on the flat plane geometry the repeat is obvious. So
// a second `sin` bends the coordinate BEFORE the cells are laid out. Two things
// make it nearly free: the warp amplitude is exactly 1, so it needs no
// multiply, just one more operand on an add that already exists; and it
// replaces the per-axis tilt term the cells used to need (which fought the warp
// and made the net look noisy). Warp before scaling, never after — warping the
// phase per channel shifts each wave family independently and barely helps.
const STYLIZED_WATER_CODE = `import { add, cameraPosition, color, dot, Fn, max, min, mix, mul, normalize, normalWorld, positionGeometry, positionWorld, sin, sub, time, uniform, vec3 } from "three/tsl";

const shader = Fn(() => {
  const flowSpeed = uniform(0.35);
  const waterScale = uniform(4);
  const deepColor = uniform(color(0x01579B));
  const shallowColor = uniform(color(0x4DD0E1));
  const causticStrength = uniform(0.9);
  const pos = positionGeometry;
  const t = time;

  const ts = mul(t, flowSpeed);
  const scaled = mul(pos, waterScale);

  // Bend the coordinate before the cells are laid out, so the tiling never
  // repeats. Amplitude is exactly 1, so this costs one sin and one operand.
  const wob = sin(scaled);
  const wobSwz = vec3(wob.y, wob.z, wob.x);
  const flowDir = vec3(1.7, 0.47, 0.75);
  const flow = mul(flowDir, ts);
  const p = add(scaled, flow, wobSwz);

  // Three plane waves for the price of one sin node. The per-axis frequencies
  // never divide evenly, so no two cells line up.
  const cells = vec3(2.41, 3.29, 2.87);
  const q = mul(p, cells);
  const waves = sin(q);

  // Rank the three waves: the cell wall is where the top two are tied.
  const hi = max(waves.x, waves.y);
  const lo = min(waves.x, waves.y);
  const first = max(hi, waves.z);
  const mid = min(hi, waves.z);
  const second = max(lo, mid);
  const tie = sub(first, second);

  // Narrow tie band -> thin filament, squared so junctions bloom to white.
  const tieNeg = mul(tie, -4.4);
  const ridge = add(tieNeg, 1.5);
  const web = max(ridge, 0);
  const glow = mul(web, web);

  // View-depth: shallow turquoise facing the camera, deep blue at the rim.
  const toCam = sub(cameraPosition, positionWorld);
  const viewDir = normalize(toCam);
  const ndv = dot(normalWorld, viewDir);
  const facing = max(ndv, 0);
  const depthT = mul(facing, 0.55);
  const base = mix(deepColor, shallowColor, depthT);

  const lightAmt = mul(glow, causticStrength);
  const causticTint = vec3(0.75, 0.95, 1);
  const caustics = mul(causticTint, lightAmt);
  const result = add(base, caustics);
  return result;
});
export default shader;`;

const PRESET_ENTRIES: PresetEntry[] = [
  { id: 'gradient', tier: 1, name: 'Gradient (UV Mix)', color: '#43A047', code: GRADIENT_CODE,
    description: 'The hello-world of shading: the vertical texture coordinate drives a mix from deep indigo at the bottom to warm coral at the top. Wire it to the Output node\'s Color channel and scrub topColor first.',
    note: {
      heading: 'UV.y IS the Mix Factor',
      text: 'The y channel of the UV node runs 0 at the bottom to 1 at the top - exactly the range the Mix factor wants, so it wires straight in. Any 0-1 value can drive a Mix the same way.',
    } },
  { id: 'stripes', tier: 1, name: 'Stripes (Sine Threshold)', color: '#00897B', code: STRIPES_CODE,
    description: 'Diagonal stripes made by rotating the UV axis, feeding it through sin(), and thresholding the wave with smoothstep for anti-aliased edges. Wire it to the Output node\'s Color channel and scrub frequency first.',
    note: {
      heading: 'Rotated UV -> Sine -> Mix',
      text: 'Cosine and Sine of the angle scale u.x and u.y; Subtract combines them into a tilted axis, Multiply by frequency then Sine makes a wave, and Smoothstep around zero maps it to a 0-1 Mix factor.',
    } },
  { id: 'checker', tier: 1, name: 'Checker (Floor + Mod)', color: '#7CB342', code: CHECKER_CODE,
    description: 'A classic checkerboard: UVs are scaled by count, quantized with floor, and the tile parity from mod(x+y, 2) directly drives the mix between two colors. Wire it to the Color channel and scrub count first to change the tile density.',
    note: {
      heading: 'Floor -> Mod 2 -> Mix',
      text: 'Multiply scales the UV, then Floor turns it into whole tile numbers. Adding the x and y numbers and taking Modulo 2 leaves an alternating 0/1 that feeds the Mix directly.',
    } },
  { id: 'edge-glow', tier: 1, name: 'Edge Glow (Fresnel)', color: '#00ACC1', code: EDGE_GLOW_CODE,
    description: 'A dark surface whose silhouette lights up with a cyan fresnel rim, built from dot(normal, view) inverted and sharpened. Wire it to Color (or Emissive for a true glow) and scrub glowPower first to tighten or spread the rim.',
    note: {
      heading: 'Invert Dot(N,V) = Rim',
      text: 'Dot Product of normal and view direction reads 1 head-on, 0 at the silhouette; Invert flips that into an edge mask, and Power sharpens it before it tints the glow color added over the core.',
    } },
  { id: 'pulse', tier: 1, name: 'Pulse (Sine Time)', color: '#26A69A', code: PULSE_CODE,
    description: 'The whole surface beats between deep indigo and bright yellow: sin(time × pulseSpeed) is remapped from -1..1 to 0..1 and drives a two-color mix. Wire it to the Output Color channel and scrub pulseSpeed first to change the tempo.',
    note: {
      heading: 'Sine Remapped to 0-1 Mix',
      text: 'Time feeds a Multiply (pulseSpeed) for tempo, then Sine outputs -1 to 1. Mix never clamps its Factor, so negatives overshoot past A; Multiply by 0.5 and Add 0.5 rescale the swing to 0-1.',
    } },
  { id: 'uv-scroll', tier: 1, name: 'UV Scroll (Time Offset)', color: '#9CCC65', code: UV_SCROLL_CODE,
    description: 'A two-color ramp that scrolls endlessly sideways: time offsets the UV x coordinate and fract() wraps it back into 0-1 — animating the coordinate, not the colors. Wire it to the Output Color channel and scrub scrollSpeed first.',
    note: {
      heading: 'Fract Wraps a Sliding UV',
      text: 'Multiply scales Time, Add pushes it into UV.x so the coordinate slides past 1. Fract keeps only what is after the decimal point, wrapping it to 0-1 so Mix blends in a seamless loop.',
    } },
  { id: 'color-ramp', tier: 2, name: 'Color Ramp (Cosine Palette)', color: '#5C6BC0', code: COLOR_RAMP_CODE,
    description: 'Turns the horizontal UV coordinate into a smooth rainbow using Inigo Quilez\'s cosine palette — a base color plus a cosine wobble whose per-channel phase offsets (0, 0.33, 0.67) spread the three channels around the color wheel. Wire it to the Color channel and try ampColor first: picking a darker color shrinks the wobble and desaturates the ramp toward the base gray.',
    note: {
      heading: 'UV.x + phase -> Cosine',
      text: 'Add offsets UV.x per channel (0, 0.33, 0.67), so one Cosine peaks in red, green and blue at different points; Multiply scales that cosine by ampColor, Add lays it on baseColor, Clamp bounds it 0..1.',
    } },
  { id: 'noise-mask', tier: 2, name: 'Noise Mask (Threshold)', color: '#42A5F5', code: NOISE_MASK_CODE,
    description: 'Perlin noise pushed through a soft smoothstep threshold, carving the surface into organic dark-green and cream patches — the kernel inside dissolve and coverage effects. Wire to Color and scrub threshold to slide the mask across the surface.',
    note: {
      heading: 'Smoothstep Band on Noise',
      text: 'Perlin Noise is remapped to 0-1, then Subtract and Add place the Smoothstep edges around threshold: one value slides the cut, softness sets its blur, and the result is the Mix factor.',
    } },
  { id: 'toon-ramp', tier: 2, name: 'Toon Ramp (Quantized Light)', color: '#7E57C2', code: TOON_RAMP_CODE,
    description: 'Cel-shaded sphere: the surface normal is dotted with a fixed light direction and the lighting value is posterized with floor() into flat bands between a shadow purple and a lit cream. Wire to the Color channel; scrub toonSteps first to change the band count.',
    note: {
      heading: 'Floor Bands the Dot Ramp',
      text: 'Dot Product plus Remap makes a smooth 0-1 light ramp. Multiply by toonSteps, Floor it, then Divide by toonSteps-1 (Max keeps that at least 1) and Clamp: the snapped levels make Mix paint flat bands.',
    } },
  { id: 'vertex-wave', tier: 2, name: 'Vertex Wave (Sine Displacement)', color: '#29B6F6', code: VERTEX_WAVE_CODE,
    description: 'Displaces each vertex along its surface normal by a sine wave traveling up the model, making the whole surface ripple. The output is the wave HEIGHT, not a finished position — the Output node adds it along the normal for you. Wire it to the Displacement channel (on Color you get a rainbow, because a position shown as a colour is exactly that), and scrub waveAmplitude first to see the ripples grow.',
    note: {
      heading: 'Position.y - Time -> Sine',
      text: 'Position y sets the sine phase, so the ripple would stand frozen; subtracting Time slides that phase, which is what makes the wave travel up. The last Multiply only scales its height.',
    } },
  { id: 'top-cover', tier: 2, name: 'Top Cover (Normal Mask)', color: '#8E24AA', code: TOP_COVER_CODE,
    description: 'Snow-white cover that settles only on up-facing surfaces — the mask is a smoothstep of the world-space surface normal\'s Y component, not a painted pattern, so the snow line stays level even as the model turns. Wire it to the Output node\'s Color channel and scrub coverage first to raise or lower the snow line.',
    note: {
      heading: 'Normal Y -> Smoothstep Mix',
      text: 'World Normal\'s .y says how up-facing a face is. Invert turns coverage into a cutoff on that value; Subtract/Add widen it into a band, Smoothstep makes a soft 0-1 mask, Mix blends ground to cover.',
    } },
  { id: 'dissolve', tier: 3, name: 'Dissolve (Noise Cutoff)', color: '#F4511E', code: DISSOLVE_CODE,
    description: 'Classic noise-cutoff dissolve: where noise falls below the threshold the surface goes black, with a hot orange rim burning exactly along the edge. Wire it to the Output Color channel and scrub dissolveAmount to sweep the dissolve — for a true cutout, add a Less Than node (the noise vs dissolveAmount) into the Output node\'s Discard channel.',
    note: {
      heading: 'Mask x Invert = Edge Rim',
      text: 'Smoothstep squeezes the Perlin Noise into a near-binary mask; multiplying it by its own Invert leaves light only in the thin blend zone, so the rim draws itself on the cutoff line.',
    } },
  { id: 'hologram', tier: 3, name: 'Hologram (Fresnel + Scanlines)', color: '#EC407A', code: HOLOGRAM_CODE,
    description: 'A sci-fi hologram: a Fresnel rim glow layered with animated horizontal scanlines, all tinted a single cyan. Wire it to Emissive (and lower Opacity) for the classic look, then scrub rimPower to sharpen or soften the edge glow.',
    note: {
      heading: 'Invert Dot -> Rim Mask',
      text: 'Dot Product of normal and view direction is 1 head-on, 0 at edges, so Invert then Power carves a rim mask. Rim plus a Time-scrolled Sine on Y sum into one brightness that Multiply tints.',
    } },
  { id: 'force-field', tier: 3, name: 'Force Field (Fresnel + Grid Pulse)', color: '#FF7043', code: FORCE_FIELD_CODE,
    description: 'A sci-fi energy barrier: a violet Fresnel rim glow layered over a pulsing grid mesh mapped on uv. Wire it to the Emissive channel (and lower Opacity for a translucent field), then scrub tiling to change the mesh density.',
    note: {
      heading: 'Round-Subtract -> Grid',
      text: 'Round then Subtract then Abs measures distance to the nearest grid line; Min unions the x and y sets, Smoothstep + Invert draw it, and a Sine pulse dims lines and rim together.',
    } },
  { id: 'stylized-water', tier: 3, name: 'Stylized Water (Caustic Web)', color: '#039BE5', code: STYLIZED_WATER_CODE,
    description: 'Cartoon ocean caustics built without a single noise node: one Sine makes three tilted plane waves, and a handful of Min/Max nodes light up the line where the top two tie — a net of bright refraction filaments drifting over a fresnel-deepened blue, shallow turquoise facing you and deep at the rim. Wire to the Output Color channel and scrub causticStrength first, then flowSpeed.',
    note: {
      heading: 'Min/Max Rank Three Waves',
      text: 'Two Sines: the first warps the scaled position, the second turns it into three waves at once. Max and Min rank the three, and Subtract takes the top-two gap - zero exactly where the leaders tie.',
    } },
];

/**
 * Parse each preset's TSL code into a group, cached. Called once at startup.
 */
let _cachedPresets: BuiltinPreset[] | null = null;

export function getBuiltinPresets(): BuiltinPreset[] {
  if (_cachedPresets) return _cachedPresets;
  _cachedPresets = PRESET_ENTRIES.map((entry) => ({
    ...buildCodeGroup(entry, 'builtin-preset-'),
    tier: entry.tier,
  }));
  return _cachedPresets;
}
