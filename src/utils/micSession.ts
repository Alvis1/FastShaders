/**
 * The live microphone SESSION — module-level state shared by every surface that
 * can arm, stop, or read the mic.
 *
 * Why a module singleton rather than the zustand store: there is exactly one
 * microphone, and its state must never ride undo history, the `fs:graph`
 * autosave, saved groups, or the FASTSHADERS_PROJECT_V1 embed. Keeping it out
 * of the store makes that structural instead of a rule someone has to remember
 * — the same standing `previewMesh` has, one step further. It also means the
 * node button (rendered inside React Flow) and the preview's own control are
 * looking at one truth rather than two copies that can disagree.
 *
 * SECURITY INVARIANT: `armMic` is the only path to capture, and every caller
 * must be a real user click. There are exactly two — the mic button on the Mic
 * node and the preview's MicControl. Never call it from an effect, a message
 * handler, a store subscription, or anything a loaded `.fastshader` can reach:
 * in this app a node's presence in a graph IS its execution (fs:graph restores
 * with no gesture), so the click is the whole consent model.
 *
 * Nothing here persists. No consent key, deliberately — see micCapture.ts.
 */

import { startMicCapture, type MicCapture, type MicStartError } from './micCapture';
import { MIC_LEVELS_ZERO, type MicLevels } from './micAnalysis';
import type { MicSettings } from './micNode';

export type MicStatus = 'off' | 'starting' | 'on' | MicStartError;

let capture: MicCapture | null = null;
let status: MicStatus = 'off';

/**
 * Monotonic arm generation. The permission prompt is non-modal and can sit open
 * for up to 30s, so a user can leave two `startMicCapture` calls in flight
 * (mic → cancel → mic). A stale continuation compares generations, recognises
 * itself, and stops the capture it was handed — without this the loser's
 * MediaStream is never stopped and the OS recording indicator stays lit for the
 * life of the tab.
 */
let armGen = 0;
/** Chosen input device — SESSION-only, never stored on the node. */
let deviceId: string | null = null;
/** The settings the live capture was started with, for a device re-arm. */
let lastSettings: MicSettings | null = null;
/** A start is awaiting the prompt — a second one would strand the first. */
let pending = false;
/** "The user does not want capture right now", written SYNCHRONOUSLY. */
let disarmed = true;

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setStatus(next: MicStatus): void {
  if (next === status) return;
  status = next;
  emit();
}

/** useSyncExternalStore subscribe. */
export function subscribeMic(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** useSyncExternalStore snapshot — a string, so it compares by value. */
export function getMicStatus(): MicStatus {
  return status;
}

export function isMicCapturing(): boolean {
  return capture !== null;
}

/**
 * Can this build reach a microphone at all?
 *
 * `navigator.mediaDevices` is undefined outside a secure context, which is
 * exactly the case for the LAN bench server (plain HTTP on 0.0.0.0:5199) — so
 * this is a real, reachable "no" in this app, not a theoretical one.
 */
export function micSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Available audio input devices.
 *
 * NB `label` is an EMPTY STRING until the page holds a microphone permission —
 * that is the spec's anti-fingerprinting rule, not a bug. So before the first
 * successful arm the user sees the right NUMBER of devices with no names; the
 * picker says so rather than rendering blank rows.
 */
export async function listMicDevices(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

export function getMicDeviceId(): string | null {
  return deviceId;
}

/**
 * Choose the input device. SESSION-only and deliberately NOT stored on the node:
 * a `deviceId` is origin-scoped and rotates when site data is cleared, so it is
 * meaningless in a shared `.fastshader` — and putting one in the graph would ride
 * the autosave, undo history and project embed while adding a fingerprinting
 * surface for nothing.
 *
 * It REDIRECTS an already-running capture but never starts one. A dropdown must
 * not become a second way to open the microphone; arming stays the button's job.
 */
export function setMicDeviceId(id: string | null): void {
  if (id === deviceId) return;
  deviceId = id;
  emit();
  if (capture && lastSettings) {
    const settings = lastSettings;
    disarmMic();
    armMic(settings);
  }
}

/**
 * Ask for the microphone. MUST be called from a user gesture (see the header).
 * Safe to call twice — a redundant call is a no-op rather than a second prompt.
 */
export function armMic(settings: MicSettings): void {
  if (capture || pending) return;
  disarmed = false;
  pending = true;
  const gen = ++armGen;
  lastSettings = settings;
  setStatus('starting');
  void startMicCapture(settings, deviceId).then((res) => {
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

/** Stop capture and release the hardware. Idempotent. */
export function disarmMic(): void {
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
export function readMicLevels(): MicLevels {
  return capture ? capture.readLevels() : { ...MIC_LEVELS_ZERO };
}

export function applyMicSettings(settings: MicSettings): void {
  capture?.applySettings(settings);
}

/** True while the user intends capture — including the pending-prompt window. */
export function micArmIntent(): boolean {
  return !disarmed;
}
