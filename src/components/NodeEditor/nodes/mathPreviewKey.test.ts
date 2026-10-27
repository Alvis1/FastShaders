import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { makeNode, makeEdge } from '@/test-utils';
import { getFieldUpstreamSet, getTargetEdges, getTimeUpstreamSet, evaluateNodeOutput } from '@/engine/cpuEvaluator';
import type { AppNode, AppEdge, BoundarySocket } from '@/types';

/**
 * MathPreviewNode draws its sin/cos waveform from a folded-string selector
 * rather than a whole-array `s.nodes`/`s.edges` subscription. The component is
 * a .tsx and the vitest env is `node`, so it cannot be rendered here — but the
 * two things that can silently BREAK THE ANIMATION are both testable:
 *
 *  1. a DRIFT GUARD over the component source, because the one way to get this
 *     wrong is subtle and was actually proposed: resolve the feeder through the
 *     UNWRAPPED view (`getTargetEdges`) and then continue the time walk through
 *     the RAW store edges. Those two views disagree exactly at a collapsed
 *     group's boundary, and mixing them freezes a waveform that animates today.
 *
 *  2. a behavioural pin of the key expression itself over the three graph
 *     shapes that matter, including the parse back out of the string.
 */
const COMPONENT_SRC = readFileSync(
  path.join(__dirname, 'MathPreviewNode.tsx'),
  'utf8',
);

function makeGroup(
  id: string,
  opts: {
    collapsed?: boolean;
    collapsedInputs?: Partial<BoundarySocket>[];
    collapsedOutputs?: Partial<BoundarySocket>[];
  } = {},
): AppNode {
  return {
    id,
    type: 'group',
    position: { x: 0, y: 0 },
    data: { label: id, ...opts },
  } as unknown as AppNode;
}

/**
 * The shipped selector body + the parse that follows it, kept in ONE place so
 * every case below exercises the same expression. Mirrors
 * MathPreviewNode.tsx's `xKey` — the drift guard above is what keeps the mirror
 * honest about the part that can freeze the animation.
 */
function xState(nodes: AppNode[], edges: AppEdge[], id: string) {
  const e = getTargetEdges(nodes, edges, id).find((x) => x.targetHandle === 'x');
  const xKey = e
    ? `${getTimeUpstreamSet(nodes, edges).has(e.source) ? '1' : '0'}${getFieldUpstreamSet(nodes, edges).has(e.source) ? '1' : '0'}${e.source}|${e.sourceHandle ?? ''}`
    : '';
  const hasConnection = xKey !== '';
  const hasTime = xKey.charCodeAt(0) === 49;
  const hasField = xKey.charCodeAt(1) === 49;
  const rest = hasConnection ? xKey.slice(2) : '';
  return {
    xKey,
    hasConnection,
    xSource: hasConnection ? rest.slice(0, rest.lastIndexOf('|')) : null,
    hasTime,
    hasField,
    // The component's readout rule: a dot and a number only for a value
    // that IS one number.
    showReadout: !hasField && (hasTime || !hasConnection),
  };
}

describe('MathPreviewNode xKey — drift guard', () => {
  it('walks the UNWRAPPED edges in the time check, never the raw store array', () => {
    // Isolate the selector so an unrelated `s.edges` elsewhere in the file
    // cannot make this pass or fail by accident.
    const selector = COMPONENT_SRC.slice(
      COMPONENT_SRC.indexOf('const xKey = useAppStore('),
      COMPONENT_SRC.indexOf('const hasConnection'),
    );
    expect(selector).not.toBe('');
    expect(selector).toContain('getTargetEdges(s.nodes, s.edges, id)');
    // THE regression this guards: pairing an unwrapped feeder id with a RAW
    // graph walk, so a Time node feeding INTO a collapsed group goes invisible
    // and the waveform freezes. `getTimeUpstreamSet` unwraps by construction
    // (it walks the shared ctx's own edge array), which is why the fix is to
    // require it here rather than to re-check the argument passed along.
    expect(selector).toContain('getTimeUpstreamSet(s.nodes, s.edges)');
    // `hasTimeUpstream` takes the edge array as an ARGUMENT, so every call site
    // re-opens the trap. Keep it out of this selector entirely — including the
    // spelling that happens to be correct today.
    expect(selector).not.toContain('hasTimeUpstream');
    // The field check rides the same unwrapped ctx.
    expect(selector).toContain('getFieldUpstreamSet(s.nodes, s.edges)');
  });

  it('keeps the readout rule and the parse this mirror copies', () => {
    expect(COMPONENT_SRC).toContain('const showReadout = !hasField && (hasTime || !hasConnection);');
    expect(COMPONENT_SRC).toContain('showReadout={showReadout}');
    expect(COMPONENT_SRC).toContain('const r = xKey.slice(2);');
    expect(COMPONENT_SRC).toContain('const hasField = xKey.charCodeAt(1) === 49;');
  });

  it('never prints the clock as the value of a wire that is not the clock', () => {
    // The tick used to pass `evaluated ?? t`: an unevaluable X printed sin(t).
    // The curve may scroll by t; the dot and readout get X or nothing.
    expect(COMPONENT_SRC).not.toContain('evaluated ?? t');
    expect(COMPONENT_SRC).toContain('applyWaveFrame(dynamicRefs, func, data.registryType, x ?? t, lastLabelRef, x);');
  });

  it('holds no whole-array subscription and no nodes/edges mirror ref', () => {
    // Deleting the subscriptions while KEEPING a nodesRef/edgesRef mirror would
    // freeze the animated branch against the mount-time graph — the ref would
    // never be refreshed again. The rAF loop must read the store per frame.
    expect(COMPONENT_SRC).not.toContain('useAppStore((s) => s.nodes)');
    expect(COMPONENT_SRC).not.toContain('useAppStore((s) => s.edges)');
    expect(COMPONENT_SRC).not.toContain('nodesRef');
    expect(COMPONENT_SRC).not.toContain('edgesRef');
    expect(COMPONENT_SRC).toContain('useAppStore.getState()');
  });

  it('carries no raw NUL/SOH byte (a binary-classified file is skipped by grep)', () => {
    // Written via fromCharCode so THIS file cannot trip the same trap.
    const ctrl = [String.fromCharCode(0), String.fromCharCode(1)];
    expect(ctrl.some((c) => COMPONENT_SRC.includes(c))).toBe(false);
  });
});

