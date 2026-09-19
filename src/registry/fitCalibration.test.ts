import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as TSL from 'three/tsl';
import * as THREE from 'three';
import {
  imageNodeCost,
  IMAGE_COST_REF_SIDE,
  IMAGE_COST_FLOOR_SIDE,
  IMAGE_COST_MIN_SCALE,
} from '@/utils/nodeCost';
import { safeJsonReviver } from '@/utils/safeJson';
import complexityData from './complexity.json';
import syntheticRun from './fixtures/fitCalibrationRun.json';
import syntheticCosts from './fixtures/fitCalibrationCosts.json';

/**
 * ShaderCarousel/benchData/fit-core.mjs is the PURE half of the calibration
 * fit: fit-calibration.mjs keeps only the I/O around it. Three things are
 * pinned here.
 *
 * 1. The Image node's size curve is written twice: in nodeCost.ts, which
 *    prices a badge, and in fit-core as IMAGE_CURVE, which tells the owner
 *    how to move that curve after a headset run. The .mjs cannot import the
 *    app's TypeScript, so the two are a drift pair and this file is the pin.
 * 2. The scaffold is per FAMILY: texture atoms subtract calib_tex_scaffold,
 *    never the ALU scaffold.
 * 3. The CLI's report text did not change when the arithmetic moved. The
 *    committed quest3 run has no calibration rows, so its op table is empty
 *    and proves nothing. fixtures/fitCalibrationRun.json is a synthetic run
 *    that reaches every branch, and fixtures/fitCalibrationCli.txt is what the
 *    OLD fit-calibration.mjs printed for it against fixtures/
 *    fitCalibrationCosts.json (a fixed table, so a repricing of
 *    complexity.json cannot move the golden).
 */

type Row = { id: string; stats: Record<string, number> };
type Combo = { id: string; terms: [string, number][] };
type OpRow = { op: string; net: number; r2: number; suggested: number; cur: number | null; delta: number | null; flags: string[] };
type TextureReport = {
  scaffoldMs: number | null;
  atoms: Record<string, { netMs: number; points: number; r2: number; current: number | null }>;
  sizeCurve: {
    ratioTo2048: Record<number, number | null>;
    currentRatio: Record<number, number>;
    suggestedMinScale: number | null;
    logLinearAt1024: { predicted: number | null; measured: number | null; residual: number | null };
    flatAbove2048: number | null;
  };
  coherence: Record<'dataOverColour' | 'minifiedColourOverFull' | 'minifiedDataOverColour' | 'minifiedDataOverFull', number | null>;
  profileCrossCheck: { texture_imageNode: number | null; fit: number | null };
  suggestions: { imageNode: number | null; colormap: number | null; IMAGE_COST_MIN_SCALE: number | null };
  flags: string[];
};
interface FitCore {
  IMAGE_CURVE: { REF_SIDE: number; FLOOR_SIDE: number; MIN_SCALE: number };
  TABLE_KEY: Record<string, string>;
  ADDITIVITY: readonly Combo[];
  imageCurveScale(side: number): number;
  currentPriceFor(op: string, current: Record<string, number>): number | null;
  netOpRows(shaders: readonly unknown[], current: Record<string, number>): OpRow[];
  textureReport(shaders: readonly unknown[], current: Record<string, number>): TextureReport | null;
  pickShippingRun(runs: readonly unknown[]): unknown;
  renderCalibrationReport(run: unknown, inPath: string, current: Record<string, number>): string[];
}

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
// Non-literal specifiers: both are plain JS modules with no type declarations,
// which tsc must not try to resolve. fit-core imports only bench-stats.js and
// bench-registry imports nothing.
const core = (await import(/* @vite-ignore */ here('../../ShaderCarousel/benchData/fit-core.mjs'))) as FitCore;
const benchRegistry = await import(/* @vite-ignore */ here('../../ShaderCarousel/lib/bench-registry.js'));

const costs = complexityData.costs as Record<string, number>;
const fixtureCosts = syntheticCosts.costs as Record<string, number>;

/** A perfectly linear k-sweep: ms = slope·k + c. */
const sweep = (op: string, slope: number, c = 0.003): Row[] =>
  [1, 4, 16].map((k) => ({ id: `calib_${op}_x${k}`, stats: { marginalMsAtRef: slope * k + c } }));

