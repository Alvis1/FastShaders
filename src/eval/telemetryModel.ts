/**
 * Telemetry model — PURE (no DOM, no store), unit-tested under the node env.
 * The DOM half (listeners, journal, timers) lives in `telemetry.ts`.
 *
 * Design follows the interaction-logging literature (see EVAL_MODE_PLAN.md):
 * SEMANTIC events at a closed vocabulary (Hilbert & Redmiles 2000 — abstraction
 * happens at capture, never raw input streams), each event carrying a sequence
 * number and a monotonic timestamp (Dumais et al. — loss/reorder detection,
 * durations from `performance.now()` because `Date.now()` is unfit for them),
 * and active time DERIVED here from raw visibility/focus/activity transitions
 * under a declared idle threshold — so reviewers can recompute it under any
 * threshold from the events that ship in the package.
 */

/** Closed event vocabulary — v1 of the `fs-eval-1` schema. */
export type EvalEventType =
  // session lifecycle
  | 'session-start'
  | 'session-end'
  | 'recovered'
  | 'truncated'
  // presence / activity raw signals
  | 'visibility'
  | 'focus'
  | 'activity'
  // graph actions
  | 'node-add'
  | 'node-remove'
  | 'edge-connect'
  | 'edge-disconnect'
  | 'undo'
  | 'redo'
  | 'gesture'
  | 'new-graph'
  // the participant chose which output node drives (several may coexist)
  | 'output-activate'
  // code / preview / assets
  | 'code-apply'
  | 'preview-rebuild'
  | 'asset-drop'
  | 'import'
  | 'export'
  // periodic totals
  | 'snapshot'
  // task / condition identity
  | 'task-start'
  // cost feedback: the graph crossed the device budget in either direction
  | 'budget-crossed'
  // questionnaire
  | 'sus-open'
  | 'sus-submit';

export interface EvalEvent {
  /** 1-based, contiguous — a gap means events were lost. */
  seq: number;
  /** `Math.round(performance.now())` — monotonic ms since page timeOrigin. */
  t: number;
  type: EvalEventType;
  [key: string]: unknown;
}

/**
 * Events that count as the participant DOING something — the markers active
 * time is derived from. `visibility`/`focus` are state transitions, `snapshot`
 * and `preview-rebuild` are machine-driven, so none of those extend activity.
 */
export const ACTIVITY_EVENT_TYPES: ReadonlySet<EvalEventType> = new Set([
  'session-start',
  'activity',
  'node-add',
  'node-remove',
  'edge-connect',
  'edge-disconnect',
  'undo',
  'redo',
  'gesture',
  'new-graph',
  'output-activate',
  'code-apply',
  'asset-drop',
  'import',
  'export',
  'sus-open',
  'sus-submit',
]);

/** Events after which the graph likely changed → a debounced snapshot is due. */
export const STRUCTURAL_EVENT_TYPES: ReadonlySet<EvalEventType> = new Set([
  'node-add',
  'node-remove',
  'edge-connect',
  'edge-disconnect',
  'undo',
  'redo',
  'new-graph',
  'output-activate',
  'code-apply',
  'import',
]);

export interface EvalSummary {
  /** ms from first event to last event. */
  wallMs: number;
  /** Derived active time (see module doc) — never exceeds wallMs. */
  activeMs: number;
  /** The T the derivation used; declared so the number is interpretable. */
  idleThresholdMs: number;
  eventCount: number;
  /** Event counts by type. */
  counts: Record<string, number>;
  /** `node-add` counts by nodeType. */
  nodeAddsByType: Record<string, number>;
  distinctNodeTypesAdded: number;
  /** ms from session start, null when the event never happened. */
  timeToFirstNodeAddMs: number | null;
  timeToFirstConnectMs: number | null;
  undoCount: number;
  redoCount: number;
  codeApplyCount: number;
  previewRebuildCount: number;
  exportCount: number;
  /** Payload of the last `snapshot` event (final graph totals), if any. */
  finalSnapshot: Record<string, unknown> | null;
  /** How many times the graph crossed the device budget, either way. */
  budgetCrossings: number;
  /**
   * Total time the graph sat ABOVE the budget, from the `budget-crossed`
   * events alone (an 'over' opens the interval, the next 'under' closes it;
   * an interval still open at session end closes there). This is what makes
   * "did the warning change what they built" a one-line question.
   */
  overBudgetMs: number;
}

