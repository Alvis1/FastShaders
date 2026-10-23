/**
 * Built-in preset definitions for the Presets category in the content browser.
 *
 * Presets are openable teaching material, not black boxes: each is TSL code
 * parsed into a real node graph on first use (same machinery as the built-in
 * textures, via buildCodeGroup), wrapped in a group the user can drop, open,
 * rewire and scrub. Tunable parameters are named uniforms, so they surface in
 * the preview's Uniforms overlay and in the exported shader schema.
 *
 * Loaded ON DEMAND by every app surface (`import()` in the content browser and
 * the store): a static import from the boot path puts `codeGroupBuilder` →
 * `codeToGraph` → @babel/* on the entry wave.
 *
 * Four tiers, ordered easy→advanced in PRESET_ENTRIES:
 *   0 — RECIPES: the beginner set, and the only one the Presets tab shows.
 *       One idea in one to five nodes, built from the palette's high-level
 *       nodes (Color Ramp, Fresnel, 0–1 Perlin) — see the Recipes block below.
 *   1 — primitives: one concept, instant feedback (gradient, stripes, fresnel…)
 *   2 — composites: two primitives combined (noise mask, toon ramp…)
 *   3 — effect recipes: the classics people come for (dissolve, hologram…)
 * Tiers 1–3 are the original library, written as flat maths with a Property
 * node per knob; they live on the "Presets 2" tab, an OPTIONAL category that
 * is off by default (registry/optionalCategories.ts). They stay in this ONE
 * list so the store's lookup by id, the intro's model slide and every saved
 * id keep working unchanged.
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

import { buildCodeGroup, layoutPricingKey, type CodeGroupAsset, type CodeGroupEntry } from '@/registry/codeGroupBuilder';

export interface BuiltinPreset extends CodeGroupAsset {
  /** 0 = beginner recipe, 1 = primitive, 2 = composite, 3 = effect recipe. */
  tier: 0 | 1 | 2 | 3;
}

interface PresetEntry extends CodeGroupEntry {
  tier: 0 | 1 | 2 | 3;
}

/** A beginner recipe (the Presets tab); every other tier is "Presets 2". */
export function isRecipe(preset: { tier: number }): boolean {
  return preset.tier === 0;
}

// ─── Recipes (tier 0) ───────────────────────────────────────────────────
//
// The beginner set. Each one teaches ONE idea in one to five nodes, so the
// whole graph fits in a glance and can be rebuilt from the palette:
//
// - Values sit ON the nodes (a Multiply's 0.2, a Greater Than's 0.6), never in
//   Property nodes: a knob a beginner can scrub where they are already looking
//   beats a second node wired into the first. So a recipe has NO uniforms.
// - Colours come from a Color Ramp — one node, its gradient drawn on the card —
//   instead of two colour Properties and a Mix.
// - Each node is written in the exact form graphToCode emits for it, so the
//   parse rebuilds the same node a palette add would. That is why two lines
//   look nested: `mul(uv(), vec2(8, 1))` is ONE UV node with U tiling 8, and
//   `mx_noise_float(positionGeometry.mul(3)).mul(0.5).add(0.5)` is ONE Perlin
//   node at scale 3 in the 0–1 range (`signed: 0`) — the range a Perlin added
//   from the palette has. These are the only built-ins that carry that flag;
//   noiseRangeCorpus.test.ts holds the original library to the absent key.
// - `fsColorRamp` / `fsFresnel` are the module helpers the Color Ramp and
//   Fresnel nodes emit; codeToGraph reads the calls back as those nodes, and
//   `.y` on the Fresnel call is its Facing socket.
// - The return names the Output sockets, so a press wires them for you.

// ── Solid Color ───────────────────────────────────────────────────────────────
const RECIPE_SOLID_CODE = `import { color, Fn } from "three/tsl";

const shader = Fn(() => {
  const paint = color(0x4FC3F7);
  return paint;
});
export default shader;`;

// ── Gradient ──────────────────────────────────────────────────────────────────
// A Color Ramp blends in LINEAR light, which pulls the middle toward the
// brighter stop: from the original Gradient's navy (0x1A237E) the sphere read
// as all coral. A mid blue keeps both ends on screen.
const RECIPE_GRADIENT_CODE = `import { Fn, uv } from "three/tsl";

const shader = Fn(() => {
  const u = uv();
  const ramp = fsColorRamp(u.y, "0 #1565C0 1,1 #FF8A65 1", "linear");
  return ramp.rgb;
});
export default shader;`;

// ── Stripes ───────────────────────────────────────────────────────────────────
// Constant interpolation is what makes the edges hard: below 0.5 the ramp
// holds its first stop, above it the second.
const RECIPE_STRIPES_CODE = `import { Fn, fract, mul, uv, vec2 } from "three/tsl";

const shader = Fn(() => {
  const u = mul(uv(), vec2(8, 1));
  const repeat = fract(u.x);
  const ramp = fsColorRamp(repeat, "0 #263238 1,0.5 #ECEFF1 1", "constant");
  return ramp.rgb;
});
export default shader;`;

// ── Snow on Top ───────────────────────────────────────────────────────────────
// World-space normal, so the snow line stays level while the preview spins
// (Top Cover's reason, in its own comment below).
const RECIPE_SNOW_CODE = `import { Fn, normalWorld } from "three/tsl";

const shader = Fn(() => {
  const nrm = normalWorld;
  const ramp = fsColorRamp(nrm.y, "0.35 #5D4037 1,0.55 #FAFAFA 1", "linear");
  return ramp.rgb;
});
export default shader;`;

