import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';
import type { OutputMaterial } from '@/utils/outputMaterials';
import { activeSink } from '@/utils/sdfPartition';

/**
 * A saved group may legitimately contain an Output (groupSelection filters
 * only groups and notes). Instantiating one folds a LEGACY-targeted copy into
 * the live Output as materials with its feeder edges re-pointed
 * (`foldExtraOutputs`), while an UNTARGETED copy arrives as an ordinary
 * INACTIVE Output — several may coexist, exactly one active
 * (utils/sdfPartition.ts `activeSink`) — and the live graph's Output keeps
 * driving because it precedes the arriving members in the combined array.
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

describe('instantiateSavedGroup and the Output it may carry', () => {
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

  it('keeps an UNTARGETED saved Output as an INACTIVE second Output, wiring intact; the live one still drives', () => {
    seed();
    useAppStore.getState().instantiateSavedGroup('sg1', { x: 500, y: 500 });

    const outs = outputs();
    expect(outs).toHaveLength(2);
    expect(outs[0].id).toBe('liveOut');
    expect((outs[0].data as { materials?: OutputMaterial[] }).materials).toBeUndefined();
    // The arriving copy keeps what fed it (fresh ids, so match by handle).
    const arrived = outs[1];
    expect(useAppStore.getState().edges.filter((e) => e.target === arrived.id && e.targetHandle === 'color')).toHaveLength(1);
    // Neither carries the flag (the group's copy was cleared at load), so the
    // historical rule holds: the first in array order — the live one — drives.
    expect(outs.some((n) => (n.data as Record<string, unknown>).activeOutput === true)).toBe(false);
    expect(activeSink(useAppStore.getState().nodes, useAppStore.getState().edges)?.id).toBe('liveOut');
  });

  it('keeps the saved Output when the graph has NONE (the clone becomes THE Output)', () => {
    seed(['Body']);
    useAppStore.setState({ nodes: [] });
    useAppStore.getState().instantiateSavedGroup('sg1', { x: 500, y: 500 });
    expect(outputs()).toHaveLength(1);
  });
});