interface Interval {
  a: number;
  b: number;
}

/** Merge sorted-by-start intervals; assumes a ≤ b per interval. */
function mergeIntervals(list: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const iv of list) {
    const last = out[out.length - 1];
    if (last && iv.a <= last.b) {
      if (iv.b > last.b) last.b = iv.b;
    } else {
      out.push({ ...iv });
    }
  }
  return out;
}

function intersectLength(xs: Interval[], ys: Interval[]): number {
  let total = 0;
  let i = 0;
  let j = 0;
  while (i < xs.length && j < ys.length) {
    const a = Math.max(xs[i].a, ys[j].a);
    const b = Math.min(xs[i].b, ys[j].b);
    if (b > a) total += b - a;
    if (xs[i].b < ys[j].b) i++;
    else j++;
  }
  return total;
}

/**
 * "Present" intervals: visible AND focused, walked from the raw transition
 * events. Both start true — the session begins with the participant clicking
 * Agree, so the tab is foregrounded by construction.
 *
 * A blur whose focus target is one of the app's OWN iframes (the 3D preview;
 * the DOM side stamps `target: 'iframe'`) counts as still-present: the
 * participant clicked INTO the shader view, which is the opposite of leaving.
 */
function presentIntervals(events: EvalEvent[], t0: number, tEnd: number): Interval[] {
  const out: Interval[] = [];
  let visible = true;
  let focused = true;
  let openAt: number | null = t0;
  for (const e of events) {
    if (e.type !== 'visibility' && e.type !== 'focus') continue;
    const wasPresent = visible && focused;
    if (e.type === 'visibility') visible = e.state === 'visible';
    else focused = e.focused === true || e.target === 'iframe';
    const isPresent = visible && focused;
    if (wasPresent && !isPresent && openAt != null) {
      if (e.t > openAt) out.push({ a: openAt, b: e.t });
      openAt = null;
    } else if (!wasPresent && isPresent) {
      openAt = e.t;
    }
  }
  if (openAt != null && tEnd > openAt) out.push({ a: openAt, b: tEnd });
  return out;
}

