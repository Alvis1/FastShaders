import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeJsonReviver } from '@/utils/safeJson';
import complexityData from './complexity.json';

const costs = complexityData.costs as Record<string, number>;
const BENCH = readFileSync(
  new URL('../../ShaderCarousel/lib/bench-registry.js', import.meta.url),
  'utf8',
);
const BENCH_DATA = join(process.cwd(), 'ShaderCarousel', 'benchData');
const TEX_ID = /^(calib_tex_|texture_)/;

type Run = { metadata?: Record<string, unknown>; shaders: Array<{ id?: unknown }> };

/**
 * Every committed RAW run that carries texture atoms, found by file CONTENT
 * (a `shaders` row whose id is a texture atom), never by file name — so the
 * gate below flips the moment such a run lands under benchData/, whatever it
 * is called.
 */
function committedTextureRuns(): { dir: string; file: string; run: Run }[] {
  const out: { dir: string; file: string; run: Run }[] = [];
  for (const dir of readdirSync(BENCH_DATA)) {
    const path = join(BENCH_DATA, dir);
    if (!statSync(path).isDirectory()) continue;
    for (const file of readdirSync(path)) {
      if (!file.endsWith('.json')) continue;
      let run: unknown;
      try {
        run = JSON.parse(readFileSync(join(path, file), 'utf8'), safeJsonReviver);
      } catch {
        continue;
      }
      const shaders = (run as Run | null)?.shaders;
      if (!Array.isArray(shaders)) continue;
      if (shaders.some((s) => typeof s?.id === 'string' && TEX_ID.test(s.id))) out.push({ dir, file, run: run as Run });
    }
  }
  return out;
}
const RUNS = committedTextureRuns();
const MEASURED = RUNS.length > 0;

/**
 * The nodes whose real cost is a TEXTURE FETCH rather than arithmetic.
 *
 * METHODS.md calls this class out by name as the one the additive point table
 * cannot model well — bandwidth-bound, so its cost depends on the access
 * pattern and the texture's size, neither of which a flat per-node number
 * carries. The bench now HAS atoms for it (bench-registry's texture groups,
 * built when a bench passes THREE), but no run with them has been committed,
 * so `imageNode` and `colormap` are still AUTHORED. This file therefore has
 * two halves, and exactly one of them runs:
 *
 *  - while no committed run carries texture atoms, the ORDERING the authored
 *    table must not get wrong (image > LUT > ALU, under Perlin);
 *  - once one does, the table must say which run priced it and agree with
 *    what benchData/fit-core.mjs derives from it.
 *
 * The JSON entry is the ANCHOR of the Image node's price rather than the price
 * itself: `imageNodeCost` (utils/nodeCost.ts) charges it in full at 2048 px
 * and discounts smaller images, so the number a badge shows is pinned over
 * `nodeCostPoints` in utils/imageNodeCost.test.ts — including that the
 * DISCOUNTED floor still sits above colormap and sin, the ordering this file
 * was written to protect.
 */
describe('the texture-sampling family', () => {
  it('the bench carries texture atoms', () => {
    // This replaces the old tripwire ("no bench atom samples a texture"),
    // which was meant to fail the moment an atom appeared — and did, in the
    // step that added them. What expires on its own now is the AUTHORED block
    // below, the moment a run carrying these atoms is committed.
    expect(BENCH).toMatch(/\btexture\s*\(/);
    for (const id of ["'texture_imageNode'", "'texture_colormap'", "'tex_c2048'", "'tex_lut256'"]) {
      expect(BENCH).toContain(id);
    }
  });

  // These expire on their own once a texture run is committed.
  describe.skipIf(MEASURED)('while the texture family is AUTHORED', () => {
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

    it('says the bench HAS texture atoms, just not a headset run of them', () => {
      // Authored no longer means "the bench cannot sample a texture": the
      // atoms exist (bench-registry.js), so the provenance record must say
      // what is missing is the RUN, and point at its protocol.
      const text = complexityData.meta.description;
      expect(text).not.toMatch(/no bench atom samples a texture/);
      expect(text).not.toMatch(/needs a texture atom in the bench/);
      expect(text).toMatch(/have not been run on a headset yet/);
      expect(text).toMatch(/METHODS\.md §6/);
    });
  });

  describe.runIf(MEASURED)('once a texture run is committed', () => {
    type Report = { suggestions: { imageNode: number | null; colormap: number | null } };
    interface FitCore {
      pickShippingRun(runs: readonly Run[]): Run | null;
      textureReport(shaders: Run['shaders'], current: Record<string, number>): Report | null;
    }
    const load = async () => {
      // Non-literal specifier: a plain .mjs with no type declarations.
      const path = fileURLToPath(new URL('../../ShaderCarousel/benchData/fit-core.mjs', import.meta.url));
      const core = (await import(/* @vite-ignore */ path)) as FitCore;
      const pick = core.pickShippingRun(RUNS.map((r) => r.run));
      expect(pick, 'a committed texture run fit-core will ship from').not.toBeNull();
      const rep = core.textureReport(pick!.shaders, costs);
      expect(rep).not.toBeNull();
      const dir = RUNS.find((r) => r.run === pick)!.dir;
      return { rep: rep!, dir };
    };

    it("complexity.json's meta names the run that priced it", async () => {
      const { dir } = await load();
      expect(complexityData.meta.description).toContain(`benchData/${dir}`);
    });

    it('imageNode and colormap sit within 10 % of what fit-core derives from that run', async () => {
      const { rep } = await load();
      const within = (actual: number, want: number) =>
        expect(Math.abs(actual - want)).toBeLessThanOrEqual(Math.max(1, 0.1 * want));
      expect(rep.suggestions.imageNode).not.toBeNull();
      within(costs.imageNode, rep.suggestions.imageNode!);
      if (rep.suggestions.colormap != null) within(costs.colormap, rep.suggestions.colormap);
    });

    it('a measured image fetch is never priced as free', () => {
      expect(costs.imageNode).toBeGreaterThanOrEqual(2);
    });
  });
});
