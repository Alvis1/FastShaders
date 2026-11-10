/**
 * The Sine / Cosine "Map to 0…1" switch: the wave's raw −1…1 remapped to 0…1
 * (`sin(x).mul(0.5).add(0.5)`), the same remap the noise nodes' range flag
 * emits (utils/noiseRange.ts).
 *
 * The polarity is load-bearing, as it is there: an ABSENT key is the plain wave,
 * so every graph, preset and imported `.js` saved before the switch emits the
 * byte-identical line it always did, and nothing but a click ever sets it. The
 * key lives in `values` (never `defaultValues`, which on this card is the
 * socket list) as a NUMBER 1 — `ShaderNodeData['values']` has no booleans.
 */

/** The node types that carry the switch, and only those. */
const UNIT_RANGE_TYPES: ReadonlySet<string> = new Set(['sin', 'cos']);

/** True when this node TYPE can map its output to 0…1. */
export function hasUnitRangeFlag(type: string | undefined): boolean {
  return type !== undefined && UNIT_RANGE_TYPES.has(type);
}

/**
 * True when this node is in the 0…1 mode. An EXACT identity test, not a
 * coercion: `values` is adversarial and `Number(null)`, `Number('')` and
 * `Number([])` are all 0, which would flip a wave's range across a reload.
 * Every other stored form reads as the plain −1…1 wave.
 */
export function isUnitRange(
  type: string | undefined,
  values: Record<string, unknown> | undefined,
): boolean {
  if (!hasUnitRangeFlag(type)) return false;
  const v = values?.unit;
  return v === 1 || v === '1';
}

/** The wave a node of this mode draws and evaluates: `fn` raw, or `½ + ½·fn`. */
export function unitWave(fn: (x: number) => number, unit: boolean): (x: number) => number {
  return unit ? (x) => 0.5 + 0.5 * fn(x) : fn;
}
