import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assetCostPoints, nodeCostPoints, setCostOverrides, getBaseCosts } from './nodeCost';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import { codeToGraph } from '@/engine/codeToGraph';
import type { AppNode } from '@/types';

/**
 * A ready-made group's price (utils/nodeCost.ts `assetCostPoints`) — what a
 * preset, recipe or texture tile prints and its strip sorts by — is the
 * creation snapshot's sum re-read under the SELECTED device's table. The
 * library is built once a session, so the snapshot sum (`totalCost`) is frozen
 * under whichever device was selected then; the tiles have to follow a device
 * change as every node card does.
 *
 * The price table is a worker-wide singleton (isolate:false): every test
 * starts and ends on the shipped table.
 */

beforeEach(() => setCostOverrides(null));
afterEach(() => setCostOverrides(null));

const assets = () => [...getBuiltinPresets(), ...getBuiltinTextures()];

/** What building the group NOW would stamp: codeToGraph's `data.cost` per node,
 *  minus the dropped Output — codeGroupBuilder's own `totalCost` sum. */
function stampedNow(code: string): number {
  return codeToGraph(code).nodes
    .filter((n) => n.data.registryType !== 'output')
    .reduce((sum, n) => sum + ((n.data as { cost?: number }).cost ?? 0), 0);
}

const count = (nodes: readonly AppNode[], type: string) =>
  nodes.filter((n) => n.data.registryType === type).length;

describe('assetCostPoints — a ready-made group, priced under the selected device', () => {
  it('is the tile\'s snapshot sum (`totalCost`) for every built-in preset, recipe and texture on the shipped table', () => {
    const all = assets();
    expect(all.length).toBeGreaterThan(40);
    for (const a of all) {
      expect(assetCostPoints(a.nodes), a.id).toBe(a.totalCost);
      // …which is what a rebuild stamps today, so the equality is the rule's,
      // not a coincidence of when the library happened to be built.
      expect(assetCostPoints(a.nodes), a.id).toBe(stampedNow(a.code));
    }
  });

  it('follows the device: a measured Perlin reprices every Perlin-bearing asset as a rebuild under that table would', () => {
    const withPerlin = assets().filter((a) => count(a.nodes, 'perlin') > 0);
    expect(withPerlin.length).toBeGreaterThan(5);
    const shipped = getBaseCosts().perlin;
    setCostOverrides({ perlin: 25 });
    for (const a of withPerlin) {
      expect(assetCostPoints(a.nodes), a.id).toBe(a.totalCost - count(a.nodes, 'perlin') * (shipped - 25));
      expect(assetCostPoints(a.nodes), a.id).toBe(stampedNow(a.code));
    }
    // An asset with no Perlin keeps its price.
    const without = assets().find((a) => a.id === 'mosaic')!;
    expect(assetCostPoints(without.nodes)).toBe(without.totalCost);
  });

  it('prices a Color Ramp through colormap, as its stamp is taken (the LUT path)', () => {
    const ramps = assets().filter((a) => count(a.nodes, 'colorRamp') > 0);
    expect(ramps.length).toBeGreaterThan(3);
    setCostOverrides({ colormap: 12 });
    for (const a of ramps) {
      expect(assetCostPoints(a.nodes), a.id).toBe(a.totalCost + count(a.nodes, 'colorRamp') * (12 - getBaseCosts().colormap));
      expect(assetCostPoints(a.nodes), a.id).toBe(stampedNow(a.code));
    }
  });

  it('charges a variadic fold its base once — the stamp\'s rule, not the cost bar\'s base × (N−1)', () => {
    // The two built-ins with a fold: the tile prints the stamped sum, the bar
    // charges the dropped graph a point or two more (ContentBrowser's byCost).
    for (const [id, tile, bar] of [['studio-shine', 76, 78], ['stylized-water', 48, 49]] as const) {
      const a = assets().find((x) => x.id === id)!;
      expect(assetCostPoints(a.nodes), id).toBe(tile);
      expect(a.nodes.reduce((sum, n) => sum + nodeCostPoints(n, a.edges), 0), id).toBe(bar);
    }
  });

  it('prices the frame and the note at nothing', () => {
    const led = getBuiltinTextures().find((t) => t.id === 'led-display')!;
    const frameAndNote = led.nodes.filter((n) => n.type === 'group' || n.type === 'note');
    expect(frameAndNote.map((n) => n.type).sort()).toEqual(['group', 'note']);
    expect(assetCostPoints(frameAndNote)).toBe(0);
    expect(assetCostPoints([])).toBe(0);
  });
});
