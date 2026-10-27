import { describe, it, expect } from 'vitest';
import { edgeChipChannels } from './EdgeInfoCard';

/** The selected wire's chip: two-decimal figures per channel — the precise
 *  readout the compact on-node labels defer to. */
const chip = (min: number[], max: number[], shapeLen = min.length) =>
  edgeChipChannels({ min, max }, shapeLen).values;

describe('edgeChipChannels', () => {
  it('keeps its two-decimal figures', () => {
    expect(chip([0.5], [0.5])).toEqual(['0.50']);
    expect(chip([0, 0], [1, 1])).toEqual(['0.00…1.00', '0.00…1.00']);
    expect(chip([-0.25], [0.75])).toEqual(['-0.25…0.75']);
  });

  it('collapses an interval narrower than its two decimals', () => {
    expect(chip([0.421], [0.4249])).toEqual(['0.42']);
    expect(chip([0.4249], [0.4251])).toEqual(['0.42']);
  });

  it('prints a figure below 0.01 with ONE significant digit, never "0.00"', () => {
    expect(chip([0.003], [0.003])).toEqual(['0.003']);
    expect(chip([-0.0004], [-0.0004])).toEqual(['-0.0004']);
    // A tiny non-zero end is the point: [0, 0.003] is not a flat zero.
    expect(chip([0], [0.003])).toEqual(['0.00…0.003']);
    expect(chip([0.0031], [0.0034])).toEqual(['0.003']);
  });

  it('never prints "-0.00"', () => {
    expect(chip([-0], [-0])).toEqual(['0.00']);
    expect(chip([-0.001], [0])).toEqual(['-0.001…0.00']);
    for (const v of [-0, -1e-9, -0.001, -0.0049]) {
      for (const end of chip([v], [0.5])[0].split('…')) expect(end).not.toBe('-0.00');
    }
  });

  it('prints "…" for a channel whose interval is inverted or non-finite — and only that channel', () => {
    expect(chip([0, 1], [1, 0])).toEqual(['0.00…1.00', '…']);
    expect(chip([0, -Infinity], [1, 1])).toEqual(['0.00…1.00', '…']);
    expect(chip([Number.NaN], [1])).toEqual(['…']);
  });

  it('pads with "…" up to the static shape when the range knows fewer channels', () => {
    expect(edgeChipChannels(null, 3)).toEqual({ count: 3, values: ['…', '…', '…'] });
    expect(edgeChipChannels({ min: [0], max: [1] }, 2)).toEqual({ count: 2, values: ['0.00…1.00', '…'] });
  });
});
