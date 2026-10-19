import { describe, it, expect } from 'vitest';
import { getAllDefinitions, getFlowNodeType } from '@/registry/nodeRegistry';
import { outputSocketKey } from './glyphs/NodeGlyph';

/**
 * EVERY socket is placeable in the Node Designer — inputs by their port id,
 * the FIRST output as `out` (the key ~60 saved designs already use), any later
 * output (split y/z/w, toHsl h/s/l, Fresnel's facing, the Image channels) by
 * its own port id. One flat `sockets` map holds all of them, which is only
 * sound while no id is shared across the two directions.
 */

const shaderDefs = getAllDefinitions().filter((d) => getFlowNodeType(d) === 'shader');

describe('outputSocketKey', () => {
  const outs = [{ id: 'out' }, { id: 'facing' }];

  it('keeps the historical `out` key for the first output', () => {
    expect(outputSocketKey(outs, outs[0])).toBe('out');
  });

  it('keys every later output by its own id', () => {
    expect(outputSocketKey(outs, outs[1])).toBe('facing');
  });

  it('is by ID, so a per-instance copy of the first output (Data node) still resolves', () => {
    expect(outputSocketKey([{ id: 'col1' }, { id: 'col2' }], { id: 'col1' })).toBe('out');
  });
});

describe('the shipped registry', () => {
  it('never reuses an input id as a later output id, nor `out` as one', () => {
    for (const d of shaderDefs) {
      const inputs = new Set(d.inputs.map((i) => i.id));
      d.outputs.slice(1).forEach((o) => {
        expect(inputs.has(o.id), `${d.type}: output "${o.id}" shares an input's id`).toBe(false);
        expect(o.id, `${d.type}: a later output is called "out"`).not.toBe('out');
      });
    }
  });

  it('never names the first output after an input either, unless it is `out`', () => {
    for (const d of shaderDefs) {
      const first = d.outputs[0];
      if (!first || first.id === 'out') continue;
      expect(d.inputs.some((i) => i.id === first.id), `${d.type}: "${first.id}"`).toBe(false);
    }
  });
});