// ── Random Tiles ──────────────────────────────────────────────────────────────
// Cell Noise is already 0–1 and never carries the range flag.
const RECIPE_TILES_CODE = `import { Fn, mx_cell_noise_float, positionGeometry } from "three/tsl";

const shader = Fn(() => {
  const cells = mx_cell_noise_float(positionGeometry.mul(4));
  const ramp = fsColorRamp(cells, "0 #0B3C5D 1,0.25 #328CC1 1,0.5 #F2C14E 1,0.75 #D9483B 1", "constant");
  return ramp.rgb;
});
export default shader;`;

// ── Pulse ─────────────────────────────────────────────────────────────────────
// `time.mul(2)` is the Time node at speed 2. Remap, not Multiply + Add: one
// node that SAYS "from -1..1 to 0..1" on its own value boxes.
const RECIPE_PULSE_CODE = `import { Fn, remap, sin, time } from "three/tsl";

const shader = Fn(() => {
  const t = time.mul(2);
  const wave = sin(t);
  const k = remap(wave, -1, 1, 0, 1);
  const ramp = fsColorRamp(k, "0 #311B92 1,1 #FFEA00 1", "linear");
  return ramp.rgb;
});
export default shader;`;

// ── Glowing Edge ──────────────────────────────────────────────────────────────
// One ramp into BOTH Color and Emissive: the body is black, so all that shows
// is the rim, and Emissive keeps the rim lit on the unlit side too.
const RECIPE_EDGE_CODE = `import { Fn, normalWorld, positionWorld } from "three/tsl";

const shader = Fn(() => {
  const fres = fsFresnel(1.5, normalWorld, positionWorld);
  const ramp = fsColorRamp(fres.y, "0.4 #000000 1,1 #00E5FF 1", "linear");
  return { color: ramp.rgb, emissive: ramp.rgb };
});
export default shader;`;

// ── Ghost ─────────────────────────────────────────────────────────────────────
const RECIPE_GHOST_CODE = `import { color, Fn, normalWorld, positionWorld } from "three/tsl";

const shader = Fn(() => {
  const body = color(0x80DEEA);
  const fres = fsFresnel(1.5, normalWorld, positionWorld);
  return { color: body, opacity: fres.y };
});
export default shader;`;

// ── Mix Two Colors ────────────────────────────────────────────────────────────
// The Mix node on its own terms: two Color nodes are A and B, so the ends are
// colours a beginner can double-click, and the Factor is 0–1 Perlin snapped by
// Round to exactly 0 or 1 (owner, 2026-10-20) — every spot is pure A or pure
// B, and deleting Round (the delete splices noise → Factor) shows the blend a
// smooth factor gives. `mix(a, b, t)` as a FUNCTION — the method form puts the
// receiver in the factor slot (the mix convention).
const RECIPE_MIX_CODE = `import { color, Fn, mix, mx_noise_float, positionGeometry, round } from "three/tsl";

const shader = Fn(() => {
  const colorA = color(0x4A148C);
  const colorB = color(0xFFC107);
  const n = mx_noise_float(positionGeometry.mul(3)).mul(0.5).add(0.5);
  const pick = round(n);
  const blend = mix(colorA, colorB, pick);
  return blend;
});
export default shader;`;

// ── Holes ─────────────────────────────────────────────────────────────────────
// Discard is a truthiness test, so the mask is a Greater Than, not a ramp. The
// Color node is not decoration: Discard is a STATEMENT, not a channel, so an
// Output fed by Discard alone emits the red "nothing wired" sentinel
// (graphToCode's `return vec3(1, 0, 0)`) and the lesson came out red.
const RECIPE_HOLES_CODE = `import { color, Fn, greaterThan, mx_noise_float, positionGeometry } from "three/tsl";

const shader = Fn(() => {
  const paint = color(0xFFB74D);
  const n = mx_noise_float(positionGeometry.mul(4)).mul(0.5).add(0.5);
  const cut = greaterThan(n, 0.6);
  return { color: paint, discard: cut };
});
export default shader;`;

// ── Noise Patches ─────────────────────────────────────────────────────────────
const RECIPE_NOISE_CODE = `import { Fn, mx_noise_float, positionGeometry } from "three/tsl";

const shader = Fn(() => {
  const n = mx_noise_float(positionGeometry.mul(3)).mul(0.5).add(0.5);
  const ramp = fsColorRamp(n, "0.4 #1B5E20 1,0.6 #FFF9C4 1", "linear");
  return ramp.rgb;
});
export default shader;`;

// ── Bumps ─────────────────────────────────────────────────────────────────────
// The Displacement socket takes the AMOUNT and pushes along the normal (Vertex
// Wave's comment below). A 0–1 noise only ever pushes OUT, which is the
// easier picture for a first displacement; Noise Blob keeps it signed.
const RECIPE_BUMPS_CODE = `import { Fn, mul, mx_noise_float, positionGeometry } from "three/tsl";

const shader = Fn(() => {
  const n = mx_noise_float(positionGeometry.mul(2)).mul(0.5).add(0.5);
  const h = mul(n, 0.2);
  return { position: h };
});
export default shader;`;

// ── Wobble ────────────────────────────────────────────────────────────────────
// Bumps plus one Add: a float added to a vec3 shifts all three axes, so the
// noise field slides along its diagonal and the lumps keep re-forming.
const RECIPE_WOBBLE_CODE = `import { add, Fn, mul, mx_noise_float, positionGeometry, time } from "three/tsl";

const shader = Fn(() => {
  const pos = positionGeometry;
  const t = time;
  const moved = add(pos, t);
  const n = mx_noise_float(moved.mul(2)).mul(0.5).add(0.5);
  const h = mul(n, 0.2);
  return { position: h };
});
export default shader;`;

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

