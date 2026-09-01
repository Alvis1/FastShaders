/**
 * The Textures tab's SESSION unlock.
 *
 * The content browser's ready-made Textures strip is hidden by default and is
 * switched on for ONE page load by arriving through the `/textures` entry
 * (`public/textures/index.html`, the /eval redirector's shape): that page arms
 * a sessionStorage key and hands over to the app, which CONSUMES the key here
 * at module init and keeps the answer in memory for the rest of the page's
 * life.
 *
 * Consume-once is the whole mechanism, and it is what makes "any reload turns
 * them off again" true without asking the browser a question it cannot answer:
 * a page CANNOT detect that the user pressed Cmd+Shift+R rather than Cmd+R
 * (PerformanceNavigationTiming reports `type: 'reload'` for both, and
 * sessionStorage survives either), so a flag that merely SAT in storage would
 * have to be cleared by something — and the only reliable something is the app
 * itself. Reading it destructively means the next load, soft or hard, finds
 * nothing. The tab-close case falls out for free, since sessionStorage is
 * per-tab.
 *
 * Three rules keep it honest:
 *
 * 1. **This is an ADD-SURFACE filter, exactly like `editorVisibility`.** It
 *    gates what the palette OFFERS and nothing else. `getBuiltinTextures()`
 *    still builds every texture, a `.fastshader` authored from one still loads
 *    (a texture is dropped as a GROUP of ordinary nodes — nothing in a saved
 *    graph references a texture id), a built-in preset containing one is
 *    untouched, and node-editor.html's overview keeps listing all of them.
 *    Deliberately NOT imported by `GraphsPage` or by anything under `engine/`
 *    or `store/` — `texturesUnlock.test.ts` greps for that.
 *
 * 2. **It is sampled ONCE, at module init** (the `isEvalMode` /
 *    `bootGeometryWasCustom` precedent), so every consumer sees one answer for
 *    the whole page lifetime. ContentBrowser builds its tab list at MODULE
 *    scope, so a per-call read would also be a per-render read of a key that
 *    no longer exists.
 *
 * 3. **The answer is memoised on `globalThis`, not merely in module scope.**
 *    Vite's HMR re-executes a changed module's dependents, which would re-run
 *    this file's initialiser against the key it has already consumed — so
 *    editing any file in the import chain would silently re-lock the textures
 *    mid-session while developing. The memo survives an HMR re-execution and
 *    dies with the page, which is precisely the lifetime the unlock wants.
 */

/** Written by `public/textures/index.html`, read and destroyed here. */
export const TEXTURES_ARM_KEY = 'fs:texturesArm';

/** Value the redirector writes. Anything else is not an arm. */
export const TEXTURES_ARM_VALUE = '1';

/** Where the consumed answer is parked so an HMR re-execution recovers it. */
const MEMO_KEY = '__fsTexturesUnlocked';

/**
 * The destructive read, taken as a parameter so the vitest `node` environment
 * (which has no `sessionStorage`) can drive it with a stub.
 *
 * A storage that THROWS on either call — private mode, a blocked third-party
 * context — degrades to "locked", which is the safe direction: the palette
 * merely looks the way it does for everyone who did not use the entry.
 */
export function consumeTexturesArm(storage: Pick<Storage, 'getItem' | 'removeItem'>): boolean {
  try {
    const armed = storage.getItem(TEXTURES_ARM_KEY) === TEXTURES_ARM_VALUE;
    // Remove it even when it held something else: a stale or hand-edited value
    // must not sit there waiting to be interpreted by a later build.
    storage.removeItem(TEXTURES_ARM_KEY);
    return armed;
  } catch {
    return false;
  }
}

const unlocked: boolean = (() => {
  const g = globalThis as Record<string, unknown>;
  if (typeof g[MEMO_KEY] === 'boolean') return g[MEMO_KEY] as boolean;
  let armed = false;
  try {
    armed = consumeTexturesArm(sessionStorage);
  } catch {
    // `sessionStorage` itself can throw on access (blocked cookies/storage).
    armed = false;
  }
  g[MEMO_KEY] = armed;
  return armed;
})();

/**
 * True when this page load may OFFER the built-in textures — the Textures tab
 * and the texture cards a live search surfaces on any tab.
 *
 * **The DESKTOP build is always unlocked**, and that is a decision rather than
 * an oversight: the `.dmg`/`.exe` shell has no address bar and registers no
 * Reload menu item, so `/textures` is not reachable there by any gesture. A
 * lock that ships to desktop would remove the texture library from that build
 * permanently, with no way back — the same shape as the rule the WGSL/GLSL
 * toggle follows ("a control that vanishes per-platform reads as a
 * regression", which is why that one locks with an explanation instead of
 * hiding). The entry exists for the WEB deploys, where a URL can be typed.
 */
export function areTexturesUnlocked(): boolean {
  return __FS_DESKTOP__ || unlocked;
}
