import { describe, it, expect } from 'vitest';
import { designerNodes, NODE_COSTS, TYPE_CHANNELS, definitionOf } from './ndData';
import { getAllDefinitions, getFlowNodeType } from '@/registry/nodeRegistry';

/**
 * The designer's node list is DERIVED from the registry (this is what killed
 * the old snapshot-drift bug class), so most of the old designerCoverage
 * assertions hold by construction. What still deserves pinning:
 *  - the filter is exactly the ShaderNode-rendered rule (a designer that
 *    listed live-canvas nodes would let you author glyphs nothing renders);
 *  - the tuple shape the ported app logic indexes ([id, dataType]);
 *  - costs come from the same complexity.json the app prices from.
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

  it('prices from complexity.json (every designable node resolves a number)', () => {
    for (const n of nodes) {
      expect(typeof (NODE_COSTS[n.type] ?? 0), n.type).toBe('number');
    }
  });

  it('channel seeding covers every socket data type in the designable set', () => {
    for (const n of nodes) {
      for (const [, ty] of [...n.in, ...n.out]) {
        expect(TYPE_CHANNELS[ty], `missing TYPE_CHANNELS entry for "${ty}" (node ${n.type})`).toBeGreaterThan(0);
      }
    }
  });
});
