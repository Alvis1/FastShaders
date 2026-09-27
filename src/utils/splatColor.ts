/**
 * TINT, NOT PAINT — what the Splat Output's Color does to the colour each
 * splat was captured with (2026-09-27, owner: "how to mix the colours of the
 * gaussian splats with other procedural textures?"). LEAF: the emitter, the
 * parse, the resync, Reset, Preview mode and the settings menu read it.
 *
 * A wired or stored Color MULTIPLIES the captured colour by default:
 *   return vec4(mul(c.rgb, <colour>), <opacity>);
 * so a pattern or a swatch tints the scene like a coloured gel — white keeps a
 * splat as captured, black darkens it — instead of erasing it. It used to
 * REPLACE the captured colour, which made every wired texture look like a
 * repaint and left keeping the photo to the one user who knew that "Vertex
 * Color" is the splat's own colour. Replacing is still one tick away:
 * `values.replaceColor` (only the literal `true`, off DELETES the key — the
 * `invert` / `lit` rule, utils/trueFlag.ts) emits the colour alone, as before.
 * An unwired Color with nothing stored is the captured colour either way
 * (`c.rgb`).
 */
import { HEX6 } from './colorUtils';
import { hasTrueFlag, withTrueFlag } from './trueFlag';

/** A stored Color (or light colour) the emitter will actually use: a
 *  `#rrggbb` string, else null — so the node never shows a swatch for a value
 *  the module ignores, and the emitter and the resync ask the same test. */
export function splatStoredColor(v: unknown): string | null {
  return typeof v === 'string' && HEX6.test(v) ? v : null;
}

/** Does this node's raw `values` make Color REPLACE the captured colour? The
 *  OWN key, strictly the literal `true` — exactly what the emitter counts. */
export function isSplatReplaceColor(rawValues: unknown): boolean {
  return hasTrueFlag(rawValues, 'replaceColor');
}

/** `values` with Replace switched: `replaceColor: true` added, or the key
 *  DELETED. A fresh object; the input is never mutated. */
export function splatReplaceColorValues(values: Readonly<Record<string, unknown>>, on: boolean): Record<string, unknown> {
  return withTrueFlag(values, 'replaceColor', on);
}

/**
 * Carry `replaceColor` across a code-panel Apply when the module could not say
 * it. The parse reads the mode off the shade's return — `mul(c.rgb, X)` is a
 * tint, a bare `X` a replace — so it is invisible exactly when Color is
 * neither wired nor stored (the return is `c.rgb` in both modes). Then, and
 * only then, the OLD node's key is carried. `colorFed` says whether the PARSED
 * node's Color is wired or stored. Returns the next values, or null.
 */
export function carrySplatReplaceColor(
  parsedValues: Readonly<Record<string, unknown>>,
  oldValues: Readonly<Record<string, unknown>>,
  colorFed: boolean,
): Record<string, unknown> | null {
  if (colorFed || isSplatReplaceColor(parsedValues) || !isSplatReplaceColor(oldValues)) return null;
  return { ...parsedValues, replaceColor: true };
}
