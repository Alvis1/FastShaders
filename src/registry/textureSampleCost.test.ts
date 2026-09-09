import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import complexityData from './complexity.json';

const costs = complexityData.costs as Record<string, number>;
const BENCH = readFileSync(
  new URL('../../ShaderCarousel/lib/bench-registry.js', import.meta.url),
  'utf8',
);

/**
 * The nodes whose real cost is a TEXTURE FETCH rather than arithmetic.
 *
 * METHODS.md calls this class out by name as the one the additive point table
 * cannot model well — bandwidth-bound, so its cost depends on the access
 * pattern and the texture's size, neither of which a flat per-node number
 * carries. None of it has ever been measured: the bench prices ALU ops only.
 * These assertions are therefore about the ORDERING the table must not get
 * wrong, not about the values, which are authored and expected to move once
 * someone runs a texture atom on a headset.
 */
describe('the texture-sampling family', () => {
  it('prices an IMAGE fetch above a LUT fetch', () => {
    // THE bug this file exists for. imageNode sat at 2 — below `colormap`,
    // which samples a 256-texel (~1 KB) ramp that is permanently
    // cache-resident, while an Image node samples a mipmapped texture of up
    // to ~16 MB. No GPU makes that ordering true, and underpricing is the
    // dangerous direction: four image samples read as 8 points.
    expect(costs.imageNode).toBeGreaterThan(costs.colormap);
    expect(costs.imageNode).toBeGreaterThan(costs.dataNode);
  });

  it('prices an image fetch as more than an ALU op and less than a Perlin', () => {
    // The band the authored value has to stay inside: a filtered fetch is
    // never as cheap as a multiply, and never as expensive as the noise the
    // bench MEASURED at 27 points on a Quest 3.
    expect(costs.imageNode).toBeGreaterThan(costs.mul);
    expect(costs.imageNode).toBeGreaterThan(costs.sin);
    expect(costs.imageNode).toBeLessThan(costs.perlin);
  });

  it('stays inside the estimated 4…26 point band', () => {
    // ~4 = texture-unit throughput for one trilinear fetch over the
    // 2064x2208 reference; ~26 = the same fetch when every tap misses cache
    // and the frame is DRAM-bound. Both are derived in complexity.json's own
    // meta. A value outside this needs a measurement, not an edit.
    expect(costs.imageNode).toBeGreaterThanOrEqual(4);
    expect(costs.imageNode).toBeLessThanOrEqual(26);
  });

  it('records that the number is AUTHORED, so nobody reads it as measured', () => {
    // complexity.json's meta is the file's own provenance record — the noise
    // family says where it was measured, and this has to say that it wasn't.
    expect(complexityData.meta.description).toMatch(/Image node repriced/);
    expect(complexityData.meta.description).toMatch(/AUTHORED, not measured/);
  });

  it('still has no bench atom that samples a texture', () => {
    // The check that makes the note above expire on its own: the moment
    // someone adds a texture atom, this fails and the value should come from
    // the run instead of from the estimate.
    expect(BENCH).not.toMatch(/\btexture\s*\(/);
  });
});
