/**
 * Eval-mode telemetry — the DOM half (buffer, journal, listeners, timers).
 * The pure model (event vocabulary, summary derivation, quality checks,
 * journal sanitizing) lives in `telemetryModel.ts` and is node-tested.
 *
 * `evalLog` is called from a small, reviewed set of chokepoints (the store's
 * graph actions, NodeEditor's connect/delete paths, CodeEditor's Apply, the
 * export tail) — pinned by `evalHooks.test.ts` so telemetry can neither rot
 * nor quietly spread. Outside an active eval session every call is a boolean
 * check and a return: normal users pay nothing.
 *
 * Crash-safety: the buffer is journaled to SESSION storage — synchronous
 * writes, reliable at the teardown flush points (`visibilitychange → hidden`,
 * `pagehide`; `beforeunload` is documented-unreliable and unused).
 * sessionStorage rather than localStorage is a CONSENT decision, not a
 * convenience: it survives the mid-session reload the recovery path exists
 * for, and dies with the tab — which is exactly the "close the tab to
 * withdraw, nothing is kept" promise the consent screen makes. It also keeps
 * the journal out of the localStorage quota the fs:graph autosave lives in.
 *
 * Clock: every event's `t` sits on ONE monotonic axis anchored at the FIRST
 * page's `performance.timeOrigin`. `performance.now()` restarts at zero on
 * every reload, so the recovery path computes an epoch offset from the
 * anchor persisted in the journal — without it, a resumed session would mix
 * two clock domains and every derived duration would be garbage.
 *
 * Deliberately NOT imported: `useAppStore`. The store imports THIS module for
 * its `evalLog` calls, so the graph totals the periodic snapshot needs arrive
 * through a bridge the mounting component (`EvalGate`) registers instead —
 * no import cycle, and this module stays store-agnostic.
 */

import { safeJsonReviver } from '@/utils/safeJson';
import { EVAL_JOURNAL_KEY, type EvalSessionRecord } from './evalMode';
import {
  STRUCTURAL_EVENT_TYPES,
  sanitizeJournal,
  type EvalEvent,
  type EvalEventType,
} from './telemetryModel';

/** Graph facts the snapshot event records; supplied by EvalGate's bridge. */
export interface EvalBridge {
  getSnapshot(): Record<string, number>;
  /** Subscribe to (debounced) preview rebuilds; must return an unsubscribe. */
  subscribePreviewRebuild(cb: () => void): () => void;
}

/** In-memory cap — a runaway-loop backstop far above any real session. */
const MAX_EVENTS = 50_000;
/** Journal size cap — sessionStorage has its own origin quota, but the
 *  crash-recovery mirror still stays bounded. */
const MAX_JOURNAL_CHARS = 2_000_000;
/** Input heartbeats are coalesced to at most one `activity` event per this. */
const ACTIVITY_THROTTLE_MS = 5_000;
const FLUSH_INTERVAL_MS = 5_000;
const SNAPSHOT_INTERVAL_MS = 30_000;
const SNAPSHOT_DEBOUNCE_MS = 1_000;
const FLUSH_EVERY_N_EVENTS = 20;

let active = false;
let recordingStopped = false;
let sessionId = '';
let seq = 0;
let events: EvalEvent[] = [];
let dirty = false;
/** One-way per page load — nothing ever clears it. `pushEvent` relies on that
 *  (see `journalEventsJson`), and so does the early return in `flushJournal`. */
let journalFrozen = false;
/**
 * `events` serialized, comma-joined, WITHOUT the enclosing brackets — i.e.
 * exactly `JSON.stringify(events)` minus its `[` and `]`.
 *
 * WHY a running string rather than stringifying the array at flush time: a
 * flush happens every FLUSH_EVERY_N_EVENTS events AND every FLUSH_INTERVAL_MS,
 * so re-serializing the whole log each time is O(n) against a list that only
 * grows — quadratic over a session, and worst exactly where it hurts most. A
 * long study session walks up to MAX_JOURNAL_CHARS, where each flush is a
 * multi-millisecond hitch landing inside the interactions the study is timing.
 * Appending per event makes a flush O(new events); the O(n) that remains is
 * the sessionStorage write itself, which no scheme avoids.
 *
 * THE INVARIANT: this string and `events` must describe the SAME list. `events`
 * is written in exactly two places — `pushEvent` (which appends here too) and
 * `startEvalSession` (which rebuilds or clears this alongside it) — and it has
 * to stay that way, because a desync corrupts the crash-recovery journal
 * SILENTLY: `sanitizeJournal` would reject the malformed record and a resumed
 * session would simply start over, losing everything before the reload.
 */
let journalEventsJson = '';

