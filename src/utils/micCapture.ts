/**
 * Microphone capture: the DOM-only half, and the ONLY `getUserMedia` call site
 * in this codebase.
 *
 * That "only" is a security property, not tidiness. In FastShaders a node's
 * presence in a graph IS its execution — `fs:graph` is restored on mount with
 * no user gesture, the sync engine regenerates code on any graph change, and
 * the preview iframe swaps `srcDoc`. So a shared `.fastshader` containing a Mic
 * node runs on the next reload with zero interaction. The ONLY thing standing
 * between that and an open microphone is that capture is reachable exclusively
 * from a real user CLICK — the light on the Mic node, or the preview's
 * MicControl, both routed through `micSession.armMic`. Never from a node's
 * mere existence, a message handler, `graphToCode`, or a lifecycle effect.
 * Keep it that way.
 *
 * Nothing here persists. There is deliberately no `fs:micConsent` key and no
 * "remember this" affordance, because `projectImport.ts`'s `writeLs` block
 * copies preview preferences into localStorage straight out of an imported
 * file — any persisted grant would be one line of attacker-supplied JSON away
 * from being pre-granted. Not having the key makes that trap unreachable rather
 * than merely unused. The cost is one click per session, and that is the right
 * trade.
 *
 * No audio is recorded, buffered, or sent anywhere: the analyser is read
 * synchronously each frame and reduced to four floats (see `micAnalysis.ts`).
 * No PCM ever leaves the audio graph.
 */

import { analyseMic, type MicLevels, MIC_LEVELS_ZERO } from './micAnalysis';
import type { MicSettings } from './micNode';

/** How long to wait for the permission prompt before giving up. */
const MIC_PROMPT_TIMEOUT_MS = 30_000;

export type MicStartError =
  | 'insecure-context'
  | 'unsupported'
  | 'denied'
  | 'no-device'
  | 'in-use'
  | 'timeout'
  | 'failed';

export interface MicCapture {
  /** Read the analyser and reduce it to the four shader values. */
  readLevels(): MicLevels;
  /** Re-apply settings without tearing down the stream. */
  applySettings(settings: MicSettings): void;
  /** Stop the tracks and close the AudioContext. Idempotent. */
  stop(): void;
  /** The context's real sample rate — the band maths needs it. */
  readonly sampleRate: number;
}

export type MicStartResult =
  | { ok: true; capture: MicCapture }
  | { ok: false; error: MicStartError };

/** Map a getUserMedia rejection onto something we can write a sentence about. */
function classify(err: unknown): MicStartError {
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
 * Ask for the microphone and build the analyser graph.
 *
 * MUST be called from a user gesture. The 30 s timeout exists because
 * `getUserMedia`'s promise may never settle at all if the user simply ignores
 * the permission prompt — and it also stalls while the document is hidden, so
 * without a bound the UI would sit on "starting…" forever with no way back.
 * A stream that arrives after the timeout is stopped rather than leaked.
 */
export async function startMicCapture(
  settings: MicSettings,
  deviceId?: string | null,
): Promise<MicStartResult> {
  // `navigator.mediaDevices` is undefined outside a secure context, which is
  // exactly the case for the LAN bench server (plain HTTP on 0.0.0.0:5199).
  // Distinguish that from "this browser has no Web Audio" so the message can
  // tell the user something actionable.
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
    return { ok: false, error: insecure ? 'insecure-context' : 'unsupported' };
  }
  const Ctor: typeof AudioContext | undefined =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return { ok: false, error: 'unsupported' };

  let timedOut = false;
  let stream: MediaStream;
  try {
    stream = await new Promise<MediaStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        reject(Object.assign(new Error('mic prompt timeout'), { name: 'FsTimeoutError' }));
      }, MIC_PROMPT_TIMEOUT_MS);
      navigator.mediaDevices
        .getUserMedia({
          // No echo/noise processing: those are tuned for speech intelligibility
          // and actively fight a visualiser — AGC in particular re-normalizes
          // level, so a sustained loud sound would fade to mid-scale on its own.
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            // `exact` rather than a plain hint: silently falling back to a
            // different microphone than the one the user picked is worse than
            // an error we can name (OverconstrainedError -> 'no-device').
            ...(deviceId ? { deviceId: { exact: deviceId } } : null),
          },
          video: false,
        })
        .then(
          (s) => {
            clearTimeout(timer);
            // Lost the race: nobody is going to hold this, so don't leak it
            // (and don't leave the OS recording indicator lit).
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
  } catch (err) {
    return { ok: false, error: timedOut ? 'timeout' : classify(err) };
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
    // Deliberately NOT connected to ctx.destination — that would play the
    // microphone back through the speakers and feed back.
  } catch {
    for (const t of stream.getTracks()) t.stop();
    return { ok: false, error: 'failed' };
  }

  let bins = new Uint8Array(analyser.frequencyBinCount);
  let stopped = false;

  const capture: MicCapture = {
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
    stop() {
      if (stopped) return;
      stopped = true;
      for (const t of stream.getTracks()) t.stop();
      // Closing releases the audio hardware; without it the OS recording
      // indicator can linger even after the tracks stop.
      void ctx.close().catch(() => { /* already closed */ });
    },
  };

  return { ok: true, capture };
}
