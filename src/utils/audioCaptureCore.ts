/**
 * The analyser half of live-audio capture, shared by the two capture surfaces:
 * `micCapture.ts` (`getUserMedia` — a microphone, or any other audio INPUT
 * device, which is how a loopback driver like BlackHole / VB-Cable is reached)
 * and `systemAudioCapture.ts` (`getDisplayMedia` — whatever the machine or a
 * browser tab is PLAYING).
 *
 * Split out because the two differ ONLY in WHICH media call is made and what it
 * is given. Everything around that call — the timeout race and its lost-race
 * cleanup (`acquireStream`), then the AudioContext, the AnalyserNode, the
 * per-frame reduction to four floats, the fftSize realloc rule, and the teardown
 * that clears the OS capture indicator — is identical, and a hand-copied twin of
 * it is precisely the drift class this codebase kills elsewhere (micGeometry,
 * soundStatusMessage, the `fit-bounds` twin guard). The two rules that must never
 * drift — never leak a stream nobody reads, and always report `ended` — are
 * therefore each written once, here.
 *
 * The "no PCM ever leaves the audio graph" guarantee lives HERE, so it holds for
 * both sources: the analyser is read synchronously each frame and reduced to
 * four numbers. Nothing is buffered, recorded, or connected to `ctx.destination`
 * — the latter would also feed a microphone straight back into the speakers.
 */

import { analyseSound, type SoundLevels, SOUND_LEVELS_ZERO } from './soundAnalysis';
import type { SoundSettings } from './soundSettings';

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
  readLevels(): SoundLevels;
  /** Re-apply settings without tearing down the stream. */
  applySettings(settings: SoundSettings): void;
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

/** What `acquireStream` hands back — a live stream, or a nameable cause. */
export type StreamAcquireResult =
  | { ok: true; stream: MediaStream }
  | { ok: false; error: AudioStartError };

/**
 * Await a `MediaStream` under a hard time bound, and STOP one that arrives after
 * we have given up on it.
 *
 * Both capture surfaces need exactly this, which is why it lives here rather
 * than in a copy each: `getUserMedia`'s and `getDisplayMedia`'s promises may
 * never settle at all (the user ignores the permission prompt or the share
 * picker, or the document is hidden and the prompt stalls), so without a bound
 * the UI sits on "starting…" forever with no way back.
 *
 * The lost-race branch is the load-bearing half, and it is the rule this whole
 * module exists to keep in one place: once we have reported a timeout, nobody
 * holds the stream that turns up afterwards, so every track is stopped. Leak it
 * instead and the OS recording indicator — or the browser's "you are sharing
 * your screen" bar — stays lit for the life of the tab over a capture with no
 * reader, which is the one failure this app must never ship.
 *
 * @param start   called INSIDE the race, so a synchronous throw from the media
 *                API rejects like any other failure.
 * @param what    names the wait in the timeout error (diagnostics only — the
 *                caller-facing value is the `'timeout'` status).
 */
export async function acquireStream(
  start: () => Promise<MediaStream>,
  timeoutMs: number,
  what: string,
): Promise<StreamAcquireResult> {
  let timedOut = false;
  try {
    const stream = await new Promise<MediaStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        reject(Object.assign(new Error(`${what} timeout`), { name: 'FsTimeoutError' }));
      }, timeoutMs);
      start().then(
        (s) => {
          clearTimeout(timer);
          if (timedOut) {
            for (const t of s.getTracks()) t.stop();
            return;
          }
          resolve(s);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
    return { ok: true, stream };
  } catch (err) {
    return { ok: false, error: timedOut ? 'timeout' : classifyAudioError(err) };
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
  settings: SoundSettings,
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
      if (stopped) return { ...SOUND_LEVELS_ZERO };
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
      return analyseSound({ freqBytes: bins, sampleRate: ctx.sampleRate });
    },
    applySettings(s) {
      if (stopped) return;
      // NB `s.gain` is deliberately ignored — see readLevels.
      // Both setters throw IndexSizeError on out-of-range input; readSoundSettings
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
