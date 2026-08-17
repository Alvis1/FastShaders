/**
 * System / tab audio capture: the DOM-only half, and the ONLY `getDisplayMedia`
 * call site in this codebase.
 *
 * That "only" is the same security property `micCapture.ts` states for
 * `getUserMedia`, and it matters for the same reason: in FastShaders a node's
 * presence in a graph IS its execution (`fs:graph` restores on mount with no
 * gesture), so a shared `.fastshader` holding an Audio Input node runs on the
 * next reload with zero interaction. The only thing between that and a live
 * capture of the user's screen audio is that this function is reachable
 * exclusively from a real user CLICK, routed through `audioSession.armAudio`.
 *
 * Here the platform helps: `getDisplayMedia` REQUIRES transient user activation
 * and always shows the browser's own share picker, so it is strictly harder to
 * reach silently than `getUserMedia` is. Do not treat that as licence to relax
 * the click rule — the picker is the browser's consent, not ours.
 *
 * Nothing persists. A display capture cannot be remembered even in principle:
 * the grant dies with the share, and there is no origin-scoped permission to
 * store. Same as the mic, one step stronger.
 *
 * WHAT THIS CAN ACTUALLY CAPTURE, measured against shipping browsers:
 *   - Chromium (Chrome/Edge/WebView2): TAB audio on every platform when the
 *     user picks a browser tab and ticks "Share tab audio"; WHOLE-SYSTEM audio
 *     on Windows and ChromeOS, and on macOS only with Chrome 141+ running on
 *     macOS 14.2+ (Apple exposed no third-party system-audio API before that).
 *   - Safari / WebKit — including the Tauri macOS shell — implements
 *     `getDisplayMedia` and IGNORES the audio constraint: the share succeeds
 *     and carries a video track only. That surfaces as `no-audio-track`, not as
 *     a failure, because the user did nothing wrong and the fix is different
 *     (route the sound through a loopback input device instead).
 *   - Firefox: same as Safari — audio is not implemented.
 */

import type { MicSettings } from './micNode';
import {
  buildAnalyserCapture,
  classifyAudioError,
  audioContextCtor,
  type AudioStartResult,
} from './audioCaptureCore';

/**
 * How long to wait for the share picker before giving up.
 *
 * Longer than the microphone's 30 s on purpose: a mic prompt is one Allow
 * button, while this picker asks the user to FIND the right tab or window among
 * everything they have open, and often to notice a "share audio" checkbox on the
 * way. Thirty seconds is a realistic amount of hunting, and timing out mid-hunt
 * would read as the button being broken.
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
 * Ask the user to share a tab / window / screen and analyse ITS audio.
 *
 * MUST be called from a user gesture (see the header).
 *
 * `video: true` is not optional and not a mistake: the spec REQUIRES a video
 * track, and `getDisplayMedia({ video: false })` rejects with a TypeError rather
 * than handing back audio-only. So we ask for video, then never consume it —
 * `enabled = false` and no sink anywhere. The track is deliberately NOT stopped:
 * a display session hangs off its video track, and stopping it can tear the
 * whole share down, taking the audio with it. An unconsumed disabled track costs
 * essentially nothing; a torn-down share costs the feature.
 */
export async function startSystemAudioCapture(
  settings: MicSettings,
  opts: { onEnded?: () => void } = {},
): Promise<AudioStartResult> {
  // `navigator.mediaDevices` is undefined outside a secure context — the real,
  // reachable case here being the LAN bench server (plain HTTP on :5199).
  if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
    const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
    return { ok: false, error: insecure ? 'insecure-context' : 'unsupported' };
  }
  if (!audioContextCtor()) return { ok: false, error: 'unsupported' };

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

  let timedOut = false;
  let stream: MediaStream;
  try {
    stream = await new Promise<MediaStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        reject(Object.assign(new Error('share picker timeout'), { name: 'FsTimeoutError' }));
      }, SHARE_PICKER_TIMEOUT_MS);
      navigator.mediaDevices.getDisplayMedia(options).then(
        (s) => {
          clearTimeout(timer);
          // Lost the race: nobody is going to hold this, so don't leak it — and
          // don't leave the browser's "sharing" bar up over a capture that no
          // longer has a reader.
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

  // Requested only because the spec demands it. Disable rather than stop — see
  // the doc comment above.
  for (const v of stream.getVideoTracks()) v.enabled = false;

  // buildAnalyserCapture reports `no-audio-track` and stops every track if the
  // share carried no audio — the Safari/Firefox outcome, and the Chromium
  // outcome when the user leaves the audio box unticked.
  return buildAnalyserCapture(stream, settings, opts);
}
