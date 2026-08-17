import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  subscribeMic,
  getMicStatus,
  armMic,
  disarmMic,
  readMicLevels,
  applyMicSettings,
  micArmIntent,
  type MicStatus,
} from '@/utils/micSession';
import {
  liveAudioChannelOf,
  liveAudioVarBaseOf,
  MIC_VAR_BASE,
} from '@/utils/micAnalysis';
import {
  readAudioLevels,
  applyAudioSettings,
  audioArmIntent,
  disarmAudio,
  subscribeAudio,
  getAudioStatus,
} from '@/utils/audioSession';
import type { MicSettings } from '@/utils/micNode';

export type { MicStatus };

export interface MicPump {
  status: MicStatus;
  armed: boolean;
  arm: () => void;
  disarm: () => void;
  /**
   * Attach to the meter fill element. The rAF loop writes its `transform`
   * DIRECTLY — see the note on why this is not React state.
   */
  meterRef: React.RefObject<HTMLSpanElement>;
}

/**
 * Drive the Mic node's uniforms from the live microphone session.
 *
 * The SESSION (arm/disarm/capture) lives in `utils/micSession.ts` so the node's
 * own button and this panel share one truth. What lives HERE is everything that
 * needs the preview's context: the iframe to post into, the uniform names to
 * drive, and the rAF loop that connects them.
 *
 * Three rules make this safe to run at 60 Hz, and all three are load-bearing:
 *
 * 1. **It posts `fs:uniform` DIRECTLY and never touches `handleUniformChange`
 *    or `handleReset`.** Those call `setUniformValues`, which is a
 *    `usePersistedState` — i.e. a React commit PLUS a synchronous
 *    `localStorage.setItem(JSON.stringify(...))`. Routed through them this
 *    would do 60 JSON serializations and 60 re-renders of a ~1000-line panel
 *    every second, and it would persist microphone-derived values to disk,
 *    contradicting the "nothing is recorded" guarantee outright.
 * 2. **The meter is written imperatively from the loop**, not via state, for
 *    the same reason (the `useFitText` / `PreviewNode` precedent).
 * 3. **Targets come from the GENERATED CODE, not the graph.** After a
 *    code-panel Apply the node ids are all fresh and `nodeVarNames` misses
 *    every lookup, but the names in the code are still the names in the code.
 *
 * The capture lives in the PARENT document, so it survives the iframe's srcDoc
 * rebuild (which happens on essentially every graph edit). The new document
 * boots with its uniforms at their schema default of 0 and the very next pump
 * frame overwrites them — a rebuild costs at most one frame of silence, not a
 * re-prompt.
 */
