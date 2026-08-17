import { describe, it, expect } from 'vitest';
import {
  MIC_CHANNELS,
  MIC_BAND_LO_HZ,
  MIC_BAND_HI_HZ,
  MIC_LEVELS_ZERO,
  bandBinRange,
  analyseMic,
  micUniformName,
  isLiveAudioUniformName,
  liveAudioChannelOf,
  liveAudioVarBaseOf,
  liveAudioVarBase,
  isLiveAudioNodeType,
  MIC_VAR_BASE,
  AUDIO_VAR_BASE,
} from './micAnalysis';

/** 48 kHz / fftSize 1024 → 512 bins, 46.875 Hz per bin. */
const SR = 48000;
const BINS = 512;

function bytes(fill: (i: number) => number): Uint8Array {
  const a = new Uint8Array(BINS);
  for (let i = 0; i < BINS; i++) a[i] = Math.max(0, Math.min(255, Math.round(fill(i))));
  return a;
}

describe('bandBinRange', () => {
  it('maps Hz to bins using sampleRate/(2*binCount)', () => {
    // perBin = 48000 / 1024 = 46.875 Hz
    expect(bandBinRange(0, MIC_BAND_LO_HZ, SR, BINS)).toEqual({ start: 0, end: 4 });
    expect(bandBinRange(MIC_BAND_LO_HZ, MIC_BAND_HI_HZ, SR, BINS)).toEqual({ start: 4, end: 42 });
    expect(bandBinRange(MIC_BAND_HI_HZ, SR / 2, SR, BINS)).toEqual({ start: 42, end: BINS });
  });

  it('partitions the spectrum — adjacent bands share no bin', () => {
    const bass = bandBinRange(0, MIC_BAND_LO_HZ, SR, BINS);
    const mid = bandBinRange(MIC_BAND_LO_HZ, MIC_BAND_HI_HZ, SR, BINS);
    const treble = bandBinRange(MIC_BAND_HI_HZ, SR / 2, SR, BINS);
    expect(bass.end).toBe(mid.start);
    expect(mid.end).toBe(treble.start);
    expect(treble.end).toBe(BINS);
  });

  it('always yields at least one bin', () => {
    // A zero-width band would divide by zero in the mean.
    expect(bandBinRange(1000, 1000, SR, BINS).end).toBeGreaterThan(
      bandBinRange(1000, 1000, SR, BINS).start,
    );
    // Above Nyquist: clamped into range, still non-empty.
    const r = bandBinRange(90000, 99000, SR, BINS);
    expect(r.end).toBeGreaterThan(r.start);
    expect(r.end).toBeLessThanOrEqual(BINS);
  });

  it('survives a degenerate sample rate instead of dividing by zero', () => {
    for (const sr of [0, -1, NaN, Infinity]) {
      expect(bandBinRange(0, 200, sr, BINS)).toEqual({ start: 0, end: BINS });
    }
    expect(bandBinRange(0, 200, SR, 0)).toEqual({ start: 0, end: 1 });
  });
});

