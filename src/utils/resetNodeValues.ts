import type { NodeDefinition } from '@/types';

/**
 * "Reset values to default" for a single node.
 *
 * The reset target is the REGISTRY defaults, not what `initialNodeValues` would
 * produce for a brand-new node: that path assigns a fresh auto-name and rolls a
 * palette colour, so using it here would silently rename a property node's
 * uniform (breaking the preview binding and the exported schema) and repaint a
 * swatch the user chose. Reset restores settings; it must not change identity.
 *
 * Two rules do the work:
 *
 *  1. **Start from `def.defaultValues`.** Anything the registry declares comes
 *     back at its declared value.
 *  2. **Drop every other key.** Several nodes keep settings ONLY in `values`
 *     with a code-gen fallback (`nv.radial ?? 0`, `nv.mode ?? 'minmax'`,
 *     `getColormap(undefined)` → viridis, the Image node's `repeat`/`flipX`/
 *     `colorSpace`). Deleting the key IS the reset for those — the emitter's
 *     documented fallback is the default.
 *
 * …except for keys that are not settings at all. `PRESERVED_KEYS` lists the
 * payload and identity a reset must never touch: a Data node's CSV blob, an
 * Image node's picture, an Unknown node's captured expression, and the uniform
 * NAME of a property node. Dropping any of those does not restore a default, it
 * destroys the node — a Data node without `dataB64` renders as an inert zero,
 * and a renamed uniform quietly detaches from every stored preview value.
 */

/** Per-type keys that survive a reset because they are payload, not settings. */
const PRESERVED_KEYS: Record<string, readonly string[]> = {
  // The CSV payload (makeDataNodeData) plus the display filename.
  dataNode: ['columnNames', 'rowCount', 'columnCount', 'dataB64', 'fileName'],
  // The picture, and the pre-snap original behind "Revert to original".
  imageNode: ['imageB64', 'fileName', 'originId', 'srcWidth', 'srcHeight'],
  // The verbatim TSL this node exists to round-trip.
  unknown: ['functionName', 'rawExpression'],
  // The noise range mode. Unlike a settings number, dropping this key does not
  // restore a neutral default — it changes what the node OUTPUTS, because an
  // absent key means the legacy signed ~[-1,1] range. Reset restores pos/scale;
  // it must not silently turn a 0-1 node back into a signed one.
  perlin: ['signed'],
  perlinVec3: ['signed'],
  fbm: ['signed'],
  fbmVec3: ['signed'],
};

/**
 * Keys preserved on EVERY node. `name` is a uniform's identifier — it appears
 * in the generated code, in the exported property schema, and in the
 * name-keyed persisted uniform values — so resetting it to the registry's
 * `property1` would both detach the stored tuning and risk colliding with
 * another property already called that.
 */
const PRESERVED_ALWAYS: readonly string[] = ['name'];

function preservedFor(registryType: string): readonly string[] {
  return [...PRESERVED_ALWAYS, ...(PRESERVED_KEYS[registryType] ?? [])];
}

/** The `values` a node should hold after "Reset values to default". */
export function resetNodeValues(
  def: NodeDefinition,
  current: Record<string, string | number>,
): Record<string, string | number> {
  const next: Record<string, string | number> = { ...def.defaultValues };
  for (const key of preservedFor(def.type)) {
    if (current[key] !== undefined) next[key] = current[key];
  }
  return next;
}

/**
 * Whether a reset would change anything.
 *
 * Compared as strings because the same setting legitimately arrives as either
 * type: the registry declares `value: 1.0` while a menu edit or an imported
 * project may store `"1"`. A strict compare would mark such a node dirty
 * forever and leave the button permanently enabled with nothing to do.
 */
export function isAtDefaultValues(
  def: NodeDefinition,
  current: Record<string, string | number>,
): boolean {
  const target = resetNodeValues(def, current);
  const keys = new Set([...Object.keys(target), ...Object.keys(current)]);
  for (const key of keys) {
    if (String(target[key] ?? '') !== String(current[key] ?? '')) return false;
  }
  return true;
}

/**
 * Whether the node has settings at all — i.e. whether the reset action is
 * meaningful enough to show. False for the many nodes that carry no values
 * (`add`, `uv`, `positionGeometry`), where a permanently-disabled row would be
 * pure clutter.
 */
export function hasResettableValues(
  def: NodeDefinition | undefined,
  current: Record<string, string | number>,
): boolean {
  if (!def) return false;
  if (Object.keys(def.defaultValues ?? {}).length > 0) return true;
  const preserved = new Set(preservedFor(def.type));
  return Object.keys(current).some((k) => !preserved.has(k));
}
