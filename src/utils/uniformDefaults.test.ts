import { describe, it, expect } from 'vitest';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';
import { getNodeValues } from '@/types';
import { applyUniformDefaults, planUniformDefaults, type UniformRow } from './uniformDefaults';

/** A property node with the given registry type + values. */
function prop(id: string, registryType: string, values: Record<string, string | number>): AppNode {
  const n = makeNode(id, registryType);
  (n.data as { values: Record<string, string | number> }).values = values;
  return n;
}

const FLOAT_ROW: UniformRow = { name: 'speed', kind: 'float' };
const COLOR_ROW: UniformRow = { name: 'tint', kind: 'color' };

describe('planUniformDefaults', () => {
  it('maps a tuned float onto its property node', () => {
    const nodes = [prop('n1', 'property_float', { name: 'speed', value: 1 })];
    const plan = planUniformDefaults(nodes, new Map([['n1', 'speed']]), [FLOAT_ROW], { speed: 2.5 });
    expect(plan.get('n1')).toEqual({ value: 2.5 });
  });

  it('maps a tuned colour onto its property node, lowercased', () => {
    const nodes = [prop('n1', 'property_color', { name: 'tint', hex: '#ff0000' })];
    const plan = planUniformDefaults(nodes, new Map([['n1', 'tint']]), [COLOR_ROW], { tint: '#00FF88' });
    expect(plan.get('n1')).toEqual({ hex: '#00ff88' });
  });

  it('resolves by GENERATED var name, so a collision suffix hits the right node', () => {
    // Two nodes both named "speed" generate `speed` and `speed2`. Recomputing
    // the name from values.name would write one value into both.
    const nodes = [
      prop('n1', 'property_float', { name: 'speed', value: 1 }),
      prop('n2', 'property_float', { name: 'speed', value: 1 }),
    ];
    const varNames = new Map([['n1', 'speed'], ['n2', 'speed2']]);
    const rows: UniformRow[] = [FLOAT_ROW, { name: 'speed2', kind: 'float' }];
    const plan = planUniformDefaults(nodes, varNames, rows, { speed2: 9 });
    expect(plan.has('n1')).toBe(false);
    expect(plan.get('n2')).toEqual({ value: 9 });
  });

  it('skips rows with no tuned value (already at the default)', () => {
    const nodes = [prop('n1', 'property_float', { name: 'speed', value: 1 })];
    expect(planUniformDefaults(nodes, new Map([['n1', 'speed']]), [FLOAT_ROW], {}).size).toBe(0);
  });

  it('skips values already equal to the node — an unchanged graph plans nothing', () => {
    const nodes = [prop('n1', 'property_float', { name: 'speed', value: 2 })];
    const plan = planUniformDefaults(nodes, new Map([['n1', 'speed']]), [FLOAT_ROW], { speed: 2 });
    expect(plan.size).toBe(0);
  });

  it('plans nothing when the STORED value is the noisy one (untuned overlay seeded from it)', () => {
    // A node can hold full-precision noise (typed parseFloat, imported
    // uniform(...) literal); the overlay seeds uniformValues with that exact
    // double. "Set as default" with nothing tuned must stay a no-op — no
    // undo entry, no iframe rebuild.
    const nodes = [prop('n1', 'property_float', { name: 'speed', value: 0.30500000000000005 })];
    const plan = planUniformDefaults(nodes, new Map([['n1', 'speed']]), [FLOAT_ROW], {
      speed: 0.30500000000000005,
    });
    expect(plan.size).toBe(0);
  });

  it('rounds float noise from the slider step', () => {
    const nodes = [prop('n1', 'property_float', { name: 'speed', value: 0 })];
    const plan = planUniformDefaults(nodes, new Map([['n1', 'speed']]), [FLOAT_ROW], {
      speed: 0.30500000000000005,
    });
    expect(plan.get('n1')).toEqual({ value: 0.305 });
  });

  it('does not flatten a legitimately tiny value to zero', () => {
    const nodes = [prop('n1', 'property_float', { name: 'speed', value: 1 })];
    const plan = planUniformDefaults(nodes, new Map([['n1', 'speed']]), [FLOAT_ROW], { speed: 1e-7 });
    expect(plan.get('n1')).toEqual({ value: 1e-7 });
  });

  it('skips a uniform whose node was deleted (values persist by name)', () => {
    const plan = planUniformDefaults([], new Map(), [FLOAT_ROW], { speed: 3 });
    expect(plan.size).toBe(0);
  });

  it('skips mismatched value types and malformed hex', () => {
    const nodes = [
      prop('n1', 'property_float', { name: 'speed', value: 1 }),
      prop('n2', 'property_color', { name: 'tint', hex: '#ff0000' }),
    ];
    const varNames = new Map([['n1', 'speed'], ['n2', 'tint']]);
    const rows = [FLOAT_ROW, COLOR_ROW];
    // colour string on a float row, 3-digit hex on a colour row
    const plan = planUniformDefaults(nodes, varNames, rows, { speed: '#ff0000', tint: '#fff' });
    expect(plan.size).toBe(0);
    expect(
      planUniformDefaults(nodes, varNames, rows, { speed: Number.NaN, tint: 'red' }).size,
    ).toBe(0);
  });

  it('ignores non-property nodes even when a var name matches', () => {
    const nodes = [prop('n1', 'mul', { value: 1 })];
    const plan = planUniformDefaults(nodes, new Map([['n1', 'speed']]), [FLOAT_ROW], { speed: 5 });
    expect(plan.size).toBe(0);
  });

  it('will not write a float into a colour node sharing the row name', () => {
    const nodes = [prop('n1', 'property_color', { name: 'speed', hex: '#ff0000' })];
    const plan = planUniformDefaults(nodes, new Map([['n1', 'speed']]), [FLOAT_ROW], { speed: 4 });
    expect(plan.size).toBe(0);
  });
});

describe('applyUniformDefaults', () => {
  it('merges the patch and leaves other values intact', () => {
    const nodes = [prop('n1', 'property_float', { name: 'speed', value: 1 })];
    const out = applyUniformDefaults(nodes, new Map([['n1', { value: 7 }]]));
    expect(getNodeValues(out[0])).toEqual({ name: 'speed', value: 7 });
  });

  it('does not mutate the input nodes (history snapshots share those objects)', () => {
    const nodes = [prop('n1', 'property_float', { name: 'speed', value: 1 })];
    applyUniformDefaults(nodes, new Map([['n1', { value: 7 }]]));
    expect(getNodeValues(nodes[0]).value).toBe(1);
  });

  it('returns the same array identity for an empty plan', () => {
    const nodes = [prop('n1', 'property_float', { name: 'speed', value: 1 })];
    expect(applyUniformDefaults(nodes, new Map())).toBe(nodes);
  });

  it('leaves unpatched nodes referentially identical', () => {
    const nodes = [
      prop('n1', 'property_float', { name: 'speed', value: 1 }),
      prop('n2', 'property_float', { name: 'other', value: 1 }),
    ];
    const out = applyUniformDefaults(nodes, new Map([['n1', { value: 7 }]]));
    expect(out[1]).toBe(nodes[1]);
    expect(out[0]).not.toBe(nodes[0]);
  });
});
