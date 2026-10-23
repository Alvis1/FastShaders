/**
 * Every point figure printed ON the canvas is LIVE and printed through
 * <Points> (owner, 2026-10-23: a device's budget prints as 100, node points
 * carry two decimals, and a rounded figure is marked).
 *
 * Until then the noise, sin/cos, Time and Sound cards printed the `data.cost`
 * stamped when the node was created, and the collapsed group pill a sum the
 * collapse took — both under whichever device was selected at that moment, so
 * under the Steam Frame row a noise card kept its shipped price while the
 * total used the measured one.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { HISTORY_IDLE, makeNode, makeEdge } from '@/test-utils';
import type { AppEdge, AppNode } from '@/types';
import { getCost, setCostOverrides } from '@/utils/costTable';
import { getUnwrappedEdges } from '@/engine/cpuEvaluator';
import { groupMemberCost, makeGroupMemberCostSelector } from './GroupNode';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
/** Source with its comments removed — the cards explain the snapshot they
 *  no longer read, and only CODE must not read it. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

beforeEach(() => {
  // The collapse rewires its boundary edges on the next animation frame; run
  // it synchronously in the node test env.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setCostOverrides(null);
});

// isolate: false shares this worker's store with later files.
afterAll(() => {
  vi.unstubAllGlobals();
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], ...HISTORY_IDLE });
});

function frame(id: string, parentId?: string): AppNode {
  return {
    id,
    type: 'group',
    position: { x: 0, y: 0 },
    width: 300,
    height: 200,
    ...(parentId ? { parentId } : {}),
    data: { label: id, color: '#dde', collapsed: false, width: 300, height: 200 },
  } as unknown as AppNode;
}

/** `n` inside frame `parentId`, carrying a junk creation snapshot — a sum that
 *  read `data.cost` would show it. */
function member(n: AppNode, parentId: string): AppNode {
  return { ...n, parentId, position: { x: 20, y: 40 }, data: { ...n.data, cost: 999 } } as AppNode;
}

/**
 * Frame `g` holds a Sin, an Add fed THREE operands (two from the Sin inside,
 * its third — the highest socket, so no interior gap counts it — from a Perlin
 * OUTSIDE) and a nested frame `h` holding a Cos. The Perlin and the Output stay
 * outside.
 */
function graph(): { nodes: AppNode[]; edges: AppEdge[] } {
  return {
    nodes: [
      frame('g'),
      member(makeNode('s1', 'sin'), 'g'),
      member(makeNode('a1', 'add'), 'g'),
      frame('h', 'g'),
      member(makeNode('c1', 'cos'), 'h'),
      makeNode('p', 'perlin'),
      makeNode('o', 'output'),
    ],
    edges: [
      makeEdge('s1', 'out', 'a1', 'a'),
      makeEdge('s1', 'out', 'a1', 'b'),
      makeEdge('p', 'out', 'a1', 'c'),
      makeEdge('a1', 'out', 'o', 'color'),
    ],
  };
}

/** The Sin, plus the Add at its three-operand price (base × 2). */
const expected = () => getCost('sin') + 2 * getCost('add');

