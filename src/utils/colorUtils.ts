import type { TSLDataType } from '@/types';

export function getCostColor(cost: number): string {
  const t = Math.min(cost / 60, 1);

  if (t < 0.5) {
    const r = Math.round(76 + (255 - 76) * (t * 2));
    const g = Math.round(175 + (193 - 175) * (t * 2));
    const b = Math.round(80 - 80 * (t * 2));
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    const tt = (t - 0.5) * 2;
    const r = 255;
    const g = Math.round(193 - 193 * tt);
    const b = Math.round(7 + (34 - 7) * tt);
    return `rgb(${r}, ${g}, ${b})`;
  }
}

export function getCostScale(cost: number): number {
  if (cost <= 2) return 1.0;
  if (cost >= 50) return 1.6;
  return 1.0 + ((cost - 2) / 48) * 0.6;
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
