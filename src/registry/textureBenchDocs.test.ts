import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import complexityData from './complexity.json';

/**
 * The Quest 3 texture run (ShaderCarousel/benchData/METHODS.md §6) is done by
 * hand, once, from the prose — so the prose is the part that must not be
 * wrong. These pins tie each instruction the run's owner or the repricing
 * agent acts on to the code it describes.
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(here(rel), 'utf8');

interface BenchRegistry {
  TEX_OPS: readonly (readonly [string, string, string, number])[];
  TEX_SCREEN_SPAN: number;
  TEX_CONFIGS: Record<string, { kind: string }>;
}
// Non-literal specifier: plain JS with no type declarations (fitCalibration.test.ts does the same).
const reg = (await import(/* @vite-ignore */ here('../../ShaderCarousel/lib/bench-registry.js'))) as BenchRegistry;

const METHODS = read('../../ShaderCarousel/benchData/METHODS.md');
const between = (text: string, from: string, to: string) => {
  const a = text.indexOf(from);
  const b = text.indexOf(to, a + from.length);
  expect(a, from).toBeGreaterThanOrEqual(0);
  expect(b, to).toBeGreaterThan(a);
  return text.slice(a, b);
};

describe('METHODS §6.4–6.6: the Quest 3 texture protocol', () => {
  it('warns about the bench chip BEFORE the first run, not only after the Quest one', () => {
    // Every driver run stores fs:benchResult, the desktop dry run included.
    const preamble = between(METHODS, '### 6.4 The Quest 3 run', '0. **Desktop dry run**');
    expect(preamble).toMatch(/\*\*Add\*\* chip/);
    expect(preamble).toMatch(/steps 0, 2, 4 and 5/);
    expect(preamble).toMatch(/dismiss it with ✕/);
  });

  it('gives the repeatability and cross-check gates room for per-copy rounding', () => {
    // marginalPoints is an integer per copy; at single digits 10 % is under a point.
    const step5 = between(METHODS, '5. **Repeatability.**', '6. **Move the files');
    expect(step5).toMatch(/stats\.marginalMsAtRef/);
    expect(step5).toMatch(/max\(1 point, 10 %\)/);
    const gates = between(METHODS, '### 6.5 Acceptance gates', '### 6.6');
    expect(between(gates, '7. **The profile agrees', '8. **')).toMatch(/max\(1 point, 30 %\)/);
    expect(between(gates, '8. **Repeatable.**', 'Reported but not gated')).toMatch(/stats\.marginalMsAtRef/);
  });

  it('calls textureReport the way its signature takes it', () => {
    // textureReport(shaders, current): the RUN object throws "not iterable".
    const calls = METHODS.match(/textureReport\([^`]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call, call).toMatch(/^textureReport\(pickShippingRun\(runs\)\.shaders, costs\)$/);
  });

  it("quotes complexity.json's meta passage the repricing replaces verbatim, both ends", () => {
    const repricing = between(METHODS, '### 6.6', 'Owner decisions');
    const m = repricing.match(/from "([^"]+)"\s+to "…([^"]+)"/);
    expect(m, 'the §6.6 passage bounds').not.toBeNull();
    const norm = (s: string) => s.replace(/\s+/g, ' ');
    const description = complexityData.meta.description;
    expect(description).toContain(norm(m![1]));
    expect(description).toContain(norm(m![2]));
  });
});

describe('the texture atoms as the docs describe them', () => {
  const quarter = reg.TEX_OPS.filter(([op]) => op.endsWith('q'));
  const lut = reg.TEX_OPS.filter(([, , key]) => reg.TEX_CONFIGS[key].kind === 'lut');
  const registrySource = read('../../ShaderCarousel/lib/bench-registry.js');
  const claudeBullet = read('../../CLAUDE.md').split('\n').find((l) => l.includes('`bench-registry.js` (baseline'))!;
  const docs: Record<string, string> = {
    'CLAUDE.md (ShaderCarousel lib bullet)': claudeBullet,
    'ShaderCarousel/README.md': read('../../ShaderCarousel/README.md'),
    'ShaderCarousel/benchData/METHODS.md §6.1': between(METHODS, '### 6.1', '### 6.2'),
  };

  it('code facts the prose restates', () => {
    expect(reg.TEX_SCREEN_SPAN).toBe(2048);
    expect(quarter.map(([op]) => op)).toEqual(['tex_c2048q', 'tex_d2048q']);
    for (const [op, , , span] of quarter) expect(span, op).toBe(512);
    expect(lut.map(([op]) => op)).toEqual(['tex_lut256']);
    expect(registrySource).toContain('fract(add(base, vec2(TEX_OFFSETS[i][0], TEX_OFFSETS[i][1])))');
    expect(registrySource).toContain('mul(screenCoordinate.xy, 1 / span)');
    expect(registrySource).toContain("uv => texture(texOf(key), vec2(uv.x, 0.5)).rgb");
    expect(registrySource).toContain('THREE.HalfFloatType');
  });

  for (const [name, text] of Object.entries(docs)) {
    it(`${name} states the span, the quarter-size span and the LUT read exactly`, () => {
      expect(text, name).toBeTruthy();
      expect(text).toContain('fract(screenCoordinate.xy / span + offset_i)');
      expect(text).not.toMatch(/fract\(screenCoordinate(\.xy)? \/ 2048/);
      expect(text).toMatch(/span\s+2048/);
      expect(text).toMatch(/512/);
      expect(text).toContain('vec2(uv.x, 0.5)');
      expect(text).toMatch(/half-float/);
      expect(text).not.toMatch(/incompressible\s+RGBA8\s+textures/);
    });
  }
});
