import { describe, it, expect } from 'vitest';
import {
  deriveSummary,
  nodeEditFields,
  runQualityChecks,
  sanitizeJournal,
  susResponsePattern,
  type EvalEvent,
  type EvalEventType,
} from './telemetryModel';

/** Build a well-formed event stream from [type, t, payload?] tuples. */
function stream(rows: [EvalEventType, number, Record<string, unknown>?][]): EvalEvent[] {
  return rows.map(([type, t, payload], i) => ({ ...(payload ?? {}), seq: i + 1, t, type }));
}

const T = 60_000;

describe('deriveSummary — active time', () => {
  it('returns zeros for an empty log', () => {
    // The WHOLE shape: an empty log runs the general path, not a second literal.
    expect(deriveSummary([], { idleThresholdMs: T })).toEqual({
      wallMs: 0, activeMs: 0, idleThresholdMs: T, eventCount: 0,
      counts: {}, nodeAddsByType: {}, distinctNodeTypesAdded: 0,
      timeToFirstNodeAddMs: null, timeToFirstConnectMs: null,
      undoCount: 0, redoCount: 0, codeApplyCount: 0, previewRebuildCount: 0, exportCount: 0,
      finalSnapshot: null, budgetCrossings: 0, overBudgetMs: 0,
      assetDropsByKind: {}, assetNodesAdded: 0, nodeEditCount: 0, gestureCount: 0,
      introOpenCount: 0, introMs: 0, introSlidesSeen: 0,
      tutorialStartCount: 0, tutorialsCompleted: 0, tutorialAutoSteps: 0,
    });
  });

  it('wall time spans first to last event', () => {
    const s = deriveSummary(
      stream([
        ['session-start', 0],
        ['session-end', 300_000],
      ]),
      { idleThresholdMs: T },
    );
    expect(s.wallMs).toBe(300_000);
  });

  it('a lone activity marker is active for exactly the threshold', () => {
    const s = deriveSummary(
      stream([
        ['session-start', 0],
        ['session-end', 300_000],
      ]),
      { idleThresholdMs: T },
    );
    // session-start is itself an activity marker (it is a click on Agree).
    expect(s.activeMs).toBe(T);
  });

  it('overlapping markers merge instead of double-counting', () => {
    const s = deriveSummary(
      stream([
        ['session-start', 0],
        ['activity', 10_000],
        ['session-end', 300_000],
      ]),
      { idleThresholdMs: T },
    );
    // [0,60k] ∪ [10k,70k] = [0,70k]
    expect(s.activeMs).toBe(70_000);
  });

  it('an idle gap between markers is not counted', () => {
    const s = deriveSummary(
      stream([
        ['session-start', 0],
        ['activity', 200_000],
        ['session-end', 300_000],
      ]),
      { idleThresholdMs: T },
    );
    // [0,60k] + [200k,260k]
    expect(s.activeMs).toBe(120_000);
  });

  it('hidden-tab periods are excluded even inside an activity window', () => {
    const s = deriveSummary(
      stream([
        ['session-start', 0],
        ['visibility', 20_000, { state: 'hidden' }],
        ['visibility', 40_000, { state: 'visible' }],
        ['session-end', 300_000],
      ]),
      { idleThresholdMs: T },
    );
    // Marker window [0,60k] ∩ present ([0,20k] ∪ [40k,300k]) = 20k + 20k.
    expect(s.activeMs).toBe(40_000);
  });

  it('focus moving into the app\'s own iframe counts as PRESENT and as activity', () => {
    // Clicking into the 3D preview blurs the window; without the target tag
    // the participant's shader inspection would be counted as absence.
    const s = deriveSummary(
      stream([
        ['session-start', 0],
        ['focus', 100_000, { focused: false, target: 'iframe' }],
        ['focus', 130_000, { focused: true }],
        ['session-end', 300_000],
      ]),
      { idleThresholdMs: T },
    );
    // Markers: session-start [0,60k] + iframe entry [100k,160k]; presence
    // never closes (iframe target keeps focused true).
    expect(s.activeMs).toBe(120_000);
  });

  it('a plain blur (no iframe target) still closes presence', () => {
    const s = deriveSummary(
      stream([
        ['session-start', 0],
        ['focus', 100_000, { focused: false }],
        ['session-end', 300_000],
      ]),
      { idleThresholdMs: T },
    );
    expect(s.activeMs).toBe(60_000);
  });

  it('blur/focus behaves like hide/show', () => {
    const s = deriveSummary(
      stream([
        ['session-start', 0],
        ['focus', 30_000, { focused: false }],
        ['focus', 50_000, { focused: true }],
        ['session-end', 300_000],
      ]),
      { idleThresholdMs: T },
    );
    // [0,60k] ∩ ([0,30k] ∪ [50k,300k]) = 30k + 10k.
    expect(s.activeMs).toBe(40_000);
  });

  it('the threshold is a declared parameter — same events, different T, different number', () => {
    const events = stream([
      ['session-start', 0],
      ['activity', 100_000],
      ['session-end', 300_000],
    ]);
    expect(deriveSummary(events, { idleThresholdMs: 30_000 }).activeMs).toBe(60_000);
    expect(deriveSummary(events, { idleThresholdMs: 60_000 }).activeMs).toBe(120_000);
  });

  it('active time never exceeds wall time', () => {
    const events = stream([
      ['session-start', 0],
      ['activity', 1_000],
      ['activity', 2_000],
      ['session-end', 5_000],
    ]);
    const s = deriveSummary(events, { idleThresholdMs: T });
    expect(s.activeMs).toBeLessThanOrEqual(s.wallMs);
    expect(s.activeMs).toBe(5_000);
  });
});

