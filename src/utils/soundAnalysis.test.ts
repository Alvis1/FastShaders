import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SOUND_CHANNELS,
  SOUND_BAND_LO_HZ,
  SOUND_BAND_HI_HZ,
  SOUND_LEVELS_ZERO,
  bandBinRange,
  analyseSound,
  soundUniformName,
  isSoundUniformName,
  soundChannelOf,
  soundVarBaseOf,
  soundVarBase,
  isSoundNodeType,
  SOUND_VAR_BASE,
} from './soundAnalysis';

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
    expect(bandBinRange(0, SOUND_BAND_LO_HZ, SR, BINS)).toEqual({ start: 0, end: 4 });
    expect(bandBinRange(SOUND_BAND_LO_HZ, SOUND_BAND_HI_HZ, SR, BINS)).toEqual({ start: 4, end: 42 });
    expect(bandBinRange(SOUND_BAND_HI_HZ, SR / 2, SR, BINS)).toEqual({ start: 42, end: BINS });
  });

  it('partitions the spectrum — adjacent bands share no bin', () => {
    const bass = bandBinRange(0, SOUND_BAND_LO_HZ, SR, BINS);
    const mid = bandBinRange(SOUND_BAND_LO_HZ, SOUND_BAND_HI_HZ, SR, BINS);
    const treble = bandBinRange(SOUND_BAND_HI_HZ, SR / 2, SR, BINS);
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

describe('analyseSound', () => {
  it('reports silence for an all-zero spectrum', () => {
    expect(analyseSound({ freqBytes: bytes(() => 0), sampleRate: SR })).toEqual(SOUND_LEVELS_ZERO);
  });

  it('saturates every channel at 1 for a full-scale spectrum', () => {
    const r = analyseSound({ freqBytes: bytes(() => 255), sampleRate: SR });
    for (const ch of SOUND_CHANNELS) expect(r[ch]).toBeCloseTo(1, 6);
  });

  it('routes low-frequency energy to bass, not treble', () => {
    // Energy only in bins 0-3, i.e. below 200 Hz.
    const r = analyseSound({ freqBytes: bytes((i) => (i < 4 ? 255 : 0)), sampleRate: SR });
    expect(r.bass).toBeCloseTo(1, 6);
    expect(r.mid).toBe(0);
    expect(r.treble).toBe(0);
    expect(r.level).toBeGreaterThan(0);
  });

  it('routes high-frequency energy to treble, not bass', () => {
    const r = analyseSound({ freqBytes: bytes((i) => (i >= 42 ? 255 : 0)), sampleRate: SR });
    expect(r.treble).toBeCloseTo(1, 6);
    expect(r.bass).toBe(0);
    expect(r.mid).toBe(0);
  });

  it('routes speech-band energy to mid', () => {
    const r = analyseSound({ freqBytes: bytes((i) => (i >= 4 && i < 42 ? 255 : 0)), sampleRate: SR });
    expect(r.mid).toBeCloseTo(1, 6);
    expect(r.bass).toBe(0);
    expect(r.treble).toBe(0);
  });

  // NB there is no gain here on purpose — the Sound node's gain is applied
  // shader-side (graphToCode emits a separate `.mul()`), so applying it in the
  // analyser too would scale twice. See analyseSound's doc.

  it('returns zeros rather than NaN for an empty spectrum', () => {
    expect(analyseSound({ freqBytes: new Uint8Array(0), sampleRate: SR })).toEqual(SOUND_LEVELS_ZERO);
  });

  it('never emits a value outside 0…1', () => {
    // Plain arrays can carry values a Uint8Array cannot.
    const hostile = [NaN, Infinity, -1e9, 1e9, 255, 0] as unknown as ArrayLike<number>;
    const r = analyseSound({ freqBytes: hostile, sampleRate: SR });
    for (const ch of SOUND_CHANNELS) {
      expect(Number.isFinite(r[ch])).toBe(true);
      expect(r[ch]).toBeGreaterThanOrEqual(0);
      expect(r[ch]).toBeLessThanOrEqual(1);
    }
  });
});

describe('uniform names', () => {
  it('builds <var>_<channel>', () => {
    expect(soundUniformName('sound1', 'level')).toBe('sound1_level');
    expect(soundUniformName('sound2', 'treble')).toBe('sound2_treble');
  });

  it('recognises every emitted channel name', () => {
    for (const ch of SOUND_CHANNELS) {
      expect(isSoundUniformName(soundUniformName(`${SOUND_VAR_BASE}1`, ch))).toBe(true);
      expect(soundChannelOf(soundUniformName(`${SOUND_VAR_BASE}7`, ch))).toBe(ch);
    }
  });

  it('rejects names that are not live-audio uniforms', () => {
    for (const n of [
      'colorA', 'sound', 'sound1', 'sound1_', 'sound1_volume', 'xsound1_bass', 'sound1_bass2',
      // The absorbed Audio Input node's base. `aud1_bass` was a REAL uniform
      // name until 2026-09-08 and is now just another identifier — a graph
      // holding that node migrates to `soundNode` before codegen ever sees it
      // (registry/legacyNodeTypes.ts), so nothing emits `aud` and nothing may
      // claim to recognise it. Keeping the whole family here, `aud1_bass`
      // included, is what stops the retired base being quietly re-honoured.
      'aud', 'aud1', 'aud1_', 'aud1_bass', 'aud1_volume', 'xaud1_bass', 'audio1_bass',
    ]) {
      expect(isSoundUniformName(n)).toBe(false);
      expect(soundChannelOf(n)).toBeNull();
      expect(soundVarBaseOf(n)).toBeNull();
    }
  });

  /**
   * ONE base, and `mic` is it.
   *
   * There were two until 2026-09-08 (the Audio Input node emitted `aud`), and
   * the pair had to stay distinct because the preview pump routes each uniform
   * back to its own capture session by prefix. The fold removed the second
   * session, so the risk this pins has inverted: what must not happen now is
   * `aud` coming BACK as a live base — it is inside modules the app exported
   * before the fold, and honouring it again would let a stale `aud1_bass` be
   * driven by a session that no longer has anything to do with it.
   *
   * `SOUND_VAR_BASE` is asserted against its literal on purpose. It is a
   * persisted contract — inside every exported module and inside podest's own
   * `SOUND_RE` — so this is one of the few places where restating the string is
   * the point rather than a duplication.
   */
  it('resolves the one live-audio base, and no longer honours `aud`', () => {
    expect(SOUND_VAR_BASE).toBe('sound');
    expect(soundVarBase('soundNode')).toBe(SOUND_VAR_BASE);
    expect(soundVarBaseOf('sound3_bass')).toBe(SOUND_VAR_BASE);
    expect(soundVarBaseOf('aud3_bass')).toBeNull();
  });

  it('identifies the live-audio node types and nothing else', () => {
    expect(isSoundNodeType('soundNode')).toBe(true);
    // `audioInput` is NOT one any more. It is a legacy registry type that
    // migrates to `soundNode` on every restore path, so by the time codegen asks
    // this question the type cannot still be in the graph — and answering
    // `true` would let an unmigrated node emit a second, unroutable base.
    expect(isSoundNodeType('audioInput')).toBe(false);
    for (const t of ['float', 'time', 'dataNode', 'imageNode', '', undefined, null]) {
      expect(isSoundNodeType(t as string)).toBe(false);
    }
    // `registryType` arrives from .fastshader files, so the lookup must not
    // resolve prototype members — the documented Record-vs-Map trap.
    for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(isSoundNodeType(t)).toBe(false);
    }
  });
});

/**
 * DRIFT GUARD for the documented hand-written twin.
 *
 * `public/podest.html` is a standalone vanilla page — it cannot import this
 * module, so it carries its own `micBand`/`micMean` beside a comment saying
 * they mirror it. That was the ONE documented twin with nothing checking it;
 * a divergence here is silent, and it would make the same shader react
 * differently on the pedestal than in the editor.
 *
 * The two are evaluated against each other over a finite matrix rather than
 * compared as text: podest's copy is minified-by-hand and legitimately spells
 * things differently.
 */
describe('podest.html mic band maths mirrors micAnalysis', () => {
  const podest = readFileSync(new URL('../../public/podest.html', import.meta.url), 'utf8');

  const grab = (name: string): string => {
    const start = podest.indexOf(`function ${name}(`);
    expect(start, `podest.html no longer defines ${name}`).toBeGreaterThan(-1);
    // Each is a self-contained declaration ending at a line holding just "  }".
    const end = podest.indexOf('\n  }', start);
    expect(end).toBeGreaterThan(start);
    return podest.slice(start, end + '\n  }'.length);
  };

  const podestBand = new Function(
    `${grab('micBand')}\nreturn micBand;`,
  )() as (lo: number, hi: number, rate: number, n: number) => [number, number];
  const podestMean = new Function(
    `${grab('micMean')}\nreturn micMean;`,
  )() as (arr: ArrayLike<number>, a: number, b: number) => number;

  it('agrees with bandBinRange across rates, bin counts and the three shipped bands', () => {
    for (const rate of [8000, 44100, 48000, 96000]) {
      for (const n of [1, 16, 512, 1024]) {
        const bands: [number, number][] = [
          [0, SOUND_BAND_LO_HZ],
          [SOUND_BAND_LO_HZ, SOUND_BAND_HI_HZ],
          [SOUND_BAND_HI_HZ, rate / 2],
        ];
        for (const [lo, hi] of bands) {
          const mine = bandBinRange(lo, hi, rate, n);
          const theirs = podestBand(lo, hi, rate, n);
          expect(theirs, `rate=${rate} n=${n} band=${lo}..${hi}`).toEqual([mine.start, mine.end]);
        }
      }
    }
  });

  it('agrees on the degenerate rate, where both must still yield a usable range', () => {
    // NB podest's guard is `!(rate > 0)` and this module's is a finite check
    // plus `<= 0`; they agree on rate <= 0, which is the case that reaches
    // either in practice. Non-finite rates are deliberately not swept — the
    // two spell that case differently on purpose.
    for (const n of [1, 16, 512]) {
      const mine = bandBinRange(0, 200, 0, n);
      expect(podestBand(0, 200, 0, n)).toEqual([mine.start, mine.end]);
    }
  });

  it('agrees on the normalized mean, including the empty-range case', () => {
    const bins = Array.from({ length: 512 }, (_, i) => (i * 7) % 256);
    // analyseSound's level is the whole-spectrum mean, so it IS micMean(0, n).
    const whole = analyseSound({ freqBytes: bins, sampleRate: SR });
    expect(podestMean(bins, 0, bins.length)).toBeCloseTo(whole.level, 12);
    expect(podestMean(bins, 5, 5)).toBe(0);
  });
});
