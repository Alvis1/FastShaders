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

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
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
import { primeTutorialPicture, tutorialPicture } from './tutorialPicture';
import { COST_SCALED_TYPES, drawnCostScale, estimateNodeSize } from '@/engine/layoutEngine';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { effectiveExposedPorts } from '@/utils/exposedPorts';

// The Image step's picture is painted once, ahead of the step, as the panel does.
beforeAll(async () => {
  expect(await primeTutorialPicture()).not.toBeNull();
});

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

/**
 * What React Flow does a frame after a mount: measure the card. Node has no
 * DOM, so the measured box is the layout engine's estimate, UNSCALED (React
 * Flow measures before the cost transform; `drawnCostScale` grows it back).
 * Without it every card is the 160×60 default and the planner plans against
 * boxes the canvas never draws.
 */
function measureCards() {
  const s = useAppStore.getState();
  const measured = s.nodes.map((n) => {
    if ((n as { measured?: unknown }).measured) return n;
    const est = estimateNodeSize(n);
    const k = COST_SCALED_TYPES.has(n.type ?? '') ? drawnCostScale(n, []) : 1;
    return { ...n, measured: { width: est.width / k, height: est.height / k } } as AppNode;
  });
  useAppStore.setState({ nodes: measured });
}

/** Run every step's auto path; returns the final graph. */
function buildLesson(id: string) {
  const def = TUTORIALS.find((d) => d.id === id)!;
  useAppStore.setState({ tutorial: { id, phase: 'run', step: 0, reached: 0, bindings: { [OUT_ROLE]: 'out-1' } } });
  def.steps.forEach((step, i) => {
    const t = useAppStore.getState().tutorial!;
    useAppStore.setState({ tutorial: { ...t, step: i, reached: i } });
    const before = useAppStore.getState().past.length;
    tutorialAutoStep(useAppStore.getState().tutorial!, () => 0);
    measureCards();
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
    const { def, nodes, edges, code } = buildLesson(id);
    expect(code).not.toContain(SENTINEL);
    const parsed = codeToGraph(code);
    // An Image node is one-way through codeToGraph: the code carries an `fs-asset:`
    // placeholder, never the picture, so its sampling parses back only as warnings.
    const withPicture = def.steps.some((s) => s.kind === 'add' && s.type === 'imageNode');
    expect(parsed.errors.filter((e) => !(withPicture && e.severity === 'warning'))).toEqual([]);
    if (!withPicture) expect(parsed.nodes.filter((n) => n.data.registryType === 'unknown')).toEqual([]);
    // What the cost bar shows: the nodes that FEED an Output (Detail Costs
    // leaves two unwired noises on the canvas, which cost nothing).
    expect(computeReachableCost(nodes, edges)).toBeLessThanOrEqual(complexity.meta.maxBudget);
    // A picture's placeholder names its node, whose id is minted from the clock.
    expect(code.replace(/fs-asset:[\w-]+/g, 'fs-asset:<node>')).toMatchSnapshot();
  });

  it('is exactly the lesson list the snapshot file knows', () => {
    expect(TUTORIALS.length).toBe(27);
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

  it.each(TUTORIALS.map((d) => [d.id] as const))('%s lays its nodes out left to right: no wire runs back, crosses another or a card', (id) => {
    const { nodes, edges } = buildLesson(id);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const box = (n: AppNode) => {
      const m = (n as { measured?: { width: number; height: number } }).measured!;
      const k = COST_SCALED_TYPES.has(n.type ?? '') ? drawnCostScale(n, []) : 1;
      return { x: n.position.x, y: n.position.y, w: m.width * k, h: m.height * k };
    };
    // A socket's height on its card, by its place among the sockets the card shows (the Output: its rows).
    const socketY = (n: AppNode, handle: string) => {
      const b = box(n);
      const def = NODE_REGISTRY.get(String(n.data.registryType))!;
      const ids = n.type === 'output'
        ? def.inputs.map((p) => p.id).filter((p) => effectiveExposedPorts(n).includes(p))
        : [...def.inputs.map((p) => p.id), ...Object.keys(def.defaultValues ?? {})];
      return b.y + (b.h * (Math.max(0, ids.indexOf(handle)) + 1)) / (ids.length + 1);
    };
    const wires = edges.map((e) => {
      const s = byId.get(e.source)!, t = byId.get(e.target)!;
      const a = box(s), b = box(t);
      return { e, x1: a.x + a.w, y1: a.y + a.h / 2, x2: b.x, y2: socketY(t, e.targetHandle ?? '') };
    });
    for (const w of wires) expect(w.x1, `${id}: ${w.e.id} runs backwards`).toBeLessThan(w.x2);
    // Two wires over the same stretch of x cross when their ends swap order; a shared end is a fan, not a cross.
    for (let i = 0; i < wires.length; i++) {
      for (let j = i + 1; j < wires.length; j++) {
        const p = wires[i], q = wires[j];
        if (p.e.source === q.e.source || p.e.target === q.e.target) continue;
        const lo = Math.max(p.x1, q.x1), hi = Math.min(p.x2, q.x2);
        if (lo >= hi) continue;
        const at = (w: typeof p, x: number) => w.y1 + ((w.y2 - w.y1) * (x - w.x1)) / (w.x2 - w.x1);
        const before = Math.sign(at(p, lo) - at(q, lo)), after = Math.sign(at(p, hi) - at(q, hi));
        expect(before * after >= 0, `${id}: ${p.e.id} crosses ${q.e.id}`).toBe(true);
      }
    }
    // No card on another, and no wire through a card it does not touch.
    const cards = nodes.map((n) => ({ n, b: box(n) }));
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i].b, b = cards[j].b;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${id}: ${cards[i].n.data.registryType} overlaps ${cards[j].n.data.registryType}`).toBe(true);
      }
    }
    for (const w of wires) {
      for (const { n, b } of cards) {
        if (n.id === w.e.source || n.id === w.e.target) continue;
        for (let k = 1; k < 20; k++) {
          const x = w.x1 + ((w.x2 - w.x1) * k) / 20, y = w.y1 + ((w.y2 - w.y1) * k) / 20;
          const inside = x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h;
          expect(inside, `${id}: ${w.e.id} runs through ${n.data.registryType}`).toBe(false);
        }
      }
    }
  });

  it('the picture step fills an EMPTY Image node the reader added from the palette, rather than adding a second', () => {
    const def = TUTORIALS.find((d) => d.id === 'tut-material')!;
    const at = def.steps.findIndex((s) => s.kind === 'add' && s.type === 'imageNode');
    const empty = {
      id: 'img-1', type: 'shader', position: { x: -300, y: 0 },
      data: { registryType: 'imageNode', label: 'Image', cost: 0, values: { tileX: 1, tileY: 1, offsetX: 0, offsetY: 0 } },
    } as unknown as AppNode;
    useAppStore.setState({ nodes: [loneOutput(), empty] });
    useAppStore.setState({ tutorial: { id: 'tut-material', phase: 'run', step: at, reached: at, bindings: { [OUT_ROLE]: 'out-1' } } });
    expect(evaluateStep(def.steps[at], { [OUT_ROLE]: 'out-1' }, useAppStore.getState().nodes, []).status).toBe('pending');
    expect(tutorialAutoStep(useAppStore.getState().tutorial!)).toMatchObject({ addedId: 'img-1' });
    const s = useAppStore.getState();
    expect(s.nodes).toHaveLength(2);
    expect(s.past).toHaveLength(1);
    expect(s.tutorial!.bindings.sky).toBe('img-1');
    const values = (s.nodes[1].data as { values: Record<string, unknown> }).values;
    expect(values.imageB64).toBe(tutorialPicture()!.dataUrl);
    expect(values).toMatchObject({ width: 1024, height: 512, fileName: 'sky.png', tileX: 1 });
    expect(evaluateStep(def.steps[at], s.tutorial!.bindings, s.nodes, s.edges).status).toBe('satisfied');
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
