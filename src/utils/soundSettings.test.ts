import { describe, it, expect } from 'vitest';
import {
  MIC_FFT_SIZES,
  MIC_SETTINGS_DEFAULTS,
  MIC_SMOOTHING_MAX,
  MIC_GAIN_MIN,
  MIC_GAIN_MAX,
  readSoundSettings,
} from './soundSettings';

describe('readSoundSettings', () => {
  it('returns defaults for missing values', () => {
    expect(readSoundSettings(undefined)).toEqual(MIC_SETTINGS_DEFAULTS);
    expect(readSoundSettings(null)).toEqual(MIC_SETTINGS_DEFAULTS);
    expect(readSoundSettings({})).toEqual(MIC_SETTINGS_DEFAULTS);
  });

  it('passes through in-range values', () => {
    expect(readSoundSettings({ smoothing: 0.5, gain: 2, fftSize: 2048 })).toEqual({
      smoothing: 0.5,
      gain: 2,
      fftSize: 2048,
    });
  });

  it('coerces numeric strings, as values from a .fastshader may be', () => {
    expect(readSoundSettings({ smoothing: '0.25', gain: '3', fftSize: '512' })).toEqual({
      smoothing: 0.25,
      gain: 3,
      fftSize: 512,
    });
  });

  it('clamps smoothing below 1 so the analyser never freezes', () => {
    // smoothingTimeConstant === 1 means the exponential average never admits
    // new data: every band would hold its initial value forever.
    expect(readSoundSettings({ smoothing: 1 }).smoothing).toBe(MIC_SMOOTHING_MAX);
    expect(readSoundSettings({ smoothing: 99 }).smoothing).toBe(MIC_SMOOTHING_MAX);
    expect(readSoundSettings({ smoothing: -5 }).smoothing).toBe(0);
  });

  it('clamps gain into range', () => {
    expect(readSoundSettings({ gain: 1000 }).gain).toBe(MIC_GAIN_MAX);
    expect(readSoundSettings({ gain: 0 }).gain).toBe(MIC_GAIN_MIN);
    expect(readSoundSettings({ gain: -1 }).gain).toBe(MIC_GAIN_MIN);
  });

  it('SNAPS fftSize to an allowed size rather than clamping', () => {
    // The Web Audio spec throws IndexSizeError unless fftSize is a power of two
    // in [32, 32768]. A clamp would leave 1023 as 1023 and take out capture.
    expect(readSoundSettings({ fftSize: 1023 }).fftSize).toBe(MIC_SETTINGS_DEFAULTS.fftSize);
    expect(readSoundSettings({ fftSize: 4096 }).fftSize).toBe(MIC_SETTINGS_DEFAULTS.fftSize);
    expect(readSoundSettings({ fftSize: 0 }).fftSize).toBe(MIC_SETTINGS_DEFAULTS.fftSize);
    for (const n of MIC_FFT_SIZES) expect(readSoundSettings({ fftSize: n }).fftSize).toBe(n);
  });

  it('survives adversarial values without throwing or emitting NaN', () => {
    const hostile: Record<string, unknown>[] = [
      { smoothing: NaN, gain: Infinity, fftSize: -Infinity },
      { smoothing: 'abc', gain: {}, fftSize: [] },
      { smoothing: null, gain: undefined, fftSize: 'x' },
      { smoothing: [0.5], gain: [[2]], fftSize: {} },
    ];
    for (const v of hostile) {
      const s = readSoundSettings(v);
      expect(Number.isFinite(s.smoothing)).toBe(true);
      expect(Number.isFinite(s.gain)).toBe(true);
      expect(MIC_FFT_SIZES).toContain(s.fftSize);
      expect(s.smoothing).toBeGreaterThanOrEqual(0);
      expect(s.smoothing).toBeLessThanOrEqual(MIC_SMOOTHING_MAX);
    }
  });
});