// ── Circle (Distance Field) ───────────────────────────────────────────
// The shapes rung of the ladder: a coordinate's DISTANCE from a point is a
// field you can threshold, which is every SDF shape in one node.
//
// The softness is guarded with max(s, 0.001) for the reason Stripes documents:
// smoothstep(e, e, x) is undefined behaviour, and this uniform is meant to be
// scrubbed to zero.
const CIRCLE_CODE = `import { add, color, distance, Fn, max, mix, oneMinus, smoothstep, uniform, uv, vec2 } from "three/tsl";

const shader = Fn(() => {
  const discRadius = uniform(0.32);
  const discSoftness = uniform(0.04);
  const discColor = uniform(color(0xFFC845));
  const discBackColor = uniform(color(0x14203A));
  const u = uv();
  const centre = vec2(0.5, 0.5);
  const field = distance(u, centre);
  const soft = max(discSoftness, 0.001);
  const outer = add(discRadius, soft);
  const edge = smoothstep(discRadius, outer, field);
  const disc = oneMinus(edge);
  const result = mix(discBackColor, discColor, disc);
  return result;
});
export default shader;`;

// ── Hue Shift (HSL Round Trip) ────────────────────────────────────
// The colour-space rung, and the only shipped asset that exercises hsl/toHsl.
//
// Those two are NOT three/tsl exports - graphToCode emits its own branchless
// helper Fn for each at module scope and codeToGraph skips the declarator by
// name (see the hsl/toHsl convention in CLAUDE.md). This preset is therefore
// the first artwork that compiles those helpers on both backends.
//
// The hue is shifted by adding into the h channel alone, then wrapped with
// fract: h is periodic, so a bare add would walk out of range and clamp.
const HUE_SHIFT_CODE = `import { add, clamp, color, Fn, fract, hsl, mul, time, toHsl, uniform, uv } from "three/tsl";

const shader = Fn(() => {
  const hueColor = uniform(color(0x8E6FD8));
  const hueSpread = uniform(0.35);
  const hueSpeed = uniform(0.15);
  const hueBoost = uniform(1.3);
  const src = toHsl(hueColor);
  const u = uv();
  const sweep = mul(u.y, hueSpread);
  const drift = mul(time, hueSpeed);
  const travel = add(sweep, drift);
  const turned = add(src.x, travel);
  const wrapped = fract(turned);
  const boosted = mul(src.y, hueBoost);
  const vivid = clamp(boosted, 0, 1);
  const result = hsl(wrapped, vivid, src.z);
  return result;
});
export default shader;`;

// ── Mosaic (Cell Noise ID) ───────────────────────────────────────
// The Voronoi family's cheap half, and the library's plainest cost lesson.
//
// mx_cell_noise_float returns ONE flat random number per integer cell and
// nothing inside it - no distance field, so no per-fragment site search. That
// is the whole 7-point price. The distance-carrying members of the same family
// (mx_worley_noise_float 230, mx_worley_noise_vec2 235) buy cell WALLS, which
// is why Stylized Water fakes those with ranked sine waves instead.
const MOSAIC_CODE = `import { color, Fn, mix, mul, mx_cell_noise_float, positionGeometry, pow, uniform } from "three/tsl";

const shader = Fn(() => {
  const mosaicScale = uniform(7);
  const mosaicContrast = uniform(1.6);
  const mosaicColorA = uniform(color(0x0B3C5D));
  const mosaicColorB = uniform(color(0xF2C14E));
  const pos = positionGeometry;

  const cellPos = mul(pos, mosaicScale);
  const id = mx_cell_noise_float(cellPos);
  const graded = pow(id, mosaicContrast);
  const result = mix(mosaicColorA, mosaicColorB, graded);
  return result;
});
export default shader;`;

// ── Noise Blob (Vertex Noise Displacement) ───────────────────────────
// Vertex Wave's skeleton with noise in place of the sine, so the two read as
// siblings: same Displacement channel, same return-the-HEIGHT contract.
//
// The noise is left SIGNED here, unlike Noise Mask and Dissolve. That is the
// point - negatives dent and positives bulge, so the mesh deforms about its
// own radius instead of only inflating.
const NOISE_BLOB_CODE = `import { add, Fn, mul, mx_noise_float, positionGeometry, time, uniform } from "three/tsl";

const shader = Fn(() => {
  const blobScale = uniform(2.4);
  const blobAmount = uniform(0.28);
  const blobSpeed = uniform(0.4);

  const pos = positionGeometry;
  const t = time;

  const field = mul(pos, blobScale);
  const drift = mul(t, blobSpeed);
  const boil = add(field, drift);
  const n = mx_noise_float(boil);
  const height = mul(n, blobAmount);

  // One Add of a single float shifts all three noise axes at once, so the
  // whole field drifts along its own diagonal. The noise is left SIGNED on
  // purpose: negatives dent and positives bulge, so the mesh deforms around
  // its own radius instead of only inflating. Return the height alone - the
  // Output node pushes each vertex along its normal.
  return { position: height };
});
export default shader;`;

