import type { TSLDataType, NodeCategory } from '@/types';

/**
 * One canonical `#rrggbb`, or null if the input is not exactly that.
 *
 * THE colour whitelist for this app, kept in one place on purpose. It is a
 * security control, not a formatting nicety: these strings are written into
 * `style.background` (so anything else is CSS injection), persisted to `fs:*`
 * keys and shared `.fastshader` files, and colours ultimately reach generated
 * shader code through `hexLiteral`, which applies this same
 * `/^#[0-9a-f]{6}$/` rule. `safeJsonReviver` is the precedent — a control that
 * used to live in three files and had to be corrected in three files.
 *
 * Lower-cased so `#FF0000` and `#ff0000` are one colour rather than two
 * entries in a recents list or a palette. Deliberately does NOT expand `#abc`
 * shorthand and does NOT accept 8-digit alpha — the same refusal
 * `utils/drawings.ts` documents, since an alpha channel would slip past the
 * opacity isolation the renderer relies on.
 */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : null;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

export function hexToRgb01(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

/**
 * sRGB-encoded channel (0-1) → linear-light. The IEC 61966-2-1 transfer
 * function — the same conversion `THREE.Color` applies when it reads a hex
 * (ColorManagement has been on by default since r152), which is why `color(0x…)`
 * and a bare `vec3(r/255, …)` are NOT the same colour in a shader.
 *
 * Anything that bakes picked colours into GPU data (the colormap LUT) must run
 * them through here first. Interpolating sRGB-encoded values as if they were
 * linear is exactly the error that destroys the perceptual uniformity a
 * scientific colormap exists to provide.
 */
export function srgbToLinear01(c: number): number {
  if (!Number.isFinite(c)) return 0;
  const v = c < 0 ? 0 : c > 1 ? 1 : c;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * Pick a foreground color (black or white) that contrasts with `bgHex`.
 * Uses perceived luminance (Rec. 601). Defaults to black for light backgrounds,
 * white for dark — same heuristic the cost badge and 1-channel edge color use
 * to flip themselves when the canvas background changes.
 */
export function getContrastColor(bgHex: string): '#000000' | '#ffffff' {
  // Be lenient on input — anything other than a 7-char #rrggbb falls back to dark assumption.
  if (typeof bgHex !== 'string' || bgHex.length !== 7 || !bgHex.startsWith('#')) {
    return '#000000';
  }
  const [r, g, b] = hexToRgb(bgHex);
  // Rec. 601 luminance — cheap, perceptually OK, no gamma correction needed for a binary flip.
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#000000' : '#ffffff';
}

/** Interpolate between low and high color poles based on cost. */
function costLerp(
  cost: number,
  low: [number, number, number],
  high: [number, number, number],
): [number, number, number] {
  const t = Math.min(cost / 80, 1);
  return [
    lerp(low[0], high[0], t),
    lerp(low[1], high[1], t),
    lerp(low[2], high[2], t),
  ];
}

/** Node background color — lightened blend with white. */
export function getCostColor(
  cost: number,
  lowHex = '#8BC34A',
  highHex = '#FF5722',
): string {
  if (cost <= 0) return '#EBEBEB';
  const low = hexToRgb(lowHex);
  const high = hexToRgb(highHex);
  const [r, g, b] = costLerp(cost, low, high);
  // Blend with white at 55% to lighten for node backgrounds
  return rgbToHex(r * 0.45 + 255 * 0.55, g * 0.45 + 255 * 0.55, b * 0.45 + 255 * 0.55);
}

/** Badge text color — full saturation, no lightening. */
export function getCostTextColor(
  cost: number,
  lowHex = '#8BC34A',
  highHex = '#FF5722',
): string {
  if (cost <= 0) return '#999999';
  const low = hexToRgb(lowHex);
  const high = hexToRgb(highHex);
  const [r, g, b] = costLerp(cost, low, high);
  return rgbToHex(r, g, b);
}

export function getCostScale(cost: number): number {
  if (cost <= 0) return 1;
  return 1 + Math.min(cost / 80, 1) * 0.35;
}

/** Default group color — used when a group carries no (or an invalid) color. */
const GROUP_DEFAULT_COLOR = '#6366f1';
/** How much group color goes into the body fill / the resting border. */
const GROUP_FILL_MIX = 0.18;
const GROUP_BORDER_MIX = 0.45;
/**
 * The base the group tints mix FROM: `--node-bg` in tokens.css, duplicated here
 * because the tests run under `node` with no CSSOM to read the variable from.
 * MUST track that token — a group frame is the backdrop panel BEHIND its member
 * cards, so mixing from a brighter base than the cards inverts the depth
 * ordering and the frame reads as floating on top of its own contents.
 */
const NODE_WHITE: [number, number, number] = [0xf1, 0xf2, 0xf3];

/**
 * Opaque frame colors for a group (canvas frame + Saved Groups tile).
 *
 * Group frames are FILLED, never translucent: the canvas background is
 * user-pickable, so an alpha tint would drag every group's color along with it
 * — washing out to near-nothing on a dark canvas. Mixing into white instead
 * keeps a group's color identical on any backdrop and in either theme, the
 * same rule the node cards it holds already follow (`--node-bg`). A selected
 * frame keeps the full-strength border.
 */
export function getGroupFrameColors(
  hex: string,
  selected = false,
): { background: string; borderColor: string } {
  const base = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : GROUP_DEFAULT_COLOR;
  const [r, g, b] = hexToRgb(base);
  const [wr, wg, wb] = NODE_WHITE;
  const mix = (t: number) => rgbToHex(lerp(wr, r, t), lerp(wg, g, t), lerp(wb, b, t));
  return {
    background: mix(GROUP_FILL_MIX),
    borderColor: selected ? base : mix(GROUP_BORDER_MIX),
  };
}

/**
 * Raw hex colors per category — the single source of truth. Also powers the
 * `--cat-*` CSS variables that OutputNode.css and friends reference; see the
 * `publishCategoryVars` call at the bottom of this module.
 *
 * `saved` is a pseudo-category for the Saved Groups library (no registry entry).
 */
export const CAT_HEX: Record<NodeCategory | 'saved', string> = {
  input: '#4CAF50',
  type: '#2196F3',
  arithmetic: '#FF9800',
  math: '#9C27B0',
  interpolation: '#00BCD4',
  logic: '#7E57C2',
  vector: '#E91E63',
  noise: '#795548',
  dataviz: '#FF5722',
  texture: '#8D6E63',
  presets: '#009688',
  unknown: '#9E9E9E',
  output: '#f44336',
  saved: '#6366f1',
};

export const CATEGORY_COLORS: Record<NodeCategory, string> = {
  input: 'var(--cat-input)',
  type: 'var(--cat-type)',
  arithmetic: 'var(--cat-arithmetic)',
  math: 'var(--cat-math)',
  interpolation: 'var(--cat-interpolation)',
  logic: 'var(--cat-logic)',
  vector: 'var(--cat-vector)',
  noise: 'var(--cat-noise)',
  dataviz: 'var(--cat-dataviz)',
  texture: 'var(--cat-texture)',
  presets: 'var(--cat-presets)',
  unknown: 'var(--cat-unknown)',
  output: 'var(--cat-output)',
};

// Publish CAT_HEX as CSS variables on :root so CSS files and CATEGORY_COLORS
// (var() lookups) resolve to the same hex values. Runs once at module load,
// which happens before any React component mounts.
if (typeof document !== 'undefined') {
  const style = document.documentElement.style;
  for (const [cat, hex] of Object.entries(CAT_HEX)) {
    style.setProperty(`--cat-${cat}`, hex);
  }
}

const TYPE_COLORS: Record<TSLDataType, string> = {
  float: 'var(--type-float)',
  int: 'var(--type-int)',
  vec2: 'var(--type-vec2)',
  vec3: 'var(--type-vec3)',
  vec4: 'var(--type-vec4)',
  color: 'var(--type-color)',
  any: 'var(--type-any)',
};

export function getTypeColor(dataType: TSLDataType): string {
  return TYPE_COLORS[dataType] || TYPE_COLORS.any;
}

/** Per-channel edge colors keyed by channel count (saturated). */
export const COUNT_EDGE_COLORS: Record<number, string[]> = {
  1: ['#000000'],
  2: ['#ff4444', '#44dd44'],
  3: ['#ff4444', '#44dd44', '#4488ff'],
  4: ['#ff4444', '#44dd44', '#4488ff', '#dddddd'],
};

/** Per-channel info-card colors keyed by channel count (lighter). */
export const COUNT_CARD_COLORS: Record<number, string[]> = {
  1: ['#ffffff'],
  2: ['#ff6666', '#66dd66'],
  3: ['#ff6666', '#66dd66', '#6699ff'],
  4: ['#ff6666', '#66dd66', '#6699ff', '#dddddd'],
};

/** Channel labels keyed by channel count (single-channel has no label). */
export const COUNT_LABELS: Record<number, string[]> = {
  1: [''],
  2: ['R', 'G'],
  3: ['R', 'G', 'B'],
  4: ['R', 'G', 'B', 'A'],
};