/** A texture size curve whose NET slopes are 0.2 / 0.33 / 0.4 / c4096 ms over a 0.005 scaffold. */
const curveRun = (c4096: number): Row[] => [
  ...sweep('tex_scaffold', 0.005),
  ...sweep('tex_c256', 0.205),
  ...sweep('tex_c1024', 0.335),
  ...sweep('tex_c2048', 0.405),
  ...sweep('tex_c4096', c4096 + 0.005),
];

describe('fit-core: the Image node size curve restates nodeCost', () => {
  it('IMAGE_CURVE equals the IMAGE_COST_* constants and prices every side the same', () => {
    expect(core.IMAGE_CURVE).toEqual({
      REF_SIDE: IMAGE_COST_REF_SIDE,
      FLOOR_SIDE: IMAGE_COST_FLOOR_SIDE,
      MIN_SCALE: IMAGE_COST_MIN_SCALE,
    });
    for (const s of [1, 64, 256, 512, 1024, 2048, 4096, 8192]) {
      expect(Math.round(10 * core.imageCurveScale(s)), `side ${s}`).toBe(imageNodeCost(10, s, s));
    }
  });

  it('charges each texture atom what the table charges the node it measures', () => {
    const base = costs.imageNode;
    expect(core.currentPriceFor('tex_c256', costs)).toBe(imageNodeCost(base, 256, 256));
    expect(core.currentPriceFor('tex_c1024', costs)).toBe(imageNodeCost(base, 1024, 1024));
    for (const op of ['tex_c2048', 'tex_c4096', 'tex_d2048', 'tex_c2048q', 'tex_d2048q']) {
      expect(core.currentPriceFor(op, costs), op).toBe(base);
    }
    expect(core.currentPriceFor('tex_lut256', costs)).toBe(costs.colormap);
    expect(core.currentPriceFor('sin', costs)).toBe(costs.sin);
    expect(core.currentPriceFor('notANode', costs)).toBeNull();
    // Op names come out of shader ids in a dropped file: a prototype key must
    // read as "no entry", not as Object.prototype.constructor.
    expect(core.currentPriceFor('constructor', costs)).toBeNull();
  });

  it('TABLE_KEY names real complexity.json entries', () => {
    expect(core.TABLE_KEY).toEqual({ tex_c2048: 'imageNode', tex_lut256: 'colormap' });
    for (const key of Object.values(core.TABLE_KEY)) expect(costs[key], key).toBeTypeOf('number');
  });
});

describe('fit-core: per-family scaffold', () => {
  it('subtracts each family its own scaffold, and neither scaffold is a row', () => {
    const shaders = [
      ...sweep('scaffold', 0.01),
      ...sweep('mul', 0.03),
      ...sweep('tex_scaffold', 0.005),
      ...sweep('tex_c2048', 0.405),
    ];
    const rows = core.netOpRows(shaders, {});
    expect(rows.map((r) => r.op)).toEqual(['mul', 'tex_c2048']);
    expect(rows[0].net).toBeCloseTo(0.02, 10);
    expect(rows[1].net).toBeCloseTo(0.4, 10);
    const rep = core.textureReport(shaders, {})!;
    expect(rep.scaffoldMs).toBeCloseTo(0.005, 10);
    expect(rep.atoms.tex_c2048.netMs).toBeCloseTo(0.4, 10);
    expect(Object.keys(rep.atoms)).toEqual(['tex_c2048']);
  });
});

