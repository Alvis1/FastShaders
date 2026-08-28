import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import type { OutputMaterial } from '@/utils/outputMaterials';

/**
 * The Output node is a SINGLETON (outputFocus.ts), and `instantiateSavedGroup`
 * was the ONE live path that could still mint a second one at runtime: a saved
 * group may legitimately contain an Output (groupSelection filters only groups
 * and notes), and `foldExtraOutputs` used to run only on the RESTORE paths.
 * Instantiation now folds too — the live graph's Output survives (it precedes
 * the arriving members in the combined array), a TARGETED copy becomes
 * materials on it with its feeder edges re-pointed, and an UNTARGETED copy is
 * dropped as dead weight, fold's standing rule everywhere else.
 */

afterAll(() => {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], savedGroups: [] });
});

const groupNode = (id: string): AppNode =>
  ({
    id,
    type: 'group',
    position: { x: 0, y: 0 },
    width: 200,
    height: 120,
    data: { label: id, color: '#dde', collapsed: false, width: 200, height: 120 },
  }) as unknown as AppNode;

function seed(savedOutputTargets?: string[]) {
  const savedOut = makeNode('sgOut', 'output') as AppNode;
  if (savedOutputTargets) {
    (savedOut.data as { meshTargets?: string[] }).meshTargets = savedOutputTargets;
  }
  useAppStore.setState({
    nodes: [makeNode('liveOut', 'output')],
    edges: [],
    past: [],
    future: [],
    savedGroups: [
      {
        id: 'sg1',
        name: 'with-output',
        nodes: [
          groupNode('g'),
          { ...makeNode('feeder', 'float'), parentId: 'g' } as AppNode,
          { ...savedOut, parentId: 'g' } as AppNode,
        ],
        edges: [makeEdge('feeder', 'out', 'sgOut', 'color')],
      },
    ] as never,
  });
}

const outputs = () =>
  useAppStore.getState().nodes.filter((n) => n.data.registryType === 'output');

beforeEach(() => {
  useAppStore.setState({ nodes: [], edges: [], past: [], future: [], savedGroups: [] });
});

describe('instantiateSavedGroup keeps the Output a singleton', () => {
  it('folds a TARGETED saved Output into the live one as a material, re-pointing its feeder edge', () => {
    seed(['Body']);
    useAppStore.getState().instantiateSavedGroup('sg1', { x: 500, y: 500 });

    const outs = outputs();
    expect(outs).toHaveLength(1);
    expect(outs[0].id).toBe('liveOut');
    const materials = (outs[0].data as { materials?: OutputMaterial[] }).materials ?? [];
    expect(materials.map((m) => m.meshTargets)).toEqual([['Body']]);

    // The feeder edge survived, re-pointed onto the surviving node's new
    // material handle (m1:color) — fold's whole point: the wiring is kept.
    const rePointed = useAppStore
      .getState()
      .edges.filter((e) => e.target === 'liveOut' && e.targetHandle === 'm1:color');
    expect(rePointed).toHaveLength(1);
  });

  it('drops an UNTARGETED saved Output as dead weight (fold rule on every path)', () => {
    seed();
    useAppStore.getState().instantiateSavedGroup('sg1', { x: 500, y: 500 });

    const outs = outputs();
    expect(outs).toHaveLength(1);
    expect(outs[0].id).toBe('liveOut');
    expect((outs[0].data as { materials?: OutputMaterial[] }).materials).toBeUndefined();
    expect(useAppStore.getState().edges.filter((e) => e.target === 'liveOut')).toHaveLength(0);
  });

  it('keeps the saved Output when the graph has NONE (the clone becomes THE Output)', () => {
    seed(['Body']);
    useAppStore.setState({ nodes: [] });
    useAppStore.getState().instantiateSavedGroup('sg1', { x: 500, y: 500 });
    expect(outputs()).toHaveLength(1);
  });
});
