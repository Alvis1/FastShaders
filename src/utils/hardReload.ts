/**
 * "Hard reload": navigate to `?fsreload=<stamp>`. A new URL is a new HTTP cache
 * entry, so index.html and its hashed chunks refetch; `public/` assets do not.
 * `location.reload(true)` is a no-op (the IDL takes no argument).
 * Clear ONLY `HARD_RELOAD_CLEARED_KEYS`, never `sessionStorage.clear()`: the
 * eval journal lives there. Reasoning: docs/dev/discovery-and-i18n.md → Hard reload.
 */

/** Cache-busting marker. Stripped from the address bar once the page is up. */
export const HARD_RELOAD_PARAM = 'fsreload';

/**
 * The sessionStorage keys a hard reload drops.
 *
 * EMPTY since 2026-09-04: the only entry was the `/textures` one-load arm,
 * which the toolbar's right-click switch replaced (registry/optionalCategories
 * .ts — a persisted preference, which a hard reload must NOT clear: the user
 * asked for a fresh copy of the app, not for their settings back). The list
 * and its loop stay, because the shape is the point — an EXPLICIT list that
 * names no eval key, never a `sessionStorage.clear()` (hardReload.test.ts).
 */
export const HARD_RELOAD_CLEARED_KEYS: readonly string[] = [];

/**
 * PURE: the cache-busted URL to navigate to. `stamp` is passed in (rather than
 * read from the clock) so this is testable.
 *
 * Bumped by one when it would reproduce the marker already in the URL — a
 * navigation to the byte-identical URL is just a reload, which is what this is
 * trying not to be.
 */
export function hardReloadUrl(href: string, stamp: number): string {
  const u = new URL(href);
  const value = u.searchParams.get(HARD_RELOAD_PARAM) === String(stamp)
    ? String(stamp + 1)
    : String(stamp);
  u.searchParams.set(HARD_RELOAD_PARAM, value);
  return u.toString();
}

/**
 * PURE: `href` with the marker removed, or null when there was none.
 *
 * Returning null rather than the unchanged string is what lets the caller skip
 * a `history.replaceState` on the overwhelmingly common ordinary page load.
 */
export function strippedHardReloadUrl(href: string): string | null {
  const u = new URL(href);
  if (!u.searchParams.has(HARD_RELOAD_PARAM)) return null;
  u.searchParams.delete(HARD_RELOAD_PARAM);
  // `?` alone is legal but ugly in the address bar, and it would be copied
  // into every bookmark and shared link made from this page.
  return u.toString().replace(/\?(?=#|$)/, '');
}

/** Drop the declared keys. Split out for the test; storage may throw. */
export function clearHardReloadState(storage: Pick<Storage, 'removeItem'>): void {
  for (const key of HARD_RELOAD_CLEARED_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      /* private mode / storage blocked — nothing to clear */
    }
  }
}

/**
 * Take the page down and bring it back on a URL the HTTP cache has not seen.
 *
 * `location.replace`, not `assign`: a hard reload is a do-over of the page you
 * are on, so it must not leave a Back entry pointing at the URL it replaced.
 * Any failure degrades to the plain reload the left-click already does, which
 * is strictly better than a button that does nothing.
 */
export function hardReload(): void {
  try {
    clearHardReloadState(sessionStorage);
  } catch {
    /* storage itself can throw on access */
  }
  try {
    window.location.replace(hardReloadUrl(window.location.href, Date.now()));
  } catch {
    window.location.reload();
  }
}

/**
 * Remove the marker from the address bar once the fresh document is running.
 *
 * Called once at boot. `replaceState` changes the URL without navigating, so
 * the cache-busted fetch has already happened and nothing is undone — the user
 * simply keeps a clean URL to bookmark, and the NEXT plain reload is an
 * ordinary one.
 */
export function stripHardReloadMarker(): void {
  try {
    const next = strippedHardReloadUrl(window.location.href);
    if (next) window.history.replaceState(window.history.state, '', next);
  } catch {
    /* opaque origin / blocked history — the marker is cosmetic */
  }
}
