/**
 * 1 / 2 / 3 + click on the empty canvas drops a Float / Vec2 / Vec3 at the
 * click (Unreal's constant keys; owner, 2026-11-16). NodeEditor's bare canvas
 * keys arm it on keydown (behind the same guards as A, F and Space) and
 * disarm it on keyup and window blur; its pane click places the node.
 *
 * Read by the key's PLACE (`code`, the digit row or the number pad) as well
 * as by its character, so a layout that types digits with Shift (AZERTY)
 * still arms it. Pure: no DOM, no store.
 */

/** The node type each constant key drops — registry ids. */
export const CONSTANT_KEY_TYPES: Readonly<Record<string, string>> = {
  '1': 'float',
  '2': 'vec2',
  '3': 'vec3',
};

const CODE_DIGIT = /^(?:Digit|Numpad)([123])$/;

/** The node type a key event's key drops, or null when it is not one of them. */
export function constantKeyType(e: { key?: string; code?: string }): string | null {
  const byCode = typeof e.code === 'string' ? CODE_DIGIT.exec(e.code)?.[1] : undefined;
  const digit = byCode ?? (typeof e.key === 'string' ? e.key : '');
  return Object.prototype.hasOwnProperty.call(CONSTANT_KEY_TYPES, digit) ? CONSTANT_KEY_TYPES[digit] : null;
}
