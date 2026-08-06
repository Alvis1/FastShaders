/**
 * Microphone → shader values: the PURE half.
 *
 * Everything here is arithmetic over a frequency-magnitude array, so it is
 * node-testable. The DOM half (`getUserMedia`, `AudioContext`, `AnalyserNode`)
 * lives in `micCapture.ts` — the same `imageCodec.ts` / `imageImport.ts` split,
 * and for the same reason: the vitest env is `node` with no jsdom, so anything
 * touching an AudioContext is untestable by construction. The band maths must
 * not be trapped on that side of the line.
 *
 * NB `smoothing` is deliberately NOT applied here. `AnalyserNode` already owns
 * a `smoothingTimeConstant` that does exponential smoothing in the audio
 * thread; re-implementing it on the main thread would double-smooth and add a
 * frame of latency for nothing.
 */

/** The four values a Mic node exposes, in socket order. */
export const MIC_CHANNELS = ['level', 'bass', 'mid', 'treble'] as const;

export type MicChannel = (typeof MIC_CHANNELS)[number];

export type MicLevels = Record<MicChannel, number>;

/**
 * Band crossovers in Hz. Convention, not tuned against material — 200 Hz is
 * roughly where a kick/bass guitar sits below and vocals above; 2 kHz is the
 * usual presence/brilliance split. Exported so the settings menu can print
 * them rather than the user guessing what "bass" means.
 */
export const MIC_BAND_LO_HZ = 200;
export const MIC_BAND_HI_HZ = 2000;

/** All four channels at rest — the value a disarmed mic reports. */
export const MIC_LEVELS_ZERO: MicLevels = { level: 0, bass: 0, mid: 0, treble: 0 };

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Half-open bin range `[start, end)` covering `loHz…hiHz`.
 *
 * An `AnalyserNode`'s `frequencyBinCount` bins span 0…Nyquist (`sampleRate/2`)
 * linearly, so bin `i` starts at `i * sampleRate / (2 * binCount)` and the bin
 * for frequency `f` is `f * 2 * binCount / sampleRate`.
 *
 * BOTH edges floor, so adjacent bands PARTITION the spectrum: bass `[0,a)`,
 * mid `[a,b)`, treble `[b,binCount)` share no bin. Flooring the low edge and
 * ceiling the high one — the obvious alternative — double-counts the crossover
 * bin in two bands, which makes a pure 200 Hz tone light up bass and mid
 * equally and looks like a bug in the band split.
 *
 * Always returns at least one bin. A degenerate device (`sampleRate` 0 or
 * non-finite, which some virtual inputs really do report before the graph
 * settles) would otherwise produce `start === end` and a 0/0 mean.
 */
export function bandBinRange(
  loHz: number,
  hiHz: number,
  sampleRate: number,
  binCount: number,
): { start: number; end: number } {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || binCount <= 0) {
    return { start: 0, end: Math.max(1, binCount) };
  }
  const perBin = sampleRate / (2 * binCount);
  const rawStart = Math.floor(Math.max(0, loHz) / perBin);
  const rawEnd = Math.floor(Math.max(0, hiHz) / perBin);
  const start = Math.min(Math.max(0, rawStart), binCount - 1);
  const end = Math.min(Math.max(start + 1, rawEnd), binCount);
  return { start, end };
}

/** Mean of `bytes[start…end)` normalized to 0…1. */
function meanNorm(bytes: ArrayLike<number>, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) {
    const v = bytes[i];
    // A Uint8Array can't hold NaN, but this also accepts a plain array in
    // tests and an adversarially-shaped object costs nothing to survive.
    sum += Number.isFinite(v) ? v : 0;
  }
  const n = end - start;
  return n > 0 ? sum / n / 255 : 0;
}

/**
 * Reduce one `getByteFrequencyData` snapshot to the four shader values.
 *
 * `level` is the mean across the WHOLE spectrum rather than a time-domain RMS:
 * it costs no second analyser read, and for a visual driver "how much is going
 * on" tracks spectral mean closely enough. It is not an SPL measurement and
 * must not be presented as one.
 *
 * `gain` multiplies after normalization and before the clamp, so it can lift a
 * quiet room without changing the band ratios. Everything saturates at 1.
 */
