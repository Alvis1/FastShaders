/**
 * The ONLY `getUserMedia` call site. Reachable only through
 * `soundSession.armSound` from a real click: a node's presence in a restored
 * graph IS its execution, so the click is the whole consent model.
 * No persisted grant, deliberately: `projectImport` writes prefs straight out
 * of an imported file. Reasoning: docs/dev/node-types.md → Sound.
 */

import type { SoundSettings } from './soundSettings';
import {
  acquireStream,
  buildAnalyserCapture,
  mediaGate,
  type AudioStartResult,
} from './audioCaptureCore';

/** How long to wait for the permission prompt before giving up. */
const MIC_PROMPT_TIMEOUT_MS = 30_000;

/**
 * Ask for an input device and build the analyser graph. MUST be called from a
 * user gesture.
 *
 * `deviceId` selects a specific input; a LOOPBACK driver (BlackHole, VB-Cable,
 * VoiceMeeter) is an ordinary `audioinput` here, which is how this path hears
 * the machine where `getDisplayMedia` carries no audio.
 */
export async function startDeviceCapture(
  settings: SoundSettings,
  deviceId?: string | null,
  opts: { onEnded?: () => void } = {},
): Promise<AudioStartResult> {
  const gate = mediaGate(
    typeof navigator === 'undefined' ? undefined : navigator.mediaDevices?.getUserMedia,
  );
  if (gate) return gate;

  const got = await acquireStream(
    () => navigator.mediaDevices.getUserMedia({
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
    }),
    MIC_PROMPT_TIMEOUT_MS,
    'mic prompt',
  );
  if (!got.ok) return got;

  return buildAnalyserCapture(got.stream, settings, opts);
}
