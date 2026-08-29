import { useCallback, useRef, useEffect, memo } from 'react';
import type { BuiltinPreset } from '@/registry/builtinPresets';
import { perlin2D } from '@/utils/noisePreview';
import { startTileDrag, tileGhostZoom, tileActivationProps, setHtml5TileDrag } from './tileDrag';
import { useAssetTooltip } from './AssetTooltip';
import { AssetCostBadge } from './AssetCostBadge';
import { PREVIEW_SIZE, clamp01, lerp3, smoothstep, renderPixels } from './tilePreview';

export const BUILTIN_PRESET_DRAG_TYPE = 'application/fastshaders-builtin-preset';

interface PresetCardProps {
  preset: BuiltinPreset;
}

/** Per-pixel CPU approximation of a preset's look; x/y span [-1, 1], y=-1 top. */
type Shade = (x: number, y: number) => [number, number, number];

// ─── preview shade functions ────────────────────────────────────────────────
// Static snapshots of each preset's default parameters (animated presets are
// frozen mid-motion). Normal-based presets fake a sphere: nz = sqrt(1-x²-y²).

/**
 * Hue/saturation/lightness -> RGB, matching the branchless helper graphToCode
 * emits for the `hsl` node (HSL_HELPER_LINES) so the Hue Shift tile lands on
 * the same colors the shader does.
 */
function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  const h6 = h * 6;
  const k = (n: number) => clamp01(Math.abs(((h6 + n) % 6) - 3) - 1);
  const sat = s * (1 - Math.abs(2 * l - 1));
  const lo = l - sat / 2;
  return [k(0) * sat + lo, k(4) * sat + lo, k(2) * sat + lo];
}

/**
 * Stand-in for `mx_cell_noise_float`: one stable pseudo-random value per
 * integer cell. Deterministic on purpose — Math.random would give the Mosaic
 * tile a different face on every mount.
 */