export function deriveSummary(
  events: EvalEvent[],
  opts: { idleThresholdMs: number },
): EvalSummary {
  const T = opts.idleThresholdMs;
  // Null-prototype — the recovery path feeds these journal-supplied strings
  // (adversarial per the project's Record→Map/null-proto convention): a bare
  // object would no-op on a '__proto__' key and resolve 'constructor' weirdly.
  const counts: Record<string, number> = Object.create(null);
  const nodeAddsByType: Record<string, number> = Object.create(null);
  let finalSnapshot: Record<string, unknown> | null = null;
  let firstAdd: number | null = null;
  let firstConnect: number | null = null;

  if (events.length === 0) {
    return {
      wallMs: 0,
      activeMs: 0,
      idleThresholdMs: T,
      eventCount: 0,
      counts,
      nodeAddsByType,
      distinctNodeTypesAdded: 0,
      timeToFirstNodeAddMs: null,
      timeToFirstConnectMs: null,
      undoCount: 0,
      redoCount: 0,
      codeApplyCount: 0,
      previewRebuildCount: 0,
      exportCount: 0,
      finalSnapshot: null,
      budgetCrossings: 0,
      overBudgetMs: 0,
    };
  }

  const t0 = events[0].t;
  const tEnd = events[events.length - 1].t;

  const markers: Interval[] = [];
  let overSince: number | null = null;
  let overBudgetMs = 0;
  let budgetCrossings = 0;
  for (const e of events) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === 'node-add') {
      const nt = typeof e.nodeType === 'string' ? e.nodeType : 'unknown';
      nodeAddsByType[nt] = (nodeAddsByType[nt] ?? 0) + 1;
      if (firstAdd == null) firstAdd = e.t;
    }
    if (e.type === 'edge-connect' && firstConnect == null) firstConnect = e.t;
    if (e.type === 'budget-crossed') {
      budgetCrossings++;
      if (e.direction === 'over') {
        if (overSince == null) overSince = e.t;
      } else if (overSince != null) {
        overBudgetMs += e.t - overSince;
        overSince = null;
      }
    }
    if (e.type === 'snapshot') {
      const { seq: _s, t: _t, type: _ty, ...rest } = e;
      finalSnapshot = rest;
    }
    if (
      ACTIVITY_EVENT_TYPES.has(e.type) ||
      // Entering the app's own 3D-preview iframe is a deliberate act; input
      // inside the sandboxed iframe is unobservable, so the entry itself is
      // the marker (conservative — a long orbit still idles out after T).
      (e.type === 'focus' && e.target === 'iframe')
    ) {
      markers.push({ a: e.t, b: Math.min(e.t + T, tEnd) });
    }
  }

  const active = mergeIntervals(markers);
  const present = presentIntervals(events, t0, tEnd);
  const wallMs = tEnd - t0;
  // Deliberately NOT clamped to wallMs: with a sane log the intersection is
  // ≤ wall by construction, so the active-within-wall quality check stays a
  // REAL check — a clamp here would make it tautological.
  const activeMs = intersectLength(active, present);

  return {
    wallMs,
    activeMs,
    idleThresholdMs: T,
    eventCount: events.length,
    counts,
    nodeAddsByType,
    distinctNodeTypesAdded: Object.keys(nodeAddsByType).length,
    timeToFirstNodeAddMs: firstAdd == null ? null : firstAdd - t0,
    timeToFirstConnectMs: firstConnect == null ? null : firstConnect - t0,
    undoCount: counts['undo'] ?? 0,
    redoCount: counts['redo'] ?? 0,
    codeApplyCount: counts['code-apply'] ?? 0,
    previewRebuildCount: counts['preview-rebuild'] ?? 0,
    exportCount: counts['export'] ?? 0,
    finalSnapshot,
    budgetCrossings,
    // Still above budget when the session ended — close the interval there.
    overBudgetMs: overBudgetMs + (overSince == null ? 0 : tEnd - overSince),
  };
}

export interface QualityCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/**
 * Automated sanity checks (Dumais: "make sure you believe the numbers") — run
 * at package time so a broken capture is visible BEFORE the participant
 * leaves, and embedded in the zip so the analysis can trust or reject a log
 * without re-deriving these by hand.
 */
/** Events that mean the participant CHANGED THE GRAPH (not merely looked). */
const EDIT_EVENT_TYPES: ReadonlySet<EvalEventType> = new Set([
  'node-add', 'node-remove', 'edge-connect', 'edge-disconnect',
  'undo', 'redo', 'gesture', 'new-graph', 'output-activate', 'code-apply', 'asset-drop', 'import',
]);

/**
 * SUS responses that look like the participant stopped reading.
 *  - straight-lining: one answer for all ten items. SUS alternates polarity,
 *    so a uniform pattern agrees and disagrees with the same claim — it always
 *    scores exactly 50 and carries no information.
 *  - odd/even inconsistency: the positively worded items (odd) and the
 *    negatively worded ones (even) both read as agreement (or both as
 *    disagreement), which is self-contradictory.
 * Neither is proof of a bad response — both are FLAGS for the researcher to
 * weigh, which is why they ship in the package rather than blocking submit.
 */
export function susResponsePattern(responses: readonly number[]): {
  straightLining: boolean;
  oddEvenInconsistent: boolean;
} {
  if (responses.length !== 10 || responses.some((r) => !Number.isInteger(r))) {
    return { straightLining: false, oddEvenInconsistent: false };
  }
  const odd = responses.filter((_, i) => i % 2 === 0);
  const even = responses.filter((_, i) => i % 2 === 1);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const o = mean(odd);
  const e = mean(even);
  return {
    straightLining: responses.every((r) => r === responses[0]),
    // Both halves agreeing (or both disagreeing) with opposite claims.
    oddEvenInconsistent: (o >= 4 && e >= 4) || (o <= 2 && e <= 2),
  };
}

export interface QualityInput {
  /** The ten SUS responses, for the response-pattern checks. */
  susResponses?: readonly number[];
}

