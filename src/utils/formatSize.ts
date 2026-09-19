/**
 * The ONE formatter for a byte size printed in a notice ("… is 64.1 MB, over
 * the 64 MB limit"). Pure and dependency-free apart from the Language type, so
 * every surface that reports a measured size against a cap prints it the same
 * way — four packages had each drafted their own copy, and they disagreed on
 * rounding, grouping and the decimal separator.
 *
 * NB `WorkFolder.tsx` has an unrelated local function called `formatSize` (the
 * folder listing's second line). It is not this module.
 */
import type { Language } from '@/i18n';

/** Bytes → the number printed before "MB" in a notice. MB means MiB (bytes / 2^20).
 *  At most one decimal. 'up' (the default) rounds up to the next tenth, so a size
 *  just over a limit never prints equal to it (64 MiB + 1 B → 64.1, not 64).
 *  Latvian gets a decimal comma. Never grouped. */
export function formatMiB(bytes: number, lang: Language, rounding: 'up' | 'nearest' = 'up'): string {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const tenths = (b * 10) / 1048576;
  const v = (rounding === 'up' ? Math.ceil(tenths) : Math.round(tenths)) / 10;
  return v.toLocaleString(lang === 'lv' ? 'lv' : 'en', { maximumFractionDigits: 1, useGrouping: false });
}
