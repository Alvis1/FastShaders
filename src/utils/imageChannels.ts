/**
 * The Texture (Image) node's CHANNEL sockets — the ONE table.
 *
 * Besides `out` (Color, vec3, always `outputs[0]`), the node offers Alpha, R,
 * G and B. All four are SWIZZLES of the node's ONE `texture()` sample — the
 * toHsl shape — never four samples: TSL does not merge TextureNodes, so every
 * extra sample would cost a real texture fetch.
 *
 * A LEAF that imports nothing (the costTable lesson): graphToCode, cpuEvaluator
 * and NodeEditor all read it, and it must never sit inside the store's import
 * cycle, where evaluating across the cycle during initialisation throws a TDZ
 * ReferenceError that depends on which module a vitest worker reached first.
 *
 * Every table is a `Map`, never a plain object: `sourceHandle` arrives out of
 * `.fastshader` files, and a plain-object lookup resolves `constructor` /
 * `__proto__` / `toString` to truthy values (the VALID_SWIZZLE/TOHSL_* trap).
 */

export type ImageChannelComponent = 'r' | 'g' | 'b' | 'a';

/** socket id → the swizzle graphToCode emits on the wide sample. Insertion
 *  order is the registry's output order after `out`: alpha, r, g, b. */
export const IMAGE_CHANNEL_COMPONENTS: ReadonlyMap<string, ImageChannelComponent> = new Map<
  string,
  ImageChannelComponent
>([
  ['alpha', 'a'],
  ['r', 'r'],
  ['g', 'g'],
  ['b', 'b'],
]);

/** socket id → that channel's index in the sample's rgba vector (the CPU
 *  projection). MUST equal `'rgba'.indexOf(component)` for every socket, or
 *  the on-node label and the shader read different channels — pinned. */
export const IMAGE_CHANNEL_INDEX: ReadonlyMap<string, number> = new Map<string, number>([
  ['r', 0],
  ['g', 1],
  ['b', 2],
  ['alpha', 3],
]);

/** True only for the four channel sockets. `out`, null, undefined and every
 *  tampered id are false, so they carry the RGB triple. */
export function isImageChannelHandle(h: string | null | undefined): boolean {
  return typeof h === 'string' && IMAGE_CHANNEL_COMPONENTS.has(h);
}
