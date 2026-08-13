import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { makeNode, makeEdge } from '@/test-utils';
import { getTargetEdges, getUnwrappedEdges, evaluateNodeScalar } from '@/engine/cpuEvaluator';
import { hasTimeUpstream } from '@/utils/graphTraversal';
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
    ? `${hasTimeUpstream(e.source, nodes, getUnwrappedEdges(nodes, edges)) ? '1' : '0'}${e.source}`
    : '';
  return {
    xKey,
    hasConnection: xKey !== '',
    xSource: xKey !== '' ? xKey.slice(1) : null,
    hasTime: xKey.charCodeAt(0) === 49,
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
    // THE regression this guards: `hasTimeUpstream(e.source, s.nodes, s.edges)`
    // pairs an unwrapped feeder id with a raw graph walk, so a Time node feeding
    // INTO a collapsed group goes invisible and the waveform freezes.
    expect(selector).toContain('getUnwrappedEdges(s.nodes, s.edges)');
    expect(selector).not.toContain('hasTimeUpstream(e.source, s.nodes, s.edges)');
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
    expect(evaluateNodeScalar(s.xSource!, nodes, edges, 1.5)).toBe(1.5);
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
    expect(evaluateNodeScalar(s.xSource!, nodes, edges, 1.5)).toBe(3);
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
    });
  });

  it('the leading-flag key is unambiguous for any node id (no separator needed)', () => {
    // The flag is exactly one char and the id is everything after it, so an id
    // that itself starts with '0' or '1' cannot be misparsed.
    for (const id of ['1weird', '0weird', 'time1']) {
      const nodes = [
        { ...makeNode(id, 'time') } as AppNode,
        makeNode('sin1', 'sin', { x: 0 }),
      ];
      const edges = [makeEdge(id, 'out', 'sin1', 'x')];
      expect(xState(nodes, edges, 'sin1')).toMatchObject({ xSource: id, hasTime: true });
    }
  });
});
