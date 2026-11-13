/**
 * The asset browser's `'tutorials'` pseudo-tab, decided by PURE functions so a
 * test can hold the rule without faking the study flag (only
 * editorVisibility.test.ts may re-mock `@/eval/evalArm`).
 *
 * The tab is always on outside a study (it is not an optional category: there
 * is no switch), and on EVERY study entry since 2026-11-10 (owner: the arms
 * differ only in the points; through the first study round it was `/evalpro`
 * only). A session with no recorded entry (an older redirector) has none, like
 * the intro (`introInStudy`). Where the cost bar is hidden (`/evalp`), the one
 * lesson that teaches the cost bar is left out (`offeredLessons`), as the
 * intro leaves out its budget slide. Where the tab is absent, a stored `fs:assetTab` of
 * `'tutorials'` stays a VALID value and is derived to `'all'` at render, never
 * written back — the same rule the optional categories follow (`effectiveTab`,
 * registry/optionalCategories.ts).
 */

import type { EvalArm } from '@/eval/evalTask';

export const TUTORIALS_TAB = 'tutorials';

/** Whether the Tutorials tab (and its tiles) exist in this page. */
export function tutorialsOffered(evalMode: boolean, arm: EvalArm | null): boolean {
  return !evalMode || arm !== null;
}

/** The lessons that teach the cost bar's point figures (`tut-costs`). */
export const COST_LESSON_IDS: ReadonlySet<string> = new Set(['tut-costs']);

/** The lessons this page lists: every one, less the cost lesson where the
 *  point budget is not shown (`introShowsBudget(evalTask())` at the caller). */
export function offeredLessons<T extends { id: string }>(defs: readonly T[], showsBudget: boolean): readonly T[] {
  return showsBudget ? defs : defs.filter((d) => !COST_LESSON_IDS.has(d.id));
}

/** The tab to RENDER for a stored one: a hidden Tutorials tab shows the All strip. */
export function effectiveBrowserTab<T extends string>(stored: T, offered: boolean): T | 'all' {
  return stored === TUTORIALS_TAB && !offered ? 'all' : stored;
}