// ── Distance Fog (Camera Depth) ─────────────────────────────────
// The first preset that reads where the CAMERA is, rather than where the
// surface faces.
//
// Depth is measured RELATIVE to the model's centre - distance(camera, fragment)
// minus the camera's own orbit radius - so the fade spans the mesh at any zoom.
// Absolute camera distances would have been simpler to read and useless the
// moment the user scrolled: the whole model would leave the fog range.
// The offsets are signed, negative toward the viewer, so fogNear < fogFar.
const DISTANCE_FOG_CODE = `import { cameraPosition, clamp, color, distance, div, Fn, length, max, mix, positionWorld, sub, uniform } from "three/tsl";

const shader = Fn(() => {
  const fogNear = uniform(-0.8);
  const fogFar = uniform(0);
  const fogSurfaceColor = uniform(color(0xD84315));
  const fogColor = uniform(color(0xB0BEC5));
  const camPos = cameraPosition;
  const wPos = positionWorld;

  const depth = distance(camPos, wPos);
  const orbit = length(camPos);
  const behind = sub(depth, orbit);

  const pastNear = sub(behind, fogNear);
  const spanRaw = sub(fogFar, fogNear);
  const fogSpan = max(spanRaw, 0.001);
  const fogRatio = div(pastNear, fogSpan);
  const fogAmount = clamp(fogRatio, 0, 1);

  const result = mix(fogSurfaceColor, fogColor, fogAmount);
  return result;
});
export default shader;`;

// ── Iridescence (Fresnel Palette) ───────────────────────────────
// Tier 1 x tier 1 = tier 3, and the clearest statement of the library's thesis:
// Edge Glow's rim mask feeds Colour Ramp's cosine palette as its PHASE, so the
// hue depends on viewing angle. No noise anywhere - 45 points.
//
// The rim is used twice, as phase and again as amplitude, which is what keeps
// the head-on centre at the base colour instead of banding across the whole
// surface. normalWorld, bare - see the world-normal convention.
const IRIDESCENCE_CODE = `import { add, cameraPosition, clamp, color, cos, dot, Fn, mul, normalize, normalWorld, oneMinus, positionWorld, pow, sub, uniform, vec3 } from "three/tsl";

const shader = Fn(() => {
  const iriSharpness = uniform(0.7);
  const iriSpread = uniform(1.6);
  const iriBaseColor = uniform(color(0x8C8CA0));
  const iriSheenColor = uniform(color(0x736680));

  const camPos = cameraPosition;
  const wPos = positionWorld;
  const nrm = normalWorld;

  const toCam = sub(camPos, wPos);
  const viewDir = normalize(toCam);
  const ndv = dot(nrm, viewDir);
  const facing = clamp(ndv, 0, 1);
  const inv = oneMinus(facing);
  const rim = pow(inv, iriSharpness);

  const sweep = mul(rim, iriSpread);
  const phase = vec3(0, 0.33, 0.67);
  const shifted = add(phase, sweep);
  const ang = mul(shifted, 6.2832);
  const cs = cos(ang);
  const wob = mul(iriSheenColor, cs);
  const sheen = mul(wob, rim);
  const raw = add(iriBaseColor, sheen);
  const result = clamp(raw, 0, 1);
  return result;
});
export default shader;`;

// ── Lava Crust (Ridged Noise) ──────────────────────────────────
// Dissolve's other half: where Dissolve thresholds noise to CUT, this folds it
// about zero to draw the contour itself.
//
// abs() on a signed Perlin turns its zero crossing - a set of winding closed
// curves - into a valley; smoothstep widens that valley into the crack. One
// noise sample pays for the cracks, the plate shading AND the emissive core,
// which is the whole reason this is 55 points rather than three times that.
const LAVA_CRUST_CODE = `import { abs, add, color, Fn, max, mix, mul, mx_noise_float, oneMinus, positionGeometry, smoothstep, time, uniform } from "three/tsl";

const shader = Fn(() => {
  const lavaScale = uniform(2.5);
  const lavaFlowSpeed = uniform(0.12);
  const lavaCrackWidth = uniform(0.1);
  const lavaCrustColor = uniform(color(0x3A2A22));
  const lavaHotColor = uniform(color(0xFF5A00));
  const pos = positionGeometry;
  const t = time;

  // ONE noise sample. Everything below is built from it - the cracks, the
  // plate shading and the emissive core all reuse this one value.
  const scaled = mul(pos, lavaScale);
  const creep = mul(t, lavaFlowSpeed);
  const p = add(scaled, creep);
  const n = mx_noise_float(p);

  // abs() folds the signed noise about zero, so its zero contour - a set of
  // winding closed curves - becomes a valley at 0. Smoothstep widens that
  // valley into the crack; invert makes 1 the hot side.
  const ridge = abs(n);
  const w = max(lavaCrackWidth, 0.001);
  const crust = smoothstep(0, w, ridge);
  const heat = oneMinus(crust);

  // The same sample again, for free: the plates darken away from the cracks.
  const cool = mul(ridge, 0.7);
  const plate = oneMinus(cool);
  const rock = mul(lavaCrustColor, plate);
  const surface = mix(rock, lavaHotColor, heat);

  // Squared, so only the thin core of a vein burns past 1 and reads as molten.
  const core = mul(heat, heat);
  const hotAmt = mul(core, 2);
  const glow = mul(lavaHotColor, hotAmt);
  return { color: surface, emissive: glow };
});
export default shader;`;