function cellHash(ix: number, iy: number, iz: number): number {
  let h = (ix | 0) * 374761393 + (iy | 0) * 668265263 + (iz | 0) * 2147483647;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const PRESET_SHADES: Record<string, Shade> = {
  'gradient':
  (x, y) => {
    const t = clamp01((1 - y) / 2);
    return lerp3([0.102, 0.137, 0.494], [1.0, 0.541, 0.396], t);
  },
  'stripes':
  (x, y) => {
    const u = (x + 1) / 2;
    const v = (1 - y) / 2;
    const a = 30 * 0.01745329;
    const rx = u * Math.cos(a) - v * Math.sin(a);
    const s = Math.sin(rx * 20);
    const k = clamp01(smoothstep(-0.4, 0.4, s));
    const colorA: [number, number, number] = [0.149, 0.196, 0.22];
    const colorB: [number, number, number] = [0.925, 0.937, 0.945];
    return lerp3(colorA, colorB, k);
  },
  'checker':
  (x, y) => {
    const A: [number, number, number] = [0.980, 0.980, 0.980];
    const B: [number, number, number] = [0.129, 0.129, 0.129];
    const count = 8;
    const ux = (x + 1) / 2;
    // v=1 at the TOP (the file's shared convention) — with an even count a
    // flipped v inverts the parity and swaps the two colors vs the shader.
    const uy = (1 - y) / 2;
    const fx = Math.floor(ux * count);
    const fy = Math.floor(uy * count);
    const m = (((fx + fy) % 2) + 2) % 2;
    return lerp3(A, B, m);
  },
  'circle':
  (x, y) => {
    // Pure UV space, so the tile IS the plane view: a true circle here, while
    // the sphere's equirectangular UV stretches it into a lobe (as the card
    // description says).
    const u = (x + 1) / 2;
    const v = (1 - y) / 2;
    const field = Math.hypot(u - 0.5, v - 0.5);
    const soft = Math.max(0.04, 0.001); // discSoftness, guarded as the preset does
    const disc = 1 - smoothstep(0.32, 0.32 + soft, field); // discRadius = 0.32
    const back: [number, number, number] = [0.078, 0.125, 0.227]; // 0x14203A
    const disc0: [number, number, number] = [1.0, 0.784, 0.271]; // 0xFFC845
    return lerp3(back, disc0, clamp01(disc));
  },
  'edge-glow':
  (x: number, y: number): [number, number, number] => {
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.01, 0.02, 0.04];
    const nz = Math.sqrt(1 - r2); // ndv: normal=(x,-y,nz), viewDir=(0,0,1)
    const inv = 1 - clamp01(nz);
    const rim = Math.pow(inv, 3) * 2; // glowPower=3, intensity=2
    const base: [number, number, number] = [0.051, 0.106, 0.165]; // 0x0D1B2A
    const glow: [number, number, number] = [0, 0.898, 1]; // 0x00E5FF
    return [
      clamp01(base[0] + glow[0] * rim),
      clamp01(base[1] + glow[1] * rim),
      clamp01(base[2] + glow[2] * rim),
    ];
  },
  'pulse':
  (x: number, y: number): [number, number, number] => {
    // Spatially uniform pulse — freeze time at t = 0.26 (pulseSpeed = 2), a
    // mid-swing instant: k ≈ 0.75 shows BOTH colors (t = 0.6 froze at k ≈ 0.97,
    // rendering the card as a flat pulseColor swatch with no trace of rest).
    const t = 0.26;
    const s = Math.sin(t * 2); // ~0.497
    const k = clamp01(s * 0.5 + 0.5); // ~0.75, visibly mid-pulse
    const rest: [number, number, number] = [0x31 / 255, 0x1b / 255, 0x92 / 255];
    const pulse: [number, number, number] = [0xff / 255, 0xea / 255, 0x00 / 255];
    return lerp3(rest, pulse, k);
  },
  'uv-scroll':
  (x, y) => {
    const t = 0.6;
    const scrollSpeed = 0.3;
    const colorA: [number, number, number] = [0 / 255, 77 / 255, 64 / 255];
    const colorB: [number, number, number] = [167 / 255, 255 / 255, 235 / 255];
    const ux = (x + 1) / 2;
    const off = t * scrollSpeed;
    const fx = (ux + off) % 1;
    return lerp3(colorA, colorB, clamp01(fx));
  },
  'color-ramp':
  (x, y) => {
    const t = (x + 1) / 2;
    const base = 127 / 255;
    const amp = 127 / 255;
    const r = clamp01(base + amp * Math.cos(6.2832 * t));
    const g = clamp01(base + amp * Math.cos(6.2832 * (t + 0.33)));
    const b = clamp01(base + amp * Math.cos(6.2832 * (t + 0.67)));
    return [r, g, b];
  },
  'hue-shift':
  (x, y) => {
    // The base 0x8E6FD8 in HSL — computed once rather than converted per pixel,
    // since the preset only ever shifts its HUE. s is pre-multiplied by the
    // hueBoost of 1.3 and clamped, exactly as the graph's Clamp does.
    const h0 = 0.7159, s0 = 0.7459, l0 = 0.6412;
    const v = (1 - y) / 2;
    // Frozen at t = 2 (hueSpeed 0.15): puts the red-to-green quarter of the
    // wheel on the tile. Lightness is constant by construction, so this reads
    // as a band of hue and not as a light ramp.
    const turned = (h0 + v * 0.35 + 2.0 * 0.15) % 1; // hueSpread = 0.35
    const [r, g, b] = hsl2rgb(turned, s0, l0);
    return [clamp01(r), clamp01(g), clamp01(b)];
  },
  'noise-mask':
  (x: number, y: number): [number, number, number] => {
    const n = perlin2D(x * 3, y * 3);
    // Preset remaps noise to 0..1 and thresholds at 0.5 ± 0.2. ×0.33 tames
    // perlin2D's real ~±1.5 spread (its "roughly [-1,1]" doc undersells the
    // gradient overshoot) so thresholds stay comparable to the GPU's
    // mx_noise_float — the file-wide convention (dissolve does the same).
    const k = clamp01(smoothstep(0.3, 0.7, clamp01(n * 0.33 + 0.5)));
    const colorA: [number, number, number] = [0.106, 0.369, 0.125];
    const colorB: [number, number, number] = [1.0, 0.976, 0.769];
    return lerp3(colorA, colorB, k);
  },
  'mosaic':
  (x: number, y: number): [number, number, number] => {
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.06, 0.07, 0.10];
    const nz = Math.sqrt(1 - r2);
    // mosaicScale 7 x the sphere's 0.8 radius, then x0.62 for the tile: at the
    // authored scale the facets fall to a few pixels each and read as static
    // rather than as cells (the tile-scale adjustment dissolve/noise-mask make).
    const S = 7 * 0.8 * 0.62;
    const id = cellHash(Math.floor(x * S), Math.floor(-y * S), Math.floor(nz * S));
    const a: [number, number, number] = [0.043, 0.235, 0.365]; // 0x0B3C5D
    const b: [number, number, number] = [0.949, 0.757, 0.306]; // 0xF2C14E
    return lerp3(a, b, clamp01(Math.pow(id, 1.6))); // mosaicContrast = 1.6
  },
  'toon-ramp':
  (x: number, y: number): [number, number, number] => {
    const shadow: [number, number, number] = [74 / 255, 20 / 255, 140 / 255];
    const lit: [number, number, number] = [255 / 255, 224 / 255, 130 / 255];
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.12, 0.11, 0.16];
    const nz = Math.sqrt(1 - r2);
    const len = Math.sqrt(0.5 * 0.5 + 0.8 * 0.8 + 0.4 * 0.4);
    const nl = (x * 0.5 - y * 0.8 + nz * 0.4) / len;
    const k = clamp01(nl * 0.5 + 0.5);
    // floor(k*steps)/(steps−1), matching the preset — ÷steps would cap the
    // brightest band at 2/3 and never show litColor.
    const kq = Math.min(Math.floor(k * 3) / 2, 1);
    return lerp3(shadow, lit, kq);
  },
  'vertex-wave':
  (x: number, y: number): [number, number, number] => {
    // Displaced-sphere SILHOUETTE: the rim ripples by the same phase the
    // shader displaces vertices with (amp·sin(pos.y·freq − t·speed), t = 0.6),
    // so the card depicts displacement itself, not a painted stripe pattern.
    const waveFrequency = 8;
    const waveSpeed = 2;
    const waveAmplitude = 0.08;
    const t = 0.6;
    const phase = -y * 0.8 * waveFrequency - t * waveSpeed; // pos.y = −y·0.8 (y=−1 top)
    const ripple = waveAmplitude * Math.sin(phase);
    const R = 0.8 + ripple;
    const r = Math.sqrt(x * x + y * y);
    if (r > R) return [0.12, 0.13, 0.17];
    const q = r / R;
    const nz = Math.sqrt(Math.max(0, 1 - q * q));
    // sphere shading + a faint swell-band in the same phase, so the wave
    // reads across the body and not just at the rim
    const swell = 0.5 + 0.5 * Math.sin(phase);
    const g = clamp01(0.3 + 0.55 * nz + 0.15 * swell);
    return [g, g, clamp01(g * 1.06)];
  },
  'noise-blob':
  (x: number, y: number): [number, number, number] => {
    // Displacement, like vertex-wave — so the tile draws the SILHOUETTE the
    // displacement produces, not a painted pattern. Here the radius is
    // perturbed by noise rather than by a travelling sine.
    const drift = 0.6 * 0.4; // t = 0.6, blobSpeed = 0.4
    // x0.33 tames perlin2D's real ~±1.5 spread to mx_noise_float's ~±1 (the
    // file-wide convention); the noise stays SIGNED, so lumps dent and bulge.
    const nAt = (ax: number, ay: number) =>
      perlin2D(ax * 0.8 * 2.4 + drift, ay * 0.8 * 2.4 + drift) * 0.33;
    const r = Math.hypot(x, y);
    const dx = r > 1e-4 ? x / r : 0;
    const dy = r > 1e-4 ? y / r : 0;
    const R = 0.8 + nAt(dx, dy) * 0.28; // blobAmount = 0.28
    if (r > R) return [0.12, 0.13, 0.17];
    const q = r / R;
    const nz = Math.sqrt(Math.max(0, 1 - q * q));
    const g = clamp01(0.3 + 0.55 * nz + 0.55 * nAt(x, y));
    return [clamp01(g * 1.04), clamp01(g * 0.96), clamp01(g * 0.88)];
  },
  'top-cover':
  (x: number, y: number): [number, number, number] => {
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.09, 0.08, 0.08];
    // Sphere normal at this pixel: (x, -y, nz); y = -1 is the top row, so n.y = -y.
    const ny = -y;
    const base: [number, number, number] = [0.365, 0.251, 0.216];   // 0x5D4037
    const cover: [number, number, number] = [0.980, 0.980, 0.980];  // 0xFAFAFA
    // coverage 0.6 -> snow line 1−0.6 = 0.4, softness 0.2 -> smoothstep(0.2, 0.6, n.y)
    const k = clamp01(smoothstep(0.2, 0.6, ny));
    return lerp3(base, cover, k);
  },
  'distance-fog':
  (x: number, y: number): [number, number, number] => {
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.10, 0.11, 0.12];
    const nz = Math.sqrt(1 - r2);
    // `behind` is the fragment's offset from the model centre ALONG the view,
    // negative toward the camera — which on the faked sphere is exactly
    // -nz * 0.8. fogNear = -0.8 (the nose) to fogFar = 0 (the centre plane).
    const behind = -nz * 0.8;
    const k = clamp01((behind + 0.8) / 0.8);
    const surface: [number, number, number] = [0.847, 0.263, 0.082]; // 0xD84315
    const fog: [number, number, number] = [0.690, 0.745, 0.773];     // 0xB0BEC5
    return lerp3(surface, fog, k);
  },
  'iridescence':
  (x: number, y: number): [number, number, number] => {
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.07, 0.07, 0.09];
    const nz = Math.sqrt(1 - r2);
    // viewDir = (0,0,1), so the fresnel term is just nz. iriSharpness = 0.7.
    const rim = Math.pow(1 - clamp01(nz), 0.7);
    const sweep = rim * 1.6; // iriSpread
    const base = [0.549, 0.549, 0.627]; // 0x8C8CA0
    const sheen = [0.451, 0.400, 0.502]; // 0x736680
    const ph = [0, 0.33, 0.67];
    // The rim drives the palette PHASE and then scales its amplitude, so the
    // head-on centre stays base colour and the bands crowd toward the edge.
    return [0, 1, 2].map((i) =>
      clamp01(base[i] + sheen[i] * Math.cos((ph[i] + sweep) * 6.2832) * rim),
    ) as [number, number, number];
  },
  'dissolve':
  (x, y) => {
    // ×0.8 maps the tile to the sphere's ±0.8 geometry domain; ×0.33 tames
    // perlin2D's ±1.5 spread (the file-wide convention — see noise-mask).
    const n = perlin2D(x * 4 * 0.8, y * 4 * 0.8);
    const n01 = clamp01(n * 0.33 + 0.5);
    const solid = smoothstep(0.45, 0.53, n01);
    const band = solid * (1 - solid) * 4;
    const body: [number, number, number] = [0.216, 0.278, 0.310];
    const edge: [number, number, number] = [1.0, 0.427, 0.0];
    return [
      clamp01(body[0] * solid + edge[0] * band),
      clamp01(body[1] * solid + edge[1] * band),
      clamp01(body[2] * solid + edge[2] * band),
    ];
  },
  'lava-crust':
  (x: number, y: number): [number, number, number] => {
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.05, 0.04, 0.04];
    // lavaScale 2.5 x the sphere's 0.8 radius, then x1.15 for the tile — the
    // crack network has to show a few whole loops at 128px, and the taming
    // factor is 0.62 rather than the file's usual 0.33 because what matters
    // here is the WIDTH of the zero contour, and perlin2D runs ~1.5x the
    // amplitude of the shader's mx_noise_float.
    const n = perlin2D(x * 2.5 * 0.8 * 1.15 + 0.072, y * 2.5 * 0.8 * 1.15 + 0.072) * 0.62;
    const ridge = Math.abs(n);
    const crust = smoothstep(0, 0.14, ridge); // lavaCrackWidth, tile-widened
    const heat = 1 - crust;
    const plate = 1 - ridge * 0.7;
    const rock: [number, number, number] = [0.227 * plate, 0.165 * plate, 0.133 * plate];
    const hot: [number, number, number] = [1.0, 0.353, 0.0]; // 0xFF5A00
    const surface = lerp3(rock, hot, heat);
    // Colour AND emissive, since that is what the user sees once both are wired.
    const hotAmt = heat * heat * 2;
    return [0, 1, 2].map((i) => clamp01(surface[i] + hot[i] * hotAmt)) as [number, number, number];
  },
  'hologram':
  (x: number, y: number): [number, number, number] => {
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.02, 0.03, 0.04];
    const nz = Math.sqrt(1 - r2);
    const rim = Math.pow(1 - clamp01(nz), 2);
    const py = -y * 0.8;
    const s = Math.sin(py * 40 + 0.6 * 5);
    const s01 = s * 0.5 + 0.5;
    const scanDim = s01 * 0.4;
    const lifted = rim + scanDim + 0.15;
    return [clamp01((0x18 / 255) * lifted), clamp01(lifted), clamp01(lifted)];
  },
  'teleport-beam':
  (x: number, y: number): [number, number, number] => {
    // Cut pixels return the BACKGROUND, so the bite reads as missing surface
    // rather than as a dark band.
    const bg: [number, number, number] = [0.06, 0.07, 0.08];
    const r2 = x * x + y * y;
    if (r2 > 1) return bg;
    const nz = Math.sqrt(1 - r2);
    const py = -y * 0.8; // world Y; y = -1 is the top row
    // Frozen at t = 1.93 (beamSpeed 0.35): the sweep sits in the upper third,
    // so most of the body survives to be bitten INTO.
    const center = ((1.93 * 0.35) % 1) * 2 - 1;
    const d = Math.abs(py - center);
    const span = 0.25; // beamHeight
    // beamDensity is 26 here, not the authored 60: at 128px the real density
    // puts a scanline period near Nyquist and the band moires into a smear.
    const radius = (Math.sin(py * 26) * 0.5 + 0.5) * span;
    if (d < radius) return bg;
    const heat = 1 - smoothstep(0, span, d);
    const body = lerp3([0.180, 0.247, 0.322], [0.251, 1.0, 0.784], heat);
    const glow: [number, number, number] = [0.251, 1.0, 0.784]; // 0x40FFC8
    const shade = 0.75 + 0.6 * nz;
    return [0, 1, 2].map((i) => clamp01(body[i] * shade + glow[i] * heat)) as [number, number, number];
  },
  'force-field':
  (x: number, y: number): [number, number, number] => {
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.02, 0.02, 0.05];
    const nz = Math.sqrt(1 - r2);
    const rim = (1 - nz) * (1 - nz);
    const u = 0.5 + Math.atan2(x, nz) / (2 * Math.PI);
    const v = 0.5 - Math.asin(-y) / Math.PI;
    const gx = u * 12;
    const dx = Math.abs(gx - Math.round(gx));
    const gy = v * 12;
    const dy = Math.abs(gy - Math.round(gy));
    const d = Math.min(dx, dy);
    const lines = 1 - smoothstep(0.03, 0.08, d);
    const p = 0.5 + (Math.sin(1.8) + 1) * 0.25;
    const k = (rim + lines * 0.5) * p;
    return [clamp01(0.486 * k), clamp01(0.302 * k), clamp01(k)];
  },
  'stylized-water':
  (x, y) => {
    // Mirrors the shader exactly (frozen at t = 0.6): warp the coordinate, then
    // three plane waves from one sin, then the "top two tie" cell-wall test.
    // The sphere is faked as in the other normal-based shades: nz = sqrt(1-x²-y²).
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.055, 0.075, 0.09];
    const nz = Math.sqrt(1 - r2);
    const R = 0.8, waterScale = 4, ts = 0.6 * 0.35;
    const s = [x * R * waterScale, y * R * waterScale, nz * R * waterScale];
    const wob = [Math.sin(s[0]), Math.sin(s[1]), Math.sin(s[2])];
    const fd = [1.7, 0.47, 0.75];
    const p = [
      s[0] + fd[0] * ts + wob[1],
      s[1] + fd[1] * ts + wob[2],
      s[2] + fd[2] * ts + wob[0],
    ];
    const cells = [2.41, 3.29, 2.87];
    const w = [
      Math.sin(p[0] * cells[0]),
      Math.sin(p[1] * cells[1]),
      Math.sin(p[2] * cells[2]),
    ];
    const hi = Math.max(w[0], w[1]);
    const lo = Math.min(w[0], w[1]);
    const tie = Math.max(hi, w[2]) - Math.max(lo, Math.min(hi, w[2]));
    const web = Math.max(tie * -4.4 + 1.5, 0);
    const glow = web * web;
    // viewDir = (0,0,1), so the world normal's facing term is just nz.
    const base = lerp3([0.004, 0.341, 0.608], [0.302, 0.816, 0.882], clamp01(nz * 0.55));
    const light = glow * 0.9;
    return [
      clamp01(base[0] + 0.75 * light),
      clamp01(base[1] + 0.95 * light),
      clamp01(base[2] + light),
    ];
  },
  'studio-shine':
  (x: number, y: number): [number, number, number] => {
    const r2 = x * x + y * y;
    if (r2 > 1) return [0.06, 0.07, 0.09];
    const nz = Math.sqrt(1 - r2);
    // In tile space the camera basis IS the tile axes: camRight = (1,0,0),
    // camUp = (0,1,0), viewDir = (0,0,1). So the three dot products against the
    // sphere normal (x, -y, nz) are just its components.
    const keyLit = clamp01(x * -0.36 + -y * 0.48 + nz * 0.8);
    const light = clamp01(
      keyLit * 0.7                          // shineKeyLevel
      + Math.pow(keyLit, 120)               // shineTightness
      + smoothstep(0.55, 1, 1 - nz) * 0.6,  // shineRimStrength
    );
    const base: [number, number, number] = [0.118, 0.141, 0.188]; // 0x1E2430
    const key: [number, number, number] = [1.0, 0.945, 0.835];    // 0xFFF1D5
    return lerp3(base, key, light);
  },
};

