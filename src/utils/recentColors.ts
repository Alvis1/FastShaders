/**
 * The globally-recent colour MRU behind the colour picker's two bottom rows.
 *
 * Deliberately a standalone module rather than a zustand slice, mirroring
 * `menus/recentNodes.ts`: this is a UI convenience with no bearing on the
 * graph, so it must not ride undo history, must not appear in a history
 * snapshot's `structuredClone`, and must not be written into the
 * FASTSHADERS_PROJECT_V1 block or `projectImport`'s pref replay — a colour you
 * happened to pick is not part of a shader, and shipping it in an exported
 * file would leak one user's working state into another's editor.
 *
 * ADVERSARIAL ON READ, like every other `fs:*` consumer: the value can be
 * hand-edited or left by an older build, and it is rendered straight into
 * `style.background`, so a non-hex string would be injected into CSS. Only
 * literal 6-digit hex survives — the same whitelist `hexLiteral` applies
 * before a colour may reach generated shader code, and the same reason
 * `utils/drawings.ts` refuses 8-digit alpha hex.
 */

import { safeJsonReviver } from '@/utils/safeJson';
import { normalizeHex } from '@/utils/colorUtils';

/** Rows of recent swatches drawn under the palettes. */
export const RECENT_COLOR_ROWS = 2;
/**
 * Swatches per row. It is 6 because the SHIPPED PALETTES ARE 12 COLOURS, and
 * 12 divides by 6: each built-in then fills exactly two full rows in the
 * picker, with no ragged remainder. The recents grid uses the same column
 * count so it lines up with the palettes above it and needs no extra width.
 *
 * This number and `.palette-pop__row`'s `grid-template-columns` are ONE
 * decision expressed twice (CSS cannot read a TS const) — the popover's width
 * is derived from it in `PaletteColorPicker.css`, so all three move together.
 */
export const SWATCHES_PER_ROW = 6;
/** The MRU is exactly the two rows the picker draws: a longer tail would be
 *  remembered but unreachable, which reads as colours going missing. */
export const MAX_RECENT_COLORS = RECENT_COLOR_ROWS * SWATCHES_PER_ROW;

export const RECENT_COLORS_KEY = 'fs:recentColors';

/** Bound and clean a persisted list: array-of-valid-hex, deduped, capped. */
export function sanitizeRecentColors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const hex = normalizeHex(item);
    if (!hex || out.includes(hex)) continue;
    out.push(hex);
    if (out.length >= MAX_RECENT_COLORS) break;
  }
  return out;
}

/**
 * MRU insert. Returns the SAME array reference when nothing changed (the hex
 * is invalid, or already at the head), so a caller can skip a localStorage
 * write and a re-render on the overwhelmingly common repeat-pick.
 */
export function pushRecentColor(list: readonly string[], hex: unknown): string[] {
  const clean = normalizeHex(hex);
  if (!clean) return list as string[];
  if (list[0] === clean) return list as string[];
  return [clean, ...list.filter((c) => c !== clean)].slice(0, MAX_RECENT_COLORS);
}

/** Read the persisted MRU. Never throws: private mode, a quota-cleared key, or
 *  a hand-edited value all degrade to an empty list. */
export function getRecentColors(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_COLORS_KEY);
    if (!raw) return [];
    return sanitizeRecentColors(JSON.parse(raw, safeJsonReviver));
  } catch {
    return [];
  }
}

/**
 * Record one COMMITTED colour.
 *
 * "Committed" is load-bearing and is the caller's responsibility: a native
 * `<input type="color">` fires an input event PER FRAME while its wheel is
 * dragged, so recording on that stream would push ~120 near-identical shades
 * through a 10-slot MRU in a single gesture and evict every colour the user
 * had actually chosen. The picker therefore stages the live value and flushes
 * once — on idle, blur, or close — and only that flush reaches this function.
 *
 * Returns the new list, or null when nothing changed.
 */
export function noteColorUsed(hex: unknown): string[] | null {
  const current = getRecentColors();
  const next = pushRecentColor(current, hex);
  if (next === current) return null;
  try {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(next));
  } catch {
    // Quota / private mode: the MRU is a convenience, never worth surfacing a
    // notice for or failing a colour pick over.
  }
  return next;
}

/** Forget every remembered colour (the picker's "clear recents" affordance). */
export function clearRecentColors(): void {
  try {
    localStorage.removeItem(RECENT_COLORS_KEY);
  } catch {
    /* nothing to do */
  }
}
