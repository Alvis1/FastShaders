/**
 * The live SOUND SESSION — module-level state shared by every surface that can
 * arm, stop, or read the Sound node's capture.
 *
 * NAMING: the node is called "Sound" and hears either a microphone/input device
 * or the machine's own output, but every identifier here still says `mic`, as
 * does the registry type (`soundNode`) and the emitted uniform base (`mic1_bass`).
 * Those two are PERSISTED CONTRACTS — the registry type is the key inside every
 * saved `.fastshader` and the base is the name inside every exported module — so
 * renaming them would orphan existing work for a cosmetic gain. The module names
 * follow them rather than drifting from them (the same call `codeEditorTheme`
 * documents: a store field keeping its historical name once its meaning grew).
 *
 * Why a module singleton rather than the zustand store: there is exactly one
 * capture, and its state must never ride undo history, the `fs:graph` autosave,
 * saved groups, or the FASTSHADERS_PROJECT_V1 embed. Keeping it out of the store
 * makes that structural instead of a rule someone has to remember — the same
 * standing `previewMesh` has, one step further. It also means the node's own
 * button and the preview's control look at one truth rather than two copies that
 * can disagree.
 *
 * This module is the merge of what used to be two near-identical sessions, one
 * per audio node. The Audio Input node was folded into the Sound node on
 * 2026-09-08, and its source model came with it: a microphone is simply a
 * `device` source, so one session covers both. There is only ever ONE analyser,
 * which is also why the Sound node is a singleton on the canvas — see
 * `components/NodeEditor/singletonNodes.ts`.
 *
 * SECURITY INVARIANT: `armSound` is the only path to capture, and every caller
 * must be a real user click. There are exactly two — the arm light on the Sound
 * node and the preview's SoundControl. Never call it from an effect, a message
 * handler, a store subscription, or anything a loaded `.fastshader` can reach:
 * in this app a node's presence in a graph IS its execution (fs:graph restores
 * with no gesture), so the click is the whole consent model. Choosing a SOURCE
 * is deliberately not such a path — see `setSoundSource`.
 *
 * Nothing here persists. No consent key, deliberately — see micCapture.ts.
 */

import { startDeviceCapture, type DeviceCapture, type DeviceStartError } from './deviceCapture';
import { startSystemAudioCapture, systemAudioSupported } from './systemAudioCapture';
import { SOUND_LEVELS_ZERO, type SoundLevels } from './soundAnalysis';
import {
  DEFAULT_SOUND_SOURCE,
  sameSoundSource,
  type SoundSourceRef,
} from './soundSource';
import type { SoundSettings } from './soundSettings';

export type SoundStatus = 'off' | 'starting' | 'on' | DeviceStartError;

let capture: DeviceCapture | null = null;
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
 * Can this build reach ANY sound at all?
 *
 * Either capture path counts, because either one satisfies the node: a build
 * with no `getUserMedia` can still share a tab's audio, and a build where
 * `getDisplayMedia` carries no audio track can still open an input device.
 *
 * `navigator.mediaDevices` is undefined outside a secure context, which is
 * exactly the case for the LAN bench server (plain HTTP on 0.0.0.0:5199) — so
 * this is a real, reachable "no" in this app, not a theoretical one.
 */
export function soundSupported(): boolean {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return systemAudioSupported() || !!media?.getUserMedia;
}

/** Is the `system` source worth OFFERING in this build? */
export function systemAudioAvailable(): boolean {
  return systemAudioSupported();
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
 * Choose the source. SESSION-only and deliberately NOT stored on the node: a
 * `deviceId` is origin-scoped and rotates when site data is cleared, so it is
 * meaningless in a shared `.fastshader` — and putting one in the graph would
 * ride the autosave, undo history and project embed while adding a
 * fingerprinting surface for nothing. See `audioSource.ts` for why the portable
 * half (`system`) is not split out and kept either.
 *
 * It REDIRECTS an already-running capture but never starts one. A dropdown must
 * not become a second way to open the microphone; arming stays the button's
 * job. That is what makes it safe to put the picker directly on the node face,
 * where it is one stray click away.
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
 * The source vanished on its own — a USB or Bluetooth device unplugged, the
 * permission revoked from site settings mid-session, the OS reassigning the
 * default input, or Chrome's own "Stop sharing" button.
 *
 * Without this the session sits at `status: 'on'` forever: the node's arm light
 * keeps blinking red while nothing is being captured, the four uniforms decay
 * silently to zero as the analyser reads a source that no longer feeds it, the
 * AudioContext is never closed, and `armSound`'s `if (capture || pending)` guard
 * makes clicking the light again a no-op — the user has to disarm first, with
 * nothing on screen to say so.
 *
 * Generation-checked like every other continuation here: this callback outlives
 * the capture that registered it, so an `ended` arriving from a capture the user
 * has already replaced (device → system → device) must not tear down its
 * successor.
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
