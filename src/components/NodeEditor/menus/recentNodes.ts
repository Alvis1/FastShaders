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
const RECENT_KEY = 'fs:recentNodes';
export const RECENT_MAX = 6;

/** The MRU list, newest first (already deduped + capped). */
export function getRecentNodeTypes(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
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
