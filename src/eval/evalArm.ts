/**
 * The study switch's ONE flag, as a LEAF module (imports nothing), so the node
 * registry can withhold study-only add-surface entries at module init without
 * importing `evalMode.ts` — whose import chain reaches the store, and the store
 * imports the registry. `evalMode.ts` re-exports both names; everything else
 * keeps importing them from there.
 *
 * The mode is armed by `public/eval/index.html`, which sets a SESSION-storage
 * flag — never localStorage, because the flag must die with the tab. Sampled
 * ONCE at module init, so every consumer sees one answer for the whole page.
 */

export const EVAL_ARM_KEY = 'fs:evalArm';
/** The raw query string the /eval, /evalp and /evalpro redirectors capture at launch. */
export const EVAL_TASK_KEY = 'fs:evalTaskQuery';
/** The participant code a redirector read off the link's fragment (`/evalpro#P0101`). */
export const EVAL_PARTICIPANT_KEY = 'fs:evalParticipant';

const armed = (() => {
  try {
    return sessionStorage.getItem(EVAL_ARM_KEY) === '1';
  } catch {
    // node tests / storage-blocked browsers: never in eval mode.
    return false;
  }
})();

export function isEvalMode(): boolean {
  return armed;
}
