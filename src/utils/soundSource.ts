/**
 * WHICH sound the Sound node listens to — the pure, node-testable half.
 * `system` = `getDisplayMedia` (a shared tab, window or screen); `device` =
 * `getUserMedia` with an exact id (a microphone, or a loopback driver).
 * The choice is SESSION-only and never reaches `node.data.values`.
 * Reasoning: docs/dev/node-types.md → Sound.
 */

/** The sound source the Sound node is pointed at. */
export type SoundSourceRef =
  | { kind: 'system' }
  | { kind: 'device'; deviceId: string };

/** Share a tab / window / screen and listen to ITS audio. */
export const SYSTEM_SOUND_SOURCE: SoundSourceRef = { kind: 'system' };

/**
 * The system's DEFAULT audio input: a device with an EMPTY id, which is valid
 * (`startDeviceCapture` adds no `deviceId` constraint for it). Before the page
 * holds a media permission it is the only device a browser offers.
 */
export const DEFAULT_DEVICE_SOURCE: SoundSourceRef = { kind: 'device', deviceId: '' };

/**
 * A freshly placed node listens to the default input, i.e. the microphone:
 * files saved before the Audio Input fold meant that, and `system` needs a
 * share sheet and carries no audio on two of three browsers.
 */
export const DEFAULT_SOUND_SOURCE: SoundSourceRef = DEFAULT_DEVICE_SOURCE;

const SYSTEM_TOKEN = 'system';
const DEVICE_PREFIX = 'device:';

/**
 * Encode a source as a `<select>` option value.
 *
 * A device id is appended VERBATIM after the prefix rather than escaped: ids are
 * opaque UA-generated strings, and the decoder splits on the first prefix only,
 * so any content after it round-trips including a literal `device:`.
 */
export function encodeSoundSource(ref: SoundSourceRef): string {
  return ref.kind === 'system' ? SYSTEM_TOKEN : `${DEVICE_PREFIX}${ref.deviceId}`;
}

/**
 * Decode a `<select>` option value, or null if it is not one.
 *
 * Returns null — never a silent fallback to `system` — so the caller decides
 * what an unrecognised value means. Silently resolving junk to "share my screen"
 * is the one wrong answer available here.
 */
export function decodeSoundSource(value: string | null | undefined): SoundSourceRef | null {
  if (typeof value !== 'string') return null;
  if (value === SYSTEM_TOKEN) return SYSTEM_SOUND_SOURCE;
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
export function sameSoundSource(a: SoundSourceRef, b: SoundSourceRef): boolean {
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
export function soundSourceLabel(
  ref: SoundSourceRef,
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
export function selectableInputDevices<T extends { deviceId: string }>(
  devices: readonly T[],
): T[] {
  return devices.filter((d) => d.deviceId !== '');
}
