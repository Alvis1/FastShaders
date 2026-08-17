/**
 * The live AUDIO INPUT session — module-level state for the Audio Input node,
 * the sibling of `micSession.ts`.
 *
 * Why a second session rather than one generalised singleton: the two capture
 * genuinely different things and a graph may hold both nodes at once. A shared
 * slot would mean arming one silently stole the other's capture, which is the
 * "second Mic node's settings are ignored" wart one step worse — here it would
 * change what the shader HEARS, not just how it is filtered. Two sessions, two
 * captures, two arm buttons; the pump routes by uniform prefix (`mic*` vs
 * `aud*`), so neither can drive the other's uniforms.
 *
 * Everything `micSession`'s header says applies verbatim: module singleton so
 * the state can never ride undo history, the `fs:graph` autosave, saved groups,
 * or the FASTSHADERS_PROJECT_V1 embed; nothing persists; and
 *
 *   SECURITY INVARIANT: `armAudio` is the only path to capture and every caller
 *   must be a real user click. There is exactly ONE — the arm light on the Audio
 *   Input node. Never call it from an effect, a message handler, a store
 *   subscription, or anything a loaded `.fastshader` can reach: in this app a
 *   node's presence in a graph IS its execution, so the click is the whole
 *   consent model.
 *
 * The arm-generation guards below are ported from `micSession` deliberately
 * rather than re-derived — the race they close (a non-modal prompt left open
 * while the user arms again) is worse here, because a share picker is slower to
 * answer than an Allow button and so sits open for longer.
 */

import { startSystemAudioCapture, systemAudioSupported } from './systemAudioCapture';
import { startMicCapture } from './micCapture';
import type { AudioCapture, AudioStartError } from './audioCaptureCore';
import { MIC_LEVELS_ZERO, type MicLevels } from './micAnalysis';
import type { MicSettings } from './micNode';
import {
  DEFAULT_AUDIO_SOURCE,
  sameAudioSource,
  type AudioSourceRef,
} from './audioSource';
// ONE enumerateDevices call site in the codebase, in micSession. The list is the
// same list — an `audioinput` is an `audioinput` whichever node is asking.
import { listMicDevices } from './micSession';

export type AudioStatus = 'off' | 'starting' | 'on' | AudioStartError;

let capture: AudioCapture | null = null;
let status: AudioStatus = 'off';

/**
 * Monotonic arm generation. The share picker is non-modal and can sit open for
 * a minute, so a user can leave two starts in flight (arm → cancel → arm). A
 * stale continuation compares generations, recognises itself, and stops the
 * capture it was handed — without this the loser's MediaStream is never stopped
 * and the browser's "sharing" bar stays up for the life of the tab.
 */
let armGen = 0;
/** Chosen source — SESSION-only, never stored on the node. See audioSource.ts. */
let source: AudioSourceRef = DEFAULT_AUDIO_SOURCE;
/** The settings the live capture was started with, for a source re-arm. */
let lastSettings: MicSettings | null = null;
/** A start is awaiting the picker — a second one would strand the first. */
let pending = false;
/** "The user does not want capture right now", written SYNCHRONOUSLY. */
let disarmed = true;

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setStatus(next: AudioStatus): void {
  if (next === status) return;
  status = next;
  emit();
}

/** useSyncExternalStore subscribe. */
export function subscribeAudio(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** useSyncExternalStore snapshot — a string, so it compares by value. */
export function getAudioStatus(): AudioStatus {
  return status;
}

/**
 * Can this build capture audio AT ALL, by either route?
 *
 * Deliberately an OR: on Safari and on the macOS desktop shell `getDisplayMedia`
 * carries no audio, but a loopback INPUT device still works, so the node is
 * useful and must not disable itself.
 */
export function audioInputSupported(): boolean {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return systemAudioSupported() || !!media?.getUserMedia;
}

/** Is the `system` source worth OFFERING in this build? */
export function systemAudioAvailable(): boolean {
  return systemAudioSupported();
}

/** Available audio input devices — shared with the Mic node's picker. */
export { listMicDevices as listAudioInputDevices };

export function getAudioSource(): AudioSourceRef {
  return source;
}

/**
 * Choose the source. SESSION-only (see `audioSource.ts` for why).
 *
 * It REDIRECTS an already-running capture but never starts one. A dropdown must
 * not become a second way to open a capture; arming stays the button's job —
 * the same rule `setMicDeviceId` follows, and the reason this node's dropdown is
 * safe to put directly on the node face where it is one stray click away.
 */
export function setAudioSource(next: AudioSourceRef): void {
  if (sameAudioSource(next, source)) return;
  source = next;
  emit();
  if (capture && lastSettings) {
    const settings = lastSettings;
    disarmAudio();
    armAudio(settings);
  }
}

/**
 * Ask for the chosen source. MUST be called from a user gesture (see header).
 * Safe to call twice — a redundant call is a no-op rather than a second picker.
 */
export function armAudio(settings: MicSettings): void {
  if (capture || pending) return;
  disarmed = false;
  pending = true;
  const gen = ++armGen;
  lastSettings = settings;
  setStatus('starting');

  // Captured for the continuation: `source` is module state and the user can
  // change it from the dropdown while the picker is open.
  const started = source.kind === 'system'
    ? startSystemAudioCapture(settings, { onEnded: () => endedFrom(gen) })
    : startMicCapture(settings, source.deviceId, { onEnded: () => endedFrom(gen) });

  void started.then((res) => {
    if (gen === armGen) pending = false;
    if (!res.ok) {
      // Only the CURRENT request may report a failure; a superseded one would
      // overwrite a live 'on' with a stale error.
      if (gen === armGen) setStatus(res.error);
      return;
    }
    // Superseded, declined, or beaten to the slot while the picker was open.
    // The tracks are already live here, so stop them rather than leak them.
    if (disarmed || gen !== armGen || capture) {
      res.capture.stop();
      return;
    }
    // Settings tuned WHILE the picker was open never reached the analyser,
    // which was built from the snapshot taken before the await.
    res.capture.applySettings(settings);
    capture = res.capture;
    setStatus('on');
  });
}

/**
 * The source vanished on its own — Chrome's "Stop sharing" button, or a device
 * being unplugged.
 *
 * Generation-checked like every other continuation: this callback outlives the
 * capture that registered it, so an `ended` arriving from a capture the user has
 * already replaced must not tear down its successor.
 */
function endedFrom(gen: number): void {
  if (gen !== armGen) return;
  disarmAudio();
}

/** Stop capture and release the source. Idempotent. */
export function disarmAudio(): void {
  disarmed = true;
  // Invalidate anything in flight so a picker answered after this click can't
  // install a capture the user already declined.
  armGen++;
  pending = false;
  capture?.stop();
  capture = null;
  setStatus('off');
}

/** Read the current levels, or the rest state when nothing is capturing. */
export function readAudioLevels(): MicLevels {
  return capture ? capture.readLevels() : { ...MIC_LEVELS_ZERO };
}

export function applyAudioSettings(settings: MicSettings): void {
  capture?.applySettings(settings);
}

/** True while the user intends capture — including the pending-picker window. */
export function audioArmIntent(): boolean {
  return !disarmed;
}
