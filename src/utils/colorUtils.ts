import type { TSLDataType } from '@/types';

// Matches the CostBar gradient: green → amber → red
const LOW: [number, number, number] = [0x8b, 0xc3, 0x4a];  // #8BC34A
const MED: [number, number, number] = [0xff, 0xc1, 0x07];  // #FFC107
const HIGH: [number, number, number] = [0xff, 0x57, 0x22];  // #FF5722

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

export function hexToRgb01(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

export function getCostColor(cost: number): string {
  if (cost <= 0) return '#EBEBEB';
  const t = Math.min(cost / 80, 1);
  const [from, to] = t < 0.5 ? [LOW, MED] : [MED, HIGH];
  const u = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  // Blend with white at 55% to lighten
  const r = lerp(from[0], to[0], u) * 0.45 + 255 * 0.55;
  const g = lerp(from[1], to[1], u) * 0.45 + 255 * 0.55;
  const b = lerp(from[2], to[2], u) * 0.45 + 255 * 0.55;
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