describe('deriveSummary — counts and firsts', () => {
  const events = stream([
    ['session-start', 0],
    ['node-add', 5_000, { nodeType: 'perlin' }],
    ['node-add', 8_000, { nodeType: 'mix' }],
    ['node-add', 9_000, { nodeType: 'perlin' }],
    ['edge-connect', 12_000, { sourceType: 'perlin', targetType: 'mix', targetHandle: 'a' }],
    ['undo', 15_000],
    ['undo', 16_000],
    ['redo', 17_000],
    ['code-apply', 20_000],
    ['preview-rebuild', 21_000],
    ['export', 25_000, { kind: 'js' }],
    ['snapshot', 26_000, { nodes: 4, connections: 1, costPoints: 42 }],
    ['session-end', 30_000],
  ]);
  const s = deriveSummary(events, { idleThresholdMs: T });

  it('counts events by type', () => {
    expect(s.counts['node-add']).toBe(3);
    expect(s.undoCount).toBe(2);
    expect(s.redoCount).toBe(1);
    expect(s.codeApplyCount).toBe(1);
    expect(s.previewRebuildCount).toBe(1);
    expect(s.exportCount).toBe(1);
    expect(s.eventCount).toBe(events.length);
  });

  it('breaks node adds down by type', () => {
    expect(s.nodeAddsByType).toEqual({ perlin: 2, mix: 1 });
    expect(s.distinctNodeTypesAdded).toBe(2);
  });

  it('reports time-to-first metrics relative to session start', () => {
    expect(s.timeToFirstNodeAddMs).toBe(5_000);
    expect(s.timeToFirstConnectMs).toBe(12_000);
  });

  it('keeps the last snapshot as the final graph totals', () => {
    expect(s.finalSnapshot).toEqual({ nodes: 4, connections: 1, costPoints: 42 });
  });

  it('survives adversarial nodeType keys (__proto__/constructor)', () => {
    // Journal-supplied strings key nodeAddsByType — the null-prototype rule.
    const evil = deriveSummary(
      stream([
        ['session-start', 0],
        ['node-add', 1_000, { nodeType: '__proto__' }],
        ['node-add', 2_000, { nodeType: 'constructor' }],
        ['session-end', 3_000],
      ]),
      { idleThresholdMs: T },
    );
    expect(evil.nodeAddsByType['__proto__']).toBe(1);
    expect(evil.nodeAddsByType['constructor']).toBe(1);
    expect(evil.distinctNodeTypesAdded).toBe(2);
  });

  it('reports null firsts when the event never happened', () => {
    const bare = deriveSummary(stream([['session-start', 0], ['session-end', 1_000]]), {
      idleThresholdMs: T,
    });
    expect(bare.timeToFirstConnectMs).toBeNull();
    expect(bare.timeToFirstNodeAddMs).toBeNull();
  });
});

