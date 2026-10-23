/**
 * The asset browser's `'tutorials'` pseudo-tab, decided by PURE functions so a
 * test can hold the rule without faking the study flag (only
 * editorVisibility.test.ts may re-mock `@/eval/evalArm`).
 *
 * The tab is always on outside a study (it is not an optional category: there
 * is no switch) and ABSENT in one — a training surface appearing mid-study
 * would change the condition between groups (docs/dev/eval-mode.md). A stored
 * `fs:assetTab` of `'tutorials'` stays a VALID value through a study session
 * and is derived to `'all'` at render, never written back — the same rule the
 * optional categories follow (`effectiveTab`, registry/optionalCategories.ts).
 */

export const TUTORIALS_TAB = 'tutorials';

/** Whether the Tutorials tab (and its tiles) exist in this page. */
export function tutorialsOffered(evalMode: boolean): boolean {
  return !evalMode;
}

/** The tab to RENDER for a stored one: a hidden Tutorials tab shows the All strip. */
export function effectiveBrowserTab<T extends string>(stored: T, offered: boolean): T | 'all' {
  return stored === TUTORIALS_TAB && !offered ? 'all' : stored;
}
