/**
 * The noise range flag: which noise nodes can be remapped to 0–1, and how the
 * stored value is read.
 *
 * MaterialX's Perlin family is signed ~[-1,1]. That surprises people in two
 * specific ways: `round(noise)` returns -1/0/+1 rather than 0/1, and the Output
 * node's Discard culls on ANY non-zero, so BOTH tails cull and only a thin band
 * survives. Nodes the user adds from now on therefore default to 0–1.
 *
 * The polarity is load-bearing. A node with NO stored key means SIGNED, so every
 * graph saved before this existed — plus every noise member of the built-in
 * textures and presets, plus any re-imported `.js` — keeps emitting the exact
 * byte-identical line it emits today. Only `newNodeValues` (the one shared path
 * for a USER-added node) stamps the flag, which is why nothing authored,
 * imported or parsed inherits the new default.
 *
 * `cellNoise` and the three voronoi types are ALREADY [0,1] (cell noise, worley
 * distances), so they must never carry the flag: a remap there would halve a
 * range that was already correct.
 */

/** The noise types whose raw MaterialX output is signed, and only those. */
export const SIGNED_NOISE_TYPES: ReadonlySet<string> = new Set([
  'perlin', 'perlinVec3', 'fbm', 'fbmVec3',
]);

/** True when this node TYPE has a range worth flagging. */
export function hasNoiseRangeFlag(type: string | undefined): boolean {
  return type !== undefined && SIGNED_NOISE_TYPES.has(type);
}

/**
 * True when this node is in the remapped 0–1 mode.
 *
 * Deliberately an EXACT identity test, not `Number(v) < 0.5`. `values` is
 * adversarial — it rides `.fastshader` files, the project embed and
 * localStorage — and `Number()` maps `null`, `false`, `''`, `' '`, `[]`, `[0]`
 * and `0.4` all to 0, i.e. all to "unsigned". `null` is the one that bites with
 * no tampering at all: a non-finite written to values comes back from the
 * `fs:graph` autosave as `null` (JSON.stringify), so a coercing read would
 * silently change a shader's appearance across a page reload. Every rejected
 * form falls back to SIGNED, which is the legacy path and therefore
 * byte-identical.
 *
 * Stored as a NUMBER 0/1 rather than a boolean because `ShaderNodeData['values']`
 * is `Record<string, string | number>` — the same 0/1 convention the Image and
 * Stripes settings already use.
 */
export function isUnsignedNoise(
  type: string | undefined,
  values: Record<string, unknown> | undefined,
): boolean {
  if (!hasNoiseRangeFlag(type)) return false;
  const v = values?.signed;
  return v === 0 || v === '0';
}
