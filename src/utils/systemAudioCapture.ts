/**
 * The ONLY `getDisplayMedia` call site, reachable only through
 * `soundSession.armSound` from a real click. The browser's share picker is ITS
 * consent, not ours, so the click rule is not relaxed here.
 * Safari and Firefox ignore the audio constraint: the share succeeds with video
 * only and reports `no-audio-track`. Measured: docs/dev/node-types.md → Sound.
 */

import type { SoundSettings } from './soundSettings';
import {
  acquireStream,
  buildAnalyserCapture,
  audioContextCtor,
  mediaGate,
  type AudioStartResult,
} from './audioCaptureCore';

/**
 * How long to wait for the share picker. Longer than the device prompt's 30 s:
 * the user has to FIND the right tab and its "share audio" box, and timing out
 * mid-hunt reads as a broken button.
 */
const SHARE_PICKER_TIMEOUT_MS = 60_000;

/** `getDisplayMedia` options this app needs that the DOM lib may not type yet. */
interface DisplayAudioOptions extends DisplayMediaStreamOptions {
  /** Chromium: show the "also share system audio" toggle for screen/window. */
  systemAudio?: 'include' | 'exclude';
  /** Chromium: keep our own tab out of the picker — sharing it is never useful. */
  selfBrowserSurface?: 'include' | 'exclude';
  /** Chromium: leave the "Stop sharing" bar to the browser, not a surface swap. */
  surfaceSwitching?: 'include' | 'exclude';
}

/** Is a display capture reachable at all in this build? */
export function systemAudioSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function' &&
    !!audioContextCtor()
  );
}

/**
 * Ask the user to share a tab / window / screen and analyse ITS audio. MUST be
 * called from a user gesture.
 *
 * `video: true` is not a mistake: the spec REQUIRES a video track and
 * `getDisplayMedia({ video: false })` rejects. So the track is asked for and
 * never consumed — DISABLED, not stopped, because a display session hangs off
 * its video track and stopping it can tear the share down with the audio.
 */
export async function startSystemAudioCapture(
  settings: SoundSettings,
  opts: { onEnded?: () => void } = {},
): Promise<AudioStartResult> {
  const gate = mediaGate(
    typeof navigator === 'undefined' ? undefined : navigator.mediaDevices?.getDisplayMedia,
  );
  if (gate) return gate;

  const options: DisplayAudioOptions = {
    // No echo/noise processing: those are tuned for speech intelligibility and
    // actively fight a visualiser. AGC is the worst of them here — it
    // re-normalizes level, so a sustained loud passage would fade to mid-scale
    // on its own and the shader would drift while the music held steady.
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: true,
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
  };

  const got = await acquireStream(
    () => navigator.mediaDevices.getDisplayMedia(options),
    SHARE_PICKER_TIMEOUT_MS,
    'share picker',
  );
  if (!got.ok) return got;

  // Requested only because the spec demands it. Disable rather than stop — see
  // the doc comment above.
  for (const v of got.stream.getVideoTracks()) v.enabled = false;

  // buildAnalyserCapture reports `no-audio-track` and stops every track if the
  // share carried no audio — the Safari/Firefox outcome, and the Chromium
  // outcome when the user leaves the audio box unticked.
  return buildAnalyserCapture(got.stream, settings, opts);
}
