import { describe, it, expect } from 'vitest';
import {
  WAVE_SIZE,
  WAVE_CYCLE_PX,
  WAVE_Y_MIN,
  WAVE_Y_MAX,
  waveScreenY,
  buildWavePath,
  waveTranslateX,
  waveLabel,
  waveLabelWidth,
  WAVE_LABEL_CHAR_PX,
  WAVE_LABEL_PAD_PX,
} from './waveform';
import { appTime } from './appClock';

const TWO_PI = Math.PI * 2;

describe('waveScreenY', () => {
  it('maps the value range onto the plot box, y-down', () => {
    expect(waveScreenY(WAVE_Y_MAX)).toBe(0);
    expect(waveScreenY(WAVE_Y_MIN)).toBe(WAVE_SIZE);
    expect(waveScreenY(0)).toBeCloseTo(WAVE_SIZE / 2, 10);
    // ±1 sits inside the box with headroom (the 1.35 margin).
    expect(waveScreenY(1)).toBeGreaterThan(0);
    expect(waveScreenY(-1)).toBeLessThan(WAVE_SIZE);
  });
});

describe('buildWavePath', () => {
  const parseYs = (d: string): number[] =>
    d.split(' ').filter((_, i) => i % 2 === 1).map(Number);

  it('spans two cycles at one sample per px', () => {
    const ys = parseYs(buildWavePath(Math.sin));
    expect(ys).toHaveLength(WAVE_CYCLE_PX * 2 + 1);
    expect(ys.every(Number.isFinite)).toBe(true);
  });

  it('is periodic: px and px + one cycle sample the same value', () => {
    // This is what makes the phase-wrap seamless — at the 2π wrap the
    // translate jumps from −CYCLE_PX to 0, and the window shows identical
    // pixels only because the path's two halves are identical.
    const ys = parseYs(buildWavePath(Math.sin));
    for (let px = 0; px <= WAVE_CYCLE_PX; px += 7) {
      expect(ys[px]).toBeCloseTo(ys[px + WAVE_CYCLE_PX], 1);
    }
  });

  it('puts the curve through the sampled function values', () => {
    const ys = parseYs(buildWavePath(Math.sin));
    // px = CYCLE_PX/2 → x = 0 → sin = 0 → screen center.
    expect(ys[WAVE_CYCLE_PX / 2]).toBeCloseTo(WAVE_SIZE / 2, 1);
    // px = 3/4 cycle → x = π/2 → sin = 1.
    expect(ys[(WAVE_CYCLE_PX * 3) / 4]).toBeCloseTo(waveScreenY(1), 1);
  });
});

describe('waveTranslateX', () => {
  it('stays in (−CYCLE_PX, 0] and wraps at 2π', () => {
    expect(waveTranslateX(0)).toBe(-0);
    expect(waveTranslateX(Math.PI)).toBeCloseTo(-WAVE_CYCLE_PX / 2, 10);
    expect(waveTranslateX(TWO_PI)).toBeCloseTo(0, 10);
    expect(waveTranslateX(TWO_PI - 1e-6)).toBeLessThan(-WAVE_CYCLE_PX + 1e-3);
    for (const phase of [0.1, 5, 48.3, 1000.7]) {
      const t = waveTranslateX(phase);
      expect(t).toBeLessThanOrEqual(0);
      expect(t).toBeGreaterThan(-WAVE_CYCLE_PX);
    }
  });

  it('is 2π-periodic and handles negative phases', () => {
    expect(waveTranslateX(1.2 + TWO_PI * 7)).toBeCloseTo(waveTranslateX(1.2), 8);
    expect(waveTranslateX(-1.2)).toBeCloseTo(waveTranslateX(TWO_PI - 1.2), 8);
  });

  it('degrades a non-finite phase to 0 instead of NaN-ing the transform', () => {
    expect(waveTranslateX(Number.NaN)).toBe(0);
    expect(waveTranslateX(Infinity)).toBe(0);
  });
});

describe('waveLabel', () => {
  it('never exceeds the plot width — the old canvas clipped "sin(48.3) = -0.923" on both ends', () => {
    // 48.3 is the reproduction case: the leading "s" clipped off and the
    // readout was misread as "ln(48.3)".
    const label = waveLabel('sin', 48.3, Math.sin(48.3));
    expect(waveLabelWidth(label)).toBeLessThanOrEqual(WAVE_SIZE);
    expect(label).toBe(Math.sin(48.3).toFixed(2));
  });

  it('uses the full form when the budget allows it', () => {
    const wide = waveLabel('sin', 4.3, Math.sin(4.3), 200);
    expect(wide).toBe(`sin(4.3) = ${Math.sin(4.3).toFixed(2)}`);
  });

  it('matches the edge info chip precision (2 decimals), so the surfaces read identically', () => {
    expect(waveLabel('cos', 100.7, Math.cos(100.7))).toBe(Math.cos(100.7).toFixed(2));
  });

  it('degrades non-finite input or value to an honest placeholder', () => {
    expect(waveLabel('sin', Number.NaN, Number.NaN)).toBe('…');
    expect(waveLabel('sin', 1, Infinity)).toBe('…');
  });

  it('width model is the mono advance plus pill padding', () => {
    expect(waveLabelWidth('abcd')).toBe(4 * WAVE_LABEL_CHAR_PX + WAVE_LABEL_PAD_PX);
  });
});

describe('appTime', () => {
  it('is a fixed linear mapping of the performance.now() timeline', () => {
    // Two timestamps 1000ms apart are exactly 1s apart — the epoch is shared
    // module state, so every caller sees the same t for the same timestamp.
    expect(appTime(5000) - appTime(4000)).toBeCloseTo(1, 12);
    expect(appTime(4000)).toBe(appTime(4000));
  });

  it('defaults to now and is non-negative after module init', () => {
    expect(appTime()).toBeGreaterThanOrEqual(0);
  });
});
