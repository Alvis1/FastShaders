import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCostFile } from './costOverride';
import { safeJsonReviver } from './safeJson';

/**
 * The bench's per-fetch texture atoms (`texture_imageNode`,
 * `texture_colormap`) run 16 fetches and carry `copies: 16`, because a single
 * fetch sits under MicroPlane's timer floor: the committed quest3 run read
 * cellNoise at a negative marginal, i.e. 0 points. bench-stats therefore
 * divides the POINTS by copies while the milliseconds stay whole-shader.
 *
 * Two contracts are pinned here:
 * 1. Rows without `copies` are priced exactly as before, down to the
 *    committed quest3 raw files re-annotating to their stored points.
 * 2. `texture_` is stripped in BOTH places that strip group prefixes —
 *    bench-stats' `buildComplexityPatch` and costOverride's `PREFIX` — so the
 *    raw, suggestion and patch files of one run parse to the same prices.
 */

type Stats = Record<string, number | null | undefined>;
type Result = { id: string; label: string; category: string; copies?: number; stats: Stats };
type Suggestion = {
  metadata: { valid: boolean; reasons: string[] };
  suggestions: Array<{ id: string; suggestedPoints: number | null; marginalMsAtRef: number | null; copies?: number }>;
};
interface BenchStats {
  BUDGET_MS: number;
  REF_PIXELS: number;
  annotateMarginalCost(results: Result[], opts?: { pixels?: number | null }): { baselineMs: number | null; resolutionScale: number | null };
  buildSuggestion(data: unknown, sourceName: string): Suggestion;
  buildComplexityPatch(suggestion: Suggestion): { meta: Record<string, unknown>; costs: Record<string, number> };
  exportResults(data: unknown, prefix: string): { fileCount: number };
}

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
// Non-literal specifier: bench-stats.js is a plain JS module with no type
// declarations, which tsc must not try to resolve. It imports nothing.
const stats = (await import(/* @vite-ignore */ here('../../ShaderCarousel/lib/bench-stats.js'))) as BenchStats;

const row = (id: string, msPerPass: number, extra: Partial<Result> = {}): Result => ({
  id, label: id, category: id.split('_')[0], ...extra,
  stats: { msPerPass, medianFt: msPerPass, frameCount: 60 },
});

/** A fresh payload per test: annotateMarginalCost mutates its rows. */
const payload = () => ({
  metadata: { bench: 'microplane', resolution: { width: 1024, height: 1024 }, timingMethod: 'gpu-timestamp' },
  shaders: [
    row('ref_baseline', 0.5),
    row('texture_imageNode', 1.7, { copies: 16 }),
    row('noise_perlin', 1.0),
    row('calib_tex_c2048_x16', 1.7),
  ],
});

const PIXELS = 1024 * 1024;
const byId = (rows: Result[], id: string) => rows.find((r) => r.id === id)!;
const last = (cells: string[]) => cells[cells.length - 1];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('bench-stats prices a multi-copy atom per copy', () => {
  it('divides marginalPoints by copies and leaves the milliseconds whole-shader', () => {
    const run = payload();
    stats.annotateMarginalCost(run.shaders, { pixels: PIXELS });
    const scale = stats.REF_PIXELS / PIXELS;

    const tex = byId(run.shaders, 'texture_imageNode');
    expect(tex.stats.marginalPoints).toBe(Math.round(((1.2 * scale) / 16 / stats.BUDGET_MS) * 100));
    expect(tex.stats.copies).toBe(16);
    expect(tex.stats.marginalMsAtRef).toBe(+(1.2 * scale).toFixed(4));

    const perlin = byId(run.shaders, 'noise_perlin');
    expect(perlin.stats.marginalPoints).toBe(Math.round(((0.5 * scale) / stats.BUDGET_MS) * 100));
    expect('copies' in perlin.stats).toBe(false);

    // A calibration sweep row is one shader of k copies whose SLOPE is fitted
    // later; it carries no `copies`, so it is priced as the whole shader.
    const calib = byId(run.shaders, 'calib_tex_c2048_x16');
    expect(calib.stats.marginalPoints).toBe(Math.round(((1.2 * scale) / stats.BUDGET_MS) * 100));
    expect('copies' in calib.stats).toBe(false);
  });

  it('ignores a copies value that is not an integer above 1', () => {
    for (const copies of [1, 0, -4, 2.5, Number.NaN]) {
      const run = payload();
      byId(run.shaders, 'texture_imageNode').copies = copies;
      stats.annotateMarginalCost(run.shaders, { pixels: PIXELS });
      const tex = byId(run.shaders, 'texture_imageNode');
      expect(tex.stats.marginalPoints, String(copies)).toBe(byId(run.shaders, 'calib_tex_c2048_x16').stats.marginalPoints);
      expect('copies' in tex.stats, String(copies)).toBe(false);
    }
  });

  it('buildSuggestion carries copies, and suggestedPoints is the per-copy price', () => {
    const sug = stats.buildSuggestion(payload(), 'synthetic.json');
    expect(sug.metadata.valid).toBe(true);
    const tex = sug.suggestions.find((s) => s.id === 'texture_imageNode')!;
    expect(tex.copies).toBe(16);
    expect(tex.suggestedPoints).toBe(Math.round(((1.2 * (stats.REF_PIXELS / PIXELS)) / 16 / stats.BUDGET_MS) * 100));
    expect('copies' in sug.suggestions.find((s) => s.id === 'noise_perlin')!).toBe(false);
  });

  it('buildComplexityPatch strips texture_ to the table key and never strips a calib id to one', () => {
    const patch = stats.buildComplexityPatch(stats.buildSuggestion(payload(), 'synthetic.json'));
    expect(patch.costs.imageNode).toBeGreaterThan(0);
    expect(patch.costs.perlin).toBeGreaterThan(0);
    expect(patch.costs).not.toHaveProperty('texture_imageNode');
    // The patch carries sweep rows under their full id (it always has); they
    // are not table keys, so no import can price anything from them.
    expect(Object.keys(patch.costs).filter((k) => !k.startsWith('calib_')).sort()).toEqual(['imageNode', 'perlin']);
    expect(parseCostFile(JSON.stringify(patch))!.costs).toEqual({ imageNode: patch.costs.imageNode, perlin: patch.costs.perlin });
  });

  it('the summary CSV gains a trailing copies column', async () => {
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blobs.push(b as Blob); return 'blob:bench'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.stubGlobal('document', { createElement: () => ({ click() {} }) });

    expect(stats.exportResults(payload(), 'shadercarousel-microplane').fileCount).toBe(3);
    const csv = (await blobs[1].text()).split('\n');
    expect(last(csv[0].split(','))).toBe('copies');
    const cell = (id: string) => last(csv.find((l) => l.startsWith(`${id},`))!.split(','));
    expect(cell('texture_imageNode')).toBe('16');
    expect(cell('noise_perlin')).toBe('1');
    expect(cell('ref_baseline')).toBe('1');
  });
});