export function runQualityChecks(
  events: EvalEvent[],
  summary: EvalSummary,
  input: QualityInput = {},
): QualityCheck[] {
  const checks: QualityCheck[] = [];
  checks.push({
    id: 'has-events',
    ok: events.length > 0,
    detail: `${events.length} events recorded`,
  });

  const startOk = events.length > 0 && events[0].type === 'session-start';
  checks.push({
    id: 'starts-with-session-start',
    ok: startOk,
    detail: startOk ? 'first event is session-start' : `first event is ${events[0]?.type ?? 'absent'}`,
  });

  const endOk = events.length > 0 && events[events.length - 1].type === 'session-end';
  checks.push({
    id: 'ends-with-session-end',
    ok: endOk,
    detail: endOk ? 'last event is session-end' : `last event is ${events[events.length - 1]?.type ?? 'absent'}`,
  });

  let seqOk = true;
  let seqDetail = 'sequence numbers are contiguous';
  for (let i = 0; i < events.length; i++) {
    const expected = i === 0 ? events[0].seq : events[i - 1].seq + 1;
    if (events[i].seq !== expected) {
      seqOk = false;
      seqDetail = `gap at index ${i}: seq ${events[i].seq} after ${i === 0 ? 'start' : events[i - 1].seq}`;
      break;
    }
  }
  checks.push({ id: 'seq-contiguous', ok: seqOk, detail: seqDetail });

  let timeOk = true;
  let timeDetail = 'timestamps never decrease';
  for (let i = 1; i < events.length; i++) {
    if (events[i].t < events[i - 1].t) {
      timeOk = false;
      timeDetail = `t decreases at seq ${events[i].seq} (${events[i - 1].t} → ${events[i].t})`;
      break;
    }
  }
  checks.push({ id: 'time-monotone', ok: timeOk, detail: timeDetail });

  checks.push({
    id: 'active-within-wall',
    ok: summary.activeMs <= summary.wallMs,
    detail: `active ${summary.activeMs} ms of ${summary.wallMs} ms wall`,
  });

  const truncated = events.filter((e) => e.type === 'truncated').length;
  checks.push({
    id: 'no-truncation',
    ok: truncated === 0,
    detail: truncated === 0 ? 'no events were dropped' : `event cap reached ${truncated} time(s) — the tail of the session is missing`,
  });

  // The questionnaire must be answered in ONE sitting, immediately after the
  // session (Brooke's administration instruction). A long gap inside the SUS
  // phase means the participant left and came back to it.
  const susSubmit = events.find((e) => e.type === 'sus-submit');
  // The LAST sus-open before the submit, not the first. The questionnaire has a
  // "Back to the editor" button, so opening it, going back to fix one thing and
  // returning is a supported flow — and keying on the first open made that flow
  // report every edit in between as "edits after the questionnaire opened",
  // showing the participant a red data-quality panel and exiting
  // eval-analysis.mjs non-zero for a package that is perfectly fine.
  const susOpen = susSubmit
    ? [...events].reverse().find((e) => e.type === 'sus-open' && e.t <= susSubmit.t)
    : undefined;
  if (susOpen && susSubmit) {
    // `snapshot` is EXCLUDED from the gap measurement. telemetry.ts logs one
    // every 30 s while the tab is visible, which is half the 60 s threshold —
    // so with snapshots counted the gap could never reach it and this check
    // could only ever fire for a tab that was hidden or backgrounded. The
    // scenario it exists to catch is "the participant walked away with the
    // questionnaire open ON SCREEN", which is precisely the case snapshots
    // masked. Same for `activity`, which is a liveness ping rather than an
    // answer: the check is about progress through the form.
    const phase = events.filter(
      (e) =>
        e.t >= susOpen.t &&
        e.t <= susSubmit.t &&
        e.type !== 'snapshot' &&
        e.type !== 'activity',
    );
    let worstGap = 0;
    for (let i = 1; i < phase.length; i++) worstGap = Math.max(worstGap, phase[i].t - phase[i - 1].t);
    const span = susSubmit.t - susOpen.t;
    // With snapshots filtered out the phase can legitimately hold only the two
    // bounding events, and then the whole span IS the gap — a participant who
    // opened the form, sat for ten minutes and submitted logs nothing between.
    const gap = Math.max(worstGap, phase.length < 2 ? span : 0);
    checks.push({
      id: 'sus-in-one-sitting',
      ok: gap <= summary.idleThresholdMs,
      detail:
        gap <= summary.idleThresholdMs
          ? `answered in ${Math.round(span / 1000)} s with no gap over ${summary.idleThresholdMs / 1000} s`
          : `a ${Math.round(gap / 1000)} s gap inside the questionnaire (threshold ${summary.idleThresholdMs / 1000} s)`,
    });

    // Editing after the questionnaire opened means the shader in the package
    // is not the artifact the participant was rating.
    const editedAfter = events.filter((e) => e.t > susOpen.t && EDIT_EVENT_TYPES.has(e.type));
    checks.push({
      id: 'no-edits-after-sus-open',
      ok: editedAfter.length === 0,
      detail:
        editedAfter.length === 0
          ? 'the graph was not touched once the questionnaire opened'
          : `${editedAfter.length} edit(s) after the questionnaire opened — the packaged shader is not what was rated`,
    });
  }

  if (input.susResponses && input.susResponses.length === 10) {
    const pattern = susResponsePattern(input.susResponses);
    const flagged = pattern.straightLining || pattern.oddEvenInconsistent;
    checks.push({
      id: 'response-pattern',
      ok: !flagged,
      detail: flagged
        ? [
            pattern.straightLining ? 'straight-lined (one answer for all ten items)' : '',
            pattern.oddEvenInconsistent ? 'odd/even inconsistent (agrees with opposite claims)' : '',
          ].filter(Boolean).join('; ')
        : 'no straight-lining or odd/even inconsistency',
    });
  }

  const recovered = events.filter((e) => e.type === 'recovered').length;
  checks.push({
    id: 'recovery-noted',
    // A recovery is expected across a mid-session reload, so it is not a
    // failure — it is surfaced so the analysis knows the session had a seam.
    ok: true,
    detail: recovered === 0 ? 'no mid-session reloads' : `session resumed after reload ${recovered} time(s)`,
  });

  return checks;
}

