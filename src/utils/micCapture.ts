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
 * (`systemAudioCapture.ts` is the same statement for `getDisplayMedia`, which is
 * how the Audio Input node hears a media player or a browser tab. The analyser
 * graph both build is shared — see `audioCaptureCore.ts`.)
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

import type { MicSettings } from './micNode';
import {
  buildAnalyserCapture,
  classifyAudioError,
  audioContextCtor,
  type AudioCapture,
  type AudioStartError,
  type AudioStartResult,
} from './audioCaptureCore';

/** How long to wait for the permission prompt before giving up. */
const MIC_PROMPT_TIMEOUT_MS = 30_000;

/**
 * Historical names, kept because they are what the mic surfaces import. The
 * underlying types are shared with the system-audio path — the two capture
 * sources differ only in how the stream is obtained.
 */
export type MicStartError = AudioStartError;
export type MicCapture = AudioCapture;
export type MicStartResult = AudioStartResult;

/**
 * Ask for the microphone and build the analyser graph.
 *
 * MUST be called from a user gesture. The 30 s timeout exists because
 * `getUserMedia`'s promise may never settle at all if the user simply ignores
 * the permission prompt — and it also stalls while the document is hidden, so
 * without a bound the UI would sit on "starting…" forever with no way back.
 * A stream that arrives after the timeout is stopped rather than leaked.
 *
 * `deviceId` selects a specific input. Note that a LOOPBACK driver (BlackHole,
 * VB-Cable, VoiceMeeter) appears here as an ordinary `audioinput`, which is how
 * this path can hear what the machine is playing on browsers where
 * `getDisplayMedia` carries no audio.
 */
export async function startMicCapture(
  settings: MicSettings,
  deviceId?: string | null,
  opts: { onEnded?: () => void } = {},
): Promise<MicStartResult> {
  // `navigator.mediaDevices` is undefined outside a secure context, which is
  // exactly the case for the LAN bench server (plain HTTP on 0.0.0.0:5199).
  // Distinguish that from "this browser has no Web Audio" so the message can
  // tell the user something actionable.
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
    return { ok: false, error: insecure ? 'insecure-context' : 'unsupported' };
  }
  if (!audioContextCtor()) return { ok: false, error: 'unsupported' };

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
    return { ok: false, error: timedOut ? 'timeout' : classifyAudioError(err) };
  }

  return buildAnalyserCapture(stream, settings, opts);
}
