import { t, type Language } from '@/i18n';
import { fillTemplate } from './fillTemplate';
import { formatSplatCount } from './previewMesh';
import { SPLAT_MAX_COUNT } from './splatLimits';

/**
 * The Splat Output settings menu's one figure: how many splats the preview
 * actually loaded — the `textureMemoryLine` pattern (utils/textureMemory.ts),
 * a line plus a hint, both keyed by their English text.
 *
 * The number comes from the SANDBOX (`previewSplatFacts`, reported by the
 * preview document on `splat-loaded` and validated by the parent), because a
 * gzip `.spz` declares no count the trusted side can read. That report is
 * still a message out of an iframe running model code, so this formatter is
 * total on its own: anything but a safe integer in `[0, SPLAT_MAX_COUNT]`
 * prints NOTHING rather than a forged or absurd figure. With no splat loaded
 * there is no facts object and no line — the menu simply omits it.
 *
 * `t()` has no plural rules, so the count picks one of two keys (English
 * would otherwise read "1 splats"); the Latvian many-form states the count as
 * a quantity ("Pleķu skaits …: {n}") so it never needs a plural ending.
 */

export const SPLAT_COUNT_ONE_KEY = 'Loaded scene: 1 splat';
export const SPLAT_COUNT_MANY_KEY = 'Loaded scene: {n} splats';
export const SPLAT_COUNT_HINT_KEY =
  'How many splats the preview loaded. Every socket of this node is read once per splat, at its centre, in the vertex stage, so a graph wired here costs more the more splats the scene has; the cost bar does not price splats.';

/** The line, or null when there is nothing honest to print. */
export function splatCountLine(facts: { count: unknown } | null | undefined, lang: Language): string | null {
  const n = facts?.count;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > SPLAT_MAX_COUNT) return null;
  const key = n === 1 ? SPLAT_COUNT_ONE_KEY : SPLAT_COUNT_MANY_KEY;
  return fillTemplate(t(key, lang), { n: formatSplatCount(n, lang) });
}
