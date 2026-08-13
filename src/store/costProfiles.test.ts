import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAppStore, VR_HEADSETS, resolveDeviceBudget, resolveDeviceTextureDim } from './useAppStore';
import { getCost, setCostOverrides } from '@/utils/nodeCost';
import { parseCostFile } from '@/utils/costOverride';
import complexityData from '@/registry/complexity.json';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode } from '@/types';

const BASE = (complexityData as { costs: Record<string, number> }).costs;

// A minimal reachable graph: voronoi → output.color, so computeReachableCost
// sums exactly the voronoi price and reprices visibly when a profile is active.
function seedGraph() {
  useAppStore.setState({
    nodes: [makeNode('out', 'output'), makeNode('v', 'voronoi')],
    edges: [makeEdge('v', 'out', 'out', 'color')],
    costProfiles: [],
    selectedHeadsetId: 'quest3',
    totalCost: 0,
  });
}

describe('cost profiles (store lifecycle)', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
    seedGraph();
  });

  afterEach(() => {
    setCostOverrides(null);   // reset the nodeCost module singleton between tests
    vi.unstubAllGlobals();
  });

  const parsedM4 = () => parseCostFile(JSON.stringify({
    meta: { device: 'M4 Max', bench: 'microplane', valid: true }, costs: { voronoi: 230 },
  }))!;

  it('importCostProfile adds a profile, auto-selects it, and reprices the total', () => {
    useAppStore.getState().importCostProfile(parsedM4());
    const s = useAppStore.getState();
    expect(s.costProfiles).toHaveLength(1);
    expect(s.selectedHeadsetId).toMatch(/^cp:M4 Max\|microplane\|/);   // auto-selected (provenance + hash)
    expect(getCost('voronoi')).toBe(230);                              // ACTIVE repriced
    expect(s.totalCost).toBe(230);                                     // reachable total repriced
    // persisted for reload
    expect(localStorage.getItem('fs:costProfiles')).toContain('voronoi');
    expect(localStorage.getItem('fs:headsetId')).toBe(s.selectedHeadsetId);
  });

  it('the new profile inherits the current device budget, and resolveDeviceBudget reads it', () => {
    // current selection quest3 = 200 pts → profile budget = 200
    useAppStore.getState().importCostProfile(parsedM4());
    const s = useAppStore.getState();
    const b = resolveDeviceBudget(s.selectedHeadsetId, s.costProfiles);
    expect(b.isProfile).toBe(true);
    expect(b.maxPoints).toBe(200);
    expect(b.label).toBe('M4 Max');
  });

  it('selecting a built-in headset deactivates the profile (base costs) but keeps it in the list', () => {
    useAppStore.getState().importCostProfile(parsedM4());
    useAppStore.getState().setSelectedHeadsetId('quest3');
    const s = useAppStore.getState();
    expect(getCost('voronoi')).toBe(BASE.voronoi);   // back to authored
    expect(s.totalCost).toBe(BASE.voronoi);
    expect(s.costProfiles).toHaveLength(1);          // profile not deleted
  });

  it('deleting the active profile removes it and falls back to the default headset (base costs)', () => {
    useAppStore.getState().importCostProfile(parsedM4());
    const id = useAppStore.getState().selectedHeadsetId;
    useAppStore.getState().deleteCostProfile(id);
    const s = useAppStore.getState();
    expect(s.costProfiles).toHaveLength(0);
    expect(s.selectedHeadsetId).toBe(VR_HEADSETS[0].id);
    expect(getCost('voronoi')).toBe(BASE.voronoi);
    expect(s.totalCost).toBe(BASE.voronoi);
  });

  it('re-importing the SAME run dedups; a different run is a new profile', () => {
    useAppStore.getState().importCostProfile(parsedM4());            // voronoi:230
    useAppStore.getState().importCostProfile(parsedM4());            // byte-identical → dedup
    expect(useAppStore.getState().costProfiles).toHaveLength(1);
    useAppStore.getState().importCostProfile(
      parseCostFile(JSON.stringify({ meta: { device: 'M4 Max', bench: 'microplane', valid: true }, costs: { voronoi: 999 } }))!,
    );                                                              // different numbers → new entry
    const s = useAppStore.getState();
    expect(s.costProfiles).toHaveLength(2);
    expect(getCost('voronoi')).toBe(999);                           // last import is active
  });

  it('a new profile inherits the current device texture cap', () => {
    useAppStore.setState({ selectedHeadsetId: 'quest2' });           // maxTextureDim 1024
    useAppStore.getState().importCostProfile(parsedM4());
    const s = useAppStore.getState();
    expect(s.costProfiles[0].maxTextureDim).toBe(1024);
    expect(resolveDeviceTextureDim(s.selectedHeadsetId, s.costProfiles)).toBe(1024); // not loosened to 2048
  });

  it('setSelectedHeadsetId ignores an unknown/foreign id (no clobber, no persist)', () => {
    useAppStore.setState({ selectedHeadsetId: 'visionpro' });
    useAppStore.getState().setSelectedHeadsetId('cp:foreign|from-an-imported-project');
    expect(useAppStore.getState().selectedHeadsetId).toBe('visionpro'); // selection kept
    expect(localStorage.getItem('fs:headsetId')).toBeNull();            // not persisted
  });

  it('Quest 3S shares Quest 3s chip, so its budget scales by the pixel ratio', () => {
    const q3 = VR_HEADSETS.find((h) => h.id === 'quest3')!;
    const q3s = VR_HEADSETS.find((h) => h.id === 'quest3s')!;
    // Same Snapdragon XR2 Gen 2 / Adreno 740; a point is per-pixel work at the
    // Quest 3 reference resolution, so the budget scales inversely with pixels.
    // Quest 3S panels are 1832x1920 per eye; Quest 3's are 2064x2208.
    const pixelRatio = (2064 * 2208) / (1832 * 1920);   // 1.29560
    expect(q3s.maxPoints).toBeGreaterThan(q3.maxPoints);
    expect(q3s.maxPoints).toBeCloseTo(q3.maxPoints * pixelRatio, -1);
  });

  /** A collapsed group whose boundary output 'o0' stands in for `<memberId>`/'out'. */
  const collapsedGroup = (cost?: number, memberId = 'v'): AppNode => ({
    id: 'g1',
    type: 'group',
    position: { x: 0, y: 0 },
    data: {
      collapsed: true,
      ...(cost === undefined ? {} : { cost }),
      collapsedInputs: [],
      collapsedOutputs: [{ socketId: 'o0', originalNodeId: memberId, originalHandleId: 'out' }],
    },
  } as unknown as AppNode);

  it('a collapsed group is priced by its MEMBERS, not by its cached snapshot', () => {
    useAppStore.setState({
      nodes: [makeNode('out', 'output'), collapsedGroup(9999),
              { ...makeNode('v', 'voronoi'), parentId: 'g1' } as AppNode],
      edges: [makeEdge('g1', 'o0', 'out', 'color')],
      costProfiles: [], selectedHeadsetId: 'quest3', totalCost: 0,
    });
    useAppStore.getState().setSelectedHeadsetId('quest3');   // recomputes the budget
    expect(useAppStore.getState().totalCost).toBe(BASE.voronoi);   // 9999 today
  });

  it('a group collapsed before data.cost existed still contributes its members', () => {
    useAppStore.setState({
      nodes: [makeNode('out', 'output'), collapsedGroup(undefined),
              { ...makeNode('v', 'voronoi'), parentId: 'g1' } as AppNode],
      edges: [makeEdge('g1', 'o0', 'out', 'color')],
      costProfiles: [], selectedHeadsetId: 'quest3', totalCost: 0,
    });
    useAppStore.getState().setSelectedHeadsetId('quest3');
    expect(useAppStore.getState().totalCost).toBe(BASE.voronoi);   // 0 today
  });

  it('does not bill a collapsed member the Output never reaches', () => {
    // `p` sits inside the group with no outgoing edge — dead weight the old
    // snapshot summed anyway (it had no reachability filter).
    useAppStore.setState({
      nodes: [makeNode('out', 'output'), collapsedGroup(BASE.voronoi + BASE.perlin),
              { ...makeNode('v', 'voronoi'), parentId: 'g1' } as AppNode,
              { ...makeNode('p', 'perlin'), parentId: 'g1' } as AppNode],
      edges: [makeEdge('g1', 'o0', 'out', 'color')],
      costProfiles: [], selectedHeadsetId: 'quest3', totalCost: 0,
    });
    useAppStore.getState().setSelectedHeadsetId('quest3');
    expect(useAppStore.getState().totalCost).toBe(BASE.voronoi);   // voronoi+perlin today
  });
});