describe('fit-core: textureReport', () => {
  it('reads the size curve off net milliseconds', () => {
    const rep = core.textureReport(
      [...curveRun(0.41), { id: 'texture_imageNode', stats: { marginalPoints: 6 } }],
      { imageNode: 10, colormap: 4 },
    )!;
    const sc = rep.sizeCurve;
    expect(sc.suggestedMinScale).toBe(0.5); // 0.2 / 0.4
    expect(sc.flatAbove2048).toBeCloseTo(1.025, 6); // 0.41 / 0.4
    expect(sc.logLinearAt1024.predicted).toBeCloseTo(0.5 + 0.5 * (2 / 3), 10);
    expect(sc.logLinearAt1024.measured).toBeCloseTo(0.825, 6); // 0.33 / 0.4
    expect(sc.currentRatio[256]).toBe(0.5);
    expect(sc.currentRatio[2048]).toBe(1);
    expect(sc.currentRatio[4096]).toBe(1);
    expect(rep.suggestions).toEqual({ imageNode: 5, colormap: null, IMAGE_COST_MIN_SCALE: 0.5 });
    expect(rep.profileCrossCheck).toEqual({ texture_imageNode: 6, fit: 5 });
    expect(rep.atoms.tex_c256.current).toBe(5); // imageNode 10 at the 256 px floor
    expect(rep.flags).toEqual([]);
  });

  it('flags a size curve that gets cheaper as the texture grows, up to the 2048 anchor', () => {
    // Gate 4 (METHODS §6.5): c256 ≤ c1024 ≤ c2048, one point of slack.
    const dip = [
      ...sweep('tex_scaffold', 0.005),
      ...sweep('tex_c256', 0.405), //  5 pts
      ...sweep('tex_c1024', 0.205), // 2 pts
      ...sweep('tex_c2048', 0.405), // 5 pts
    ];
    const rep = core.textureReport(dip, {})!;
    expect(rep.flags.some((f) => f.startsWith('size curve not monotone: 256 px')), rep.flags.join(' | ')).toBe(true);
  });

  it('leaves 4096 to the flat check: a 4096 drop is never a gate-4 flag', () => {
    // Inside the documented [0.85, 1.15] band: 4096/2048 = 0.92, yet 20 → 18
    // points is more than the monotone check's one point of slack. Walking
    // the monotone check up to 4096 flagged it as gate 4 failing ("do not
    // reprice") on a measurement inside its own tolerance.
    const inBand = [
      ...sweep('tex_scaffold', 0.005),
      ...sweep('tex_c256', 0.805),
      ...sweep('tex_c1024', 1.305),
      ...sweep('tex_c2048', 1.671),
      ...sweep('tex_c4096', 1.538),
    ];
    const rep = core.textureReport(inBand, {})!;
    expect(rep.atoms.tex_c4096.points).toBeLessThan(rep.atoms.tex_c2048.points - 1); // not vacuous
    expect(rep.sizeCurve.flatAbove2048).toBeGreaterThan(0.85);
    expect(rep.flags).toEqual([]);
    // Outside the band it is the §6.6 owner flag that fires, and still not gate 4.
    const outOfBand = core.textureReport(curveRun(0.2), {})!;
    expect(outOfBand.flags.some((f) => f.startsWith('4096/2048 = 0.50')), outOfBand.flags.join(' | ')).toBe(true);
    expect(outOfBand.flags.some((f) => f.startsWith('size curve not monotone'))).toBe(false);
  });

  it('reports the coherence ratios and flags the two impossible orderings', () => {
    const base = [...sweep('tex_scaffold', 0), ...sweep('tex_c2048', 0.4), ...sweep('tex_d2048', 0.5)];
    const ok = core.textureReport([...base, ...sweep('tex_c2048q', 0.1), ...sweep('tex_d2048q', 0.3)], {})!;
    expect(ok.coherence.dataOverColour).toBeCloseTo(1.25, 6);
    expect(ok.coherence.minifiedColourOverFull).toBeCloseTo(0.25, 6);
    expect(ok.coherence.minifiedDataOverColour).toBeCloseTo(3, 6);
    expect(ok.coherence.minifiedDataOverFull).toBeCloseTo(0.75, 6);
    expect(ok.flags).toEqual([]);

    const bad = core.textureReport([...base, ...sweep('tex_c2048q', 0.45), ...sweep('tex_d2048q', 0.05)], {})!;
    expect(bad.flags.some((f) => f.startsWith('minified colour'))).toBe(true);
    expect(bad.flags.some((f) => f.startsWith('minified data'))).toBe(true);
  });

  it('flags an atom at or below its scaffold and never turns a negative net into a MIN_SCALE', () => {
    // The browser check's run: c256's slope (0.049) sits under the scaffold
    // (0.05), every §6.5 gate still passes, and the ratio used to clamp the
    // negative net to a silent IMAGE_COST_MIN_SCALE 0.1 — a 256 px image at
    // 1 point, under colormap.
    const rep = core.textureReport(
      [
        ...sweep('tex_scaffold', 0.05),
        ...sweep('tex_c256', 0.049),
        ...sweep('tex_c1024', 0.33),
        ...sweep('tex_c2048', 0.45),
        ...sweep('tex_c4096', 0.46),
      ],
      {},
    )!;
    expect(rep.atoms.tex_c256.netMs).toBeLessThan(0);
    expect(rep.sizeCurve.ratioTo2048[256]).toBeNull();
    expect(rep.sizeCurve.suggestedMinScale).toBeNull();
    expect(rep.suggestions.IMAGE_COST_MIN_SCALE).toBeNull();
    expect(rep.flags.filter((f) => f.startsWith('below-scaffold ')), rep.flags.join(' | ')).toEqual([
      expect.stringMatching(/^below-scaffold tex_c256 /),
    ]);
    // A net of exactly zero is under the floor too.
    const zero = core.textureReport([...sweep('tex_scaffold', 0.05), ...sweep('tex_c2048', 0.05)], {})!;
    expect(zero.flags.some((f) => f.startsWith('below-scaffold tex_c2048 '))).toBe(true);
  });

  it('flags atoms measured without their scaffold', () => {
    const rep = core.textureReport(sweep('tex_c2048', 0.4), {})!;
    expect(rep.scaffoldMs).toBeNull();
    expect(rep.flags.some((f) => f.startsWith('no calib_tex_scaffold'))).toBe(true);
  });
});