/** Wall-clock anchor of the session's t=0 (the FIRST page's timeOrigin). */
let clockOriginMs = 0;
/** Added to performance.now() so post-reload events stay on the session axis. */
let epochOffsetMs = 0;

let bridge: EvalBridge | null = null;
let teardown: (() => void)[] = [];
let snapshotTimer: number | null = null;
let lastActivityLogT = -Infinity;

export function initEvalBridge(b: EvalBridge): void {
  bridge = b;
}

/** Whether a study session is currently recording. Exposed so a call site can
 *  skip building an expensive payload for a log that would be dropped. */
export function isEvalSessionActive(): boolean {
  return active;
}

/** Wall-clock ms of the session clock's zero — ships in session.json so the
 *  package's `t` values can be placed in calendar time offline. */
export function getEvalClockOriginMs(): number {
  return clockOriginMs;
}

/**
 * Record one semantic event. No-op outside an active session — the guard is
 * the FIRST line so chokepoint calls cost one boolean read in normal use.
 */
export function evalLog(type: EvalEventType, payload?: Record<string, unknown>): void {
  if (!active) return;
  if (recordingStopped && type !== 'session-end' && type !== 'sus-submit' && type !== 'sus-open') {
    return;
  }
  if (events.length >= MAX_EVENTS && !recordingStopped) {
    recordingStopped = true;
    pushEvent({ seq: ++seq, t: now(), type: 'truncated' });
    return;
  }
  const e: EvalEvent = { ...payload, seq: ++seq, t: now(), type };
  pushEvent(e);
  if (STRUCTURAL_EVENT_TYPES.has(type)) scheduleSnapshot();
  if (events.length % FLUSH_EVERY_N_EVENTS === 0) flushJournal();
}

function now(): number {
  return Math.round(performance.now()) + epochOffsetMs;
}

/** The ONLY place an event is appended — see `journalEventsJson`'s invariant. */
function pushEvent(e: EvalEvent): void {
  events.push(e);
  dirty = true;
  // Skipping the append once frozen is safe only because the flag is one-way:
  // `flushJournal` never reads the string again, so the two are allowed to
  // diverge from here on and the string stops growing past the cap.
  if (journalFrozen) return;
  try {
    journalEventsJson += (journalEventsJson ? ',' : '') + JSON.stringify(e);
  } catch {
    // A payload that will not serialize must never take the session down:
    // degrade exactly as a quota error does — the in-memory log (which builds
    // the final package) keeps recording, only crash recovery stops. Before
    // this the same throw escaped `flushJournal` into whichever chokepoint
    // happened to log the 20th event.
    journalFrozen = true;
  }
}

/** Rebuild the journal string from `events`. Recovery only. */
function rebuildJournalJson(): void {
  try {
    journalEventsJson = events.map((e) => JSON.stringify(e)).join(',');
  } catch {
    journalFrozen = true;
  }
}

function scheduleSnapshot(): void {
  if (!bridge || snapshotTimer != null) return;
  snapshotTimer = window.setTimeout(() => {
    snapshotTimer = null;
    recordSnapshot();
  }, SNAPSHOT_DEBOUNCE_MS);
}

function recordSnapshot(): void {
  if (!active || !bridge) return;
  try {
    evalLog('snapshot', bridge.getSnapshot());
  } catch {
    // A snapshot must never take the session down.
  }
}

function flushJournal(): void {
  if (!dirty || journalFrozen) return;
  dirty = false;
  // Concatenated rather than stringified whole — see `journalEventsJson`. The
  // bytes are identical to the old `JSON.stringify({ v, sessionId, origin,
  // events })`: same key order, and an array's serialization IS its elements'
  // serializations joined by commas. `origin` goes through JSON.stringify so a
  // non-finite value still lands as `null` rather than the literal `NaN`, which
  // would make the record unparseable instead of merely unusable.
  const payload =
    `{"v":1,"sessionId":${JSON.stringify(sessionId)},` +
    `"origin":${JSON.stringify(clockOriginMs)},"events":[${journalEventsJson}]}`;
  if (payload.length > MAX_JOURNAL_CHARS) {
    // The in-memory log (which builds the final package) keeps recording;
    // only the crash-recovery mirror stops growing.
    journalFrozen = true;
    return;
  }
  try {
    sessionStorage.setItem(EVAL_JOURNAL_KEY, payload);
  } catch {
    // Quota — same posture: the live session continues, recovery degrades.
    journalFrozen = true;
  }
}

function readJournal(): { sessionId: string; origin: number | null; events: EvalEvent[] } | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(EVAL_JOURNAL_KEY);
  } catch {
    return null;
  }
  if (!raw || raw.length > MAX_JOURNAL_CHARS * 2) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, safeJsonReviver);
  } catch {
    return null;
  }
  const journal = sanitizeJournal(parsed);
  return journal ? { sessionId: journal.sessionId, origin: journal.origin, events: journal.events } : null;
}

