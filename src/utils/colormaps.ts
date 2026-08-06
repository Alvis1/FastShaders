/**
 * Colormap lookup + LUT baking.
 *
 * The catalogue itself (and the reasoning behind which maps ship) lives in
 * `colormapData.ts`. This module is the pure, node-testable layer on top:
 * parse the hex anchor strings, sample them, bake the 256-entry GPU LUT, and
 * build the CSS gradient the node card / settings menu preview with.
 *
 * TWO COLOUR SPACES, deliberately kept apart:
 *   - `sampleColormapSrgb` returns sRGB, because that is what the upstream
 *     tables publish and what a CSS gradient or a 2-D canvas wants.
 *   - `buildColormapLut` returns LINEAR light, because the LUT is baked into a
 *     `DataTexture` the shader samples as raw data (no colour-space tag), and
 *     the renderer's working space is linear.
 * Mixing the two up is silent and looks merely "a bit off", so every function
 * here names its space.
 *
 * Every entry point treats its input as ADVERSARIAL — ids and stop strings can
 * arrive from a `.fastshader` file. An unknown id falls back to the default map
 * and a malformed anchor degrades to black rather than emitting NaN.
 */

import { COLORMAPS, type ColormapDef } from './colormapData';
import { srgbToLinear01 } from './colorUtils';

export type { ColormapDef, ColormapKind } from './colormapData';
export { COLORMAPS } from './colormapData';

/** Perceptually uniform, colour-vision-safe, and the community's default. */
export const DEFAULT_COLORMAP_ID = 'viridis';

/** Width of the baked GPU LUT. 256 is the resolution the upstream tables are
 *  published at, so a linear-filtered fetch reproduces them exactly. */
export const LUT_SIZE = 256;

const BY_ID = new Map(COLORMAPS.map((c) => [c.id, c]));

/** Resolve an id to a definition; anything unrecognized falls back to the
 *  default so a tampered or older project still renders. */
export function getColormap(id: unknown): ColormapDef {
  return BY_ID.get(String(id ?? '')) ?? BY_ID.get(DEFAULT_COLORMAP_ID)!;
}

/** Parsed anchors, flattened as sRGB triples. Memoized per definition — the
 *  node card re-renders on every drag frame and re-parsing 33 stops each time
 *  is pure waste. */
const anchorCache = new WeakMap<ColormapDef, Float32Array>();

function anchorsOf(def: ColormapDef): Float32Array {
  const hit = anchorCache.get(def);
  if (hit) return hit;
  const parts = String(def.stops ?? '').split(',');
  const out = new Float32Array(parts.length * 3);
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i].trim();
    // A malformed anchor degrades to black instead of poisoning the ramp with
    // NaN, which would propagate through the LUT into the emitted module.
    const ok = /^[0-9a-fA-F]{6}$/.test(s);
    out[i * 3] = ok ? parseInt(s.slice(0, 2), 16) / 255 : 0;
    out[i * 3 + 1] = ok ? parseInt(s.slice(2, 4), 16) / 255 : 0;
    out[i * 3 + 2] = ok ? parseInt(s.slice(4, 6), 16) / 255 : 0;
  }
  anchorCache.set(def, out);
  return out;
}

/** Number of anchors in a map (exposed for tests / the drift guard). */
export function colormapStopCount(def: ColormapDef): number {
  return anchorsOf(def).length / 3;
}

/**
 * Sample a colormap at `t` ∈ [0, 1] (clamped), piecewise-linear between
 * anchors. Returns **sRGB** components in 0-1.
 */
export function sampleColormapSrgb(
  def: ColormapDef,
  t: number,
  reverse = false,
): [number, number, number] {
  const a = anchorsOf(def);
  const n = a.length / 3;
  if (n === 0) return [0, 0, 0];
  if (n === 1) return [a[0], a[1], a[2]];

  let u = Number.isFinite(t) ? t : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  if (reverse) u = 1 - u;

  const x = u * (n - 1);
  const lo = Math.min(n - 1, Math.floor(x));
  const hi = Math.min(n - 1, lo + 1);
  const f = x - lo;
  return [
    a[lo * 3] + (a[hi * 3] - a[lo * 3]) * f,
    a[lo * 3 + 1] + (a[hi * 3 + 1] - a[lo * 3 + 1]) * f,
    a[lo * 3 + 2] + (a[hi * 3 + 2] - a[lo * 3 + 2]) * f,
  ];
}