// ── Teleport Beam (Scanline Cutout) ─────────────────────────────
// The only preset that teaches the Output node's Discard channel and the logic
// category, and it teaches the Quest 3 lesson with them: a tiled mobile GPU
// pays real overdraw for transparent blending, so a CUTOUT is the cheap way to
// make a hole. (Discard is not free either - it costs early-Z - but it does not
// multiply with depth complexity the way blending does.)
//
// Discard is a TRUTHINESS test, so the mask is a Less Than, not a ramp: any
// non-zero value culls, which is why a soft edge would eat the whole model.
const TELEPORT_BEAM_CODE = `import { abs, add, color, Fn, fract, lessThan, max, mix, mul, oneMinus, positionWorld, remap, sin, smoothstep, sub, time, uniform } from "three/tsl";

const shader = Fn(() => {
  const beamBodyColor = uniform(color(0x2E3F52));
  const beamGlowColor = uniform(color(0x40FFC8));
  const beamHeight = uniform(0.25);
  const beamDensity = uniform(60);
  const beamSpeed = uniform(0.35);
  const wPos = positionWorld;
  const t = time;

  const tw = mul(t, beamSpeed);
  const sweep = fract(tw);
  const center = remap(sweep, 0, 1, -1, 1);

  const offset = sub(wPos.y, center);
  const d = abs(offset);
  const span = max(beamHeight, 0.001);

  const sy = mul(wPos.y, beamDensity);
  const s = sin(sy);
  const sHalf = mul(s, 0.5);
  const s01 = add(sHalf, 0.5);
  const radius = mul(s01, span);
  const cut = lessThan(d, radius);

  const fall = smoothstep(0, span, d);
  const heat = oneMinus(fall);

  const glow = mul(beamGlowColor, heat);
  const body = mix(beamBodyColor, beamGlowColor, heat);
  return { color: body, emissive: glow, discard: cut };
});
export default shader;`;

// ── Studio Shine (Matcap Basis) ────────────────────────────────
// The matcap idea, built without the normalView node this registry does not
// have and without a matcap texture.
//
// Two cross products raise a camera-aligned basis out of the view direction and
// world up; three dot products then read the world normal in that frame, which
// is exactly what a matcap's UV lookup does. The rig therefore turns with the
// CAMERA, not the mesh - cheap stylised lighting that stays put while the model
// spins, which is why matcaps are worth knowing in VR.
//
// worldUp carries a 0.001 z nudge so the cross product cannot collapse to zero
// when the viewer orbits directly overhead. It prevents the NaN, not the roll
// about the view axis, which is inherent to every up-vector matcap.
const STUDIO_SHINE_CODE = `import { add, cameraPosition, clamp, color, cross, dot, Fn, mix, mul, normalize, normalWorld, oneMinus, positionWorld, pow, smoothstep, sub, uniform, vec3 } from "three/tsl";

const shader = Fn(() => {
  const shineBaseColor = uniform(color(0x1E2430));
  const shineKeyColor = uniform(color(0xFFF1D5));
  const shineKeyLevel = uniform(0.7);
  const shineTightness = uniform(120);
  const shineRimStrength = uniform(0.6);

  const camOffset = sub(cameraPosition, positionWorld);
  const viewDir = normalize(camOffset);
  const worldUp = vec3(0, 1, 0.001);
  const rightAxis = cross(worldUp, viewDir);
  const camRight = normalize(rightAxis);
  const camUp = cross(viewDir, camRight);

  const nRight = dot(normalWorld, camRight);
  const nUp = dot(normalWorld, camUp);
  const nFace = dot(normalWorld, viewDir);

  const keyRight = mul(nRight, -0.36);
  const keyUp = mul(nUp, 0.48);
  const keyFace = mul(nFace, 0.8);
  const keyDot = add(keyRight, keyUp, keyFace);
  const keyLit = clamp(keyDot, 0, 1);
  const keyWash = mul(keyLit, shineKeyLevel);
  const shineSpot = pow(keyLit, shineTightness);

  const away = oneMinus(nFace);
  const rimBand = smoothstep(0.55, 1, away);
  const rimLit = mul(rimBand, shineRimStrength);

  const lightRaw = add(keyWash, shineSpot, rimLit);
  const light = clamp(lightRaw, 0, 1);
  const result = mix(shineBaseColor, shineKeyColor, light);
  return result;
});
export default shader;`;