describe('fit-core on the committed quest3 run (no calibration group)', () => {
  const dir = join(process.cwd(), 'ShaderCarousel', 'benchData', 'quest3-20260723');
  for (const bench of ['microplane', 'static']) {
    it(`${bench}: no texture report, an empty op table, not a shipping run`, () => {
      const name = readdirSync(dir).find((f) => f.includes(`-${bench}-2026`) && f.endsWith('.json'))!;
      const run = JSON.parse(readFileSync(join(dir, name), 'utf8'), safeJsonReviver) as { shaders: Row[] };
      expect(run.shaders.length).toBeGreaterThan(0);
      expect(core.textureReport(run.shaders, costs)).toBeNull();
      expect(core.netOpRows(run.shaders, costs)).toEqual([]);
      expect(core.pickShippingRun([run])).toBeNull();
    });
  }
});

describe('fit-core: ADDITIVITY names shaders the bench really builds', () => {
  const entries = benchRegistry.buildBenchRegistry(TSL, THREE) as Array<{ id: string }>;
  const ids = new Set(entries.map((e) => e.id));
  const isTexture = (c: Combo) => c.terms.some(([op]) => op.startsWith('tex_'));
  const resolves = (c: Combo) => {
    expect(ids.has(c.id), c.id).toBe(true);
    for (const [op] of c.terms) expect(ids.has(`calib_${op}_x1`), `${c.id}: calib_${op}_x1`).toBe(true);
  };
  // Self-activating: the bench builds its texture groups only from Phase 9
  // step 9.3 on (buildBenchRegistry(TSL, THREE)). Until then there is no
  // texture combo to resolve, and benchTextureAtoms.test.ts is what will pin
  // that the groups exist once they do.
  const HAS_TEXTURE_GROUPS = entries.some((e) => e.id.startsWith('calib_tex_'));

  it('every ALU combo and each of its terms', () => {
    const alu = core.ADDITIVITY.filter((c) => !isTexture(c));
    expect(alu.map((c) => c.id)).toEqual(['combo_sin4_sqrt4', 'combo_perlin4_voronoi4']);
    alu.forEach(resolves);
  });

  it('the texture combo is the only one naming a tex_ op', () => {
    expect(core.ADDITIVITY.filter(isTexture).map((c) => c.id)).toEqual(['combo_tex4_perlin4']);
  });

  it.skipIf(!HAS_TEXTURE_GROUPS)('every texture combo and each of its terms', () => {
    core.ADDITIVITY.filter(isTexture).forEach(resolves);
  });
});

