/**
 * Pins the user-set point cap (the CostBar's right-click editor).
 *
 * The cap is the one number on that panel that is a judgement rather than a
 * measurement, so it gets its own store slice instead of editing the device:
 * `VR_HEADSETS` is a module constant carrying a MEASURED budget, and a
 * profile's `maxPoints` belongs to the file it was imported from, which the
 * download → edit → drop-back loop round-trips. Both must survive an override,
 * and Reset has to mean "forget my number", not "write the default back".
 *
 * The rules worth failing a build over:
 *  - a cap layers over EITHER kind of device, keyed per device id;
 *  - `deviceMaxPoints` keeps reporting what Reset would restore, so no surface
 *    has to re-derive it (and get it wrong);
 *  - the two-argument call is byte-identical to what it was, because three
 *    call sites outside this file rely on it;
 *  - the persisted map is adversarial input — it is written to localStorage,
 *    which anything at this origin can forge.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAppStore, VR_HEADSETS, resolveDeviceBudget } from './useAppStore';
import { setCostOverrides } from '@/utils/nodeCost';
import { parseCostFile } from '@/utils/costOverride';

const QUEST = VR_HEADSETS[0];

describe('point-cap override', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
    useAppStore.setState({
      costProfiles: [],
      costBudgetOverrides: Object.create(null) as Record<string, number>,
      selectedHeadsetId: QUEST.id,
    });
  });
  afterEach(() => {
    setCostOverrides(null);
    vi.unstubAllGlobals();
  });

  const budget = () => {
    const s = useAppStore.getState();
    return resolveDeviceBudget(s.selectedHeadsetId, s.costProfiles, s.costBudgetOverrides);
  };

  it('layers over a built-in headset and still reports what Reset restores', () => {
    expect(budget()).toMatchObject({ maxPoints: QUEST.maxPoints, overridden: false, deviceMaxPoints: QUEST.maxPoints });
    useAppStore.getState().setCostBudgetOverride(QUEST.id, 320);
    expect(budget()).toMatchObject({ maxPoints: 320, overridden: true, deviceMaxPoints: QUEST.maxPoints });
    expect(budget().label).toBe(QUEST.label);          // the device is unchanged
    expect(VR_HEADSETS[0].maxPoints).toBe(QUEST.maxPoints);  // …including the shipped constant
  });

  it('null forgets it', () => {
    useAppStore.getState().setCostBudgetOverride(QUEST.id, 320);
    useAppStore.getState().setCostBudgetOverride(QUEST.id, null);
    expect(budget()).toMatchObject({ maxPoints: QUEST.maxPoints, overridden: false });
  });

  it('is keyed per device, so switching devices does not carry it across', () => {
    const parsed = parseCostFile(JSON.stringify({
      meta: { device: 'M4 Max', bench: 'microplane', valid: true }, costs: { voronoi: 230 },
    }))!;
    useAppStore.getState().importCostProfile(parsed);           // auto-selects the profile
    const profileId = useAppStore.getState().selectedHeadsetId;
    useAppStore.getState().setCostBudgetOverride(profileId, 90);
    expect(budget()).toMatchObject({ maxPoints: 90, overridden: true, isProfile: true });

    useAppStore.getState().setSelectedHeadsetId(QUEST.id);
    expect(budget()).toMatchObject({ maxPoints: QUEST.maxPoints, overridden: false });

    useAppStore.getState().setSelectedHeadsetId(profileId);
    expect(budget().maxPoints).toBe(90);                         // still there
  });

  it('a profile created afterwards inherits the typed cap, so the scale cannot jump', () => {
    useAppStore.getState().setCostBudgetOverride(QUEST.id, 320);
    const p = useAppStore.getState().createCostProfile('Bench rig');
    expect(p.maxPoints).toBe(320);
  });

  it('refuses junk instead of clamping it', () => {
    const set = useAppStore.getState().setCostBudgetOverride;
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 2e9]) {
      set(QUEST.id, bad);
      expect(budget(), `${bad} was accepted`).toMatchObject({ maxPoints: QUEST.maxPoints, overridden: false });
    }
    // …and a fraction is rounded, not rejected.
    set(QUEST.id, 249.6);
    expect(budget().maxPoints).toBe(250);
  });

  it('typing the device number clears the entry rather than storing a copy of it', () => {
    // The CostBar commits `null` for a draft equal to the device budget; the
    // store must then hold nothing, or the ✎ mark would claim a custom cap
    // identical to the measured one.
    useAppStore.getState().setCostBudgetOverride(QUEST.id, null);
    expect(Object.keys(useAppStore.getState().costBudgetOverrides)).toEqual([]);
  });

  it('persists, and keeps the map free of Object.prototype', () => {
    useAppStore.getState().setCostBudgetOverride(QUEST.id, 320);
    expect(JSON.parse(localStorage.getItem('fs:costBudgets')!)).toEqual({ [QUEST.id]: 320 });
    const map = useAppStore.getState().costBudgetOverrides;
    expect(Object.getPrototypeOf(map)).toBeNull();
    // A forged key can therefore never resolve to an inherited function.
    expect(map['constructor']).toBeUndefined();
    expect(map['__proto__']).toBeUndefined();
  });

  it('leaves the two-argument call exactly as it was', () => {
    // Three call sites outside the CostBar still pass two arguments; an
    // override must be invisible to them rather than throwing or leaking in.
    useAppStore.getState().setCostBudgetOverride(QUEST.id, 320);
    const s = useAppStore.getState();
    expect(resolveDeviceBudget(s.selectedHeadsetId, s.costProfiles)).toMatchObject({
      maxPoints: QUEST.maxPoints, overridden: false,
    });
  });
});