describe('analyseMic', () => {
  it('reports silence for an all-zero spectrum', () => {
    expect(analyseMic({ freqBytes: bytes(() => 0), sampleRate: SR })).toEqual(MIC_LEVELS_ZERO);
  });

  it('saturates every channel at 1 for a full-scale spectrum', () => {
    const r = analyseMic({ freqBytes: bytes(() => 255), sampleRate: SR });
    for (const ch of MIC_CHANNELS) expect(r[ch]).toBeCloseTo(1, 6);
  });

  it('routes low-frequency energy to bass, not treble', () => {
    // Energy only in bins 0-3, i.e. below 200 Hz.
    const r = analyseMic({ freqBytes: bytes((i) => (i < 4 ? 255 : 0)), sampleRate: SR });
    expect(r.bass).toBeCloseTo(1, 6);
    expect(r.mid).toBe(0);
    expect(r.treble).toBe(0);
    expect(r.level).toBeGreaterThan(0);
  });

  it('routes high-frequency energy to treble, not bass', () => {
    const r = analyseMic({ freqBytes: bytes((i) => (i >= 42 ? 255 : 0)), sampleRate: SR });
    expect(r.treble).toBeCloseTo(1, 6);
    expect(r.bass).toBe(0);
    expect(r.mid).toBe(0);
  });

  it('routes speech-band energy to mid', () => {
    const r = analyseMic({ freqBytes: bytes((i) => (i >= 4 && i < 42 ? 255 : 0)), sampleRate: SR });
    expect(r.mid).toBeCloseTo(1, 6);
    expect(r.bass).toBe(0);
    expect(r.treble).toBe(0);
  });

  it('applies gain after normalization and clamps at 1', () => {
    const quiet = bytes(() => 25); // ~0.098 normalized
    const g1 = analyseMic({ freqBytes: quiet, sampleRate: SR, gain: 1 });
    const g4 = analyseMic({ freqBytes: quiet, sampleRate: SR, gain: 4 });
    expect(g4.level).toBeCloseTo(g1.level * 4, 6);
    const g100 = analyseMic({ freqBytes: quiet, sampleRate: SR, gain: 100 });
    expect(g100.level).toBe(1);
  });

  it('treats a missing or hostile gain as 1', () => {
    const b = bytes(() => 128);
    const ref = analyseMic({ freqBytes: b, sampleRate: SR, gain: 1 });
    for (const g of [undefined, NaN, Infinity, -3, 0, '2x' as unknown as number]) {
      expect(analyseMic({ freqBytes: b, sampleRate: SR, gain: g as number })).toEqual(ref);
    }
  });

  it('returns zeros rather than NaN for an empty spectrum', () => {
    expect(analyseMic({ freqBytes: new Uint8Array(0), sampleRate: SR })).toEqual(MIC_LEVELS_ZERO);
  });

  it('never emits a value outside 0…1', () => {
    // Plain arrays can carry values a Uint8Array cannot.
    const hostile = [NaN, Infinity, -1e9, 1e9, 255, 0] as unknown as ArrayLike<number>;
    const r = analyseMic({ freqBytes: hostile, sampleRate: SR, gain: 8 });
    for (const ch of MIC_CHANNELS) {
      expect(Number.isFinite(r[ch])).toBe(true);
      expect(r[ch]).toBeGreaterThanOrEqual(0);
      expect(r[ch]).toBeLessThanOrEqual(1);
    }
  });
});

describe('uniform names', () => {
  it('builds <var>_<channel>', () => {
    expect(micUniformName('mic1', 'level')).toBe('mic1_level');
    expect(micUniformName('mic2', 'treble')).toBe('mic2_treble');
  });

  it('recognises every emitted channel name, for BOTH live-audio nodes', () => {
    for (const base of [MIC_VAR_BASE, AUDIO_VAR_BASE]) {
      for (const ch of MIC_CHANNELS) {
        expect(isLiveAudioUniformName(micUniformName(`${base}1`, ch))).toBe(true);
        expect(liveAudioChannelOf(micUniformName(`${base}7`, ch))).toBe(ch);
      }
    }
  });

  it('rejects names that are not live-audio uniforms', () => {
    for (const n of [
      'colorA', 'mic', 'mic1', 'mic1_', 'mic1_volume', 'xmic1_bass', 'mic1_bass2',
      'aud', 'aud1', 'aud1_', 'aud1_volume', 'xaud1_bass', 'audio1_bass',
    ]) {
      expect(isLiveAudioUniformName(n)).toBe(false);
      expect(liveAudioChannelOf(n)).toBeNull();
      expect(liveAudioVarBaseOf(n)).toBeNull();
    }
  });

  /**
   * The routing key the preview pump uses to send each uniform to its OWN
   * capture session. If these two ever collapsed onto one base, a graph holding
   * both nodes would drive one node's uniforms from the other node's sound —
   * silently, and only in the graph that has both.
   */
  it('routes each node kind to a distinct variable base', () => {
    expect(MIC_VAR_BASE).not.toBe(AUDIO_VAR_BASE);
    expect(liveAudioVarBase('micNode')).toBe(MIC_VAR_BASE);
    expect(liveAudioVarBase('audioInput')).toBe(AUDIO_VAR_BASE);
    expect(liveAudioVarBaseOf('mic3_bass')).toBe(MIC_VAR_BASE);
    expect(liveAudioVarBaseOf('aud3_bass')).toBe(AUDIO_VAR_BASE);
  });

  it('identifies the live-audio node types and nothing else', () => {
    expect(isLiveAudioNodeType('micNode')).toBe(true);
    expect(isLiveAudioNodeType('audioInput')).toBe(true);
    for (const t of ['float', 'time', 'dataNode', 'imageNode', '', undefined, null]) {
      expect(isLiveAudioNodeType(t as string)).toBe(false);
    }
    // `registryType` arrives from .fastshader files, so the lookup must not
    // resolve prototype members — the documented Record-vs-Map trap.
    for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(isLiveAudioNodeType(t)).toBe(false);
    }
  });
});
