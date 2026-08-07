import type { AppNode } from '@/types';
import { getNodeValues } from '@/types';
import { sanitizeIdentifier } from '@/utils/nameUtils';

/**
 * Does the 3D preview's uniform value still agree with the graph, and what
 * should an authoring edit do about it?
 *
 * The trap this closes: the preview persisted tuned values BY NAME and
 * re-pushed the whole map on every `fs:preview-ready`, so a value tuned once —
 * or merely SEEDED once, which used to happen the first time a uniform was
 * SEEN — outranked the number printed on the property node forever. Editing
 * the node had no visible effect. On a binary channel like Discard that reads
 * as the app being broken.
 *
 * Two rules, both here so both are testable without a browser:
 *   1. An override is DERIVED (stored ≠ authored), never remembered. A stored
 *      baseline would need a second persisted map, a FASTSHADERS_PROJECT_V1
 *      field and a migration — and it would still be wrong, because "the
 *      literal for this NAME moved" is not the same proposition as "the user
 *      edited this number": which of two same-named properties owns the bare
 *      identifier follows the nodes ARRAY order, so a group drag or a delete
 *      elsewhere can fake it.
 *   2. The one act that outranks a stored value is an authoring edit, detected
 *      at the `updateNodeData` chokepoint from the node id + before/after
 *      values — precise, so a reorder, an undo, a code→graph sync or a project
 *      import can never be mistaken for it.
 *
 * Pure and node-testable: ShaderPreview has no test coverage (the vitest env
 * is `node`, no jsdom), so none of this may live inline in the .tsx.
 */

export interface UniformInfo {
  name: string;
  kind: 'float' | 'color';
  /** float → number; color → '#rrggbb' hex string. */
  defaultValue: number | string;
  /**
   * The `uniform(...)` literal did not parse as a number — `uniform(abc)`, as
   * an adversarial or half-typed graph emits. `defaultValue` is then a
   * fabricated 0 and must never be compared against a real stored value, or a
   * broken graph would report every uniform in the shader as overridden.
   */
  unparsed?: true;
}

export interface UniformBounds {
  min: number;
  max: number;
}

/** A persistable uniform value: finite number (float) or '#rrggbb' (colour). */
export function isValidUniformValue(v: unknown): v is number | string {
  return (
    (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v))
  );
}

/**
 * Compared at the same precision "Set as default" bakes at (uniformDefaults'
 * FLOAT_PRECISION). Comparing raw would light a permanent "overridden" state
 * for a 5e-17 gap: the overlay's slider step is span/200, so a third of the
 * stops on a preset-scale row (0..20) produce values `toPrecision(9)` changes —
 * and the bake then rounds them, leaving the stored value and the node's value
 * "different" while both render identically at three decimals AND
 * `planUniformDefaults` refuses to plan anything, i.e. the button meant to
 * resolve it would do nothing.
 */
const FLOAT_PRECISION = 9;
const round9 = (n: number): number => Number(n.toPrecision(FLOAT_PRECISION));

export function sameUniformValue(
  kind: 'float' | 'color',
  a: number | string,
  b: number | string,
): boolean {
  if (kind === 'color') return String(a).toLowerCase() === String(b).toLowerCase();
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return round9(a) === round9(b);
}

/**
 * Is the preview running something other than what the graph says?
 *
 * A KIND MISMATCH is deliberately NOT an override: a stored '#hex' left over
 * from a deleted colour property, sitting under a name a float property has
 * since taken, is skipped by the fs:preview-ready push and the row falls back
 * to the authored default — so flagging it would announce a divergence that
 * isn't happening.
 */