describe('the collapsed pill sums its members LIVE', () => {
  it('prices the frame\'s direct members — never a snapshot, an outsider or a nested frame\'s members', () => {
    const { nodes, edges } = graph();
    expect(groupMemberCost(nodes, edges, 'g')).toBe(expected());
    // The nested frame is one member, priced 0 (no registry type), as the
    // collapse prices it; its own Cos is not g's.
    expect(groupMemberCost(nodes, edges, 'h')).toBe(getCost('cos'));
    expect(groupMemberCost(nodes, edges, 'nobody')).toBe(0);
  });

  it('after a collapse, the UNWRAPPED edges price it as the collapse did; the raw ones lose the outside operand', () => {
    useAppStore.setState({ ...graph(), past: [], future: [], ...HISTORY_IDLE });
    useAppStore.getState().toggleGroupCollapsed('g');
    const s = useAppStore.getState();
    const pill = s.nodes.find((n) => n.id === 'g')!;
    expect((pill.data as { collapsed?: boolean }).collapsed).toBe(true);
    // The Perlin's wire now lands on the pill's own socket…
    expect(s.edges.some((e) => e.source === 'p' && e.target === 'g')).toBe(true);
    // …so the badge reads the logical topology, the cost walks' contract.
    const live = groupMemberCost(s.nodes, getUnwrappedEdges(s.nodes, s.edges), 'g');
    expect(live).toBe(expected());
    expect(live).toBe((pill.data as { cost?: number }).cost); // the collapse's own sum, same table
    expect(groupMemberCost(s.nodes, s.edges, 'g')).toBeLessThan(live);
  });

  it('the selector serves a position-only notify from its cache and re-sums on anything that can move the sum', () => {
    const { nodes, edges } = graph();
    const select = makeGroupMemberCostSelector('g');
    const v0 = select({ nodes, edges, costVersion: 0 });
    expect(v0).toBe(expected());

    // A drag: fresh nodes array and node objects, the same `data`, the same
    // edges array. Swap the table WITHOUT bumping its version, so a re-sum
    // would show — the cache must answer.
    setCostOverrides({ sin: 40 });
    const dragged = nodes.map((n) => ({ ...n, position: { x: n.position.x + 5, y: n.position.y } }) as AppNode);
    expect(select({ nodes: dragged, edges, costVersion: 0 })).toBe(v0);

    // A device change bumps the version: repriced with no edit to the graph.
    expect(select({ nodes: dragged, edges, costVersion: 1 })).toBe(40 + 2 * getCost('add'));
    setCostOverrides(null);
    expect(select({ nodes: dragged, edges, costVersion: 2 })).toBe(v0);

    // A member edit (fresh `data`): an RGB Curves member that starts to bake.
    const withCurves = [...dragged, member(makeNode('k', 'rgbCurves'), 'g')];
    expect(select({ nodes: withCurves, edges, costVersion: 2 })).toBe(v0 + 1);
    const baked = withCurves.map((n) =>
      n.id === 'k' ? ({ ...n, data: { ...n.data, values: { curveC: '0 0,0.25 0.15,0.75 0.85,1 1' } } }) as AppNode : n,
    );
    expect(select({ nodes: baked, edges, costVersion: 2 })).toBe(v0 + 40);

    // A member leaving the frame, with every `data` untouched.
    const left = baked.map((n) => (n.id === 'k' ? ({ ...n, parentId: undefined }) as AppNode : n));
    expect(select({ nodes: left, edges, costVersion: 2 })).toBe(v0);

    // A rewire: the outside operand unplugged, the Add back to two operands.
    const unplugged = edges.filter((e) => e.source !== 'p');
    expect(select({ nodes: left, edges: unplugged, costVersion: 2 })).toBe(getCost('sin') + getCost('add'));
  });

  it('the pill prints that live sum through <Points>, never the snapshot', () => {
    const src = read('./GroupNode.tsx');
    expect(src).toContain('const memberCost = useGroupMemberCost(id, collapsed);');
    expect(src).toContain('const memberPoints = useBudgetPoints(memberCost);');
    expect(src).toContain('<Points value={memberPoints} />');
    expect(code(src)).not.toMatch(/data\.cost\b/);
  });
});

describe('every cost badge on a canvas card is live and printed through <Points>', () => {
  const dir = new URL('./', import.meta.url);
  const sources = new Map(
    readdirSync(dir).filter((f) => f.endsWith('.tsx')).map((f) => [f, read(`./${f}`)] as const),
  );
  const BADGE = /<span className=(?:"node-base__cost-badge[^"]*"|\{badgeClass\})[^>]*>([\s\S]*?)<\/span>/g;

  it('prints every badge as a <Points> figure, on every card that has one', () => {
    const carriers: string[] = [];
    for (const [file, src] of sources) {
      const bodies = [...src.matchAll(BADGE)].map((m) => m[1].trim());
      if (bodies.length === 0) continue;
      carriers.push(file);
      for (const body of bodies) expect(body, file).toMatch(/^<Points value=\{\w+\} \/>$/);
    }
    // The sweep must find the cards, or it proves nothing.
    expect(carriers.sort()).toEqual([
      'ClockNode.tsx', 'GroupNode.tsx', 'MathPreviewNode.tsx', 'NodeVisual.tsx', 'OutputNode.tsx',
      'PreviewNode.tsx', 'RaymarchOutputNode.tsx', 'ShaderNode.tsx', 'SoundNode.tsx', 'SplatOutputNode.tsx',
    ]);
  });

  it('the noise, sin/cos, Time and Sound cards price live, as ShaderNode does — never their creation snapshot', () => {
    for (const file of ['PreviewNode.tsx', 'MathPreviewNode.tsx', 'ClockNode.tsx', 'SoundNode.tsx', 'ShaderNode.tsx']) {
      const src = sources.get(file)!;
      expect(src, file).toContain('const cost = useLiveNodeCost(id, data);');
      expect(src, file).toContain('= useCostChrome(cost);');
      expect(code(src), file).not.toMatch(/data\.cost\b/);
    }
  });
});
