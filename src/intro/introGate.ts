/**
 * Whether the intro window opens on this boot. A LEAF on the main entry's
 * static graph (App.tsx reads it synchronously at its first render), so the
 * window itself stays a lazy chunk nobody fetches once it has been seen.
 *
 * - Never at BOOT in a study session: the consent dialog must be the first
 *   thing a participant sees. Every study entry opens it right after Agree
 *   instead (`openIntro('start')` from EvalGate; `introInStudy` in
 *   eval/evalTask.ts — /evalp without the point-budget slide), and every opening, page and close is
 *   logged there.
 * - `?intro` opens it again on any boot — the way back after it was closed.
 * - Otherwise it opens on every boot until the user closes it with "Don't
 *   show this again" ticked (`fs:introSeen`, listed in
 *   docs/dev/storage-and-limits.md); closing it unticked clears the mark.
 * - The toolbar's "i" button opens it any time (`openIntro`), except in a
 *   study session, where the button is not drawn.
 */

export const INTRO_SEEN_KEY = 'fs:introSeen';
const SEEN = '1';

/** The decision, pure. `seen` is the stored value, adversarial like every
 *  `fs:*` key: only the exact value this module writes counts as seen, and
 *  anything else merely shows the intro once more. */
export function introOnBoot(opts: { evalMode: boolean; search: string; seen: string | null }): boolean {
  if (opts.evalMode) return false;
  if (new URLSearchParams(opts.search).has('intro')) return true;
  return opts.seen !== SEEN;
}

function readSeen(): string | null {
  try {
    return localStorage.getItem(INTRO_SEEN_KEY);
  } catch {
    // Storage blocked: answer "seen" rather than open the intro on every boot.
    return SEEN;
  }
}

export function shouldShowIntro(evalMode: boolean): boolean {
  return introOnBoot({ evalMode, search: location.search, seen: readSeen() });
}

/** Whether the user ticked "Don't show this again" — the checkbox's start state. */
export function introHidden(): boolean {
  return readSeen() === SEEN;
}

/** The checkbox, written when the window closes: ticked keeps it closed on
 *  later boots, unticked brings it back. */
export function setIntroHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(INTRO_SEEN_KEY, SEEN);
    else localStorage.removeItem(INTRO_SEEN_KEY);
  } catch {
    /* storage full or blocked — nothing to remember it with */
  }
}

/** The toolbar's "i" button asks App to open the window (App owns whether it
 *  is mounted; the toolbar has no other line to it). EvalGate asks the same
 *  way after Agree. */
export const INTRO_OPEN_EVENT = 'fs:open-intro';

/** What opened the window: the boot decision, the toolbar's "i", or a study
 *  session's Agree. Rides the study log's `intro-open`. */
export type IntroVia = 'boot' | 'toolbar' | 'start';

export function openIntro(via: IntroVia = 'toolbar'): void {
  window.dispatchEvent(new CustomEvent<IntroVia>(INTRO_OPEN_EVENT, { detail: via }));
}

/** The opener named by an `INTRO_OPEN_EVENT` — `toolbar` for anything else, as
 *  a window event is reachable by any script on the page. */
export function introOpenVia(e: Event): IntroVia {
  const d = (e as CustomEvent<unknown>).detail;
  return d === 'boot' || d === 'start' ? d : 'toolbar';
}