describe('the texture_ prefix is one drift pair: bench-stats and costOverride', () => {
  it('both strip the same prefix set (source pin)', () => {
    const bench = readFileSync(here('../../ShaderCarousel/lib/bench-stats.js'), 'utf8');
    const editor = readFileSync(here('./costOverride.ts'), 'utf8');
    const patchRe = bench.match(/costs\[s\.id\.replace\((\/[^/]+\/)/)?.[1];
    const prefixRe = editor.match(/const PREFIX = (\/[^/]+\/);/)?.[1];
    expect(patchRe).toBe('/^(noise_|preset_|saved_|texture_)/');
    expect(prefixRe).toBe(patchRe);
  });

  it('the raw, suggestion and patch shapes of one run parse to identical costs', () => {
    const raw = payload();
    const sug = stats.buildSuggestion(raw, 'synthetic.json'); // annotates `raw` in place, as exportResults does
    const patch = stats.buildComplexityPatch(sug);
    const fromRaw = parseCostFile(JSON.stringify(raw))!;
    const fromSug = parseCostFile(JSON.stringify(sug))!;
    const fromPatch = parseCostFile(JSON.stringify(patch))!;
    expect(Object.keys(fromRaw.costs).sort()).toEqual(['imageNode', 'perlin']);
    expect(fromSug.costs).toEqual(fromRaw.costs);
    expect(fromPatch.costs).toEqual(fromRaw.costs);
  });

  it('texture_colormap reaches colormap through the suggestion branch', () => {
    const parsed = parseCostFile(JSON.stringify({
      metadata: { resolution: { width: 1, height: 1 } },
      suggestions: [{ id: 'texture_colormap', suggestedPoints: 3 }],
    }))!;
    expect(parsed.costs).toEqual({ colormap: 3 });
  });
});

describe('a run without copies is unchanged', () => {
  const DIR = join(process.cwd(), 'ShaderCarousel', 'benchData', 'quest3-20260723');
  const RAW = readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.includes('complexity-suggestion'));

  it('finds the committed raw files (a vacuous sweep would pass on nothing)', () => {
    expect(RAW.length).toBe(2);
  });

  it.each(RAW)('re-annotating %s gives back its stored marginalPoints', (name) => {
    const run = JSON.parse(readFileSync(join(DIR, name), 'utf8'), safeJsonReviver) as {
      metadata: { resolution: { width: number; height: number } };
      shaders: Result[];
    };
    const stored = run.shaders.map((s) => s.stats.marginalPoints);
    expect(stored.every((p) => typeof p === 'number')).toBe(true);
    const { width, height } = run.metadata.resolution;
    stats.annotateMarginalCost(run.shaders, { pixels: width * height });
    expect(run.shaders.map((s) => s.stats.marginalPoints)).toEqual(stored);
    expect(run.shaders.some((s) => 'copies' in s || 'copies' in s.stats)).toBe(false);
  });
});
