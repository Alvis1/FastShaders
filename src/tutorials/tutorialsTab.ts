/**
 * The asset browser's `'tutorials'` pseudo-tab, decided by PURE functions so a
 * test can hold the rule without faking the study flag (only
 * editorVisibility.test.ts may re-mock `@/eval/evalArm`).
 *
 * The tab is always on outside a study (it is not an optional category: there
 * is no switch). In a study it exists on the `/evalpro` ENTRY only (owner,
 * 2026-10-25) — keyed on the arm, never a parameter, like the professional
 * block: the student arms (`/eval`, `/evalp`) are compared with each other, so
 * a training surface in one of them would change the condition between
 * groups (docs/dev/eval-mode.md). A session with no recorded entry (an older
 * redirector) has none. Where it is absent, a stored `fs:assetTab` of
 * `'tutorials'` stays a VALID value and is derived to `'all'` at render, never
 * written back — the same rule the optional categories follow (`effectiveTab`,
 * registry/optionalCategories.ts).
 */

import type { EvalArm } from '@/eval/evalTask';

export const TUTORIALS_TAB = 'tutorials';

/** Whether the Tutorials tab (and its tiles) exist in this page. */
export function tutorialsOffered(evalMode: boolean, arm: EvalArm | null): boolean {
  return !evalMode || arm === 'evalpro';
}

/** The tab to RENDER for a stored one: a hidden Tutorials tab shows the All strip. */
export function effectiveBrowserTab<T extends string>(stored: T, offered: boolean): T | 'all' {
  return stored === TUTORIALS_TAB && !offered ? 'all' : stored;
}
