import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { freshNodeCost, nodeCostPoints, getBaseCosts, setCostOverrides } from './nodeCost';
import { getAllDefinitions } from '@/registry/nodeRegistry';
import { NODE_COSTS as DESIGNER_COSTS } from '@/nodeDesigner/bridge';
import { makeNode } from '@/test-utils';

/**
 * ONE price per node TYPE on every surface (utils/nodeCost.ts `freshNodeCost`):
 * the palette tile, the Add-node menu row, the Designer card, the node-editor
 * overview, the palette strip's sort and the `data.cost` every creation path
 * stamps all show what a node FRESH from the palette is charged. RGB Curves is
 * why this exists: a fresh
 * node is its identity form (1, no texture) while its table entry (40) is the
 * price of a node that bakes — the surfaces read the raw table and said 28
 * while the dropped node said 1.
 *
 * Reads the SHIPPED table on purpose; the ACTIVE one is a worker-wide singleton
 * (isolate:false), so every test starts and ends with no override.
 */

beforeEach(() => setCostOverrides(null));
afterEach(() => setCostOverrides(null));

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8');

describe('freshNodeCost — the price of a node type', () => {
  it('is what a fresh node of every registry type is charged', () => {
    for (const def of getAllDefinitions()) {
      const fresh = makeNode('n', def.type, { ...def.defaultValues });
      expect(nodeCostPoints(fresh, []), def.type).toBe(freshNodeCost(def.type) ?? 0);
    }
  });

  it('is the shipped table entry for every type but RGB Curves, whose fresh node bakes nothing', () => {
    const base = getBaseCosts();
    for (const type of Object.keys(base)) {
      expect(freshNodeCost(type), type).toBe(type === 'rgbCurves' ? 1 : base[type]);
    }
    expect(base.rgbCurves).toBe(40);
    expect(freshNodeCost('notARegisteredType')).toBeUndefined();
    expect(freshNodeCost('constructor')).toBeUndefined(); // the table is null-prototype
  });

  it('follows no profile — a type surface prints the shipped table, and a fresh RGB Curves node is 1 under any', () => {
    setCostOverrides({ rgbCurves: 90, colormap: 12, sin: 9 });
    expect([freshNodeCost('rgbCurves'), freshNodeCost('colorRamp'), freshNodeCost('sin')]).toEqual([1, 4, 4]);
    expect(nodeCostPoints(makeNode('k', 'rgbCurves'), [])).toBe(1);
  });

  it('the Designer import surface carries the same table, for every type it can price', () => {
    for (const type of Object.keys(getBaseCosts())) expect(DESIGNER_COSTS[type], type).toBe(freshNodeCost(type));
    expect(DESIGNER_COSTS.rgbCurves).toBe(1);
  });

  it('every type surface and every creation path read it, never the raw table (source pins)', () => {
    const created = /const cost = freshNodeCost\(def\.type\) \?\? 0;/;
    const SURFACES: Array<[string, RegExp[]]> = [
      ['components/NodeEditor/NodePreviewCard.tsx', [created]],
      // The menu row AND the node the menu creates.
      ['components/NodeEditor/menus/AddNodeMenu.tsx', [/const cost = freshNodeCost\(def\.type\) \?\? 0;[\s\S]*const cost = freshNodeCost\(def\.type\) \?\? 0;/]],
      ['components/Graphs/GraphsPage.tsx', [/cost: freshNodeCost\(def\.type\) \?\? 0,/]],
      ['components/NodeEditor/NodeEditor.tsx', [created]],
      ['engine/codeToGraph.ts', [created]],
      // The stage card, and the table designerApp's cost row and overlays scale by (ndData, through bridge's
      // `export *` — one table, never a raw one shadowed by a local export).
      ['nodeDesigner/bridge.tsx', [created]],
      ['nodeDesigner/ndData.ts', [/\[type, freshNodeCost\(type\) \?\? 0\]/]],
      // The palette strip sorts by the number its tiles print.
      ['components/NodeEditor/ContentBrowser.tsx', [/freshNodeCost\(a\.type\)/, /freshNodeCost\(b\.type\)/]],
      // The splat-graph start's one Splat Output, built as a palette drop builds one.
      ['utils/splatGraphStart.ts', [/cost: freshNodeCost\(def\.type\) \?\? 0,/]],
    ];
    for (const [file, pins] of SURFACES) {
      const src = read(file);
      for (const pin of pins) expect(src, file).toMatch(pin);
      expect(src, file).not.toMatch(/(COSTS|costs|getBaseCosts\(\))\[def\.type\]/);
    }
  });
});
