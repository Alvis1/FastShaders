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

/** The raw query string the /eval redirector captured at launch. */
export const EVAL_TASK_KEY = 'fs:evalTaskQuery';

export interface EvalTask {
  /** Task identifier from `?task=` — null when the session is unlabelled. */
  id: string | null;
  /** Point budget stated in the task brief (`?budget=`), NOT the device budget. */
  briefBudget: number | null;
  /** `?costbar=off` hides the cost bar — the cost-feedback manipulation. */
  costBarVisible: boolean;
}

export const DEFAULT_EVAL_TASK: EvalTask = {
  id: null,
  briefBudget: null,
  costBarVisible: true,
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
  const costbar = (params.get('costbar') ?? '').trim().toLowerCase();
  return {
    id: cleanId(params.get('task')),
    briefBudget: cleanBudget(params.get('budget')),
    // Only an explicit off/0/false hides it; anything else leaves it visible,
    // so a typo cannot silently drop the participant into the other condition.
    costBarVisible: !(costbar === 'off' || costbar === '0' || costbar === 'false'),
  };
}

/**
 * The session's task, sampled ONCE at module init — the launch parameters
 * cannot change mid-session, and the CostBar gate would otherwise hit
 * sessionStorage on every render. The stored QUERY STRING is the single
 * source: parsing it again here means the validation above is the only rule.
 */
const TASK: EvalTask = (() => {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(EVAL_TASK_KEY);
  } catch {
    return { ...DEFAULT_EVAL_TASK };
  }
  if (!raw || raw.length > 2048) return { ...DEFAULT_EVAL_TASK };
  return parseEvalTask(raw);
})();

export function evalTask(): EvalTask {
  return TASK;
}
