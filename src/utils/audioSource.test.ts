import { describe, it, expect } from 'vitest';
import {
  SYSTEM_AUDIO_SOURCE,
  DEFAULT_AUDIO_SOURCE,
  DEFAULT_DEVICE_SOURCE,
  selectableAudioDevices,
  encodeAudioSource,
  decodeAudioSource,
  sameAudioSource,
  audioSourceLabel,
  type AudioSourceRef,
} from './audioSource';

const STRINGS = {
  system: 'Tab / system audio',
  device: 'Input',
  missing: 'unavailable',
  defaultDevice: 'Default input',
};

describe('encode / decode round trip', () => {
  it('round-trips both kinds', () => {
    const refs: AudioSourceRef[] = [
      SYSTEM_AUDIO_SOURCE,
      { kind: 'device', deviceId: 'default' },
      { kind: 'device', deviceId: 'a'.repeat(64) },
    ];
    for (const ref of refs) {
      expect(decodeAudioSource(encodeAudioSource(ref))).toEqual(ref);
    }
  });

  it('round-trips a device id that itself looks like the encoding', () => {
    // Device ids are opaque UA strings, so nothing stops one containing the
    // prefix. The decoder splits on the FIRST prefix only, so the rest survives
    // verbatim — the alternative (splitting on every ':') would truncate it and
    // silently point the node at a different input.
    for (const id of ['device:nested', 'system', 'a:b:c', '::']) {
      const ref: AudioSourceRef = { kind: 'device', deviceId: id };
      expect(decodeAudioSource(encodeAudioSource(ref))).toEqual(ref);
    }
  });
});

describe('decode rejects rather than guessing', () => {
  it('returns null for anything it does not recognise', () => {
    for (const v of ['', 'nope', 'System', 'SYSTEM', 'devices:x', ' system']) {
      expect(decodeAudioSource(v), `for ${JSON.stringify(v)}`).toBeNull();
    }
  });

  it('returns null for non-strings', () => {
    for (const v of [null, undefined, 0 as unknown as string, {} as unknown as string]) {
      expect(decodeAudioSource(v as string | null | undefined)).toBeNull();
    }
  });

  /**
   * The one wrong answer available here. A junk value resolving to `system`
   * would mean an unrecognised stored/posted string could put a screen-share
   * picker in front of the user; falling back to a device would silently open
   * a microphone. Null lets the caller keep the source it already had.
   */
  it('never resolves junk to the system source', () => {
    for (const v of ['sys', 'systemaudio', 'system:', 'SYSTEM_AUDIO']) {
      expect(decodeAudioSource(v)).toBeNull();
    }
  });
});

describe('sameAudioSource', () => {
  it('compares kind and device id', () => {
    expect(sameAudioSource(SYSTEM_AUDIO_SOURCE, { kind: 'system' })).toBe(true);
    expect(sameAudioSource({ kind: 'device', deviceId: 'x' }, { kind: 'device', deviceId: 'x' })).toBe(true);
    expect(sameAudioSource({ kind: 'device', deviceId: 'x' }, { kind: 'device', deviceId: 'y' })).toBe(false);
    expect(sameAudioSource(SYSTEM_AUDIO_SOURCE, { kind: 'device', deviceId: 'x' })).toBe(false);
  });

  /**
   * `setAudioSource` early-returns on an equal source. If this ever reported
   * "different" for an identical ref, choosing the already-selected entry would
   * tear down and restart a live capture — which for the system source means a
   * fresh share picker in the user's face.
   */
  it('is reflexive for a fresh object with the same contents', () => {
    expect(sameAudioSource({ kind: 'device', deviceId: 'x' }, { kind: 'device', deviceId: 'x' })).toBe(true);
    expect(sameAudioSource({ ...SYSTEM_AUDIO_SOURCE }, { ...SYSTEM_AUDIO_SOURCE })).toBe(true);
  });
});

describe('audioSourceLabel', () => {
  const devices = [
    { deviceId: 'a', label: 'MacBook Pro Microphone' },
    { deviceId: 'b', label: '' },
  ];

  it('names the system source', () => {
    expect(audioSourceLabel(SYSTEM_AUDIO_SOURCE, devices, STRINGS)).toBe(STRINGS.system);
  });

  it('uses the real device label when the browser has granted one', () => {
    expect(audioSourceLabel({ kind: 'device', deviceId: 'a' }, devices, STRINGS))
      .toBe('MacBook Pro Microphone');
  });

  /**
   * Labels are '' until the page holds a media permission (the spec's
   * anti-fingerprinting rule). A positional name is the honest stand-in; the
   * raw deviceId is a long opaque hash that reads as a rendering fault.
   */
  it('falls back to a positional name, never the raw device id', () => {
    const out = audioSourceLabel({ kind: 'device', deviceId: 'b' }, devices, STRINGS);
    expect(out).toBe('Input 2');
    expect(out).not.toContain('b');
  });

  it('reports a device that is no longer enumerated', () => {
    expect(audioSourceLabel({ kind: 'device', deviceId: 'gone' }, devices, STRINGS))
      .toBe(STRINGS.missing);
  });
});

describe('the default INPUT device (empty id)', () => {
  /**
   * Before the page holds any media permission, enumerateDevices() returns a
   * placeholder whose deviceId is '' — so an empty id has to be a VALID source
   * meaning "the system default input", or the device half of the picker is
   * unusable until the user grants a permission they can only reach through it.
   * This was a real bug found by driving the app: selecting the only device
   * entry on offer silently reverted to the system source.
   */
  it('decodes an empty device id as the default input', () => {
    expect(decodeAudioSource('device:')).toEqual(DEFAULT_DEVICE_SOURCE);
    expect(decodeAudioSource(encodeAudioSource(DEFAULT_DEVICE_SOURCE))).toEqual(DEFAULT_DEVICE_SOURCE);
  });

  it('is a device source, not the system one', () => {
    expect(DEFAULT_DEVICE_SOURCE.kind).toBe('device');
    expect(sameAudioSource(DEFAULT_DEVICE_SOURCE, SYSTEM_AUDIO_SOURCE)).toBe(false);
  });

  it('labels it without falling through to "unavailable"', () => {
    // It matches no enumerated device by id, so the missing-device branch would
    // otherwise claim the default input does not exist.
    expect(audioSourceLabel(DEFAULT_DEVICE_SOURCE, [], STRINGS)).toBe(STRINGS.defaultDevice);
  });
});

describe('selectableAudioDevices', () => {
  it('drops the empty-id placeholder and keeps real devices', () => {
    expect(selectableAudioDevices([
      { deviceId: '' },
      { deviceId: 'a' },
      { deviceId: 'b' },
    ])).toEqual([{ deviceId: 'a' }, { deviceId: 'b' }]);
  });

  it('leaves a fully unpermissioned list empty rather than offering a nameless row', () => {
    expect(selectableAudioDevices([{ deviceId: '' }])).toEqual([]);
  });
});

describe('the default source', () => {
  /**
   * The node exists to react to sound that is ALREADY PLAYING, so defaulting to
   * a device would open a microphone nobody asked for on the first arm. Where
   * the browser cannot share audio the picker says so and the device list is
   * right underneath.
   */
  it('is the system source', () => {
    expect(DEFAULT_AUDIO_SOURCE).toEqual(SYSTEM_AUDIO_SOURCE);
  });
});
