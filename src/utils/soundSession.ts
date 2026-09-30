/**
 * The live SOUND SESSION: module state for the Sound node's ONE capture. Not in
 * the store, so it never rides undo, the autosave or the project embed.
 * `armSound` is the only path to capture and every caller must be a real user
 * click — never an effect, a message handler or a store subscription.
 * Nothing persists. Reasoning: docs/dev/node-types.md → Sound.
 */

import { startDeviceCapture } from './deviceCapture';
import { startSystemAudioCapture, systemAudioSupported } from './systemAudioCapture';
import type { AudioCapture, AudioStartError } from './audioCaptureCore';
import { SOUND_LEVELS_ZERO, type SoundLevels } from './soundAnalysis';
import {
  DEFAULT_SOUND_SOURCE,
  sameSoundSource,
  type SoundSourceRef,
} from './soundSource';
import type { SoundSettings } from './soundSettings';

/** Is the `system` source worth OFFERING in this build? The UI asks the session, never the capture module. */
export { systemAudioSupported } from './systemAudioCapture';

export type SoundStatus = 'off' | 'starting' | 'on' | AudioStartError;

let capture: AudioCapture | null = null;
let status: SoundStatus = 'off';

/**
 * Monotonic arm generation. The permission prompt and the share picker are both
 * non-modal and can sit open for up to 30s, so a user can leave two starts in
 * flight (arm → cancel → arm). A stale continuation compares generations,
 * recognises itself, and stops the capture it was handed — without this the
 * loser's MediaStream is never stopped and the OS recording indicator stays lit
 * for the life of the tab.
 */
let armGen = 0;
/** WHICH sound to listen to — SESSION-only, never stored on the node. */
let source: SoundSourceRef = DEFAULT_SOUND_SOURCE;
/** The settings the live capture was started with, for a source re-arm. */
let lastSettings: SoundSettings | null = null;
/** A start is awaiting the prompt — a second one would strand the first. */
let pending = false;
/** "The user does not want capture right now", written SYNCHRONOUSLY. */
let disarmed = true;

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setStatus(next: SoundStatus): void {
  if (next === status) return;
  status = next;
  emit();
}

/** useSyncExternalStore subscribe. */
export function subscribeSound(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** useSyncExternalStore snapshot — a string, so it compares by value. */
export function getSoundStatus(): SoundStatus {
  return status;
}

/**
 * Can this build reach ANY sound? Either capture path counts. A "no" is really
 * reachable: `navigator.mediaDevices` is undefined outside a secure context
 * (the LAN bench server is plain HTTP).
 */
export function soundSupported(): boolean {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return systemAudioSupported() || !!media?.getUserMedia;
}

/**
 * Available audio input devices.
 *
 * NB `label` is an EMPTY STRING until the page holds a microphone permission —
 * that is the spec's anti-fingerprinting rule, not a bug. So before the first
 * successful arm the user sees the right NUMBER of devices with no names; the
 * picker says so rather than rendering blank rows.
 */
export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

/** The sound the session is pointed at. */
export function getSoundSource(): SoundSourceRef {
  return source;
}

/**
 * Choose the source. SESSION-only, never stored on the node: a `deviceId` is
 * origin-scoped and meaningless in a shared `.fastshader`.
 *
 * It REDIRECTS an already-running capture but never starts one: the picker must
 * not become a second way to open the microphone.
 */
export function setSoundSource(next: SoundSourceRef): void {
  if (sameSoundSource(next, source)) return;
  source = next;
  emit();
  if (capture && lastSettings) {
    const settings = lastSettings;
    disarmSound();
    armSound(settings);
  }
}

/**
 * Ask for the chosen source. MUST be called from a user gesture (see header).
 * Safe to call twice — a redundant call is a no-op rather than a second prompt.
 */
export function armSound(settings: SoundSettings): void {
  if (capture || pending) return;
  disarmed = false;
  pending = true;
  const gen = ++armGen;
  lastSettings = settings;
  setStatus('starting');

  // Read `source` ONCE, here: it is module state and the user can change it
  // from the dropdown while the prompt is still open, and the continuation
  // below must belong to the capture that was actually requested.
  const started =
    source.kind === 'system'
      ? startSystemAudioCapture(settings, { onEnded: () => endedFrom(gen) })
      : startDeviceCapture(settings, source.deviceId, { onEnded: () => endedFrom(gen) });

  void started.then((res) => {
    if (gen === armGen) pending = false;
    if (!res.ok) {
      // Only the CURRENT request may report a failure; a superseded one would
      // overwrite a live 'on' with a stale error.
      if (gen === armGen) setStatus(res.error);
      return;
    }
    // Superseded, declined, or beaten to the slot while the prompt was open.
    // The tracks are already live here, so stop them rather than leak them.
    if (disarmed || gen !== armGen || capture) {
      res.capture.stop();
      return;
    }
    // Settings tuned WHILE the prompt was open never reached the analyser,
    // which was built from the snapshot taken before the await.
    res.capture.applySettings(settings);
    capture = res.capture;
    setStatus('on');
  });
}

/**
 * The source vanished on its own (device unplugged, permission revoked,
 * Chrome's "Stop sharing"). Without this the session sits at `on` forever while
 * every band decays to zero, and clicking the arm light again is a no-op.
 * Generation-checked: an `ended` from a capture the user already replaced must
 * not tear down its successor.
 */
function endedFrom(gen: number): void {
  if (gen !== armGen) return;
  disarmSound();
}

/** Stop capture and release the source. Idempotent. */
export function disarmSound(): void {
  disarmed = true;
  // Invalidate anything in flight so a prompt answered after this click can't
  // install a capture the user already declined.
  armGen++;
  pending = false;
  capture?.stop();
  capture = null;
  setStatus('off');
}

/** Read the current levels, or the rest state when nothing is capturing. */
export function readSoundLevels(): SoundLevels {
  return capture ? capture.readLevels() : { ...SOUND_LEVELS_ZERO };
}

export function applySoundSettings(settings: SoundSettings): void {
  capture?.applySettings(settings);
}

/** True while the user intends capture — including the pending-prompt window. */
export function soundArmIntent(): boolean {
  return !disarmed;
}