export function isOverridden(row: UniformInfo, stored: number | string | undefined): boolean {
  if (stored === undefined || row.unparsed) return false;
  // A value that could never be RUN is not a divergence to announce. NaN and
  // Infinity can't reach the persisted map (sanitizeUniformValues drops them),
  // but `!sameUniformValue(...)` is true for any incomparable pair, so without
  // this the first hostile entry would flag its uniform as overridden and offer
  // a revert for a state the preview was never in.
  if (!isValidUniformValue(stored) || !isValidUniformValue(row.defaultValue)) return false;
  if (row.kind === 'color') {
    if (typeof stored !== 'string' || typeof row.defaultValue !== 'string') return false;
  } else if (typeof stored !== 'number' || typeof row.defaultValue !== 'number') return false;
  return !sameUniformValue(row.kind, stored, row.defaultValue);
}

/** name → the value the PREVIEW is running, for every genuine override. */
export function overriddenUniforms(
  rows: readonly UniformInfo[],
  values: Record<string, number | string>,
): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const r of rows) if (isOverridden(r, values[r.name])) out[r.name] = values[r.name];
  return out;
}

/**
 * Drop tuning for one name. Returns the SAME object when nothing matched —
 * which is what makes the authoring path free: a DragNumberInput scrub changes
 * the authored value ~60×/s, and only the first frame has anything to delete.
 * Every later frame gets `prev` back, React bails out of the setState, and
 * usePersistedState's persist effect never fires — so there is no
 * JSON.stringify + localStorage.setItem of the whole map per pointermove.
 */
export function clearUniformValue(
  values: Record<string, number | string>,
  name: string,
): Record<string, number | string> {
  if (!Object.prototype.hasOwnProperty.call(values, name)) return values;
  const next = { ...values };
  delete next[name];
  return next;
}

export function clearUniformValues(
  values: Record<string, number | string>,
  names: readonly string[],
): Record<string, number | string> {
  let next = values;
  for (const n of names) next = clearUniformValue(next, n);
  return next;
}

/**
 * Fallback slider bounds when the user hasn't set any: fit the value.
 * Preset/texture uniforms ship defaults far above 1 (frequency = 20, count = 8);
 * a fixed 0..1 fallback pinned the thumb at max and CLAMPED the value into
 * 0..1 on the first touch, snapping the dropped asset broken.
 */
export function seedBounds(value: unknown): UniformBounds {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return { min: Math.min(0, v * 2), max: Math.max(1, v * 2) };
}

/**
 * Keep frozen fallback bounds while they still CONTAIN the value the row is
 * about to display; otherwise re-seed around it.
 *
 * Containment, not "has this uniform been seen" and not "did the authored
 * default move": the row's value now moves for reasons that leave the authored
 * default alone — the ↺ revert, the red ✕ Reset, a stored value of the wrong
 * kind — and a stale seed would print the true number against a track that
 * cannot reach it, so the first slider touch clamps the number away and stores
 * the clamp. It cannot reintroduce the exponential compounding `seedBounds`
 * warns about, because a value the slider itself emitted is inside [min,max]
 * by construction and therefore never re-seeds. One re-seed always suffices:
 * seedBounds(v) provably contains v (min = min(0,2v) ≤ v, max = max(1,2v) ≥ v).
 */
export function fallbackBounds(
  prev: UniformBounds | undefined,
  value: number,
): UniformBounds {
  if (
    prev
    && Number.isFinite(prev.min)
    && Number.isFinite(prev.max)
    && value >= prev.min
    && value <= prev.max
  ) return prev;
  return seedBounds(value);
}

/**
 * Neither uniform map has a count cap and nothing prunes them in normal use,
 * while projectImport writes an imported map in VERBATIM — into a ~5-10MB
 * origin budget shared with the fs:graph autosave, whose quota failure raises
 * a LimitModal while this one is swallowed silently.
 */
export const MAX_UNIFORM_ENTRIES = 512;

/** Per-entry whitelist + count cap for the persisted VALUES map. */
export function sanitizeUniformValues(parsed: unknown): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  if (!parsed || typeof parsed !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (n >= MAX_UNIFORM_ENTRIES) break;
    if (isValidUniformValue(v)) { out[k] = v; n++; }
  }
  return out;
}

