/**
 * Every device's budget prints as 100 (utils/budgetPoints.ts), so the store's
 * job is to hand the point display the SELECTED device's budget in table
 * points — the divisor — on every selection, and nothing else.
 *
 * The rules worth failing a build over:
 *  - selecting a device (built-in or profile) moves the display's divisor
 *    with its price table, in the same action that bumps `costVersion`;
 *  - the budget is the device's own measured one — the user-typed cap layered
 *    over it (`fs:costBudgets`, the cost bar's right-click editor) is retired:
 *    no reader, no writer, the key forgotten at boot;
 *  - a study package states both units, so a total is interpretable later.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { useAppStore, VR_HEADSETS, resolveDeviceBudget } from './useAppStore';
import { setCostOverrides } from '@/utils/nodeCost';
import { getDeviceBudget, setDeviceBudget, budgetPointsOf } from '@/utils/budgetPoints';
import { sanitizeCostMeta, type CostProfile } from '@/utils/costOverride';
import { costTableProvenance } from '@/eval/evalContext';
import { stubLocalStorage } from '@/test-utils';

const QUEST = VR_HEADSETS[0];
const RIG: CostProfile = {
  id: 'cp:bench rig', label: 'Bench rig', maxPoints: 150, maxTextureDim: 2048,
  costs: { voronoi: 300 }, meta: sanitizeCostMeta({ manual: true }),
};

describe('the device budget the point display divides by', () => {
  beforeEach(() => {
    stubLocalStorage();
    useAppStore.setState({ costProfiles: [RIG], selectedHeadsetId: QUEST.id, nodes: [], edges: [], totalCost: 0 });
    useAppStore.getState().setSelectedHeadsetId(QUEST.id);
  });
  afterEach(() => {
    setCostOverrides(null);
    setDeviceBudget(QUEST.maxPoints);
    useAppStore.setState({ costProfiles: [], selectedHeadsetId: QUEST.id });
    vi.unstubAllGlobals();
  });

  it('follows every selection, with the price table, in the action that bumps costVersion', () => {
    expect(getDeviceBudget()).toBe(QUEST.maxPoints);
    const v = useAppStore.getState().costVersion;
    useAppStore.getState().setSelectedHeadsetId(RIG.id);
    expect(useAppStore.getState().costVersion).toBe(v + 1);
    expect(getDeviceBudget()).toBe(150);
    // 300 table points is twice this device's frame: 200 budget points.
    expect(budgetPointsOf(300)).toBe(200);
    useAppStore.getState().setSelectedHeadsetId('steamframe');
    expect(getDeviceBudget()).toBe(200);
  });

  it('ignores an id that resolves to no device, keeping the current divisor', () => {
    useAppStore.getState().setSelectedHeadsetId(RIG.id);
    useAppStore.getState().setSelectedHeadsetId('cp:somebody else');
    expect(getDeviceBudget()).toBe(150);
  });

  it('is the device row\'s own measured budget — there is no override layer', () => {
    expect(resolveDeviceBudget(RIG.id, [RIG])).toEqual({ label: 'Bench rig', maxPoints: 150, isProfile: true });
    expect(resolveDeviceBudget('gone', [])).toEqual({ label: QUEST.label, maxPoints: QUEST.maxPoints, isProfile: false });
    const state = useAppStore.getState() as unknown as Record<string, unknown>;
    expect('costBudgetOverrides' in state).toBe(false);
    expect('setCostBudgetOverride' in state).toBe(false);
  });

  it('retires fs:costBudgets: never read or written, forgotten at boot', () => {
    const store = readFileSync(new URL('./useAppStore.ts', import.meta.url), 'utf8');
    expect(store).toContain("localStorage.removeItem('fs:costBudgets')");
    expect(store).not.toMatch(/getItem\('fs:costBudgets'\)|setItem\('fs:costBudgets'/);
  });

  it('every suite that can move the divisor restores it (isolate:false shares it with the next file)', () => {
    // The divisor is a module singleton like the price table, and a leaked
    // budget is silent: the next file in the worker lays out cost-scaled cards
    // at that budget's scale (a layout suite's wire-crossing count moved by one
    // under a leaked 111). A suite that selects a device, imports or creates a
    // profile, or sets the budget must also call setDeviceBudget to put it back.
    const root = new URL('..', import.meta.url);
    const moves = /\b(setSelectedHeadsetId|importCostProfiles?|createCostProfile|deleteCostProfile|setDeviceBudget)\(/;
    const offenders: string[] = [];
    for (const rel of readdirSync(root, { recursive: true }) as string[]) {
      if (!rel.endsWith('.test.ts')) continue;
      const src = readFileSync(new URL(rel, root), 'utf8');
      if (moves.test(src) && !/setDeviceBudget\([^)]/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('a study package records the table budget and the 100 it was printed as', () => {
    useAppStore.getState().setSelectedHeadsetId(RIG.id);
    expect(costTableProvenance()).toMatchObject({ kind: 'manual', budget: 150, shownBudget: 100 });
    useAppStore.getState().setSelectedHeadsetId(QUEST.id);
    expect(costTableProvenance()).toMatchObject({ kind: 'builtin', budget: QUEST.maxPoints, shownBudget: 100 });
  });
});