describe('fit-core: pickShippingRun', () => {
  const baseline: Row = { id: 'ref_baseline', stats: { msPerPass: 1 } };
  const run = (
    bench: string,
    date: string,
    shaders: Row[] = [baseline, ...sweep('tex_c2048', 0.4)],
    md: Record<string, unknown> = {},
  ) => ({
    metadata: { bench, date, timingMethod: 'gpu-timestamp', resolution: { width: 1024, height: 1024 }, ...md },
    shaders,
  });

  it('prefers a Static run, then the latest date, among runs that carry texture sweeps', () => {
    const micro = run('microplane', '2026-09-01T00:00:00Z');
    const staticOld = run('static', '2026-08-01T00:00:00Z');
    const staticNew = run('static', '2026-08-15T00:00:00Z');
    const aluOnly = run('static', '2026-09-10T00:00:00Z', sweep('mul', 0.03));
    expect(core.pickShippingRun([micro, staticOld, aluOnly, staticNew])).toBe(staticNew);
    const microLater = run('microplane', '2026-09-05T00:00:00Z');
    expect(core.pickShippingRun([micro, microLater])).toBe(microLater);
    expect(core.pickShippingRun([aluOnly])).toBeNull();
    expect(core.pickShippingRun([])).toBeNull();
  });

  it('never ships from a run that cannot price, however late or Static it is', () => {
    // METHODS §6.6: "Static when Static is present and valid". A raw export
    // carries no validity block, so fit-core applies buildSuggestion's gates.
    const micro = run('microplane', '2026-10-01T00:00:00Z');
    const inout = run('inout', '2026-10-02T00:00:00Z', undefined, { timingMethod: 'raf-delta', resolution: undefined });
    const later = '2026-10-03T00:00:00Z';
    const invalidStatic = [
      run('static', later, undefined, { vsyncClamping: { hz: 72, periodMs: 13.9 } }),
      run('static', later, sweep('tex_c2048', 0.4)), // no ref_baseline
      run('static', later, undefined, { timingMethod: 'raf-delta' }),
      run('static', later, undefined, { resolution: null }),
      run('static', later, [baseline, ...sweep('tex_c2048', 0.4), { id: 'noise_perlin', stats: { insufficientData: 1 } }]),
      run('inout', later, undefined, {}), // InOut never prices, even with clean-looking metadata
    ];
    expect(core.pickShippingRun([micro, inout])).toBe(micro);
    for (const bad of invalidStatic) expect(core.pickShippingRun([micro, bad]), JSON.stringify(bad.metadata)).toBe(micro);
    expect(core.pickShippingRun([inout, ...invalidStatic])).toBeNull();
  });
});

describe('the fit-calibration CLI report', () => {
  const golden = readFileSync(here('./fixtures/fitCalibrationCli.txt'), 'utf8');

  it('is byte-identical to what fit-calibration.mjs printed before fit-core existed', () => {
    const lines = core.renderCalibrationReport(syntheticRun, 'fitCalibrationRun.json', fixtureCosts);
    expect(lines.join('\n') + '\n').toBe(golden);
  });

  it('the golden reaches every branch of the ALU report', () => {
    for (const needle of [
      '  ⚠ second reason line',
      'nonlinear?',
      'below-scaffold',
      'mispriced',
      '→ additive',
      'SUB-additive',
      'ILP (sqrt×8)',
      'DCE sentinel',
    ]) {
      expect(golden, needle).toContain(needle);
    }
    expect(core.netOpRows(syntheticRun.shaders, fixtureCosts)).toHaveLength(9);
    // An ALU-only run says nothing about texture atoms or the texture combo.
    expect(golden).not.toContain('Texture atoms');
    expect(golden).not.toContain('combo_tex4_perlin4');
  });

  it('adds the Texture atoms section and the texture combo only when the run carries texture sweeps', () => {
    const shaders = [
      ...syntheticRun.shaders,
      ...curveRun(0.41),
      { id: 'combo_tex4_perlin4', stats: { marginalMsAtRef: 11 } },
    ];
    const text = core.renderCalibrationReport({ ...syntheticRun, shaders }, 'x.json', fixtureCosts).join('\n');
    const at = (s: string) => text.indexOf(s);
    expect(at('Texture atoms')).toBeGreaterThan(at('voronoi '));
    expect(at('Texture atoms')).toBeLessThan(at('Additivity'));
    expect(text).toContain('Size curve: MIN_SCALE current 0.5 → suggested 0.5');
    expect(text).toContain('Texture flags: none');
    expect(text).toMatch(/combo_tex4_perlin4: measured 11\.00000 \/ predicted 10\.82000 = 1\.02×  → additive/);
  });

  it('fit-calibration.mjs is only the I/O around fit-core', () => {
    const src = readFileSync(here('../../ShaderCarousel/benchData/fit-calibration.mjs'), 'utf8');
    expect(src).toMatch(/from '\.\/fit-core\.mjs'/);
    expect(src).toContain('renderCalibrationReport(');
    // No second copy of the fit: the least squares, the sweep parser and the
    // report formatting all live in fit-core.
    expect(src).not.toMatch(/function ols|calib_\(|\.slope\b|toFixed\(/);
  });
});
