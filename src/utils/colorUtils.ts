import type { TSLDataType } from '@/types';

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

/** Per-channel colors for edge lines (saturated). */
export const EDGE_CHANNEL_COLORS: Record<TSLDataType, string[]> = {
  float: [],
  int: [],
  any: [],
  vec2: ['#ff4444', '#44dd44'],
  vec3: ['#ff4444', '#44dd44', '#4488ff'],
  color: ['#ff4444', '#44dd44', '#4488ff'],
  vec4: ['#ff4444', '#44dd44', '#4488ff', '#dddddd'],
};

/** Per-channel colors for info cards (lighter). */
export const CARD_CHANNEL_COLORS: Record<TSLDataType, string[]> = {
  float: [],
  int: [],
  any: [],
  vec2: ['#ff6666', '#66dd66'],
  vec3: ['#ff6666', '#66dd66', '#6699ff'],
  color: ['#ff6666', '#66dd66', '#6699ff'],
  vec4: ['#ff6666', '#66dd66', '#6699ff', '#dddddd'],
};

/** Channel labels per data type. */
export const CHANNEL_LABELS: Record<TSLDataType, string[]> = {
  float: [''],
  int: [''],
  any: [''],
  vec2: ['X', 'Y'],
  vec3: ['X', 'Y', 'Z'],
  color: ['R', 'G', 'B'],
  vec4: ['X', 'Y', 'Z', 'W'],
};

/** Number of visual lines per data type. */
export const LINE_COUNT: Record<TSLDataType, number> = {
  float: 1,
  int: 1,
  any: 1,
  vec2: 2,
  vec3: 3,
  color: 3,
  vec4: 4,
};
