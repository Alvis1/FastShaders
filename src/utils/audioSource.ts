/**
 * WHICH sound the Audio Input node listens to — the pure half, so it is
 * node-testable (the vitest env has no jsdom, and everything that touches a
 * MediaStream is untestable by construction).
 *
 * Two kinds, because no single browser API covers what users mean by "the audio
 * playing on this machine":
 *
 *   - `system` — `getDisplayMedia`. The user picks a tab, window or screen in
 *     the browser's own share sheet and ticks its audio box. This is the one
 *     that hears a YouTube tab or a media player with nothing installed, and it
 *     is Chromium-only (Safari and Firefox implement the API and ignore audio).
 *   - `device` — `getUserMedia` with an exact `deviceId`. Normally a microphone,
 *     but a LOOPBACK driver (BlackHole, VB-Cable, VoiceMeeter) appears in the
 *     very same list, which is how this path hears system sound on the browsers
 *     and on the macOS desktop shell where `getDisplayMedia` carries none.
 *
 * The choice is SESSION-only and never reaches `node.data.values`. A `deviceId`
 * is origin-scoped and rotates when site data is cleared, so it is meaningless
 * in a shared `.fastshader`; storing one would ride the autosave, undo history
 * and project embed while adding a fingerprinting surface for nothing. That is
 * the rule `micSession.setMicDeviceId` already states, and splitting it — keeping
 * `system` because it happens to be portable while dropping device ids — would
 * leave the node half-remembered, which is harder to explain than either
 * consistent answer.
 */

/** The sound source an Audio Input node is pointed at. */
export type AudioSourceRef =
  | { kind: 'system' }
  | { kind: 'device'; deviceId: string };

/** Share a tab / window / screen and listen to ITS audio. */
export const SYSTEM_AUDIO_SOURCE: AudioSourceRef = { kind: 'system' };

/**
 * The system's DEFAULT audio input, expressed as a device with an empty id.
 *
 * An empty `deviceId` is not a hole in the model, it is the useful spelling of
 * "whatever the OS considers the default": `startMicCapture` already treats a
 * falsy id as "add no `deviceId` constraint", which is exactly that request.
 *
 * It also has to exist for a reason the spec forces on us. Before the page holds
 * ANY media permission, `enumerateDevices()` does not merely blank the labels —
 * Chrome returns a single placeholder entry per kind whose `deviceId` is the
 * empty string too. So on first run there is no real id to select, and without
 * this entry the device half of the picker is unusable until the user has
 * granted a permission they can only reach by... using the picker.
 */
export const DEFAULT_DEVICE_SOURCE: AudioSourceRef = { kind: 'device', deviceId: '' };

/**
 * The default for a freshly placed node.
 *
 * `system` rather than a device, because that is what the node is FOR — hearing
 * what is already playing. Where the browser cannot deliver it the picker says
 * so and the device list is right there underneath, which is a better first run
 * than silently opening a microphone the user never asked for.
 */
export const DEFAULT_AUDIO_SOURCE: AudioSourceRef = SYSTEM_AUDIO_SOURCE;

const SYSTEM_TOKEN = 'system';
const DEVICE_PREFIX = 'device:';

/**
 * Encode a source as a `<select>` option value.
 *
 * A device id is appended VERBATIM after the prefix rather than escaped: ids are
 * opaque UA-generated strings, and the decoder splits on the first prefix only,
 * so any content after it round-trips including a literal `device:`.
 */
export function encodeAudioSource(ref: AudioSourceRef): string {
  return ref.kind === 'system' ? SYSTEM_TOKEN : `${DEVICE_PREFIX}${ref.deviceId}`;
}

/**
 * Decode a `<select>` option value, or null if it is not one.
 *
 * Returns null — never a silent fallback to `system` — so the caller decides
 * what an unrecognised value means. Silently resolving junk to "share my screen"
 * is the one wrong answer available here.
 */
export function decodeAudioSource(value: string | null | undefined): AudioSourceRef | null {
  if (typeof value !== 'string') return null;
  if (value === SYSTEM_TOKEN) return SYSTEM_AUDIO_SOURCE;
  if (value.startsWith(DEVICE_PREFIX)) {
    // An EMPTY id is valid and means the system default input — see
    // DEFAULT_DEVICE_SOURCE. Rejecting it here made the only device entry a
    // pre-permission browser can offer unselectable, so the picker silently
    // snapped back to `system` on first use.
    return { kind: 'device', deviceId: value.slice(DEVICE_PREFIX.length) };
  }
  return null;
}

/** Do two source refs point at the same sound? */
export function sameAudioSource(a: AudioSourceRef, b: AudioSourceRef): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'system' || a.deviceId === (b as { deviceId: string }).deviceId;
}

/**
 * The label to show for a source, given the devices currently enumerated.
 *
 * Device LABELS are empty strings until the page holds a media permission — the
 * spec's anti-fingerprinting rule, not a bug — so this falls back to a positional
 * name. It deliberately does NOT fall back to the raw `deviceId`: that is a long
 * opaque hash which tells the user nothing and looks like a rendering fault.
 */
export function audioSourceLabel(
  ref: AudioSourceRef,
  devices: readonly { deviceId: string; label: string }[],
  strings: { system: string; device: string; missing: string; defaultDevice: string },
): string {
  if (ref.kind === 'system') return strings.system;
  if (ref.deviceId === '') return strings.defaultDevice;
  const i = devices.findIndex((d) => d.deviceId === ref.deviceId);
  if (i < 0) return strings.missing;
  return devices[i].label || `${strings.device} ${i + 1}`;
}

/**
 * The devices worth OFFERING as their own entries.
 *
 * Drops the empty-id placeholder a pre-permission `enumerateDevices()` returns:
 * it carries no name and no id, so it would render as an unnamed duplicate of
 * the "Default input" entry that is already in the list — two rows that do the
 * same thing, one of which looks broken.
 */
export function selectableAudioDevices<T extends { deviceId: string }>(
  devices: readonly T[],
): T[] {
  return devices.filter((d) => d.deviceId !== '');
}
