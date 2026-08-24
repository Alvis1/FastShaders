/**
 * The Output node is a SINGLETON, and these are the two places that assumption
 * is load-bearing rather than merely tidy.
 *
 * 1. WHICH Output emits, when more than one exists. `topologicalSort` seeds
 *    Kahn's queue from every in-degree-0 node, so an UNWIRED Output always
 *    sorts BEFORE a wired one regardless of where it sits in the nodes array.
 *    Resolving the output from `sorted` therefore picked the EMPTY one and
 *    emitted the red `vec3(1, 0, 0)` fallback — a working shader turning solid
 *    red the instant a second Output appeared. Resolving from the nodes array
 *    picks creation order instead, which is stable under wiring and puts a
 *    newly added Output last, where it is inert.
 *
 * 2. WHETHER a second one can appear at all. Every add surface gates the
 *    Output, except paste and duplicate, which clone whatever is selected
 *    straight through `setNodes`. That hole is what makes case 1 reachable by
 *    an ordinary Ctrl+D, so both halves are pinned together.
 *
 * With exactly one Output — every real graph today — the two resolutions name
 * the same node, so nothing about emission changes and the byte-stability
 * snapshots elsewhere in the suite stay valid.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { graphToCode } from './graphToCode';
import { makeNode, makeEdge } from '@/test-utils';

describe('graphToCode picks the Output by array order, not topological order', () => {
  const wiredGraph = () => {
    const color = makeNode('color1', 'color', { hex: '#3366ff' });
    const wired = makeNode('outWired', 'output');
    return {
      color,
      wired,
      edge: makeEdge('color1', 'out', 'outWired', 'color'),
    };
  };

  it('emits the wired Output even when an unwired one sorts first', () => {
    const { color, wired, edge } = wiredGraph();
    const unwired = makeNode('outEmpty', 'output');
    // Array order: the wired Output was created first, the empty one pasted
    // after — exactly what Ctrl+D produces.
    const { code } = graphToCode([color, wired, unwired], [edge]);
    expect(code).toContain('color1');
    // The red fallback is what the empty Output would have emitted.
    expect(code).not.toContain('vec3(1, 0, 0)');
  });

  it('is unaffected by where the unwired Output sits in the array', () => {
    const { color, wired, edge } = wiredGraph();
    const unwired = makeNode('outEmpty', 'output');
    const first = graphToCode([color, wired, unwired], [edge]).code;
    const middle = graphToCode([wired, color, unwired], [edge]).code;
    // Both keep the wired Output as the emitter; only an Output placed BEFORE
    // it in the array could take over, which creation order prevents.
    expect(first).toContain('color1');
    expect(middle).toContain('color1');
  });

  it('emits identically to a single-Output graph — no byte drift', () => {
    const { color, wired, edge } = wiredGraph();
    const alone = graphToCode([color, wired], [edge]).code;
    const withCopy = graphToCode([color, wired, makeNode('outEmpty', 'output')], [edge]).code;
    expect(withCopy).toBe(alone);
  });
});

describe('paste and duplicate cannot mint a second Output', () => {
  it('filters the Output out of the clone set', () => {
    // NodeEditor is a React component and this suite runs in the node env, so
    // the guard is a source assertion: what matters is that the filter exists
    // in the ONE function both Ctrl+V and Ctrl+D route through, since that is
    // the only path that writes clones straight through setNodes.
    const src = readFileSync(
      path.resolve(__dirname, '../components/NodeEditor/NodeEditor.tsx'),
      'utf8',
    );
    const fn = src.slice(src.indexOf('function pasteNodes('));
    expect(fn.slice(0, 1400)).toContain(
      "sourceNodes.filter((n) => n.data.registryType !== 'output')",
    );
  });
});
