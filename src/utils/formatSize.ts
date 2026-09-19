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
 *  At most one decimal. Latvian gets a decimal comma. Never grouped.
 *
 *  WHICH rounding follows from what the number IS, and the two are opposites:
 *  a MEASURED size takes 'up' (the default), so one byte over a cap never
 *  prints equal to it (64 MiB + 1 B → 64.1, not 64); a declared CAP takes
 *  'nearest', because rounding a cap up claims more room than is enforced.
 *  Both appear in one sentence ("{size} MB — max {limit} MB"), so getting them
 *  the same way round would make the pair contradict itself at the boundary.
 *  Every cap shipped today is a whole number of MiB, so the two agree and no
 *  string moves — it matters the first time one is not. */
export function formatMiB(bytes: number, lang: Language, rounding: 'up' | 'nearest' = 'up'): string {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const tenths = (b * 10) / 1048576;
  const v = (rounding === 'up' ? Math.ceil(tenths) : Math.round(tenths)) / 10;
  return v.toLocaleString(lang === 'lv' ? 'lv' : 'en', { maximumFractionDigits: 1, useGrouping: false });
}
