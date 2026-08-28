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
  // code / preview / assets
  | 'code-apply'
  | 'preview-rebuild'
  | 'asset-drop'
  | 'import'
  | 'export'
  // periodic totals
  | 'snapshot'
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
    };
  }

  const t0 = events[0].t;
  const tEnd = events[events.length - 1].t;

  const markers: Interval[] = [];
  for (const e of events) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === 'node-add') {
      const nt = typeof e.nodeType === 'string' ? e.nodeType : 'unknown';
      nodeAddsByType[nt] = (nodeAddsByType[nt] ?? 0) + 1;
      if (firstAdd == null) firstAdd = e.t;
    }
    if (e.type === 'edge-connect' && firstConnect == null) firstConnect = e.t;
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
export function runQualityChecks(events: EvalEvent[], summary: EvalSummary): QualityCheck[] {
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
  'undo', 'redo', 'gesture', 'new-graph',
  'code-apply', 'preview-rebuild', 'asset-drop', 'import', 'export',
  'snapshot', 'sus-open', 'sus-submit',
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
