import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  useAppStore, VR_HEADSETS, UNLIMITED_DEVICE_ID, resolveDeviceBudget, deviceCostOverrides, isSelectableDeviceId,
} from './useAppStore';
import { getCost, setCostOverrides } from '@/utils/nodeCost';
import { getDeviceBudget, setDeviceBudget } from '@/utils/budgetPoints';
import { parseCostFile } from '@/utils/costOverride';
import complexityData from '@/registry/complexity.json';
import { makeNode, makeEdge, stubLocalStorage } from '@/test-utils';

/**
 * The device dropdown's "Unlimited" row (owner, 2026-11-21): a selection with
 * NO budget, so the cost bar draws no slider and nothing is coloured by cost.
 * It is no device: everything a device decides — the prices, the divisor the
 * point figures print with, the image cap — is the DEFAULT device's, and a
 * study tab never selects it, because there the cost feedback is the arm's
 * condition. The colour and slider halves are React (node-only suite), so
 * they are pinned on the source below; the store half runs.
 */

const BASE = (complexityData as { costs: Record<string, number> }).costs;
const QUEST = VR_HEADSETS[0];
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('the "Unlimited" device row', () => {
  beforeEach(() => {
    stubLocalStorage();
    useAppStore.setState({
      nodes: [makeNode('out', 'output'), makeNode('v', 'voronoi')],
      edges: [makeEdge('v', 'out', 'out', 'color')],
      costProfiles: [],
      selectedHeadsetId: QUEST.id,
      totalCost: 0,
    });
  });

  afterEach(() => {
    setCostOverrides(null);
    setDeviceBudget(QUEST.maxPoints);
    useAppStore.setState({ costProfiles: [], selectedHeadsetId: QUEST.id });
    vi.unstubAllGlobals();
  });

  it('is no device: not a VR_HEADSETS row, and no cost profile id can be it', () => {
    expect(VR_HEADSETS.some((h) => h.id === UNLIMITED_DEVICE_ID)).toBe(false);
    expect(UNLIMITED_DEVICE_ID.startsWith('cp:')).toBe(false);
  });

  it('is selectable outside a study, persisted, and bumps costVersion', () => {
    expect(isSelectableDeviceId(UNLIMITED_DEVICE_ID, [])).toBe(true);
    const v = useAppStore.getState().costVersion;
    useAppStore.getState().setSelectedHeadsetId(UNLIMITED_DEVICE_ID);
    expect(useAppStore.getState().selectedHeadsetId).toBe(UNLIMITED_DEVICE_ID);
    expect(useAppStore.getState().costVersion).toBe(v + 1);
    expect(localStorage.getItem('fs:headsetId')).toBe(UNLIMITED_DEVICE_ID);
  });

  it("prices with the shipped table and prints against the default device's divisor", () => {
    useAppStore.getState().setSelectedHeadsetId('steamframe');
    expect(getCost('voronoi')).not.toBe(BASE.voronoi);
    useAppStore.getState().setSelectedHeadsetId(UNLIMITED_DEVICE_ID);
    expect(deviceCostOverrides(UNLIMITED_DEVICE_ID, [])).toBeNull();
    expect(getCost('voronoi')).toBe(BASE.voronoi);
    expect(useAppStore.getState().totalCost).toBe(BASE.voronoi);
    expect(getDeviceBudget()).toBe(QUEST.maxPoints);
    // The image-notice label and the cap it names are the default device's.
    expect(resolveDeviceBudget(UNLIMITED_DEVICE_ID, [])).toEqual({ label: QUEST.label, maxPoints: QUEST.maxPoints, isProfile: false });
  });

  it('survives a bundle import that keeps the current selection', () => {
    useAppStore.getState().setSelectedHeadsetId(UNLIMITED_DEVICE_ID);
    const other = parseCostFile(JSON.stringify({ meta: { device: 'Someone else' }, costs: { voronoi: 999 } }))!;
    useAppStore.getState().importCostProfiles([other], { select: 'current' });
    expect(useAppStore.getState().selectedHeadsetId).toBe(UNLIMITED_DEVICE_ID);
    expect(getCost('voronoi')).toBe(BASE.voronoi);
  });

  it('is never offered, kept or selected in a study', () => {
    // The study flags are sampled at module init or set by a consented
    // session, neither of which a node suite has, so this half is pinned on
    // the source rather than run. The store asks telemetry (its one eval import).
    const store = read('./useAppStore.ts');
    expect(store).toMatch(/if \(id === UNLIMITED_DEVICE_ID\) return !isEvalSessionActive\(\);/);
    expect(store).toMatch(/setSelectedHeadsetId: \(id\) => \{[\s\S]{0,900}if \(!isSelectableDeviceId\(id, costProfiles\)\) return;/);
    // A browser that had it from ordinary use starts the participant on the default device.
    const gate = read('../eval/EvalGate.tsx');
    const slate = gate.slice(gate.indexOf('function cleanSlateForStudy'), gate.indexOf('export function EvalGate'));
    expect(slate).toContain('if (store.selectedHeadsetId === UNLIMITED_DEVICE_ID) store.setSelectedHeadsetId(VR_HEADSETS[0].id);');
    const bar = read('../components/Layout/CostBar.tsx');
    expect(bar).toMatch(/const OFFERS_UNLIMITED = !isEvalMode\(\);/);
    expect(bar).toMatch(/\{OFFERS_UNLIMITED && \(\s*<optgroup[^>]*>\s*<option value=\{UNLIMITED_DEVICE_ID\}>/);
  });

  it('drops the slider and the cost colours, never the figures or the card size', () => {
    const bar = read('../components/Layout/CostBar.tsx');
    expect(bar).toMatch(/\{!unlimited && <div className="cost-bar__track-row">/);
    expect(bar).toMatch(/const over = !unlimited && points > POINT_BUDGET;/);
    const chrome = read('../components/NodeEditor/nodes/useCostChrome.ts');
    expect(chrome).toMatch(/const colourPoints = unlimited \? 0 : visiblePoints;/);
    expect(chrome).toMatch(/costScale: getCostScale\(visiblePoints\)/);
    expect(chrome).toMatch(/cost > max && !unlimited \? ' node-base__cost-badge--over'/);
    // Every other surface that colours a price by the gradient asks the same hook.
    for (const rel of [
      '../components/NodeEditor/AssetCostBadge.tsx',
      '../components/NodeEditor/menus/AddNodeMenu.tsx',
      '../intro/InsertScene.tsx',
      '../nodeDesigner/bridge.tsx',
      '../llm/GeneratorDialog.tsx',
    ]) expect(read(rel), rel).toMatch(/useBudgetUnlimited\(\)/);
  });
});