/** Flat tint fallback for a preset without a shade function (dev safety net). */
function fallbackShade(hex: string): Shade {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return () => [clamp01(r), clamp01(g), clamp01(b)];
}

export const PresetCard = memo(function PresetCard({ preset }: PresetCardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    renderPixels(ctx, PRESET_SHADES[preset.id] ?? fallbackShade(preset.color));
  }, [preset.id, preset.color]);

  const onDragStart = useCallback(
    (event: React.DragEvent) => {
      event.dataTransfer.setData(BUILTIN_PRESET_DRAG_TYPE, preset.id);
      event.dataTransfer.effectAllowed = 'move';
      // Record the payload for dragover (dataTransfer is unreadable there) so
      // the canvas can withhold the drop-on-edge highlight — a preset drop
      // never splices, and the preview must not promise one. Teardown rides
      // ContentBrowser's root onDragEnd (endHtml5TileDrag).
      setHtml5TileDrag({ kind: 'preset', id: preset.id });
    },
    [preset.id],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      const tile = event.currentTarget as HTMLElement;
      startTileDrag(
        event.nativeEvent,
        { kind: 'preset', id: preset.id },
        `<div class="saved-group-card saved-group-card--preview" style="zoom: ${tileGhostZoom(tile)}">${tile.innerHTML}</div>`,
      );
    },
    [preset.id],
  );

  // Counts SHADER nodes: drop the group container and the explainer note, so
  // the number matches what the user will actually be reading in the graph.
  const memberCount = preset.nodes.filter(
    (n) => n.type !== 'group' && n.type !== 'note',
  ).length;
  const { tooltip, tooltipHandlers } = useAssetTooltip(
    `${preset.description} Click, or drag onto the canvas, to add it.`,
  );

  return (
    <div
      className="saved-group-card saved-group-card--preview"
      draggable
      onDragStart={onDragStart}
      onPointerDown={onPointerDown}
      {...tileActivationProps({ kind: 'preset', id: preset.id }, `Add ${preset.name} preset`)}
      {...tooltipHandlers}
    >
      {tooltip}
      <AssetCostBadge cost={preset.totalCost} />
      <div
        className="saved-group-card__frame"
        style={{
          background: `${preset.color}1A`,
          borderColor: `${preset.color}66`,
        }}
      >
        <div
          className="saved-group-card__header"
          style={{ background: preset.color }}
        >
          <span className="saved-group-card__title">{preset.name}</span>
        </div>
        <div className="saved-group-card__body">
          <canvas
            ref={canvasRef}
            width={PREVIEW_SIZE}
            height={PREVIEW_SIZE}
            // Fills the card's content width — the tile is meant to be the
            // image, not a small swatch adrift in a large frame.
            style={{ width: '100%', height: 'auto', aspectRatio: '1 / 1', display: 'block', borderRadius: 0, imageRendering: 'auto' }}
          />
          <span className="saved-group-card__count" style={{ marginTop: 2 }}>
            {memberCount} {memberCount === 1 ? 'node' : 'nodes'}
          </span>
        </div>
      </div>
    </div>
  );
});