/**
 * Per-entry whitelist for the persisted BOUNDS map — which was a bare cast
 * while its sibling had a whitelist, and is written straight out of an imported
 * project block. `{min:'abc'}` makes the row's span NaN and therefore its step
 * NaN; `{min:5,max:0}` leaves a control that cannot move.
 */
export function sanitizeUniformBounds(parsed: unknown): Record<string, UniformBounds> {
  const out: Record<string, UniformBounds> = {};
  if (!parsed || typeof parsed !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (n >= MAX_UNIFORM_ENTRIES) break;
    const b = v as { min?: unknown; max?: unknown } | null;
    if (!b || typeof b !== 'object') continue;
    const { min, max } = b;
    if (typeof min !== 'number' || typeof max !== 'number') continue;
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) continue;
    out[k] = { min, max };
    n++;
  }
  return out;
}

/**
 * Extract scalar property uniforms from generated TSL code by matching
 * `const NAME = uniform(VALUE)` — the same pattern the shaderloader
 * auto-detects, so the names rendered in the overlay match the keys the
 * shaderloader uses for `_propertyUniforms`, regardless of any mangling
 * graphToCode does to the original property name.
 */
export function extractUniforms(code: string): UniformInfo[] {
  const result: UniformInfo[] = [];
  const seen = new Set<string>();
  // Colour pass FIRST: the numeric regex's `[^)]+` stops at the first ')', so
  // it also matches `uniform(color(0xff0000)` with a garbage capture — colour
  // names must be claimed before the numeric pass sees them. Same ordering rule
  // as the shaderloader's autoDetectSchema.
  const colorRegex = /\bconst\s+(\w+)\s*=\s*uniform\(\s*color\(\s*0x([0-9a-fA-F]{6})\s*\)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = colorRegex.exec(code)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    result.push({ name, kind: 'color', defaultValue: `#${m[2].toLowerCase()}` });
  }
  const regex = /\bconst\s+(\w+)\s*=\s*uniform\(\s*([^)]+)\s*\)/g;
  while ((m = regex.exec(code)) !== null) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const val = parseFloat(m[2]);
    // Carry the parse OUTCOME, don't launder it into 0: a fabricated 0 compared
    // against a real stored value would report every uniform as overridden.
    result.push(
      isNaN(val)
        ? { name, kind: 'float', defaultValue: 0, unparsed: true }
        : { name, kind: 'float', defaultValue: val },
    );
  }
  return result;
}

/**
 * The authoring signal: `before` → `after` is a named property whose VALUE
 * changed. Returns the emitted uniform name + the new value, or null.
 *
 * Gated on value/hex, never on `name`: a rename produces a different uniform
 * with no stored entry, so there is nothing to outrank. Non-finite / non-hex
 * values return null — a half-typed number must not clear a tuning.
 *
 * `varNames` is the store's nodeVarNames (id → emitted name); a value edit
 * cannot change it, so the pre-edit map is correct here. The stored-name
 * fallback covers a code-panel Apply, where codeToGraph mints fresh ids and
 * every lookup misses — safe because codeToGraph names BOTH property kinds
 * from the code identifier, collision suffix included.
 */
export function authoredUniformChange(
  before: AppNode | undefined,
  after: AppNode | undefined,
  varNames: Record<string, string>,
): { name: string; value: number | string } | null {
  if (!before || !after) return null;
  const type = after.data.registryType;
  if (type !== 'property_float' && type !== 'property_color') return null;
  const key = type === 'property_color' ? 'hex' : 'value';
  const raw = getNodeValues(after)[key];
  if (getNodeValues(before)[key] === raw) return null;
  const value = type === 'property_color' ? String(raw) : Number(raw);
  if (!isValidUniformValue(value)) return null;
  const stored = getNodeValues(after).name;
  const name = varNames[after.id]
    ?? (stored != null && stored !== '' ? sanitizeIdentifier(String(stored)) : '');
  return name ? { name, value } : null;
}
