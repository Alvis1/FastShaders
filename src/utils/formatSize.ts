/**
 * The ONE formatter for a byte size printed in a NOTICE ("… is 64.1 MB, over
 * the 64 MB limit"), so every surface reporting a size against a cap agrees on
 * rounding, grouping and the decimal separator. For ASCII output that ships
 * inside exported code use `feedbackReport.formatBytes`.
 */
import type { Language } from '@/i18n';

/** A compact size for a LISTING or a hover title (Work-folder rows, texture
 *  cells): whole KB under 1 MB, one decimal above. Never for a notice —
 *  `formatMiB` rounds UP against a cap, which prints every texture as "1". */
export function formatKbMb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

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
