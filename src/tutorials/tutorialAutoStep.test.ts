/**
 * The auto path builds every lesson in the REAL store, step by step, and after
 * each step the pure evaluator must agree the step is done (a runner/matcher
 * drift is the bug this catches). Then the finished graph must emit a shader
 * that parses back, costs within budget, and — where the lesson has a recipe —
 * IS that recipe's shader: the two emitted modules are compared with every
 * `const` inlined into the return expression, which is what makes the test
 * order-free (variable names are claimed in topological order seeded by array
 * order, and a lesson's pedagogical add order rarely matches the recipe's
 * statement order). `byteExact` lessons additionally match byte for byte.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { HISTORY_IDLE } from '@/test-utils';
import type { AppNode } from '@/types';
import { graphToCode } from '@/engine/graphToCode';
import { codeToGraph } from '@/engine/codeToGraph';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import { nodeCostPoints, computeReachableCost } from '@/utils/nodeCost';
import complexity from '@/registry/complexity.json';
import { TUTORIALS } from './tutorialDefs';
import { evaluateStep } from './tutorialRun';
import { tutorialAutoStep } from './tutorialAutoStep';
import { OUT_ROLE } from './tutorialTypes';

afterAll(() => {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], drawings: [], past: [], future: [], tutorial: null, ...HISTORY_IDLE });
});

const loneOutput = (): AppNode => ({
  id: 'out-1', type: 'output', position: { x: 0, y: 0 },
  data: { registryType: 'output', label: 'Output', cost: 0 },
} as unknown as AppNode);

beforeEach(() => {
  useAppStore.setState({
    nodes: [loneOutput()], edges: [], drawings: [], past: [], future: [],
    tutorial: null, nodePreview: null, ...HISTORY_IDLE,
  });
});

const SENTINEL = 'return vec3(1, 0, 0);';

/** The Fn body's return expression with every `const` inlined — the shader
 *  itself, independent of statement order and variable numbering. */
function inlinedReturn(code: string): string {
  const start = code.indexOf('const shader = Fn(() => {');
  expect(start, 'the module has a shader Fn').toBeGreaterThan(-1);
  const body = code.slice(start, code.indexOf('\n});', start));
  const defs = new Map<string, string>();
  for (const m of body.matchAll(/^\s*const (\w+) = (.+);$/gm)) defs.set(m[1], m[2]);
  let ret = body.match(/^\s*return ([\s\S]+?);\s*$/m)?.[1] ?? '';
  for (let guard = 0; guard < 64; guard++) {
    let changed = false;
    for (const [name, expr] of defs) {
      const re = new RegExp(`\\b${name}\\b`, 'g');
      if (re.test(ret)) { ret = ret.replace(re, `(${expr})`); changed = true; }
    }
    if (!changed) break;
  }
  return ret;
}

/** What the CostBar shows: every node but the Output. */
const costOf = (nodes: AppNode[], edges: ReturnType<typeof useAppStore.getState>['edges']) =>
  nodes.filter((n) => n.data.registryType !== 'output').reduce((sum, n) => sum + nodeCostPoints(n, edges), 0);

/** Run every step's auto path; returns the final graph. */
function buildLesson(id: string) {
  const def = TUTORIALS.find((d) => d.id === id)!;
  useAppStore.setState({ tutorial: { id, phase: 'run', step: 0, reached: 0, bindings: { [OUT_ROLE]: 'out-1' } } });
  def.steps.forEach((step, i) => {
    const t = useAppStore.getState().tutorial!;
    useAppStore.setState({ tutorial: { ...t, step: i, reached: i } });
    const before = useAppStore.getState().past.length;
    tutorialAutoStep(useAppStore.getState().tutorial!, () => 0);
    const s = useAppStore.getState();
    const r = evaluateStep(step, s.tutorial!.bindings, s.nodes, s.edges);
    expect(r.status, `${id}/${step.id} after the auto path: ${JSON.stringify(r)}`).toBe('satisfied');
    expect(s.past.length - before, `${id}/${step.id}: one undo entry per auto step`).toBe(step.kind === 'look' ? 0 : 1);
  });
  const s = useAppStore.getState();
  return { def, nodes: s.nodes, edges: s.edges, code: graphToCode(s.nodes, s.edges).code };
}

describe('every lesson, built by "Do it for me"', () => {
  it.each(TUTORIALS.map((d) => [d.id] as const))('%s builds a shader that parses back, within budget', (id) => {
    const { nodes, edges, code } = buildLesson(id);
    expect(code).not.toContain(SENTINEL);
    const parsed = codeToGraph(code);
    expect(parsed.errors).toEqual([]);
    expect(parsed.nodes.filter((n) => n.data.registryType === 'unknown')).toEqual([]);
    // What the cost bar shows: the nodes that FEED an Output (Detail Costs
    // leaves two unwired noises on the canvas, which cost nothing).
    expect(computeReachableCost(nodes, edges)).toBeLessThanOrEqual(complexity.meta.maxBudget);
    expect(code).toMatchSnapshot();
  });

  it('is exactly the lesson list the snapshot file knows', () => {
    expect(TUTORIALS.length).toBe(22);
  });

  it.each(TUTORIALS.filter((d) => d.recipeId).map((d) => [d.id, d.recipeId!] as const))(
    '%s builds the %s recipe\'s shader (order-free), and its name',
    (id, recipeId) => {
      const recipe = getBuiltinPresets().find((p) => p.id === recipeId);
      expect(recipe, recipeId).toBeDefined();
      const def = TUTORIALS.find((d) => d.id === id)!;
      expect(def.recipeName).toBe(recipe!.name);
      const want = codeToGraph(recipe!.code);
      const wantCode = graphToCode(want.nodes, want.edges).code;
      const { code, nodes, edges } = buildLesson(id);
      expect(inlinedReturn(code)).toBe(inlinedReturn(wantCode));
      expect(costOf(nodes, edges)).toBe(costOf(want.nodes, want.edges));
      if (def.byteExact) expect(code).toBe(wantCode);
    },
  );

  it('a fresh Perlin is the 0–1 node, which the Noise lesson\'s caption promises', () => {
    const { nodes, code } = buildLesson('tut-noise');
    const perlin = nodes.find((n) => n.data.registryType === 'perlin')!;
    expect((perlin.data as { values?: Record<string, unknown> }).values?.signed).toBe(0);
    expect(code).toContain('.mul(0.5).add(0.5)');
  });

  it('wiring Opacity makes it readable: Transparent is ticked by the expose step and kept by the wire', () => {
    const { nodes } = buildLesson('tut-ghost');
    const out = nodes.find((n) => n.type === 'output')!;
    const data = out.data as { exposedPorts?: string[]; materialSettings?: { transparent?: boolean } };
    expect(data.exposedPorts).toContain('opacity');
    expect(data.materialSettings?.transparent).toBe(true);
  });

  it('a look step writes nothing and a step with a missing role writes nothing', () => {
    useAppStore.setState({ tutorial: { id: 'tut-mix', phase: 'run', step: 0, reached: 0, bindings: { out: 'out-1' } } });
    expect(tutorialAutoStep(useAppStore.getState().tutorial!)).toEqual({});
    const wireIndex = TUTORIALS.find((d) => d.id === 'tut-mix')!.steps.findIndex((s) => s.kind === 'wire');
    useAppStore.setState({ tutorial: { id: 'tut-mix', phase: 'run', step: wireIndex, reached: wireIndex, bindings: { out: 'out-1' } } });
    expect(tutorialAutoStep(useAppStore.getState().tutorial!)).toEqual({});
    expect(useAppStore.getState().past).toHaveLength(0);
  });
});
