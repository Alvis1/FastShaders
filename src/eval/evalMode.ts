/**
 * Eval mode — the user-study switch. See EVAL_MODE_PLAN.md for the research
 * basis (SUS + interaction telemetry for the paper's usability study).
 *
 * The mode is armed by `public/eval/index.html`, which sets a SESSION-storage
 * flag and hands over to the app — sessionStorage, never localStorage, because
 * the flag must die with the tab: a participant's browser must not stay in
 * eval mode for every later visit. The flag is sampled ONCE at module init
 * (the `bootGeometryWasCustom` precedent) so every consumer sees one answer
 * for the whole page lifetime; a mid-session flag edit cannot half-enable
 * logging.
 *
 * Nothing in this folder runs outside eval mode: `evalLog` no-ops, EvalGate is
 * mounted behind `isEvalMode()`, and `evalHooks.test.ts` pins that the hook
 * calls appear only at the reviewed chokepoints.
 */

import { safeJsonReviver } from '@/utils/safeJson';
import { FEEDBACK_EMAIL } from '@/utils/feedbackReport';

export const EVAL_ARM_KEY = 'fs:evalArm';
export const EVAL_SESSION_KEY = 'fs:evalSession';
export const EVAL_JOURNAL_KEY = 'fs:evalJournal';

/** Where the study package is addressed. Kept beside FEEDBACK_EMAIL on purpose
 *  — one constant to change if the study uses a different inbox. */
export const EVAL_STUDY_EMAIL = FEEDBACK_EMAIL;

/** Rides every package so analysis scripts can dispatch on the log format. */
export const EVAL_SCHEMA = 'fs-eval-1';

/**
 * Version tag of the consent text shown; recorded with the consent act, so a
 * package always says which wording its participant agreed to. BUMP IT
 * whenever the text changes materially — consent-2 added the automatic
 * transfer to the university server (delivery option B going live).
 */
export const CONSENT_TEXT_VERSION = 'consent-2';

/**
 * Active-time idle threshold. There is NO validated threshold in the
 * literature (industry spread: 5 s Chartbeat, 10 s Meyer et al. 2017, 30 s
 * idle libraries, 30 min GA sessions) — so the raw visibility/focus/activity
 * events ship in the package and the derived number DECLARES this T, making
 * it a reporting choice reviewers can recompute, not a capture choice.
 */
export const IDLE_THRESHOLD_MS = 60_000;

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

/** The per-tab study session, persisted to sessionStorage so a mid-session
 *  reload resumes instead of re-asking consent. */
export interface EvalSessionRecord {
  id: string;
  participant: string;
  startedIso: string;
  consentIso: string;
  consentVersion: string;
}

const MAX_FIELD = 200;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length <= MAX_FIELD ? v : null;
}

/** Validated read — sessionStorage is the same trust level as localStorage. */
export function readEvalSession(): EvalSessionRecord | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(EVAL_SESSION_KEY);
  } catch {
    return null;
  }
  if (!raw || raw.length > 4096) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, safeJsonReviver);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const id = str(p.id);
  const participant = str(p.participant);
  const startedIso = str(p.startedIso);
  const consentIso = str(p.consentIso);
  const consentVersion = str(p.consentVersion);
  if (id == null || participant == null || startedIso == null || consentIso == null || consentVersion == null) {
    return null;
  }
  return { id, participant, startedIso, consentIso, consentVersion };
}

export function writeEvalSession(rec: EvalSessionRecord): void {
  try {
    sessionStorage.setItem(EVAL_SESSION_KEY, JSON.stringify(rec));
  } catch {
    // Storage blocked: the session still runs in memory; a reload re-asks
    // consent, which is the safe direction to fail in.
  }
}

/** Decline path: drop the flag + record so a reload boots the normal app. */
export function clearEvalMode(): void {
  try {
    sessionStorage.removeItem(EVAL_ARM_KEY);
    sessionStorage.removeItem(EVAL_SESSION_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Session ids only need to be unique per machine per study. */
export function mintEvalSessionId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `es-${Date.now().toString(36)}-${rand}`;
}