export function useMicPump(opts: {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** Emitted mic uniform names present in the current shader (`mic1_bass`, …). */
  micUniformNames: string[];
  settings: MicSettings;
  /** Emitted Audio Input uniform names present in the current shader (`aud1_bass`, …). */
  audioUniformNames?: string[];
  /** The Audio Input node's analyser settings, resolved like the mic's. */
  audioSettings?: MicSettings;
}): MicPump {
  const { iframeRef, micUniformNames, settings } = opts;
  // Stable empty default: a fresh `[]` per render would re-run every effect
  // keyed on it, and the auto-disarm one would then fire on every render.
  const audioUniformNames = opts.audioUniformNames ?? EMPTY_NAMES;
  const audioSettings = opts.audioSettings;

  const status = useSyncExternalStore(subscribeMic, getMicStatus, getMicStatus);
  // Subscribed for the zero-on-leave effect below; the Audio Input node draws
  // its own meter and owns its own arm button, so nothing else here needs it.
  const audioStatus = useSyncExternalStore(subscribeAudio, getAudioStatus, getAudioStatus);
  const meterRef = useRef<HTMLSpanElement>(null);

  // rAF-loop inputs live in refs so the loop can be started once with `[]`
  // deps and never restarted — the codebase's standard rAF ref pattern.
  const namesRef = useRef(micUniformNames);
  const audioNamesRef = useRef(audioUniformNames);
  const settingsRef = useRef(settings);
  const iframeRefRef = useRef(iframeRef);
  useEffect(() => { namesRef.current = micUniformNames; }, [micUniformNames]);
  useEffect(() => { audioNamesRef.current = audioUniformNames; }, [audioUniformNames]);
  useEffect(() => { iframeRefRef.current = iframeRef; }, [iframeRef]);

  // Settings changes re-configure the live analyser in place. No teardown, so
  // tuning smoothing/gain never re-prompts and never drops a frame.
  useEffect(() => {
    settingsRef.current = settings;
    applyMicSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (audioSettings) applyAudioSettings(audioSettings);
  }, [audioSettings]);

  const arm = useCallback(() => armMic(settingsRef.current), []);
  const disarm = useCallback(() => disarmMic(), []);

  // The pump. Runs for the component's whole life and simply idles when nothing
  // is armed — cheaper and far less error-prone than tearing an rAF loop up and
  // down around a permission prompt.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const micOn = micArmIntent();
      const audioOn = audioArmIntent();
      if (!micOn && !audioOn) return;

      // Read each session at most ONCE per frame, even though the names below
      // are interleaved: readLevels() runs a full getByteFrequencyData + band
      // reduction, so doing it per uniform would repeat that up to four times.
      const micLevels = micOn ? readMicLevels() : null;
      const audioLevels = audioOn ? readAudioLevels() : null;

      const win = iframeRefRef.current.current?.contentWindow;
      if (win) {
        // Routed by the uniform's PREFIX, which is the whole reason the two
        // nodes claim different variable bases (`mic` vs `aud`). A graph may
        // hold both nodes, and each must be driven by its OWN capture — sharing
        // a base here would make one node's sound drive the other's uniforms.
        const post = (names: readonly string[]) => {
          for (const name of names) {
            const ch = liveAudioChannelOf(name);
            if (!ch) continue;
            const levels = liveAudioVarBaseOf(name) === MIC_VAR_BASE ? micLevels : audioLevels;
            if (!levels) continue;
            win.postMessage({ type: 'fs:uniform', name, value: levels[ch] }, '*');
          }
        };
        post(namesRef.current);
        post(audioNamesRef.current);
      }

      const el = meterRef.current;
      // scaleX rather than width: transform-only so the compositor handles it
      // and a 60 Hz meter never triggers layout. This is the MIC's meter (the
      // preview's MicControl); the Audio Input node draws its own on the card.
      if (el && micLevels) el.style.transform = `scaleX(${micLevels.level.toFixed(3)})`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Leaving a capturing state must ZERO the uniforms. Without this the shader
  // holds whatever the last captured frame happened to be — a room-noise level
  // frozen in at the instant of disarming, which reads as "the mic is still
  // connected" and is exactly the wrong signal after turning it off.
  const wasLiveRef = useRef(false);
  useEffect(() => {
    const live = status === 'on' || status === 'starting';
    if (wasLiveRef.current && !live) {
      const win = iframeRefRef.current.current?.contentWindow;
      if (win) {
        for (const name of namesRef.current) {
          win.postMessage({ type: 'fs:uniform', name, value: 0 }, '*');
        }
      }
      const el = meterRef.current;
      if (el) el.style.transform = 'scaleX(0)';
    }
    wasLiveRef.current = live;
  }, [status]);

  // Same rule for the Audio Input session, tracked separately: the two capture
  // independently, so one stopping must not zero the other's uniforms.
  const audioWasLiveRef = useRef(false);
  useEffect(() => {
    const live = audioStatus === 'on' || audioStatus === 'starting';
    if (audioWasLiveRef.current && !live) {
      const win = iframeRefRef.current.current?.contentWindow;
      if (win) {
        for (const name of audioNamesRef.current) {
          win.postMessage({ type: 'fs:uniform', name, value: 0 }, '*');
        }
      }
    }
    audioWasLiveRef.current = live;
  }, [audioStatus]);

  // An armed microphone with nothing left to drive is pure downside: the OS
  // indicator stays lit for a graph that no longer listens. Deleting the last
  // Mic node (or unwiring it, which drops its uniforms from the emitted code)
  // disarms.
  //
  // Gated on INTENT (`micArmIntent()`), not on whether a capture exists yet.
  // During the permission prompt there IS no capture, and the button that would
  // stop it unmounts at that same moment — a capture-gated check would let the
  // answer install a live mic with no control anywhere to turn it off.
  useEffect(() => {
    if (micUniformNames.length === 0 && micArmIntent()) disarmMic();
  }, [micUniformNames]);

  // The same guarantee for the Audio Input node. It matters MORE here: this
  // session can be holding a screen share, so an orphaned capture leaves the
  // browser's "you are sharing your screen" bar up over a graph that no longer
  // listens to it.
  useEffect(() => {
    if (audioUniformNames.length === 0 && audioArmIntent()) disarmAudio();
  }, [audioUniformNames]);

  return { status, armed: status === 'on' || status === 'starting', arm, disarm, meterRef };
}

/** Stable identity for the default — see the note where it is used. */
const EMPTY_NAMES: string[] = [];
