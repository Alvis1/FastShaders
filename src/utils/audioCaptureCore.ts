/**
 * The analyser half of live-audio capture, shared by the two capture surfaces:
 * `micCapture.ts` (`getUserMedia` — a microphone, or any other audio INPUT
 * device, which is how a loopback driver like BlackHole / VB-Cable is reached)
 * and `systemAudioCapture.ts` (`getDisplayMedia` — whatever the machine or a
 * browser tab is PLAYING).
 *
 * Split out because the two differ ONLY in how the `MediaStream` is obtained.
 * Everything after that — the AudioContext, the AnalyserNode, the per-frame
 * reduction to four floats, the fftSize realloc rule, and the teardown that
 * clears the OS capture indicator — is identical, and a hand-copied twin of it
 * is precisely the drift class this codebase kills elsewhere (micGeometry,
 * micStatusMessage, the `fit-bounds` twin guard).
 *
 * The "no PCM ever leaves the audio graph" guarantee lives HERE, so it holds for
 * both sources: the analyser is read synchronously each frame and reduced to
 * four numbers. Nothing is buffered, recorded, or connected to `ctx.destination`
 * — the latter would also feed a microphone straight back into the speakers.
 */

import { analyseMic, type MicLevels, MIC_LEVELS_ZERO } from './micAnalysis';
import type { MicSettings } from './micNode';

/**
 * Everything that can go wrong starting a capture, in terms we can write a
 * sentence about. Shared by both sources; not every member is reachable from
 * both (`no-audio-track` is a `getDisplayMedia` outcome, `no-device` a
 * `getUserMedia` one), which is fine — the message table has a default.
 */
export type AudioStartError =
  | 'insecure-context'
  | 'unsupported'
  | 'denied'
  | 'no-device'
  | 'in-use'
  | 'timeout'
  /**
   * The share succeeded but carries NO audio track. This is the normal outcome
   * in Safari and Firefox, which implement `getDisplayMedia` and then ignore the
   * audio constraint entirely, and it is also what a user gets in Chromium when
   * they pick a screen/window without ticking the audio box. It must be its own
   * status: "failed" would be a lie (the user granted exactly what they were
   * asked for) and the fix is a different action in each case.
   */
  | 'no-audio-track'
  | 'failed';

export interface AudioCapture {
  /** Read the analyser and reduce it to the four shader values. */
  readLevels(): MicLevels;
  /** Re-apply settings without tearing down the stream. */
  applySettings(settings: MicSettings): void;
  /** Stop the tracks and close the AudioContext. Idempotent. */
  stop(): void;
  /** The context's real sample rate — the band maths needs it. */
  readonly sampleRate: number;
}

export type AudioStartResult =
  | { ok: true; capture: AudioCapture }
  | { ok: false; error: AudioStartError };

/** Map a getUserMedia / getDisplayMedia rejection onto a nameable cause. */
export function classifyAudioError(err: unknown): AudioStartError {
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no-device';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'in-use';
    case 'SecurityError':
      return 'insecure-context';
    default:
      return 'failed';
  }
}

/**
 * The AudioContext constructor, or undefined where there is none.
 *
 * `webkitAudioContext` is still the only spelling on some WebKit builds this app
 * has to run in (the Tauri WKWebView shell among them).
 */
export function audioContextCtor(): typeof AudioContext | undefined {
  return typeof AudioContext !== 'undefined'
    ? AudioContext
    : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

/**
 * Wrap a live `MediaStream` in the analyser graph and hand back the capture.
 *
 * Takes ownership of the stream: on any failure here, and on `stop()`, EVERY
 * track is stopped — including a display capture's video track, which otherwise
 * leaves the browser's "you are sharing your screen" bar up after the visualiser
 * has stopped listening.
 *
 * `onEnded` fires when the source disappears from underneath us — the user
 * pressing Chrome's "Stop sharing" button, or a USB device being unplugged. The
 * session needs that: without it the status stays 'on' forever while every band
 * reads a frozen last value, which is the same wrong signal as a mic that never
 * disarms.
 */
export async function buildAnalyserCapture(
  stream: MediaStream,
  settings: MicSettings,
  opts: { onEnded?: () => void } = {},
): Promise<AudioStartResult> {
  const Ctor = audioContextCtor();
  if (!Ctor) {
    for (const t of stream.getTracks()) t.stop();
    return { ok: false, error: 'unsupported' };
  }

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    for (const t of stream.getTracks()) t.stop();
    return { ok: false, error: 'no-audio-track' };
  }

  let ctx: AudioContext;
  let analyser: AnalyserNode;
  try {
    ctx = new Ctor();
    // A context created outside a gesture starts suspended and its graph never
    // runs, so every band would read a flat 0 with no error anywhere.
    if (ctx.state === 'suspended') await ctx.resume().catch(() => { /* best effort */ });
    analyser = ctx.createAnalyser();
    analyser.fftSize = settings.fftSize;
    analyser.smoothingTimeConstant = settings.smoothing;
    ctx.createMediaStreamSource(stream).connect(analyser);
    // Deliberately NOT connected to ctx.destination — for a microphone that
    // feeds back through the speakers, and for system audio it would double the
    // very sound we are measuring.
  } catch {
    for (const t of stream.getTracks()) t.stop();
    return { ok: false, error: 'failed' };
  }

  let bins = new Uint8Array(analyser.frequencyBinCount);
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const t of stream.getTracks()) t.stop();
    // Closing releases the audio hardware; without it the OS capture indicator
    // can linger even after the tracks stop.
    void ctx.close().catch(() => { /* already closed */ });
  };

  if (opts.onEnded) {
    const { onEnded } = opts;
    // EVERY track, not just the audio ones. `ended` is the only signal for
    // "Stop sharing", and a display capture's session hangs off the VIDEO
    // track — so on some builds that is the track that ends first (or alone)
    // when the user stops the share from the browser's own bar.
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        if (stopped) return;
        onEnded();
      });
    }
  }

  const capture: AudioCapture = {
    get sampleRate() {
      return ctx.sampleRate;
    },
    readLevels() {
      if (stopped) return { ...MIC_LEVELS_ZERO };
      // fftSize changes reallocate frequencyBinCount, so re-check rather than
      // reading into a stale short buffer (getByteFrequencyData would silently
      // fill only part of the spectrum).
      if (bins.length !== analyser.frequencyBinCount) {
        bins = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(bins);
      // RAW 0-1, no gain. `gain` is applied in the SHADER (graphToCode emits a
      // `.mul()` on the uniform) so that it can be driven by a wire — applying
      // it here as well would scale twice, and the level meter would stop
      // agreeing with what the shader actually receives.
      return analyseMic({ freqBytes: bins, sampleRate: ctx.sampleRate });
    },
    applySettings(s) {
      if (stopped) return;
      // NB `s.gain` is deliberately ignored — see readLevels.
      // Both setters throw IndexSizeError on out-of-range input; readMicSettings
      // is what guarantees these are in range. Guard anyway — a throw here would
      // kill the pump's rAF loop and freeze every band at its last value.
      try {
        if (analyser.fftSize !== s.fftSize) analyser.fftSize = s.fftSize;
        if (analyser.smoothingTimeConstant !== s.smoothing) {
          analyser.smoothingTimeConstant = s.smoothing;
        }
      } catch { /* keep the previous, known-good analyser config */ }
    },
    stop,
  };

  return { ok: true, capture };
}
