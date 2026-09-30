/**
 * Sound → shader values: the PURE, node-testable half (arithmetic over a
 * frequency-magnitude array). The DOM half is `audioCaptureCore.ts`.
 *
 * `smoothing` is deliberately NOT applied here: the `AnalyserNode` already
 * smooths in the audio thread, so a second pass would double-smooth.
 */

/** The four values a Sound node exposes, in socket order. */
export const SOUND_CHANNELS = ['level', 'bass', 'mid', 'treble'] as const;

export type SoundChannel = (typeof SOUND_CHANNELS)[number];

export type SoundLevels = Record<SoundChannel, number>;

/**
 * Band crossovers in Hz. Convention, not tuned against material — 200 Hz is
 * roughly where a kick/bass guitar sits below and vocals above; 2 kHz is the
 * usual presence/brilliance split. Exported for the test, which holds
 * podest's hand-written twin to them.
 */
export const SOUND_BAND_LO_HZ = 200;
export const SOUND_BAND_HI_HZ = 2000;

/** All four channels at rest — the value a disarmed session reports. */
export const SOUND_LEVELS_ZERO: SoundLevels = { level: 0, bass: 0, mid: 0, treble: 0 };

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
 * There is deliberately NO gain parameter: the Sound node's `gain` is applied
 * SHADER-side (`const _sound1_bass = sound1_bass.mul(g);`), so applying it here
 * too would scale twice. The clamps guard hostile ArrayLike input, not gain.
 */
export function analyseSound(opts: {
  freqBytes: ArrayLike<number>;
  sampleRate: number;
}): SoundLevels {
  const { freqBytes, sampleRate } = opts;
  const binCount = freqBytes.length;
  if (binCount <= 0) return { ...SOUND_LEVELS_ZERO };

  const bass = bandBinRange(0, SOUND_BAND_LO_HZ, sampleRate, binCount);
  const mid = bandBinRange(SOUND_BAND_LO_HZ, SOUND_BAND_HI_HZ, sampleRate, binCount);
  const treble = bandBinRange(SOUND_BAND_HI_HZ, sampleRate / 2, sampleRate, binCount);

  return {
    level: clamp01(meanNorm(freqBytes, 0, binCount)),
    bass: clamp01(meanNorm(freqBytes, bass.start, bass.end)),
    mid: clamp01(meanNorm(freqBytes, mid.start, mid.end)),
    treble: clamp01(meanNorm(freqBytes, treble.start, treble.end)),
  };
}

/** The emitted uniform name for one channel of a live-audio node, e.g. `sound1_bass`. */
export function soundUniformName(varName: string, channel: SoundChannel): string {
  return `${varName}_${channel}`;
}

/**
 * The emitted variable base (`sound1_bass`, …). A persisted contract inside
 * every exported module; podest's `SOUND_RE` must match it, so never rename.
 */
export const SOUND_VAR_BASE = 'sound';

export type SoundVarBase = typeof SOUND_VAR_BASE;

const SOUND_BASES = [SOUND_VAR_BASE] as const;

/**
 * Registry type → emitted variable base for the hand-emitted Sound node. THE
 * pairing: codegen's name claim, its emission branch and `resolveEdgeRef` all
 * read it here, so a second audio node cannot be added with a base that
 * disagrees with what the pump routes on.
 *
 * A `Map`, not a plain object: `registryType` arrives from adversarial
 * `.fastshader` files, and a bare-object lookup resolves `constructor` /
 * `__proto__` to truthy values.
 */
const SOUND_NODE_BASES = new Map<string, SoundVarBase>([['soundNode', SOUND_VAR_BASE]]);

/** Is this registry type one of the hand-emitted live-audio nodes? */
export function isSoundNodeType(type: string | undefined | null): boolean {
  return typeof type === 'string' && SOUND_NODE_BASES.has(type);
}

/**
 * The emitted variable base for a live-audio node type.
 *
 * Falls back to the one base for anything unknown — unreachable from the call
 * sites (all guarded by `isSoundNodeType`), and it keeps the return type
 * non-nullable for `claimName`. The indirection stays so codegen, the pump and
 * podest cannot disagree about the string (docs/dev/node-types.md → Sound).
 */
export function soundVarBase(type: string): SoundVarBase {
  return SOUND_NODE_BASES.get(type) ?? SOUND_VAR_BASE;
}

/**
 * Does this EMITTED uniform name belong to a live-audio node?
 *
 * The pump drives uniforms by name rather than by node id, because after a
 * code-panel Apply the node ids are fresh and `nodeVarNames` misses every
 * lookup — but the names in the code are still the names in the code.
 *
 * A user property named `sound1_bass` in a graph with NO live-audio node would
 * still match this pattern, so callers that use it to HIDE things must intersect
 * it with the names actually emitted — see `soundUniformNamesIn`. The pump
 * itself is safe either way: it only runs once the user has armed a graph that
 * really does contain the node.
 */
const SOUND_UNIFORM_RE = new RegExp(
  `^(${SOUND_BASES.join('|')})\\d*_(${SOUND_CHANNELS.join('|')})$`,
);

export function isSoundUniformName(name: string): boolean {
  return SOUND_UNIFORM_RE.test(name);
}

/** The channel a live-audio uniform name refers to, or null if it isn't one. */
export function soundChannelOf(name: string): SoundChannel | null {
  const m = SOUND_UNIFORM_RE.exec(name);
  return m ? (m[2] as SoundChannel) : null;
}

/**
 * The live-audio uniform names a generated module declares, in source order.
 *
 * Used by the exported module's header to name the exact properties the
 * recipient has to drive — a note saying "this has microphone properties"
 * without naming them is barely better than nothing.
 */
export function soundUniformNamesIn(code: string): string[] {
  const re = new RegExp(
    `\\bconst\\s+((?:${SOUND_BASES.join('|')})\\d*_(?:${SOUND_CHANNELS.join('|')}))\\s*=\\s*uniform\\(`,
    'g',
  );
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
export function soundChannelForHandle(handle: string | null | undefined): SoundChannel {
  return (SOUND_CHANNELS as readonly string[]).includes(handle ?? '')
    ? (handle as SoundChannel)
    : 'level';
}
