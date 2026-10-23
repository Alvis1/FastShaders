import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { designerNodes, NODE_COSTS, TYPE_CHANNELS, definitionOf, costColorOf, costLabelOf, costScaleOf } from './ndData';
import { getAllDefinitions, getFlowNodeType } from '@/registry/nodeRegistry';
import { freshNodeCost } from '@/utils/nodeCost';
import { getDeviceBudget, setDeviceBudget } from '@/utils/budgetPoints';
import { getCostColor, getCostScale } from '@/utils/colorUtils';
import { useAppStore } from '@/store/useAppStore';

/**
 * The designer's node list is DERIVED from the registry (this is what killed
 * the old snapshot-drift bug class), so most of the old designerCoverage
 * assertions hold by construction. What still deserves pinning:
 *  - the filter is exactly the ShaderNode-rendered rule (a designer that
 *    listed live-canvas nodes would let you author glyphs nothing renders);
 *  - the tuple shape the ported app logic indexes ([id, dataType]);
 *  - costs are a FRESH node's price (`freshNodeCost`), the number the app's
 *    palette tile prints for the same node.
 */
describe('ndData — designer node list derives from the live registry', () => {
  const nodes = designerNodes();
  const shaderTypes = getAllDefinitions()
    .filter((d) => getFlowNodeType(d) === 'shader')
    .map((d) => d.type);

  it('covers exactly the ShaderNode-rendered registry', () => {
    expect(nodes.map((n) => n.type).sort()).toEqual([...shaderTypes].sort());
  });

  it('keeps registry order (the dropdown groups by category in registry order)', () => {
    expect(nodes.map((n) => n.type)).toEqual(shaderTypes);
  });

  it('shapes ports as [id, dataType] tuples with real definitions behind them', () => {
    for (const n of nodes) {
      const def = definitionOf(n.type)!;
      expect(def, n.type).toBeTruthy();
      expect(n.in).toEqual(def.inputs.map((p) => [p.id, p.dataType]));
      expect(n.out).toEqual(def.outputs.map((p) => [p.id, p.dataType]));
      expect(n.cat).toBe(def.category);
      // `def` mirrors defaultValues (null when absent) — the app reads it for
      // preview seeding and the property_float header name.
      expect(n.def).toEqual(def.defaultValues ?? null);
    }
  });

  it('prices every designable node as a fresh node of it (freshNodeCost), never by the raw table', () => {
    for (const n of nodes) {
      expect(typeof (NODE_COSTS[n.type] ?? 0), n.type).toBe('number');
      expect(NODE_COSTS[n.type] ?? 0, n.type).toBe(freshNodeCost(n.type) ?? 0);
    }
    // RGB Curves is why: its table entry (40) prices a node that BAKES; a fresh one is the identity form.
    expect(NODE_COSTS.rgbCurves).toBe(1);
  });

  it('channel seeding covers every socket data type in the designable set', () => {
    for (const n of nodes) {
      for (const [, ty] of [...n.in, ...n.out]) {
        expect(TYPE_CHANNELS[ty], `missing TYPE_CHANNELS entry for "${ty}" (node ${n.type})`).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * NODE_COSTS stays in TABLE points; the cost row, its colour dot and the
 * overlays' px-per-unit read it as the selected device's BUDGET points, as
 * every card does (utils/budgetPoints.ts) — so the overlays still scale by the
 * same factor the stage card (bridge.tsx) is drawn at. The device budget is a
 * worker-wide singleton (isolate:false): restored after every test.
 */
describe('ndData — the cost row and overlays print and scale budget points', () => {
  let saved = 0;
  beforeEach(() => { saved = getDeviceBudget(); });
  afterEach(() => setDeviceBudget(saved));

  it('prints a price as the selected device\'s share of 100, rounded to 0.01 and flagged when rounded', () => {
    setDeviceBudget(200);
    expect(costLabelOf(35)).toEqual({ text: '17.5', rounded: false, exact: '17.5' });
    setDeviceBudget(150);
    expect(costLabelOf(35)).toEqual({ text: '23.33', rounded: true, exact: '23.333333' });
    expect(costLabelOf(0)).toEqual({ text: '0', rounded: false, exact: '0' });
  });

  it('colours the dot and scales the overlays by the same budget points the stage card is drawn at', () => {
    const { costColorLow, costColorHigh } = useAppStore.getState();
    setDeviceBudget(200);
    // 80 table points of a 200 budget = 40 budget points: the gradient's top.
    expect(costScaleOf(80)).toBe(getCostScale(40));
    expect(costScaleOf(80)).toBeCloseTo(1.35);
    expect(costColorOf(80)).toBe(getCostColor(40, costColorLow, costColorHigh));
    // A stricter device runs the same price hotter.
    setDeviceBudget(100);
    expect(costScaleOf(20)).toBe(getCostScale(20));
    expect(costColorOf(20)).toBe(getCostColor(20, costColorLow, costColorHigh));
    expect(costScaleOf(0)).toBe(1);
  });
});