/** Journal payload shape persisted to sessionStorage between flushes. */
export interface EvalJournal {
  v: 1;
  sessionId: string;
  /**
   * Wall-clock anchor (the first page's performance.timeOrigin) of the
   * session clock's zero. Load-bearing for recovery: performance.now()
   * restarts per page load, so without the anchor a resumed session cannot
   * rebase new events onto the old axis. Null when a legacy/tampered journal
   * lacks it — the DOM side then refuses to resume rather than mix epochs.
   */
  origin: number | null;
  events: EvalEvent[];
}

const MAX_JOURNAL_EVENTS = 60_000;
const EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'session-start', 'session-end', 'recovered', 'truncated',
  'visibility', 'focus', 'activity',
  'node-add', 'node-remove', 'edge-connect', 'edge-disconnect',
  'undo', 'redo', 'gesture', 'new-graph', 'output-activate',
  'code-apply', 'preview-rebuild', 'asset-drop', 'import', 'export',
  'snapshot', 'task-start', 'budget-crossed', 'sus-open', 'sus-submit',
]);

/**
 * Validate a parsed journal as adversarial input — localStorage is writable by
 * anything at the origin (the standing `sanitizeDrawings`/`edgeExtras` rule).
 * Events with a wrong shape are dropped rather than failing the whole journal:
 * a crash-recovery path that throws away a session over one bad row would lose
 * exactly the data it exists to save.
 */
export function sanitizeJournal(parsed: unknown): EvalJournal | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1 || typeof p.sessionId !== 'string' || p.sessionId.length > 200) return null;
  if (!Array.isArray(p.events)) return null;
  const origin = typeof p.origin === 'number' && Number.isFinite(p.origin) ? p.origin : null;
  const events: EvalEvent[] = [];
  for (const raw of p.events.slice(0, MAX_JOURNAL_EVENTS)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (
      typeof e.seq !== 'number' || !Number.isFinite(e.seq) ||
      typeof e.t !== 'number' || !Number.isFinite(e.t) ||
      typeof e.type !== 'string' || !EVENT_TYPES.has(e.type)
    ) {
      continue;
    }
    events.push(e as unknown as EvalEvent);
  }
  return { v: 1, sessionId: p.sessionId, origin, events };
}