const PRESET_ENTRIES: PresetEntry[] = [
  // ── Recipes (tier 0): plain words, one idea each, and a "Try:" to end on.
  { id: 'recipe-solid', tier: 0, name: 'Solid Color', color: '#4FC3F7', code: RECIPE_SOLID_CODE,
    description: 'The simplest shader there is: one Color node in the Output node\'s Color socket paints the whole model sky blue. Double-click the Color node to pick another color.',
    note: {
      heading: 'One Color, Whole Model',
      text: 'The Output node paints the model with whatever reaches its Color socket. Here that is one Color node. Try: double-click it and pick a new color.',
    } },
  { id: 'recipe-gradient', tier: 0, name: 'Gradient', color: '#FF8A65', code: RECIPE_GRADIENT_CODE,
    description: 'Blue at the bottom fading to coral at the top. UV.y is a number that runs from 0 at the bottom of the model to 1 at the top, and the Color Ramp turns each of those numbers into a color. Goes into the Output node\'s Color socket.',
    note: {
      heading: 'A Number Becomes a Color',
      text: 'UV.y is 0 at the bottom of the model and 1 at the top. Color Ramp turns each number into a color. Try: right-click Color Ramp and drag a color stop.',
    } },
  { id: 'recipe-stripes', tier: 0, name: 'Stripes', color: '#78909C', code: RECIPE_STRIPES_CODE,
    description: 'Dark and light stripes running round the model. The UV node is tiled 8 times, so its U counts from 0 to 8; Fract keeps only the part after the decimal point, so the count starts again at 0 eight times; and a Color Ramp set to Constant gives two hard-edged colors. Goes into the Output node\'s Color socket.',
    note: {
      heading: 'Fract Repeats',
      text: 'UV tiled 8 times counts from 0 to 8. Fract keeps only the part after the decimal point, so it starts again at 0 eight times. Try: change U on the UV node.',
    } },
  { id: 'recipe-snow', tier: 0, name: 'Snow on Top', color: '#6D8B9E', code: RECIPE_SNOW_CODE,
    description: 'White snow on every part of the model that faces up, brown ground everywhere else. The world normal points straight out of the surface: its y part is 1 on top, 0 on the sides and -1 underneath, and the Color Ramp makes the high values white. The snow line stays level while the model turns. Goes into the Output node\'s Color socket.',
    note: {
      heading: 'Facing Up Means Snow',
      text: 'Normal tells which way the surface faces. Its y part is 1 on top and -1 underneath. Color Ramp makes the high values white. Try: drag the white stop left.',
    } },
  { id: 'recipe-tiles', tier: 0, name: 'Random Tiles', color: '#F2C14E', code: RECIPE_TILES_CODE,
    description: 'The model split into blocky cells, each painted one of four colors. Cell Noise gives one random number for each cell, and a Color Ramp set to Constant picks a color for that number. Goes into the Output node\'s Color socket.',
    note: {
      heading: 'One Random Number a Cell',
      text: 'Cell Noise cuts space into cubes and gives each cube one random number from 0 to 1. Color Ramp picks a color for it. Try: right-click Cell Noise, change Scale.',
    } },
  { id: 'recipe-pulse', tier: 0, name: 'Pulse', color: '#9C27B0', code: RECIPE_PULSE_CODE,
    description: 'The whole model beats slowly between deep purple and bright yellow. Time counts seconds, Sine turns them into a wave from -1 to 1, Remap moves that wave to 0 to 1, and the Color Ramp turns it into a color. Goes into the Output node\'s Color socket.',
    note: {
      heading: 'Time Makes It Move',
      text: 'Time counts seconds. Sine turns them into a wave from -1 to 1, and Remap moves it to 0 to 1 for Color Ramp. Try: right-click Time and change its speed.',
    } },
  { id: 'recipe-edge', tier: 0, name: 'Glowing Edge', color: '#00B8D4', code: RECIPE_EDGE_CODE,
    description: 'A black model whose outline glows cyan, even on the side the light does not reach. The Fresnel node\'s Facing output is 0 where the surface looks straight at you and 1 at the outline. The same color goes into the Output node\'s Color and Emissive sockets, and Emissive makes a color shine by itself.',
    note: {
      heading: 'Edges Face Away',
      text: 'Fresnel\'s Facing is 0 where the surface faces you and 1 at the outline. Color Ramp colors it; Emissive makes it shine on its own. Try: drag the black stop.',
    } },
  { id: 'recipe-ghost', tier: 0, name: 'Ghost', color: '#80DEEA', code: RECIPE_GHOST_CODE,
    description: 'A see-through pale blue model: clear in the middle, solid at the outline. The Fresnel node\'s Facing output goes into the Output node\'s Opacity socket, where 0 means invisible and 1 means solid, while a Color node paints it.',
    note: {
      heading: 'Opacity 0 Is Invisible',
      text: 'Opacity 0 is invisible and 1 is solid. Fresnel\'s Facing is 0 in the middle and 1 at the outline, so only the edge stays. Try: use its Fresnel output instead.',
    } },
  { id: 'recipe-mix', tier: 0, name: 'Mix Two Colors', color: '#7B1FA2', code: RECIPE_MIX_CODE,
    description: 'Purple and gold patches with hard edges, like a camouflage print. The Mix node blends its A and B inputs by its Factor: 0 gives A, 1 gives B, 0.5 half of each. Here two Color nodes are A and B, Perlin Noise gives a smooth number from 0 to 1, and Round snaps it to exactly 0 or 1, so every spot is pure A or pure B. Goes into the Output node\'s Color socket.',
    note: {
      heading: 'Mix Picks A or B',
      text: 'Mix shows A where Factor is 0, B where it is 1, and a blend in between. Round snaps the noise to exactly 0 or 1, so no blend is left. Try: delete Round to see it.',
    } },
  { id: 'recipe-holes', tier: 0, name: 'Holes', color: '#5D4037', code: RECIPE_HOLES_CODE,
    description: 'An orange model full of holes you can see straight through. Perlin Noise gives a smooth random number from 0 to 1 everywhere; Greater Than answers 1 wherever that number is above 0.6, and the Output node\'s Discard socket removes every spot that gets a 1. A Color node paints what is left.',
    note: {
      heading: 'Discard Cuts Holes',
      text: 'Perlin Noise gives a smooth random number from 0 to 1. Greater Than answers 1 where it is above 0.6, and Discard removes those spots. Try: change the 0.6.',
    } },
  { id: 'recipe-noise', tier: 0, name: 'Noise Patches', color: '#558B2F', code: RECIPE_NOISE_CODE,
    description: 'Soft patches of dark green and cream, like moss or camouflage. Perlin Noise gives every point of the model a smooth random number from 0 to 1, and the Color Ramp turns it into a color. Goes into the Output node\'s Color socket.',
    note: {
      heading: 'Smooth Random Numbers',
      text: 'Perlin Noise gives every point a smooth random number from 0 to 1. Color Ramp turns it into green or cream. Try: right-click Perlin Noise, change Scale.',
    } },
  { id: 'recipe-bumps', tier: 0, name: 'Bumps', color: '#8D6E63', code: RECIPE_BUMPS_CODE,
    description: 'The surface of the model pushed out into soft lumps. The Output node\'s Displacement socket moves each point outward by the amount it receives: Perlin Noise picks an amount from 0 to 1, and Multiply shrinks it to at most 0.2.',
    note: {
      heading: 'Displacement Moves Points',
      text: 'Displacement pushes each point of the surface outward. Perlin Noise picks how far, and Multiply by 0.2 keeps the lumps small. Try: change the 0.2.',
    } },
  { id: 'recipe-wobble', tier: 0, name: 'Wobble', color: '#6D4C41', code: RECIPE_WOBBLE_CODE,
    description: 'Bumps that never stop moving. Adding Time to Position slides the noise through the model, so the lumps keep growing and melting away. Goes into the Output node\'s Displacement socket.',
    note: {
      heading: 'Bumps That Move',
      text: 'Bumps with one change: Add puts Time into Position, so the noise slides through the model and the lumps keep changing. Try: right-click Time, change speed.',
    } },
  // ── The original library (tiers 1–3): the "Presets 2" tab.
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
  { id: 'circle', tier: 1, name: 'Circle (Distance Field)', color: '#FFC845', code: CIRCLE_CODE,
    description: 'A soft-edged amber shape on a deep navy field, drawn purely from how far each UV coordinate sits from the center - the cheapest distance-field shape there is. Switch the preview Model to Plane to see it as a true circle; the sphere stretches UV twice as wide as it is tall, so there it reads as a broad lobe. Wire it to the Output node\'s Color channel and scrub discRadius UP first - below about 0.15 the disc hides on the far side of the sphere.',
    note: {
      heading: 'Distance -> Smoothstep',
      text: 'Distance from the UV node to a Vec2 center gives a radial field. Add sets the outer edge, Smoothstep fades across the rim, Invert makes 1 mean inside, and Max keeps softness above zero.',
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
  { id: 'hue-shift', tier: 2, name: 'Hue Shift (HSL Round Trip)', color: '#D81B60', code: HUE_SHIFT_CODE,
    description: 'A saturated violet surface whose hue slides steadily round the color wheel, banded up the model. The base color only supplies the starting hue and the lightness every shifted color keeps, so nothing clips. Wire it to the Output node\'s Color channel and scrub hueSpread first - past 1 the whole wheel fits on the model at once - then hueBoost, which drains it to gray at 0.',
    note: {
      heading: 'Add Into the Hue Channel',
      text: 'RGB to HSL splits the base color into h, s and l. Multiply scales UV.y and Time, two Adds push them into h alone, Fract keeps it inside one turn, Clamp bounds s, and HSL to RGB rebuilds it.',
    } },
  { id: 'noise-mask', tier: 2, name: 'Noise Mask (Threshold)', color: '#42A5F5', code: NOISE_MASK_CODE,
    description: 'Perlin noise pushed through a soft smoothstep threshold, carving the surface into organic dark-green and cream patches — the kernel inside dissolve and coverage effects. Wire to Color and scrub threshold to slide the mask across the surface.',
    note: {
      heading: 'Smoothstep Band on Noise',
      text: 'Perlin Noise is remapped to 0-1, then Subtract and Add place the Smoothstep edges around threshold: one value slides the cut, softness sets its blur, and the result is the Mix factor.',
    } },
  { id: 'mosaic', tier: 2, name: 'Mosaic (Cell Noise ID)', color: '#1A4E7A', code: MOSAIC_CODE,
    description: 'Flat facets of navy and amber tiling the surface, each cell painted from a single random number. Cell Noise gives one value per whole-number cell and nothing inside it, which is why it costs a small fraction of what the Voronoi distance functions cost - the cheapest way to say \'random, but in patches\'. Wire it to the Output node\'s Color channel and scrub mosaicScale first to resize the facets.',
    note: {
      heading: 'One Random Value per Cell',
      text: 'Multiply drops Position into cell space, where Cell Noise returns one flat random number per whole-number cell and nothing inside it. Power biases the split; Mix picks between the two colors.',
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
  { id: 'noise-blob', tier: 2, name: 'Noise Blob (Vertex Noise Displacement)', color: '#A1887F', code: NOISE_BLOB_CODE,
    description: 'A sphere whose silhouette boils: 3D Perlin noise sampled at each vertex\'s rest position decides how far that vertex moves along its own normal, and Time drifts the noise field so the lumps keep re-forming. Wire it to the Output node\'s Displacement channel (the value is the AMOUNT to move, not a finished position). Scrub blobAmount first to grow the lumps, then blobScale to trade a few big blobs for many small ones.',
    note: {
      heading: 'Signed Noise Displaces',
      text: 'Multiply drops Position into noise space; one Add drifts all three axes by a single Time value; the last Multiply scales it. Perlin stays SIGNED - unremapped, so samples dent as well as bulge.',
    } },
  { id: 'top-cover', tier: 2, name: 'Top Cover (Normal Mask)', color: '#8E24AA', code: TOP_COVER_CODE,
    description: 'Snow-white cover that settles only on up-facing surfaces — the mask is a smoothstep of the world-space surface normal\'s Y component, not a painted pattern, so the snow line stays level even as the model turns. Wire it to the Output node\'s Color channel and scrub coverage first to raise or lower the snow line.',
    note: {
      heading: 'Normal Y -> Smoothstep Mix',
      text: 'World Normal\'s .y says how up-facing a face is. Invert turns coverage into a cutoff on that value; Subtract/Add widen it into a band, Smoothstep makes a soft 0-1 mask, Mix blends ground to cover.',
    } },
  { id: 'distance-fog', tier: 2, name: 'Distance Fog (Camera Depth)', color: '#78909C', code: DISTANCE_FOG_CODE,
    description: 'A warm orange surface that washes out into pale blue-gray haze as it recedes. Switch the preview Model to Cube or Teapot to read it properly - whole faces sink back there, while on the sphere the fade lands on the shaded rim and is easy to mistake for shading. Unlike a fresnel rim it is measured from the camera, so it moves when you do; and it tints the surface COLOR, so the lighting still falls on the fogged result. Wire it to the Output node\'s Color channel and scrub fogFar first: both uniforms are offsets from the model\'s center along the view (negative is toward you), so zooming never washes the fog away.',
    note: {
      heading: 'Length, Distance -> Mix',
      text: 'Distance measures Camera Position to Position (world); Length measures the camera to the model center. Subtract turns the pair into a signed depth, Divide scales it 0-1, Clamp bounds the Mix.',
    } },
  { id: 'iridescence', tier: 3, name: 'Iridescence (Fresnel Palette)', color: '#9575CD', code: IRIDESCENCE_CODE,
    description: 'A pearl body that blooms into oil-slick bands of lavender, violet, blue and sea-green as the surface turns away from you, with no noise node anywhere. Wire it to the Output node\'s Color channel and scrub iriSpread first to set how many hue cycles fit between the center and the silhouette. Orbit the view and the bands sweep - that angle dependence IS iridescence.',
    note: {
      heading: 'Edge Glow x Color Ramp',
      text: 'Dot, Invert and Power build the Edge Glow rim mask. That mask is used twice: inside the Color Ramp Cosine as phase, then on its output as amplitude, so the center stays base color.',
    } },
  { id: 'dissolve', tier: 3, name: 'Dissolve (Noise Cutoff)', color: '#F4511E', code: DISSOLVE_CODE,
    description: 'Classic noise-cutoff dissolve: where noise falls below the threshold the surface goes black, with a hot orange rim burning exactly along the edge. Wire it to the Output Color channel and scrub dissolveAmount to sweep the dissolve — for a true cutout, add a Less Than node (the noise vs dissolveAmount) into the Output node\'s Discard channel.',
    note: {
      heading: 'Mask x Invert = Edge Rim',
      text: 'Smoothstep squeezes the Perlin Noise into a near-binary mask; multiplying it by its own Invert leaves light only in the thin blend zone, so the rim draws itself on the cutoff line.',
    } },
  { id: 'lava-crust', tier: 3, name: 'Lava Crust (Ridged Noise)', color: '#BF360C', code: LAVA_CRUST_CODE,
    description: 'Dark basalt plates split by a network of molten veins that creeps slowly across the surface. The graph ends in two unwired nodes at the right edge: wire the Mix to the Output Color channel and the Multiply to Emissive, so the cracks light themselves instead of waiting for a lamp. Scrub lavaCrackWidth first to open or close the veins, then lavaScale for more of them.',
    note: {
      heading: 'One Mask, Two Channels',
      text: 'Abs folds the signed Perlin about zero, so its zero contour becomes the crack; Smoothstep and Invert widen it. The same mask squared by a Multiply drives Emissive, so only the vein core is self-lit.',
    } },
  { id: 'hologram', tier: 3, name: 'Hologram (Fresnel + Scanlines)', color: '#EC407A', code: HOLOGRAM_CODE,
    description: 'A sci-fi hologram: a Fresnel rim glow layered with animated horizontal scanlines, all tinted a single cyan. Wire it to Emissive (and lower Opacity) for the classic look, then scrub rimPower to sharpen or soften the edge glow.',
    note: {
      heading: 'Invert Dot -> Rim Mask',
      text: 'Dot Product of normal and view direction is 1 head-on, 0 at edges, so Invert then Power carves a rim mask. Rim plus a Time-scrolled Sine on Y sum into one brightness that Multiply tints.',
    } },
  { id: 'teleport-beam', tier: 3, name: 'Teleport Beam (Scanline Cutout)', color: '#1DE9B6', code: TELEPORT_BEAM_CODE,
    description: 'A horizontal beam sweeps up the model and eats it away one scanline at a time, with a hot aqua fringe burning along every cut. Wire the Less Than output to the Output node\'s Discard channel, the last Multiply to Emissive and the Mix to Color, then scrub beamHeight first to widen the bite. A cutout is the Quest 3 friendly way to make a hole - a tiler pays real overdraw for transparent blending.',
    note: {
      heading: 'Less Than Feeds Discard',
      text: 'Sine on world Y sets a per-line cut radius; Less Than compares it to the Abs distance from the swept plane and feeds Discard. Smoothstep plus Invert reuse that same distance as the emissive heat.',
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
  { id: 'studio-shine', tier: 3, name: 'Studio Shine (Matcap Basis)', color: '#455A64', code: STUDIO_SHINE_CODE,
    description: 'A slate ball lit like a product shot: a broad warm key wash from the upper left, a tight glossy highlight, and a bright rim along the silhouette. The light rig is built from the CAMERA direction rather than from the model, so the studio stays put while the mesh spins - the matcap trick, with no matcap texture. Wire it to the Output node\'s Color channel and scrub shineTightness first: 4 to 30 is a broad soft-box sheen, 200 is a pinpoint gloss, and 0 flattens the whole surface to the key color.',
    note: {
      heading: 'Two Crosses = Camera Axes',
      text: 'Cross of World Up with the view direction gives camera-right; a second Cross gives camera-up. Three Dot Products read the World Normal in that frame, so the rig turns with the camera, not the mesh.',
    } },
];

/**
 * Parse each preset's TSL code into a group. Built by the FIRST call and
 * cached until the selected device's pricing moves (`layoutPricingKey` — the
 * layout is measured in it); this module is loaded on demand, never at boot.
 */
let _cachedPresets: { key: string; list: BuiltinPreset[] } | null = null;

export function getBuiltinPresets(): BuiltinPreset[] {
  const key = layoutPricingKey();
  if (_cachedPresets?.key === key) return _cachedPresets.list;
  const list = PRESET_ENTRIES.map((entry) => ({
    // Recipes lay their wires out in socket order (codeGroupBuilder's option).
    ...buildCodeGroup(entry, 'builtin-preset-', { socketOrdered: isRecipe(entry) }),
    tier: entry.tier,
  }));
  _cachedPresets = { key, list };
  return list;
}