export function clearEvalJournal(): void {
  try {
    sessionStorage.removeItem(EVAL_JOURNAL_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Start (or resume) the session. If the journal belongs to the same session
 * id AND carries a usable clock anchor, this is a mid-session reload: the
 * events are restored, new timestamps are rebased onto the original axis,
 * and the seam is marked `recovered` followed by the CURRENT presence state
 * (a page that loads visible fires no visibilitychange, so without the
 * explicit re-open the flushed pre-reload `hidden` would leave the presence
 * model closed for the whole rest of the session).
 */
export function startEvalSession(rec: EvalSessionRecord): void {
  if (active) return;
  sessionId = rec.id;
  const pageOrigin = Math.round(performance.timeOrigin);
  const journal = readJournal();
  const resumable =
    journal != null &&
    journal.sessionId === rec.id &&
    journal.events.length > 0 &&
    journal.origin != null;

  if (resumable) {
    events = journal.events;
    rebuildJournalJson();
    seq = events[events.length - 1].seq;
    clockOriginMs = journal.origin as number;
    // Rebase this page's performance.now() onto the session axis. The floor
    // keeps `t` monotone past the restored maximum even if the wall clock
    // was adjusted between the two page loads.
    const lastT = events[events.length - 1].t;
    epochOffsetMs = Math.max(pageOrigin - clockOriginMs, lastT - Math.round(performance.now()) + 1);
    active = true;
    evalLog('recovered');
    evalLog('visibility', {
      state: document.visibilityState === 'visible' ? 'visible' : 'hidden',
    });
    evalLog('focus', { focused: document.hasFocus() });
  } else {
    events = [];
    journalEventsJson = '';
    seq = 0;
    clockOriginMs = pageOrigin;
    epochOffsetMs = 0;
    clearEvalJournal();
    active = true;
    evalLog('session-start');
  }
  attachListeners();
  flushJournal();
}

/** Stop recording and detach everything. Called from the SUS submit path. */
export function endEvalSession(): void {
  if (!active) return;
  if (snapshotTimer != null) {
    window.clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  recordSnapshot();
  evalLog('session-end');
  flushJournal();
  active = false;
  recordingStopped = false;
  for (const fn of teardown) fn();
  teardown = [];
}

/** The recorded events, for package assembly. */
export function getEvalEvents(): EvalEvent[] {
  return events.slice();
}

function attachListeners(): void {
  const onVisibility = () => {
    evalLog('visibility', { state: document.visibilityState === 'visible' ? 'visible' : 'hidden' });
    if (document.visibilityState !== 'visible') flushJournal();
  };
  const onFocus = () => evalLog('focus', { focused: true });
  const onBlur = () => {
    // Focus moving INTO one of the app's own iframes (the 3D preview) blurs
    // the window, but the participant has not left — record the distinction
    // so the presence model doesn't count shader-inspection as absence.
    // (Input inside the sandboxed iframe is unobservable from here; the
    // derivation treats the entry as an activity marker and the README
    // documents the conservative counting.)
    const toIframe = document.activeElement?.tagName === 'IFRAME';
    evalLog('focus', toIframe ? { focused: false, target: 'iframe' } : { focused: false });
  };
  const onPageHide = () => flushJournal();
  const onInput = () => {
    const t = performance.now();
    if (t - lastActivityLogT < ACTIVITY_THROTTLE_MS) return;
    lastActivityLogT = t;
    evalLog('activity');
  };
  const onImported = () => evalLog('import');

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pointerdown', onInput, { capture: true, passive: true });
  window.addEventListener('keydown', onInput, { capture: true, passive: true });
  window.addEventListener('wheel', onInput, { capture: true, passive: true });
  window.addEventListener('fs:graph-imported', onImported);

  const flushTimer = window.setInterval(flushJournal, FLUSH_INTERVAL_MS);
  const snapshotInterval = window.setInterval(() => {
    if (document.visibilityState === 'visible') recordSnapshot();
  }, SNAPSHOT_INTERVAL_MS);

  const unsubRebuild = bridge
    ? bridge.subscribePreviewRebuild(() => evalLog('preview-rebuild'))
    : () => {};

  teardown.push(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pointerdown', onInput, { capture: true });
    window.removeEventListener('keydown', onInput, { capture: true });
    window.removeEventListener('wheel', onInput, { capture: true });
    window.removeEventListener('fs:graph-imported', onImported);
    window.clearInterval(flushTimer);
    window.clearInterval(snapshotInterval);
    unsubRebuild();
  });
}
