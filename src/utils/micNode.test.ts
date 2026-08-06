import { describe, it, expect } from 'vitest';
import {
  MIC_FFT_SIZES,
  MIC_SETTINGS_DEFAULTS,
  MIC_SMOOTHING_MAX,
  MIC_GAIN_MIN,
  MIC_GAIN_MAX,
  readMicSettings,
} from './micNode';

describe('readMicSettings', () => {
  it('returns defaults for missing values', () => {
    expect(readMicSettings(undefined)).toEqual(MIC_SETTINGS_DEFAULTS);
    expect(readMicSettings(null)).toEqual(MIC_SETTINGS_DEFAULTS);
    expect(readMicSettings({})).toEqual(MIC_SETTINGS_DEFAULTS);
  });

  it('passes through in-range values', () => {
    expect(readMicSettings({ smoothing: 0.5, gain: 2, fftSize: 2048 })).toEqual({
      smoothing: 0.5,
      gain: 2,
      fftSize: 2048,
    });
  });

  it('coerces numeric strings, as values from a .fastshader may be', () => {
    expect(readMicSettings({ smoothing: '0.25', gain: '3', fftSize: '512' })).toEqual({
      smoothing: 0.25,
      gain: 3,
      fftSize: 512,
    });
  });

  it('clamps smoothing below 1 so the analyser never freezes', () => {
    // smoothingTimeConstant === 1 means the exponential average never admits
    // new data: every band would hold its initial value forever.
    expect(readMicSettings({ smoothing: 1 }).smoothing).toBe(MIC_SMOOTHING_MAX);
    expect(readMicSettings({ smoothing: 99 }).smoothing).toBe(MIC_SMOOTHING_MAX);
    expect(readMicSettings({ smoothing: -5 }).smoothing).toBe(0);
  });

  it('clamps gain into range', () => {
    expect(readMicSettings({ gain: 1000 }).gain).toBe(MIC_GAIN_MAX);
    expect(readMicSettings({ gain: 0 }).gain).toBe(MIC_GAIN_MIN);
    expect(readMicSettings({ gain: -1 }).gain).toBe(MIC_GAIN_MIN);
  });

  it('SNAPS fftSize to an allowed size rather than clamping', () => {
    // The Web Audio spec throws IndexSizeError unless fftSize is a power of two
    // in [32, 32768]. A clamp would leave 1023 as 1023 and take out capture.
    expect(readMicSettings({ fftSize: 1023 }).fftSize).toBe(MIC_SETTINGS_DEFAULTS.fftSize);
    expect(readMicSettings({ fftSize: 4096 }).fftSize).toBe(MIC_SETTINGS_DEFAULTS.fftSize);
    expect(readMicSettings({ fftSize: 0 }).fftSize).toBe(MIC_SETTINGS_DEFAULTS.fftSize);
    for (const n of MIC_FFT_SIZES) expect(readMicSettings({ fftSize: n }).fftSize).toBe(n);
  });

  it('survives adversarial values without throwing or emitting NaN', () => {
    const hostile: Record<string, unknown>[] = [
      { smoothing: NaN, gain: Infinity, fftSize: -Infinity },
      { smoothing: 'abc', gain: {}, fftSize: [] },
      { smoothing: null, gain: undefined, fftSize: 'x' },
      { smoothing: [0.5], gain: [[2]], fftSize: {} },
    ];
    for (const v of hostile) {
      const s = readMicSettings(v);
      expect(Number.isFinite(s.smoothing)).toBe(true);
      expect(Number.isFinite(s.gain)).toBe(true);
      expect(MIC_FFT_SIZES).toContain(s.fftSize);
      expect(s.smoothing).toBeGreaterThanOrEqual(0);
      expect(s.smoothing).toBeLessThanOrEqual(MIC_SMOOTHING_MAX);
    }
  });
});
