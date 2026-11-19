/**
 * The user's own Anthropic API key, held in this tab's MEMORY only — never in
 * the zustand store (history clones it, the autosave subscription and the
 * feedback report read store state, and one future `persist` would write it
 * into fs:*), never in localStorage or sessionStorage (readable by every page
 * on the shared origins this app is hosted on). A reload forgets it.
 *
 * A dependency-free leaf with NO getter: the key leaves the closure only
 * through `withCloudKey`, which ONE module calls (providers/claude.ts, to
 * build a client per request — source-pinned by generatorWiring.test.ts).
 *
 * This is persistence hygiene, not isolation: other code running on the same
 * origin while the tab is open could still reach it. The dialog says so, and
 * recommends a dedicated key with a spend limit.
 */

let key: string | null = null;
const listeners = new Set<(has: boolean) => void>();

/** Shortest string accepted as a key — a typo guard, not a format check. */
export const MIN_KEY_LENGTH = 20;

function notify(): void {
  for (const fn of listeners) fn(key !== null);
}

/** Keep `raw` as the key. Refused (false) when, trimmed, it is too short or
 *  holds whitespace — a pasted sentence is not a key. */
export function setCloudKey(raw: string): boolean {
  const k = raw.trim();
  if (k.length < MIN_KEY_LENGTH || /\s/.test(k)) return false;
  key = k;
  notify();
  return true;
}

export function clearCloudKey(): void {
  if (key === null) return;
  key = null;
  notify();
}

export function hasCloudKey(): boolean {
  return key !== null;
}

/** Called with whether a key is held, whenever that changes. */
export function subscribeCloudKey(fn: (has: boolean) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Run `use` with the key; null when none is held. */
export function withCloudKey<T>(use: (key: string) => T): T | null {
  return key === null ? null : use(key);
}
