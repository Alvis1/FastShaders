/**
 * Task / condition identity for the study (EVAL_MODE_PLAN.md §7.20).
 *
 * A session is launched as e.g.
 *   …/fastshaders/eval/?task=T7-fire&budget=200&costbar=off
 * and the parameters ride into `session.json` plus a `task-start` event, so a
 * package can say WHICH task it is and WHICH experimental condition it was
 * collected under. Without that, a between-conditions comparison (the
 * cost-feedback arm) cannot label its own data after the fact.
 *
 * `briefBudget` is deliberately separate from the headset budget the CostBar
 * shows: the number stated in a task brief ("stay under 200 points") and the
 * device profile's `maxPoints` are different claims, and a package that
 * carries only one of them leaves the other ambiguous.
 *
 * PURE (node-tested). The DOM side is `public/eval/index.html`, which copies
 * its own query string into sessionStorage before handing over to the app —
 * the app URL stays clean and the parameters survive a mid-session reload.
 */

// The storage keys all live in evalMode.ts, so the writer (the redirector),
// this reader and clearEvalMode's eraser cannot drift apart. Importing the
// key rather than defining it here also keeps the dependency one-way.
export { EVAL_TASK_KEY } from './evalMode';
import { EVAL_TASK_KEY as TASK_KEY, isEvalMode } from './evalMode';

export interface EvalTask {
  /** Task identifier from `?task=` — null when the session is unlabelled. */
  id: string | null;
  /** Point budget stated in the task brief (`?budget=`), NOT the device budget. */
  briefBudget: number | null;
  /** `?costbar=off` hides the cost bar — the cost-feedback manipulation. */
  costBarVisible: boolean;
  /**
   * `?points=off` (and the `/evalp` entry) removes EVERY point figure from the
   * UI: the cost bar, each node's cost badge, the asset tiles' badges, the
   * Add-node menu's per-row cost, and the shader-settings total/budget lines.
   * This is the stronger arm — `costbar=off` alone leaves per-node prices on
   * screen, so a participant can still add them up, which is not "no cost
   * feedback" at all.
   *
   * It is a DISPLAY condition only: the telemetry keeps recording cost points
   * in every snapshot, and the package still carries the cost table. The
   * researcher must be able to price what was built in the arm where the
   * participant could not see the price.
   */
  pointsVisible: boolean;
  /**
   * `?pro=on` (and the `/evalpro` entry) adds a block of professional
   * questions after the experience ones — role, how long, which platforms,
   * how often shaders are authored, whether GPU budgets constrain the work.
   * They are asked only of professionals because they are meaningless (and
   * mildly alienating) to a student participant, and because keeping them out
   * of the ordinary arm keeps that questionnaire short.
   */
  proQuestions: boolean;
}

export const DEFAULT_EVAL_TASK: EvalTask = {
  id: null,
  briefBudget: null,
  costBarVisible: true,
  pointsVisible: true,
  proQuestions: false,
};

const MAX_ID_LEN = 64;
const MAX_BUDGET = 1_000_000;

/** Task ids are labels chosen by the researcher; keep them boring and short. */
function cleanId(raw: string | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_ID_LEN) return null;
  // Printable ASCII minus the separators a filename or CSV would choke on.
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null;
}

function cleanBudget(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_BUDGET) return null;
  return Math.round(n);
}

/**
 * Parse a query string (with or without the leading '?'). Anything malformed
 * degrades to the default rather than failing the session — a mistyped launch
 * URL must still let a participant work.
 */
export function parseEvalTask(search: string): EvalTask {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return { ...DEFAULT_EVAL_TASK };
  }
  // Only an explicit off/0/false hides a surface; anything else leaves it
  // visible, so a typo cannot silently drop the participant into the other
  // condition.
  const isOff = (v: string | null): boolean => {
    const t = (v ?? '').trim().toLowerCase();
    return t === 'off' || t === '0' || t === 'false';
  };
  const pointsVisible = !isOff(params.get('points'));
  // Opt-IN, unlike the two suppression flags: an absent parameter must not
  // hand a student the professional block.
  const pro = (params.get('pro') ?? '').trim().toLowerCase();
  return {
    id: cleanId(params.get('task')),
    briefBudget: cleanBudget(params.get('budget')),
    // No points at all implies no cost bar — the bar is a point figure.
    costBarVisible: pointsVisible && !isOff(params.get('costbar')),
    pointsVisible,
    proQuestions: pro === 'on' || pro === '1' || pro === 'true',
  };
}

/**
 * The session's task, sampled ONCE at module init — the launch parameters
 * cannot change mid-session, and the CostBar gate would otherwise hit
 * sessionStorage on every render. The stored QUERY STRING is the single
 * source: parsing it again here means the validation above is the only rule.
 */
const TASK: EvalTask = (() => {
  // A condition only exists INSIDE a study session. Without this gate a
  // leftover key would keep shaping the standard app — which is exactly how
  // declining at the consent screen used to return a point-less editor. The
  // eraser in clearEvalMode is the primary fix; this makes a stale or
  // hand-written key harmless on its own.
  if (!isEvalMode()) return { ...DEFAULT_EVAL_TASK };
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(TASK_KEY);
  } catch {
    return { ...DEFAULT_EVAL_TASK };
  }
  if (!raw || raw.length > 2048) return { ...DEFAULT_EVAL_TASK };
  return parseEvalTask(raw);
})();

export function evalTask(): EvalTask {
  return TASK;
}

/**
 * Stamp the no-points condition on the document root, so the CSS sweep in
 * `eval.css` can hide every price the app draws — badges are rendered by a
 * dozen components (each node type, the group pill, all three asset-tile
 * kinds, the node-editor overview) and gating each one in React would be a
 * dozen chances to miss one. The two places that render a point figure as
 * PROSE (the Add-node menu row, the shader-settings total/budget lines) are
 * gated in their components instead: hiding those with CSS would leave a
 * blank row where a sentence was.
 *
 * Called once from main.tsx. A no-op outside the pointless arm.
 */
export function applyEvalTaskFlags(): void {
  if (!TASK.pointsVisible) document.documentElement.dataset.fsPoints = 'off';
}
