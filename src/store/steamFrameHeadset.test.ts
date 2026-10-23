import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useAppStore, VR_HEADSETS, resolveDeviceBudget, deviceCostOverrides } from './useAppStore';
import { getCost, setCostOverrides } from '@/utils/nodeCost';
import { setDeviceBudget } from '@/utils/budgetPoints';
import { costTableProvenance } from '@/eval/evalContext';
import complexityData from '@/registry/complexity.json';
import { makeNode, makeEdge, stubLocalStorage } from '@/test-utils';

/**
 * The Steam Frame is the second MEASURED built-in device, and the only one
 * whose prices are not the table: complexity.json is Quest 3 STATIC, the
 * Steam Frame ran MicroPlane, and the two benches disagree on the cheap
 * noises on the SAME Quest 3 (Perlin 27 vs 36). So the row is ratio-bridged —
 * table × SteamFrame-MicroPlane ÷ Quest3-MicroPlane — and this suite re-derives
 * every number from the committed files, so the row can never drift from the
 * evidence or be hand-edited into something nobody measured.
 */

const BASE = (complexityData as { costs: Record<string, number> }).costs;
const BENCH = join(process.cwd(), 'ShaderCarousel', 'benchData');
const STEAM = VR_HEADSETS.find((h) => h.id === 'steamframe')!;

function bridged(): Record<string, number> {
  const sf = JSON.parse(readFileSync(join(BENCH, 'steamframe-20261021',
    'shadercarousel-microplane-qualcomm-adreno-7xx-profile-2026-10-21T1828.json'), 'utf8')) as {
    meta: { valid: boolean; bench: string; timingMethod: string }; costs: Record<string, number>;
  };
  const q3 = JSON.parse(readFileSync(join(BENCH, 'quest3-20260723',
    'shadercarousel-microplane-complexity-suggestion-2026-07-22T2136.json'), 'utf8')) as {
    metadata: { timingMethod: string }; suggestions: { id: string; suggestedPoints: number }[];
  };
  // The bridge is only sound between two runs of ONE bench and ONE timer.
  expect(sf.meta.valid).toBe(true);
  expect(sf.meta.bench).toBe('microplane');
  expect(sf.meta.timingMethod).toBe(q3.metadata.timingMethod);
  const q3Points = new Map(q3.suggestions.map((s) => [s.id.replace(/^noise_/, ''), s.suggestedPoints]));
  const out: Record<string, number> = {};
  for (const [node, sfPoints] of Object.entries(sf.costs)) {
    const q3p = q3Points.get(node);
    expect(q3p, `${node}: the Quest 3 MicroPlane run must have measured it too`).toBeDefined();
    // Both under MicroPlane's timer floor: no ratio exists, the table stands.
    if (sfPoints === 0 && q3p === 0) continue;
    out[node] = Math.round(BASE[node] * sfPoints / q3p!);
  }
  return out;
}

describe('the Steam Frame headset row', () => {
  beforeEach(() => {
    stubLocalStorage();
    useAppStore.setState({
      nodes: [makeNode('out', 'output'), makeNode('v', 'voronoi')],
      edges: [makeEdge('v', 'out', 'out', 'color')],
      costProfiles: [],
      selectedHeadsetId: 'quest3',
      totalCost: 0,
    });
  });

  afterEach(() => {
    setCostOverrides(null);
    setDeviceBudget(VR_HEADSETS[0].maxPoints);
    vi.unstubAllGlobals();
  });

  it('carries exactly the prices the committed runs bridge to', () => {
    expect(STEAM.costs).toEqual(bridged());
    expect(STEAM.costsBasis).toBe('steamframe-20261021');
    // Cell Noise read 0 on both devices — it must stay at the table, not go free.
    expect(STEAM.costs).not.toHaveProperty('cellNoise');
  });

  it('only the Quest 3 row prices from the table itself', () => {
    expect(VR_HEADSETS[0].id).toBe('quest3');
    expect(VR_HEADSETS[0].costs).toBeUndefined();
    for (const h of VR_HEADSETS) expect(h.costs == null, h.id).toBe(h.costsBasis == null);
  });

  it('selecting it reprices the graph, and selecting Quest 3 restores the table', () => {
    useAppStore.getState().setSelectedHeadsetId('steamframe');
    expect(getCost('voronoi')).toBe(STEAM.costs!.voronoi);
    expect(getCost('sin')).toBe(BASE.sin);                    // unmeasured → the table
    expect(useAppStore.getState().totalCost).toBe(STEAM.costs!.voronoi);
    expect(localStorage.getItem('fs:headsetId')).toBe('steamframe');

    useAppStore.getState().setSelectedHeadsetId('quest3');
    expect(getCost('voronoi')).toBe(BASE.voronoi);
    expect(useAppStore.getState().totalCost).toBe(BASE.voronoi);
  });

  it('a cost profile wins over a headset for the same lookup, and the lookup hands out a copy', () => {
    expect(deviceCostOverrides('steamframe', [])).toEqual(STEAM.costs);
    expect(deviceCostOverrides('steamframe', [])).not.toBe(STEAM.costs);
    expect(deviceCostOverrides('quest3', [])).toBeNull();
    expect(deviceCostOverrides('cp:x', [{ id: 'cp:x', costs: { voronoi: 9 } }])).toEqual({ voronoi: 9 });
  });

  it('resolves its own label and budget', () => {
    expect(resolveDeviceBudget('steamframe', [])).toMatchObject({
      label: 'Valve Steam Frame', maxPoints: 200, isProfile: false,
    });
  });

  it('a study package records its prices as measured, naming the run', () => {
    useAppStore.getState().setSelectedHeadsetId('steamframe');
    const p = costTableProvenance();
    expect(p.kind).toBe('measured');
    expect(p.source).toMatch(/^complexity\.json@.+\+steamframe-20261021$/);
    // Table points against the device's own budget, printed against 100.
    expect([p.budget, p.shownBudget]).toEqual([200, 100]);
    useAppStore.getState().setSelectedHeadsetId('quest3');
    expect(costTableProvenance().kind).toBe('builtin');
  });
});
