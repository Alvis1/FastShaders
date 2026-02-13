import type { TSLDataType } from '@/types';

/**
 * Warm color palette matching screenshot:
 * - Low cost (0-2): light cream / pale (#F5E6C8)
 * - Medium cost (3-10): warm yellow (#F0D060)
 * - High cost (11-50): warm orange (#E8A040)
 * - Very high cost (50+): deep orange-red (#D06030)
 */
export function getCostColor(cost: number): string {
  if (cost <= 0) return '#F0F0F0';
  if (cost <= 2) return '#F5E6C8';
  if (cost <= 5) return '#F0D870';
  if (cost <= 10) return '#E8C040';
  if (cost <= 30) return '#E8A040';
  if (cost <= 50) return '#D88030';
  return '#C86030';
}

/**
 * Much more dramatic scaling to match the screenshot
 * where Noise (50pts) is ~3x the size of Color (2pts)
 */
export function getCostScale(cost: number): number {
  if (cost <= 2) return 1.0;
  if (cost >= 50) return 2.2;
  return 1.0 + ((cost - 2) / 48) * 1.2;
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
