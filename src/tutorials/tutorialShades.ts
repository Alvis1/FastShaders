/**
 * The picture on a lesson tile: what the finished lesson looks like. A lesson
 * that builds a recipe shows that recipe's own thumbnail (PresetCard's shade,
 * so the Tutorials tile and the Presets tile are visibly the same thing); the
 * two recipe-less lessons carry their own, written in the same vocabulary
 * (x/y span [-1, 1], y = -1 the top row, a sphere faked by nz = sqrt(1-x²-y²)).
 */

import { clamp01, lerp3, smoothstep } from '@/components/NodeEditor/tilePreview';
import { presetShade, type Shade } from '@/components/NodeEditor/PresetCard';
import { perlin2D } from '@/utils/noisePreview';
import type { TutorialDef } from './tutorialTypes';

/** The tiles' dark backdrop behind a sphere (PresetCard's). */
const BACKDROP: [number, number, number] = [0.12, 0.13, 0.17];
const rgb = (hex: number): [number, number, number] =>
  [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

/** Perlin in the lessons' 0–1 range (PresetCard's `noise01` convention). */
const noise01 = (x: number, y: number, scale: number) =>
  clamp01(perlin2D(x * scale * 0.8, y * scale * 0.8) * 0.33 + 0.5);

/** One stable pseudo-random value per integer cell (deterministic: a tile must
 *  not change face between mounts). */
function hash2(ix: number, iy: number): number {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The sphere every lit lesson picture sits on: radius 0.8, null outside. */
function sphere(x: number, y: number): { nx: number; ny: number; nz: number } | null {
  const r2 = x * x + y * y;
  if (r2 > 0.64) return null;
  const nx = x / 0.8;
  const ny = -y / 0.8; // y = -1 is the TOP row, so the normal's Y flips
  return { nx, ny, nz: Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) };
}
const shadeLit = (c: [number, number, number], nz: number): [number, number, number] => {
  const lit = 0.45 + 0.55 * nz;
  return [c[0] * lit, c[1] * lit, c[2] * lit];
};

const OWN: Record<string, Shade> = {
  // Checkerboard: the UV square flat, 8 × 8, (column + row) mod 2.
  'tut-checker': (x, y) => {
    const c = Math.floor(((x + 1) / 2) * 8) + Math.floor(((1 - y) / 2) * 8);
    return c % 2 === 0 ? [0.08, 0.08, 0.08] : [0.95, 0.95, 0.95];
  },
  // Detail Costs: Voronoi's F1 — the distance to the nearest scattered point.
  'tut-costs': (x, y) => {
    const S = 4;
    const gx = (x + 1) * S;
    const gy = (y + 1) * S;
    let d = 9;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = Math.floor(gx) + i;
        const cy = Math.floor(gy) + j;
        const px = cx + hash2(cx, cy);
        const py = cy + hash2(cy * 7 + 3, cx * 13 + 5);
        d = Math.min(d, Math.hypot(gx - px, gy - py));
      }
    }
    const g = clamp01(d * 1.1);
    return [g, g, g];
  },
  // Which Space?: object X shown as grey on the sphere — black on the left half.
  'tut-space': (x, y) => {
    const n = sphere(x, y);
    if (!n) return BACKDROP;
    const g = clamp01(x / 0.8);
    return [g, g, g];
  },
  // Toon Shading: N·L with the lesson's light (0, 0.6, 0.8), cut into three bands.
  'tut-toon': (x, y) => {
    const n = sphere(x, y);
    if (!n) return BACKDROP;
    const ndl = n.ny * 0.6 + n.nz * 0.8;
    return ndl >= 0.75 ? rgb(0xc5cae9) : ndl >= 0.35 ? rgb(0x3949ab) : rgb(0x1a237e);
  },
  // Dissolve Edge: holes where the noise passes 0.6, an orange rim from 0.5.
  'tut-dissolve': (x, y) => {
    const n = sphere(x, y);
    if (!n) return BACKDROP;
    const v = noise01(x, y, 4);
    if (v > 0.6) return BACKDROP;
    if (v > 0.5) return [1, 0.43, 0];
    return shadeLit(rgb(0x37474f), n.nz);
  },
  // Hologram: thirty scan lines times the Fresnel rim, cyan on the dark backdrop.
  'tut-hologram': (x, y) => {
    const n = sphere(x, y);
    if (!n) return BACKDROP;
    const v = ((1 - y) / 2) * 30;
    const k = (v - Math.floor(v)) * (1 - n.nz);
    return lerp3(BACKDROP, [0.55, 0.95, 1], clamp01(k * 1.4));
  },
  // Exposed Parameter: grey clouds with a slider drawn across the lower part —
  // inside the band the tile shows, since the square paint is cropped to a
  // wide strip (TutorialCard.css, `object-fit: cover`).
  'tut-parameter': (x, y) => {
    if (y > 0.36 && y < 0.46 && x > -0.75 && x < 0.75) {
      return Math.abs(x - 0.15) < 0.07 ? [0.4, 0.7, 1] : [0.62, 0.65, 0.7];
    }
    if (y > 0.26) return BACKDROP;
    const g = noise01(x, y, 4);
    return [g, g, g];
  },
  // Circle: the UV square seen flat (the lesson tells the user to pick the
  // Plane model) — a black disc of radius 0.3 about (0.5, 0.5), its border the
  // lesson's Smoothstep(0.30, 0.32).
  'tut-circle': (x, y) => {
    const u = (x + 1) / 2 - 0.5;
    const v = (y + 1) / 2 - 0.5;
    const k = smoothstep(0.3, 0.32, Math.hypot(u, v));
    return [k, k, k];
  },
  // Shiny or Dull: a grey metal ball — a dim diffuse term, a sky-to-floor
  // reflection and one sharp highlight (Roughness 0.1, Metalness 1).
  'tut-material': (x, y) => {
    const r2 = x * x + y * y;
    if (r2 > 0.64) return BACKDROP;
    const nx = x / 0.8;
    const ny = y / 0.8;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const lx = -0.5, ly = -0.6, lz = 0.62;
    const ndl = clamp01(nx * lx + ny * ly + nz * lz);
    const hl = Math.hypot(lx, ly, lz + 1);
    const ndh = clamp01((nx * lx + ny * ly + nz * (lz + 1)) / hl);
    const spec = Math.pow(ndh, 60);
    const base = rgb(0xb0bec5);
    const sky = lerp3(BACKDROP, [0.78, 0.82, 0.86], clamp01(0.5 - ny * 0.6));
    const c: [number, number, number] = [
      base[0] * (0.12 + 0.3 * ndl) + base[0] * sky[0] * 0.75,
      base[1] * (0.12 + 0.3 * ndl) + base[1] * sky[1] * 0.75,
      base[2] * (0.12 + 0.3 * ndl) + base[2] * sky[2] * 0.75,
    ];
    return [clamp01(c[0] + spec), clamp01(c[1] + spec), clamp01(c[2] + spec)];
  },
};

/** The lesson's picture, never undefined: its recipe's thumbnail, its own, or a flat tint. */
export function tutorialShade(def: TutorialDef): Shade {
  return (def.recipeId ? presetShade(def.recipeId) : undefined) ?? OWN[def.id] ?? (() => [0.38, 0.49, 0.55]);
}

/** Does the lesson have a real picture (not the flat tint)? `tutorialDefs.test.ts` holds every lesson to it. */
export function hasTutorialShade(def: TutorialDef): boolean {
  return !!((def.recipeId && presetShade(def.recipeId)) || OWN[def.id]);
}