export function analyseMic(opts: {
  freqBytes: ArrayLike<number>;
  sampleRate: number;
  gain?: number;
}): MicLevels {
  const { freqBytes, sampleRate } = opts;
  const binCount = freqBytes.length;
  if (binCount <= 0) return { ...MIC_LEVELS_ZERO };

  const rawGain = Number(opts.gain);
  const gain = Number.isFinite(rawGain) && rawGain > 0 ? rawGain : 1;

  const bass = bandBinRange(0, MIC_BAND_LO_HZ, sampleRate, binCount);
  const mid = bandBinRange(MIC_BAND_LO_HZ, MIC_BAND_HI_HZ, sampleRate, binCount);
  const treble = bandBinRange(MIC_BAND_HI_HZ, sampleRate / 2, sampleRate, binCount);

  return {
    level: clamp01(meanNorm(freqBytes, 0, binCount) * gain),
    bass: clamp01(meanNorm(freqBytes, bass.start, bass.end) * gain),
    mid: clamp01(meanNorm(freqBytes, mid.start, mid.end) * gain),
    treble: clamp01(meanNorm(freqBytes, treble.start, treble.end) * gain),
  };
}

/** The emitted uniform name for one channel of a Mic node, e.g. `mic1_bass`. */
export function micUniformName(varName: string, channel: MicChannel): string {
  return `${varName}_${channel}`;
}

/**
 * Does this EMITTED uniform name belong to a Mic node?
 *
 * The pump drives uniforms by name rather than by node id, because after a
 * code-panel Apply the node ids are fresh and `nodeVarNames` misses every
 * lookup — but the names in the code are still the names in the code.
 *
 * `mic` is the emitted variable base, so `claimName` produces `mic1`, `mic2`, …
 * (and reserves each `<var>_<channel>` as an alias, so a user property can
 * never take one of these names out from under the emitter).
 *
 * A user property named `mic1_bass` in a graph with NO Mic node would still
 * match this pattern, so callers that use it to HIDE things must intersect it
 * with the names actually emitted — see `micUniformNamesIn`. The pump itself is
 * safe either way: it only runs once the user has armed a graph that really
 * does contain a Mic node.
 */
const MIC_UNIFORM_RE = new RegExp(`^mic\\d*_(${MIC_CHANNELS.join('|')})$`);

export function isMicUniformName(name: string): boolean {
  return MIC_UNIFORM_RE.test(name);
}

/** The channel a Mic uniform name refers to, or null if it isn't one. */
export function micChannelOf(name: string): MicChannel | null {
  const m = MIC_UNIFORM_RE.exec(name);
  return m ? (m[1] as MicChannel) : null;
}

/**
 * The mic uniform names a generated module declares, in source order.
 *
 * Used by the exported module's header to name the exact properties the
 * recipient has to drive — a note saying "this has microphone properties"
 * without naming them is barely better than nothing.
 */
export function micUniformNamesIn(code: string): string[] {
  const re = new RegExp(`\\bconst\\s+(mic\\d*_(?:${MIC_CHANNELS.join('|')}))\\s*=\\s*uniform\\(`, 'g');
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

/**
 * The channel an EDGE's `sourceHandle` addresses, defaulting to `level`.
 *
 * Shared by graphToCode's emission loop and `resolveEdgeRef` so the two can
 * never disagree: the emitter decides which uniforms exist, the resolver
 * decides which name an edge reads, and a handle either side normalized
 * differently would emit a reference to an undeclared variable — a
 * `ReferenceError` at module load, i.e. a blank preview with no useful message.
 * A `.fastshader` can carry any string here, so there is no "impossible" input.
 */
export function micChannelForHandle(handle: string | null | undefined): MicChannel {
  return (MIC_CHANNELS as readonly string[]).includes(handle ?? '')
    ? (handle as MicChannel)
    : 'level';
}
