import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAppStore, VR_HEADSETS, resolveDeviceBudget, resolveDeviceTextureDim } from './useAppStore';
import { getCost, setCostOverrides } from '@/utils/nodeCost';
import { parseCostFile, buildProfileFile } from '@/utils/costOverride';
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

  it('a new profile inherits the ACTIVE device texture cap, never loosening it', () => {
    // Only ONE built-in preset ships (Quest 3, 2048 — untested presets were
    // removed 2026-08-14), so the stricter-cap case is pinned through a
    // measured profile: import while a 1024-cap profile is active and the new
    // profile must inherit 1024, not bounce back to the preset's 2048.
    useAppStore.getState().importCostProfile(parsedM4());            // auto-selects itself
    const first = useAppStore.getState().costProfiles[0];
    useAppStore.setState({ costProfiles: [{ ...first, maxTextureDim: 1024 }] });
    useAppStore.getState().importCostProfile(
      parseCostFile(JSON.stringify({ meta: { device: 'other', bench: 'static', valid: true }, costs: { voronoi: 111 } }))!,
    );
    const s = useAppStore.getState();
    const latest = s.costProfiles.find((p) => p.label === 'other')!;
    expect(latest.maxTextureDim).toBe(1024);
    expect(resolveDeviceTextureDim(s.selectedHeadsetId, s.costProfiles)).toBe(1024); // not loosened to 2048
  });

  it('createCostProfile adds a hand-authored profile, selects it, and changes no price', () => {
    const p = useAppStore.getState().createCostProfile('My Device');
    const s = useAppStore.getState();
    expect(s.costProfiles).toEqual([p]);
    expect(s.selectedHeadsetId).toBe(p.id);
    expect(p.meta.manual).toBe(true);
    expect(p.maxPoints).toBe(200);              // inherits the active device budget (quest3)
    expect(p.maxTextureDim).toBe(2048);         // …and its texture cap
    // Seeded from the authored table, so creating one is a no-op for the bar
    // until the user edits it — a "new profile" must not silently reprice.
    expect(getCost('voronoi')).toBe(BASE.voronoi);
    expect(s.totalCost).toBe(BASE.voronoi);
    expect(localStorage.getItem('fs:costProfiles')).toContain(p.id);
  });

  it('the download → edit → re-import loop UPDATES the row instead of forking it', () => {
    const p = useAppStore.getState().createCostProfile('My Device');
    // What "Edit profile…" writes, hand-edited: one price changed.
    const file = buildProfileFile(p) as { meta: Record<string, unknown>; costs: Record<string, number> };
    file.costs.voronoi = 777;
    useAppStore.getState().importCostProfile(parseCostFile(JSON.stringify(file), 'fastshaders-profile-my-device.json')!);
    const s = useAppStore.getState();
    expect(s.costProfiles).toHaveLength(1);      // same row — the id travelled in the file
    expect(s.costProfiles[0].id).toBe(p.id);
    expect(s.costProfiles[0].label).toBe('My Device');
    expect(s.costProfiles[0].meta.manual).toBe(true);
    expect(getCost('voronoi')).toBe(777);
  });

  it('a hand-authored file cannot overwrite a MEASURED profile', () => {
    useAppStore.getState().importCostProfile(parsedM4());          // voronoi:230, measured
    const measured = useAppStore.getState().costProfiles[0];
    useAppStore.getState().importCostProfile(parseCostFile(JSON.stringify({
      meta: { id: measured.id, label: 'typed', manual: true }, costs: { voronoi: 1 },
    }))!);
    const s = useAppStore.getState();
    expect(s.costProfiles).toHaveLength(2);                        // landed beside it, not over it
    expect(s.costProfiles.find((x) => x.id === measured.id)!.costs.voronoi).toBe(230);
  });

  it('a bundle imports every profile, each against the PRE-import device', () => {
    const a = parseCostFile(JSON.stringify({ meta: { id: 'cp:manual:a', label: 'A', maxPoints: 111, manual: true }, costs: { voronoi: 10 } }))!;
    const b = parseCostFile(JSON.stringify({ meta: { device: 'Rig B' }, costs: { voronoi: 20 } }))!;
    expect(useAppStore.getState().importCostProfiles([a, b])).toBe(2);
    const s = useAppStore.getState();
    expect(s.costProfiles).toHaveLength(2);
    expect(s.costProfiles.find((p) => p.label === 'A')!.maxPoints).toBe(111);   // its own claimed budget
    // B has none of its own, so it inherits quest3's 200 — NOT A's 111, which
    // is what resolving the budget per entry would have given it.
    expect(s.costProfiles.find((p) => p.label === 'Rig B')!.maxPoints).toBe(200);
    expect(s.selectedHeadsetId).toBe(s.costProfiles[1].id);                     // last one wins
    expect(getCost('voronoi')).toBe(20);
  });

  it("a bundle keeps the active device, counts ROWS landed, and still refreshes prices", () => {
    // Two entries claiming ONE id collapse to one row — the count the notice
    // prints must be rows, not entries, or a bundle over-reports what landed.
    const dup = (v: number) => parseCostFile(JSON.stringify({
      meta: { id: 'cp:manual:same', label: 'Same', manual: true }, costs: { voronoi: v },
    }))!;
    expect(useAppStore.getState().importCostProfiles([dup(1), dup(2)])).toBe(1);
    expect(useAppStore.getState().costProfiles).toHaveLength(1);

    // select: 'current' — restoring a backup must not reprice the open shader
    // against whichever entry the file happened to end with…
    useAppStore.getState().setSelectedHeadsetId('quest3');
    const other = parseCostFile(JSON.stringify({ meta: { device: 'Someone else' }, costs: { voronoi: 999 } }))!;
    useAppStore.getState().importCostProfiles([other], { select: 'current' });
    expect(useAppStore.getState().selectedHeadsetId).toBe('quest3');
    expect(getCost('voronoi')).toBe(BASE.voronoi);          // still the authored table

    // …but when an entry IS the active profile, its new prices must take
    // effect: the selection is unchanged, so nothing else would re-apply them.
    useAppStore.getState().setSelectedHeadsetId('cp:manual:same');
    expect(getCost('voronoi')).toBe(2);
    useAppStore.getState().importCostProfiles([dup(42)], { select: 'current' });
    expect(useAppStore.getState().selectedHeadsetId).toBe('cp:manual:same');
    expect(getCost('voronoi')).toBe(42);
  });

  it('setSelectedHeadsetId ignores an unknown/foreign id (no clobber, no persist)', () => {
    useAppStore.setState({ selectedHeadsetId: 'quest3' });
    useAppStore.getState().setSelectedHeadsetId('cp:foreign|from-an-imported-project');
    expect(useAppStore.getState().selectedHeadsetId).toBe('quest3');    // selection kept
    expect(localStorage.getItem('fs:headsetId')).toBeNull();            // not persisted
  });

  it('ships exactly the measured device presets (untested devices removed 2026-08-14)', () => {
    // A budget nobody measured certifies shaders for hardware nobody ran. A
    // device earns a row by being benchmarked — run ShaderCarousel on it and
    // import the result JSON — so this list only ever grows with evidence.
    expect(VR_HEADSETS.map((h) => h.id)).toEqual(['quest3']);
    expect(VR_HEADSETS[0].maxPoints).toBe(200); // the quest3-20260723 calibration basis
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