/**
 * Half-texel inset for sampling the baked LUT: the shader maps `t` ∈ [0,1] to
 * `t · LUT_COORD_SCALE + LUT_COORD_OFFSET`.
 *
 * A linear-filtered fetch at u reads texel-index position `u·N − 0.5`, so this
 * mapping puts t = 0 exactly on texel 0 and t = 1 exactly on texel N−1 — i.e.
 * the ramp's true endpoints, not a half-texel short of them. Without it the
 * first and last colours of every map are subtly wrong, which is the one thing
 * people check when they recognise a colormap.
 */
export const LUT_COORD_SCALE = (LUT_SIZE - 1) / LUT_SIZE;
export const LUT_COORD_OFFSET = 0.5 / LUT_SIZE;

/**
 * Bake the GPU lookup table: `LUT_SIZE` RGBA texels in **linear light**, alpha
 * pinned to 1. Texel i holds the ramp at i/(N−1), so the baked table IS the
 * upstream 256-entry table (modulo the linear→sRGB encoding) and can be
 * compared against it directly.
 *
 * `reverse` is folded in HERE rather than in the shader — flipping the baked
 * table is free, while a per-fragment `oneMinus` is not, and it keeps the
 * emitted TSL identical for both directions.
 */
export function buildColormapLut(def: ColormapDef, reverse = false): Float32Array {
  const out = new Float32Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const [r, g, b] = sampleColormapSrgb(def, i / (LUT_SIZE - 1), reverse);
    out[i * 4] = srgbToLinear01(r);
    out[i * 4 + 1] = srgbToLinear01(g);
    out[i * 4 + 2] = srgbToLinear01(b);
    out[i * 4 + 3] = 1;
  }
  return out;
}

/** `#rrggbb` for a colormap sample — the UI-facing form. */
export function colormapHexAt(def: ColormapDef, t: number, reverse = false): string {
  const rgb = sampleColormapSrgb(def, t, reverse);
  return (
    '#' +
    rgb
      .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * A CSS `linear-gradient(...)` preview of the map.
 *
 * `levels > 0` renders HARD BANDS at the same positions the shader quantizes
 * to — band i spans [i/N, (i+1)/N] and takes the colour at its CENTRE, matching
 * the `floor(t·N) + 0.5` the emitted TSL uses. The preview has to agree with the
 * render, or the discrete-levels control looks broken.
 */
export function colormapGradientCss(
  def: ColormapDef,
  reverse = false,
  levels = 0,
  angle = '90deg',
): string {
  const n = Math.floor(levels);
  if (n >= 2) {
    const stops: string[] = [];
    for (let i = 0; i < n; i++) {
      const hex = colormapHexAt(def, (i + 0.5) / n, reverse);
      stops.push(`${hex} ${((i / n) * 100).toFixed(3)}%`);
      stops.push(`${hex} ${(((i + 1) / n) * 100).toFixed(3)}%`);
    }
    return `linear-gradient(${angle}, ${stops.join(', ')})`;
  }
  // Continuous: one CSS stop per anchor. Browsers interpolate in sRGB by
  // default, which is the space the anchors are in — so the preview matches
  // `sampleColormapSrgb` exactly.
  const count = colormapStopCount(def);
  if (count < 2) return colormapHexAt(def, 0, reverse);
  const stops: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    stops.push(`${colormapHexAt(def, t, reverse)} ${(t * 100).toFixed(3)}%`);
  }
  return `linear-gradient(${angle}, ${stops.join(', ')})`;
}

/** Catalogue grouped for the picker, in the order the groups should be shown:
 *  the maps you should reach for first, then the ones with caveats. */
export const COLORMAP_GROUPS: { kind: ColormapDef['kind']; label: string; maps: ColormapDef[] }[] = [
  { kind: 'sequential', label: 'Sequential', maps: COLORMAPS.filter((c) => c.kind === 'sequential') },
  { kind: 'diverging', label: 'Diverging (zero-centred)', maps: COLORMAPS.filter((c) => c.kind === 'diverging') },
  { kind: 'isoluminant', label: 'Isoluminant (for lit 3D)', maps: COLORMAPS.filter((c) => c.kind === 'isoluminant') },
  { kind: 'rainbow', label: 'Rainbow', maps: COLORMAPS.filter((c) => c.kind === 'rainbow') },
];