describe('MathPreviewNode xKey — the time-driven path is still detected', () => {
  it('the ordinary case: Time -> sin animates', () => {
    const time1 = makeNode('time1', 'time');
    const sin1 = makeNode('sin1', 'sin', { x: 0 });
    const nodes = [time1, sin1];
    const edges = [makeEdge('time1', 'out', 'sin1', 'x')];

    const s = xState(nodes, edges, 'sin1');
    expect(s).toMatchObject({ hasConnection: true, xSource: 'time1', hasTime: true });
    // ...and the rAF loop's evaluation target resolves to the real clock value.
    expect(evaluateNodeOutput(s.xSource!, nodes, edges, 1.5)?.[0]).toBe(1.5);
  });

  it('through a collapsed group: Time -> Multiply(collapsed) -> sin still animates', () => {
    const g1 = makeGroup('g1', {
      collapsed: true,
      collapsedInputs: [{ socketId: 's-in', originalNodeId: 'mul1', originalHandleId: 'a' }],
      collapsedOutputs: [{ socketId: 's-out', originalNodeId: 'mul1', originalHandleId: 'out' }],
    });
    const mul1 = { ...makeNode('mul1', 'mul', { a: 0, b: 2 }), parentId: 'g1' } as AppNode;
    const nodes = [g1, makeNode('time1', 'time'), mul1, makeNode('sin1', 'sin', { x: 0 })];
    const edges = [makeEdge('time1', 'out', 'g1', 's-in'), makeEdge('g1', 's-out', 'sin1', 'x')];

    const s = xState(nodes, edges, 'sin1');
    expect(s).toMatchObject({ hasConnection: true, xSource: 'mul1', hasTime: true });
    expect(evaluateNodeOutput(s.xSource!, nodes, edges, 1.5)?.[0]).toBe(3);
  });

  it('a non-time feeder stays STATIC and keeps hiding the inline widget', () => {
    const nodes = [makeNode('f1', 'float', { value: 0.25 }), makeNode('sin1', 'sin', { x: 0 })];
    const edges = [makeEdge('f1', 'out', 'sin1', 'x')];

    expect(xState(nodes, edges, 'sin1')).toMatchObject({
      hasConnection: true,
      xSource: 'f1',
      hasTime: false,
    });
  });

  it('an unwired node reports no connection and no time (empty key parses cleanly)', () => {
    // ''.charCodeAt(0) is NaN, so the unwired case yields hasTime === false
    // without a second branch — that is the whole reason the flag leads.
    const nodes = [makeNode('sin1', 'sin', { x: 0.5 })];
    expect(xState(nodes, [], 'sin1')).toEqual({
      xKey: '',
      hasConnection: false,
      xSource: null,
      hasTime: false,
      hasField: false,
      showReadout: true,
    });
  });

  it('the leading-flag key is unambiguous for any node id (no separator needed)', () => {
    // The flags are exactly two chars and the id is everything after them up
    // to the LAST '|', so an id that itself starts with '0' or '1' (or holds a
    // '|') cannot be misparsed.
    for (const id of ['1weird', '0weird', '11weird', 'time1', 'a|b']) {
      const nodes = [
        { ...makeNode(id, 'time') } as AppNode,
        makeNode('sin1', 'sin', { x: 0 }),
      ];
      const edges = [makeEdge(id, 'out', 'sin1', 'x')];
      expect(xState(nodes, edges, 'sin1')).toMatchObject({ xSource: id, hasTime: true });
    }
  });
});

describe('MathPreviewNode xKey — a FIELD feeder has no single value to print', () => {
  it('UV + Time → sin: the curve animates, but there is no dot and no readout', () => {
    const nodes = [
      makeNode('uv1', 'uv'),
      makeNode('time1', 'time'),
      makeNode('add1', 'add'),
      makeNode('sin1', 'sin', { x: 0 }),
    ];
    const edges = [
      makeEdge('uv1', 'out', 'add1', 'a'),
      makeEdge('time1', 'out', 'add1', 'b'),
      makeEdge('add1', 'out', 'sin1', 'x'),
    ];
    expect(xState(nodes, edges, 'sin1')).toMatchObject({
      hasConnection: true,
      xSource: 'add1',
      hasTime: true,
      hasField: true,
      showReadout: false,
    });
  });

  it('a static field (UV → sin) shows the bare curve, as any connected static X', () => {
    const nodes = [makeNode('uv1', 'uv'), makeNode('sin1', 'sin', { x: 0 })];
    const edges = [makeEdge('uv1', 'out', 'sin1', 'x')];
    expect(xState(nodes, edges, 'sin1')).toMatchObject({ hasTime: false, hasField: true, showReadout: false });
  });

  it('Time → sin keeps its readout (a point the CPU evaluates)', () => {
    const nodes = [makeNode('time1', 'time'), makeNode('sin1', 'sin', { x: 0 })];
    const edges = [makeEdge('time1', 'out', 'sin1', 'x')];
    expect(xState(nodes, edges, 'sin1')).toMatchObject({ hasTime: true, hasField: false, showReadout: true });
  });
});
