/**
 * Most-recently-used node types for the add-node menu.
 *
 * The right-click "search" menu floats the node types you actually reach for to
 * the top under a "Recent" heading, newest first — so repeated work doesn't
 * mean re-hunting the same node through the category list every time.
 *
 * Display-order ONLY: this never touches the graph, the generated code, or
 * search matching. Persisted to localStorage, deduped, capped. Every access is
 * wrapped — private mode / a full quota just degrades to "no recents", which is
 * a nicety to lose, not a failure.
 */
import { safeJsonReviver } from '@/utils/safeJson';

const RECENT_KEY = 'fs:recentNodes';
export const RECENT_MAX = 6;

/** The MRU list, newest first (already deduped + capped). */
export function getRecentNodeTypes(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    // localStorage is writable by anything at this origin, so this is a trust
    // boundary like every other JSON.parse in the app — hence the shared
    // deny-list reviver (utils/safeJson.ts is the one copy of that rule). The
    // string filter below already contains the damage; the reviver is what
    // keeps the next deny-list key from reaching only the opted-in sites.
    const parsed = JSON.parse(raw, safeJsonReviver);
    if (!Array.isArray(parsed)) return [];
    // Adversarial/legacy storage: keep only strings, dedupe, cap.
    const out: string[] = [];
    for (const t of parsed) {
      if (typeof t === 'string' && !out.includes(t)) out.push(t);
      if (out.length >= RECENT_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Record that `type` was just added — moves it to the front of the MRU list. */
export function noteNodeUsed(type: string): void {
  try {
    const next = [type, ...getRecentNodeTypes().filter((t) => t !== type)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode / quota — recency is a nicety, not essential */
  }
}
