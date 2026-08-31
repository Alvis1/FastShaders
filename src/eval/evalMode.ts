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
/** The raw query string the /eval and /evalp redirectors capture at launch. */
export const EVAL_TASK_KEY = 'fs:evalTaskQuery';

/** Where the study package is addressed. Kept beside FEEDBACK_EMAIL on purpose
 *  — one constant to change if the study uses a different inbox. */
export const EVAL_STUDY_EMAIL = FEEDBACK_EMAIL;

/** Rides every package so analysis scripts can dispatch on the log format. */
export const EVAL_SCHEMA = 'fs-eval-1';

/**
 * Version tag of the consent text shown; recorded with the consent act, so a
 * package always says which wording its participant agreed to. BUMP IT
 * whenever the text changes materially — consent-2 added the automatic
 * transfer to the study server (delivery option B going live); consent-3
 * corrected the collection description, which had drifted badly behind the
 * code: the dialog promised "browser and platform version, screen size, and
 * time zone" and closed with "Nothing else is recorded", while the package had
 * grown a 14-field device block (unmasked GPU renderer, core count, deviceMemory
 * — a recognised fingerprinting triple), a preview.png of the participant's
 * work, a free-text comment box, and a shader bundle carrying note text, typed
 * property names and any dropped image or 3D model INCLUDING its file name.
 * consent-3 also stopped calling the researcher's own host "the university's
 * server" and made the outgoing email opt-in instead of automatic.
 */
export const CONSENT_TEXT_VERSION = 'consent-3';

/**
 * The two addresses the study app is served from. The upload target is a
 * SAME-ORIGIN relative path (`evalUpload.ts`), so the host is simply wherever
 * the participant loaded the app — moving between these needs no code change.
 * They are named here for the reader; the consent text spells them literally,
 * because in this codebase the English sentence IS the i18n key and an
 * interpolated constant would never match an entry in lv.json.
 */
export const EVAL_SERVER_HOSTS = ['alvismisjuns.lv', 'fs.sferas.lv'] as const;

/**
 * Data-protection officer contact, from the institution's data-management plan.
 *
 * EMPTY means "we do not have one to give", and the consent dialog then says so
 * by OMITTING the sentence rather than promising a route it cannot supply —
 * which is what consent-2 did ("you can also contact the university's data
 * protection officer", with no name, address or route). Fill this in and the
 * sentence appears automatically.
 */
export const EVAL_DPO_CONTACT = '';

/**
 * Concrete retention period, e.g. 'until 31 December 2028'. EMPTY falls back to
 * the honest-but-vague "for the duration of the research project"; a real
 * period is what GDPR Art. 13(2)(a) actually asks for.
 */
export const EVAL_RETENTION_PERIOD = '';

/**
 * Shouted at the researcher (never at the participant) on every study boot
 * while the two constants above are unset. The consent text stays truthful
 * either way — this exists so the gap cannot be forgotten, which is what the
 * TODO comment alone failed to prevent.
 */
export function warnIfConsentIncomplete(): void {
  const missing: string[] = [];
  if (!EVAL_DPO_CONTACT) missing.push('EVAL_DPO_CONTACT');
  if (!EVAL_RETENTION_PERIOD) missing.push('EVAL_RETENTION_PERIOD');
  if (missing.length === 0) return;
  console.warn(
    `[fs:eval] Consent text is incomplete: ${missing.join(', ')} unset in src/eval/evalMode.ts. ` +
      'Fill these in from the data-management plan before the first real participant.',
  );
}

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

/**
 * Decline path (and the post-submit teardown): drop the flag, the session
 * record AND the launch conditions, so a reload boots the STANDARD app.
 *
 * The task query is not optional here. `/evalp` stores `points=off`, and
 * leaving it behind meant "No thanks — open the normal app" handed the user an
 * app with no cost bar, no node prices and no budget lines: they had opted out
 * of the study and were still in its experimental condition, with no way back
 * short of clearing site data. Same for a reload after submitting.
 *
 * `EVAL_TASK_KEY` is imported from evalTask rather than re-spelled, so the
 * writer (the redirector), the reader and this eraser cannot drift apart.
 */
export function clearEvalMode(): void {
  try {
    sessionStorage.removeItem(EVAL_ARM_KEY);
    sessionStorage.removeItem(EVAL_SESSION_KEY);
    sessionStorage.removeItem(EVAL_TASK_KEY);
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
