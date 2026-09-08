import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import {
  subscribeSound,
  getSoundStatus,
  armSound,
  disarmSound,
  readSoundLevels,
  applySoundSettings,
  soundArmIntent,
  type SoundStatus,
} from '@/utils/soundSession';
import { soundChannelOf } from '@/utils/soundAnalysis';
import type { SoundSettings } from '@/utils/soundSettings';

export type { SoundStatus };

export interface MicPump {
  status: SoundStatus;
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
 * Drive the Sound node's uniforms from the live capture session.
 *
 * The SESSION — arm/disarm, the capture itself, and WHICH sound it is pointed
 * at — lives in `utils/soundSession.ts` so the node's own arm light and this
 * panel share one truth. What lives HERE is everything that needs the preview's
 * context: the iframe to post into, the uniform names to drive, and the rAF
 * loop that connects them.
 *
 * There is exactly ONE session, and therefore one of everything below. This
 * hook carried two of each until the Audio Input node was folded into the Sound
 * node on 2026-09-08: a microphone is now just a `device` source, so a uniform
 * no longer has to be ROUTED to a capture by its variable prefix — every
 * `mic<n>_<channel>` the shader declares is fed by the one analyser. (`mic` is
 * a retained persisted contract, not a claim about what is being heard; see
 * micAnalysis.SOUND_VAR_BASE.)
 *
 * Three rules make this safe to run at 60 Hz, and all three are load-bearing:
 *
 * 1. **It posts `fs:uniform` DIRECTLY and never touches `handleUniformChange`
 *    or `handleReset`.** Those call `setUniformValues`, which is a
 *    `usePersistedState` — i.e. a React commit PLUS a synchronous
 *    `localStorage.setItem(JSON.stringify(...))`. Routed through them this
 *    would do 60 JSON serializations and 60 re-renders of a ~1000-line panel
 *    every second, and it would persist capture-derived values to disk,
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
export function useSoundPump(opts: {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /**
   * Emitted Sound uniform names present in the current shader (`mic1_bass`, …).
   * The CALLER filters them, because it is the only place that can tell an
   * emitted uniform from a user property that happens to carry the same name.
   */
  soundUniformNames: string[];
  settings: SoundSettings;
}): MicPump {
  const { iframeRef, soundUniformNames, settings } = opts;

  const status = useSyncExternalStore(subscribeSound, getSoundStatus, getSoundStatus);
  const meterRef = useRef<HTMLSpanElement>(null);

  // rAF-loop inputs live in refs so the loop can be started once with `[]`
  // deps and never restarted — the codebase's standard rAF ref pattern.
  const namesRef = useRef(soundUniformNames);
  const settingsRef = useRef(settings);
  const iframeRefRef = useRef(iframeRef);
  useEffect(() => { namesRef.current = soundUniformNames; }, [soundUniformNames]);
  useEffect(() => { iframeRefRef.current = iframeRef; }, [iframeRef]);

  // Settings changes re-configure the live analyser in place. No teardown, so
  // tuning smoothing/gain never re-prompts and never drops a frame.
  useEffect(() => {
    settingsRef.current = settings;
    applySoundSettings(settings);
  }, [settings]);

  const arm = useCallback(() => armSound(settingsRef.current), []);
  const disarm = useCallback(() => disarmSound(), []);

  // The pump. Runs for the component's whole life and simply idles when nothing
  // is armed — cheaper and far less error-prone than tearing an rAF loop up and
  // down around a permission prompt or a share picker.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!soundArmIntent()) return;

      // Read the session at most ONCE per frame: readLevels() runs a full
      // getByteFrequencyData plus the band reduction, so asking it per uniform
      // would repeat that up to four times for one frame's worth of sound.
      const levels = readSoundLevels();

      const win = iframeRefRef.current.current?.contentWindow;
      if (win) {
        for (const name of namesRef.current) {
          // The channel is read from the NAME rather than tracked alongside it,
          // for the same reason the names themselves come from the code: after
          // an Apply nothing else about the node survives, but `mic1_bass`
          // still says which of the four values it wants.
          const ch = soundChannelOf(name);
          if (!ch) continue;
          win.postMessage({ type: 'fs:uniform', name, value: levels[ch] }, '*');
        }
      }

      const el = meterRef.current;
      // scaleX rather than width: transform-only so the compositor handles it
      // and a 60 Hz meter never triggers layout. This is the PREVIEW's meter
      // (SoundControl); the Sound node draws its own on the card, from the same
      // session.
      if (el) el.style.transform = `scaleX(${levels.level.toFixed(3)})`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Leaving a capturing state must ZERO the uniforms. Without this the shader
  // holds whatever the last captured frame happened to be — a room-noise level
  // frozen in at the instant of disarming, which reads as "the sound is still
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

  // An armed capture with nothing left to drive is pure downside: the OS
  // recording indicator — or the browser's "you are sharing your screen" bar,
  // since this one session can also be holding a display share — stays up for a
  // graph that no longer listens. Deleting the Sound node (or unwiring it,
  // which drops its uniforms from the emitted code) disarms.
  //
  // Gated on INTENT (`soundArmIntent()`), not on whether a capture exists yet.
  // While the permission prompt or the share picker is open there IS no
  // capture, and the button that would stop it unmounts at that same moment — a
  // capture-gated check would let the answer install a live capture with no
  // control anywhere to turn it off.
  useEffect(() => {
    if (soundUniformNames.length === 0 && soundArmIntent()) disarmSound();
  }, [soundUniformNames]);

  return { status, armed: status === 'on' || status === 'starting', arm, disarm, meterRef };
}