describe('runQualityChecks', () => {
  const good = stream([
    ['session-start', 0],
    ['node-add', 1_000, { nodeType: 'perlin' }],
    ['session-end', 2_000],
  ]);

  it('passes a clean log', () => {
    const summary = deriveSummary(good, { idleThresholdMs: T });
    const checks = runQualityChecks(good, summary);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('fails on a sequence gap', () => {
    const gapped = good.map((e) => (e.seq === 2 ? { ...e, seq: 5 } : e));
    const checks = runQualityChecks(gapped, deriveSummary(gapped, { idleThresholdMs: T }));
    expect(checks.find((c) => c.id === 'seq-contiguous')?.ok).toBe(false);
  });

  it('fails on a time reversal', () => {
    const reversed = good.map((e) => (e.seq === 2 ? { ...e, t: 5_000 } : e));
    const checks = runQualityChecks(reversed, deriveSummary(reversed, { idleThresholdMs: T }));
    expect(checks.find((c) => c.id === 'time-monotone')?.ok).toBe(false);
  });

  it('fails when the log does not start with session-start or end with session-end', () => {
    const headless = good.slice(1);
    const checksA = runQualityChecks(headless, deriveSummary(headless, { idleThresholdMs: T }));
    expect(checksA.find((c) => c.id === 'starts-with-session-start')?.ok).toBe(false);

    const tailless = good.slice(0, -1);
    const checksB = runQualityChecks(tailless, deriveSummary(tailless, { idleThresholdMs: T }));
    expect(checksB.find((c) => c.id === 'ends-with-session-end')?.ok).toBe(false);
  });

  it('flags truncation as a failure but recovery as a note', () => {
    const truncated = stream([
      ['session-start', 0],
      ['truncated', 1_000],
      ['session-end', 2_000],
    ]);
    const checks = runQualityChecks(truncated, deriveSummary(truncated, { idleThresholdMs: T }));
    expect(checks.find((c) => c.id === 'no-truncation')?.ok).toBe(false);

    const recovered = stream([
      ['session-start', 0],
      ['recovered', 1_000],
      ['session-end', 2_000],
    ]);
    const checks2 = runQualityChecks(recovered, deriveSummary(recovered, { idleThresholdMs: T }));
    expect(checks2.find((c) => c.id === 'recovery-noted')?.ok).toBe(true);
    expect(checks2.find((c) => c.id === 'recovery-noted')?.detail).toContain('1');
  });
});

describe('sanitizeJournal — adversarial storage', () => {
  it('accepts a well-formed journal and keeps the clock anchor', () => {
    const events = stream([['session-start', 0], ['session-end', 1_000]]);
    const j = sanitizeJournal({ v: 1, sessionId: 'es-1', origin: 1_787_000_000_000, events });
    expect(j).not.toBeNull();
    expect(j!.events).toHaveLength(2);
    expect(j!.origin).toBe(1_787_000_000_000);
  });

  it('a missing or junk clock anchor becomes null (refuse-to-resume signal)', () => {
    const events = stream([['session-start', 0]]);
    expect(sanitizeJournal({ v: 1, sessionId: 'a', events })!.origin).toBeNull();
    expect(sanitizeJournal({ v: 1, sessionId: 'a', origin: 'x', events })!.origin).toBeNull();
    expect(sanitizeJournal({ v: 1, sessionId: 'a', origin: NaN, events })!.origin).toBeNull();
  });

  it('rejects wrong roots and versions', () => {
    expect(sanitizeJournal(null)).toBeNull();
    expect(sanitizeJournal('x')).toBeNull();
    expect(sanitizeJournal({ v: 2, sessionId: 'a', events: [] })).toBeNull();
    expect(sanitizeJournal({ v: 1, sessionId: 5, events: [] })).toBeNull();
    expect(sanitizeJournal({ v: 1, sessionId: 'a', events: 'nope' })).toBeNull();
  });

  it('drops malformed events instead of failing the whole journal', () => {
    const j = sanitizeJournal({
      v: 1,
      sessionId: 'es-1',
      events: [
        { seq: 1, t: 0, type: 'session-start' },
        null,
        'junk',
        { seq: 'x', t: 0, type: 'activity' },
        { seq: 2, t: NaN, type: 'activity' },
        { seq: 2, t: 10, type: 'not-a-real-type' },
        { seq: 2, t: 10, type: 'activity' },
      ],
    });
    expect(j).not.toBeNull();
    expect(j!.events.map((e) => e.type)).toEqual(['session-start', 'activity']);
  });

  it('keeps language switches across a reload (the sanitizer reads the one vocabulary list)', () => {
    const events = stream([
      ['session-start', 0, { language: 'lv' }],
      ['lang-switch', 5_000, { from: 'lv', to: 'en' }],
    ]);
    const j = sanitizeJournal({ v: 1, sessionId: 'es-1', origin: 1_787_000_000_000, events });
    expect(j!.events).toEqual(events);
  });
});

describe('budget crossings', () => {
  it('accumulates the time spent above budget and closes an open interval', () => {
    const s = deriveSummary(
      stream([
        ['session-start', 0],
        ['budget-crossed', 10_000, { direction: 'over', total: 250, budget: 200 }],
        ['budget-crossed', 40_000, { direction: 'under', total: 180, budget: 200 }],
        ['budget-crossed', 60_000, { direction: 'over', total: 210, budget: 200 }],
        ['session-end', 100_000],
      ]),
      { idleThresholdMs: T },
    );
    // 10k→40k plus 60k→end.
    expect(s.overBudgetMs).toBe(70_000);
    expect(s.budgetCrossings).toBe(3);
  });

  it('is zero when the budget was never crossed', () => {
    const s = deriveSummary(stream([['session-start', 0], ['session-end', 5_000]]), { idleThresholdMs: T });
    expect(s.overBudgetMs).toBe(0);
    expect(s.budgetCrossings).toBe(0);
  });
});

describe('ready-made material, setting edits and the intro', () => {
  it('counts asset drops by kind and the nodes they brought', () => {
    // The first test package: one preset brought 11 of the 13 nodes, and
    // node_adds read 2.
    const s = deriveSummary(
      stream([
        ['session-start', 0],
        ['asset-drop', 4_000, { kind: 'preset', id: 'vertex-wave', nodes: 11, wired: 1 }],
        ['asset-drop', 25_000, { kind: 'node', id: 'fbm' }],
        ['node-add', 25_000, { nodeType: 'fbm' }],
        ['asset-drop', 50_000, { kind: 'file', id: 'imageNode' }],
        ['node-add', 50_000, { nodeType: 'imageNode' }],
        ['asset-drop', 60_000, { kind: 'texture', id: 'gas-giant', nodes: 7 }],
        ['asset-drop', 61_000, { kind: 'texture', id: 'x', nodes: 'lots' }],
        ['session-end', 70_000],
      ]),
      { idleThresholdMs: T },
    );
    expect(s.assetDropsByKind).toEqual({ preset: 1, node: 1, file: 1, texture: 2 });
    expect(s.assetNodesAdded).toBe(18);
    expect(Object.values(s.nodeAddsByType).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('counts discrete edits apart from continuous gestures', () => {
    const s = deriveSummary(
      stream([
        ['session-start', 0],
        ['node-edit', 1_000, { nodeType: 'perlin', fields: ['values.scale'] }],
        ['gesture', 2_000],
        ['node-edit', 3_000, { nodeType: 'output', fields: ['exposedPorts'] }],
        ['session-end', 4_000],
      ]),
      { idleThresholdMs: T },
    );
    expect(s.nodeEditCount).toBe(2);
    expect(s.gestureCount).toBe(1);
  });

  it('times the intro, counts its distinct slides, and closes an open one at a reload or the end', () => {
    const s = deriveSummary(
      stream([
        ['session-start', 0],
        ['intro-open', 100, { via: 'start', slide: 'connect' }],
        ['intro-slide', 5_000, { slide: 'insert' }],
        ['intro-slide', 9_000, { slide: 'connect' }],
        ['intro-close', 20_100, { slide: 'connect' }],
        // Reopened from the toolbar, then a reload ate the close.
        ['intro-open', 40_000, { via: 'toolbar', slide: 'connect' }],
        ['intro-slide', 41_000, { slide: 'model' }],
        ['recovered', 50_000],
        // Opened again and still open when the session ended.
        ['intro-open', 60_000, { via: 'toolbar', slide: 'connect' }],
        ['session-end', 65_000],
      ]),
      { idleThresholdMs: T },
    );
    expect(s.introOpenCount).toBe(3);
    expect(s.introMs).toBe(20_000 + 10_000 + 5_000);
    expect(s.introSlidesSeen).toBe(3);
  });

  it('lessons: started, completed (distinct), and what "Do it for me" did is not the participant\'s work', () => {
    const s = deriveSummary(
      stream([
        ['session-start', 0],
        ['tutorial-start', 1_000, { lesson: 'first-wire' }],
        ['tutorial-auto', 2_000, { lesson: 'first-wire', step: 0 }],
        ['node-add', 2_000, { nodeType: 'perlin', auto: true }],
        ['node-edit', 2_000, { nodeType: 'perlin', fields: ['values.scale'], auto: true }],
        ['tutorial-step', 3_000, { lesson: 'first-wire', step: 1 }],
        ['node-add', 4_000, { nodeType: 'color' }],
        ['tutorial-end', 5_000, { lesson: 'first-wire', step: 1, outcome: 'keep', completed: true }],
        ['tutorial-start', 6_000, { lesson: 'first-wire' }],
        ['tutorial-end', 7_000, { lesson: 'first-wire', step: 1, outcome: 'keep', completed: true }],
        ['tutorial-start', 8_000, { lesson: 'uv-ramp' }],
        ['tutorial-end', 9_000, { lesson: 'uv-ramp', step: 0, outcome: 'new', completed: false }],
        ['session-end', 10_000],
      ]),
      { idleThresholdMs: T },
    );
    expect([s.tutorialStartCount, s.tutorialsCompleted, s.tutorialAutoSteps]).toEqual([3, 1, 1]);
    expect(s.nodeAddsByType).toEqual({ color: 1 });
    expect(s.nodeEditCount).toBe(0);
    expect(s.timeToFirstNodeAddMs).toBe(4_000);
    // The raw counts still hold every event.
    expect(s.counts['node-add']).toBe(2);
  });

  it('intro events and setting edits keep the participant ACTIVE', () => {
    // Paging slides for three minutes is not idling.
    const rows: [EvalEventType, number, Record<string, unknown>?][] = [['session-start', 0], ['intro-open', 0, { slide: 'connect' }]];
    for (let t = 50_000; t <= 150_000; t += 50_000) rows.push(['intro-slide', t, { slide: `s${t}` }]);
    rows.push(['intro-close', 180_000], ['session-end', 180_000]);
    expect(deriveSummary(stream(rows), { idleThresholdMs: T }).activeMs).toBe(180_000);
  });
});

describe('nodeEditFields', () => {
  it('names the settings that changed, never their values', () => {
    expect(nodeEditFields({ values: { scale: '1', octaves: 3 } }, { values: { scale: '2', octaves: 3 } })).toEqual(['values.scale']);
    expect(nodeEditFields({ label: 'a', exposedPorts: ['x'] }, { exposedPorts: ['x', 'y'] })).toEqual(['exposedPorts']);
  });

  it('a removed value key is a change; an identical patch is none', () => {
    expect(nodeEditFields({ values: { a: 1, b: 2 } }, { values: { a: 1 } })).toEqual(['values.b']);
    expect(nodeEditFields({ values: { a: 1 } }, { values: { a: 1 } })).toEqual([]);
  });

  it('drops anything that is not a plain identifier, and caps the list', () => {
    expect(nodeEditFields({ values: {} }, { values: { 'my name': 1, ok_1: 2, '': 3 } })).toEqual(['values.ok_1']);
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]));
    expect(nodeEditFields({ values: {} }, { values: many })).toHaveLength(8);
  });

  it('survives a node with no data and a non-object values', () => {
    expect(nodeEditFields(undefined, { label: 'x' })).toEqual(['label']);
    expect(nodeEditFields({ values: 5 }, { values: { a: 1 } })).toEqual(['values.a']);
  });
});

describe('SUS sequence integrity', () => {
  const base: [string, number, Record<string, unknown>?][] = [
    ['session-start', 0],
    ['node-add', 1_000, { nodeType: 'perlin' }],
  ];

  it('passes a questionnaire answered in one sitting with no edits after it opened', () => {
    const ev = stream([...base, ['sus-open', 10_000], ['sus-submit', 60_000], ['session-end', 61_000]] as never);
    const checks = runQualityChecks(ev, deriveSummary(ev, { idleThresholdMs: T }));
    expect(checks.find((c) => c.id === 'sus-in-one-sitting')?.ok).toBe(true);
    expect(checks.find((c) => c.id === 'no-edits-after-sus-open')?.ok).toBe(true);
  });

  it('a questionnaire that takes longer than the threshold passes when input runs through it', () => {
    // The first test package (2026-10-20): 62 s on the form with an `activity`
    // every 5–11 s, failed because activity was excluded and the whole span
    // became the "gap". Answering logs nothing BUT activity.
    const acts: [string, number][] = [];
    for (let t = 15_000; t < 170_000; t += 8_000) acts.push(['activity', t]);
    const ev = stream([
      ...base,
      ['sus-open', 10_000],
      ...acts,
      ['snapshot', 40_000],
      ['sus-submit', 172_000],
      ['session-end', 172_000],
    ] as never);
    const checks = runQualityChecks(ev, deriveSummary(ev, { idleThresholdMs: T }));
    expect(checks.find((c) => c.id === 'sus-in-one-sitting')?.ok).toBe(true);
  });

  it('a real pause inside the form still fails, even with input on both sides of it', () => {
    const ev = stream([
      ...base,
      ['sus-open', 10_000],
      ['activity', 15_000],
      ['snapshot', 45_000],
      ['snapshot', 75_000],
      ['activity', 100_000],
      ['sus-submit', 105_000],
      ['session-end', 105_000],
    ] as never);
    const check = runQualityChecks(ev, deriveSummary(ev, { idleThresholdMs: T })).find((c) => c.id === 'sus-in-one-sitting');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('85 s gap');
  });

  it('flags a long gap inside the questionnaire phase', () => {
    // Opened, then answered five minutes later — not the immediate response
    // Brooke's administration instruction asks for.
    const ev = stream([...base, ['sus-open', 10_000], ['sus-submit', 320_000], ['session-end', 321_000]] as never);
    const checks = runQualityChecks(ev, deriveSummary(ev, { idleThresholdMs: T }));
    expect(checks.find((c) => c.id === 'sus-in-one-sitting')?.ok).toBe(false);
  });

  it('a 30s snapshot stream cannot mask a long gap in the questionnaire', () => {
    // telemetry.ts logs a `snapshot` every 30 s while the tab is VISIBLE — half
    // the 60 s threshold — so with snapshots counted the measured gap could
    // never reach it and this check could only fire for a hidden tab. That is
    // the exact inverse of what it is for: the scenario is "the participant
    // walked away with the questionnaire open ON SCREEN". The original test
    // passed only because its synthetic stream contained no snapshots.
    const snaps: [string, number][] = [];
    for (let t = 40_000; t < 320_000; t += 30_000) snaps.push(['snapshot', t]);
    const ev = stream([
      ...base,
      ['sus-open', 10_000],
      ...snaps,
      ['sus-submit', 320_000],
      ['session-end', 321_000],
    ] as never);
    const checks = runQualityChecks(ev, deriveSummary(ev, { idleThresholdMs: T }));
    expect(checks.find((c) => c.id === 'sus-in-one-sitting')?.ok).toBe(false);
  });

  it('going Back to the editor and returning is not an integrity failure', () => {
    // The questionnaire has a "Back to the editor" button, so open → fix one
    // thing → reopen → submit is a supported flow. Keying the edit window on
    // the FIRST sus-open reported every edit in between, showed the participant
    // a red data-quality panel and made eval-analysis.mjs exit 1 for a package
    // that is entirely fine.
    const ev = stream([
      ...base,
      ['sus-open', 10_000],
      ['node-add', 20_000, { nodeType: 'mix' }],
      ['sus-open', 30_000],
      ['sus-submit', 60_000],
      ['session-end', 61_000],
    ] as never);
    const checks = runQualityChecks(ev, deriveSummary(ev, { idleThresholdMs: T }));
    expect(checks.find((c) => c.id === 'no-edits-after-sus-open')?.ok).toBe(true);
    // …but an edit after the LAST open still fails.
    const ev2 = stream([
      ...base,
      ['sus-open', 10_000],
      ['sus-open', 30_000],
      ['node-add', 40_000, { nodeType: 'mix' }],
      ['sus-submit', 60_000],
      ['session-end', 61_000],
    ] as never);
    const checks2 = runQualityChecks(ev2, deriveSummary(ev2, { idleThresholdMs: T }));
    expect(checks2.find((c) => c.id === 'no-edits-after-sus-open')?.ok).toBe(false);
  });

  it('flags edits made after the questionnaire opened', () => {
    // The packaged shader would then not be the artifact that was rated.
    const ev = stream([...base, ['sus-open', 10_000], ['node-add', 20_000, { nodeType: 'mix' }], ['sus-submit', 40_000], ['session-end', 41_000]] as never);
    const checks = runQualityChecks(ev, deriveSummary(ev, { idleThresholdMs: T }));
    expect(checks.find((c) => c.id === 'no-edits-after-sus-open')?.ok).toBe(false);
  });
});

describe('susResponsePattern', () => {
  it('flags straight-lining — which always scores exactly 50', () => {
    for (const v of [1, 2, 3, 4, 5]) {
      expect(susResponsePattern(Array(10).fill(v)).straightLining, `all ${v}`).toBe(true);
    }
  });

  it('flags odd/even inconsistency (agreeing with opposite claims)', () => {
    expect(susResponsePattern([5, 5, 5, 5, 5, 4, 4, 4, 4, 4]).oddEvenInconsistent).toBe(true);
    expect(susResponsePattern([1, 1, 1, 1, 1, 2, 2, 2, 2, 2]).oddEvenInconsistent).toBe(true);
  });

  it('leaves a coherent response set unflagged', () => {
    // Positive items agreed with, negative items disagreed with.
    const coherent = [5, 1, 4, 2, 5, 1, 4, 2, 5, 1];
    expect(susResponsePattern(coherent)).toEqual({ straightLining: false, oddEvenInconsistent: false });
  });

  it('reports the flags through the quality checks', () => {
    const ev = stream([['session-start', 0], ['sus-open', 1_000], ['sus-submit', 20_000], ['session-end', 21_000]] as never);
    const checks = runQualityChecks(ev, deriveSummary(ev, { idleThresholdMs: T }), {
      susResponses: Array(10).fill(3),
    });
    const rp = checks.find((c) => c.id === 'response-pattern');
    expect(rp?.ok).toBe(false);
    expect(rp?.detail).toContain('straight-lined');
  });
});
