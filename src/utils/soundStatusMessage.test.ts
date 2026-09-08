import { describe, it, expect } from 'vitest';
import { soundStatusMessage } from './soundStatusMessage';
import { SYSTEM_SOUND_SOURCE, DEFAULT_DEVICE_SOURCE, type SoundSourceRef } from './soundSource';
import type { SoundStatus } from './soundSession';

/**
 * The Sound node's failure wording, shared by its arm light and the preview's
 * SoundControl — the only two click paths into `armSound`.
 *
 * This is the MERGE of two tables (2026-09-08): the Audio Input node was folded
 * into the Sound node, and its `system` source came with it. They were separate
 * because the two sources fail differently, and that is still true inside one
 * node — so the function takes a `source` and most cases branch on it. The
 * whole risk of the merge is that a branch collapses onto one vocabulary and
 * starts telling half the users to fix the wrong thing, which is exactly what
 * happened once before (the desktop build told people to click a permission in
 * an address bar the desktop shell does not have).
 *
 * Nothing here had a test until now. It is asserted in English because `t()`
 * returns its key verbatim for any language but `lv`, so the key IS the
 * English string.
 */

const EN = 'en' as const;

/** A named input — a specific microphone or a loopback driver. */
const NAMED_DEVICE: SoundSourceRef = { kind: 'device', deviceId: 'abc123' };

/** Every status the union can hold, so a new one cannot slip through untested. */
const ALL: SoundStatus[] = [
  'off', 'starting', 'on',
  'insecure-context', 'unsupported', 'denied',
  'no-device', 'in-use', 'timeout', 'failed', 'no-audio-track',
];

describe('every status is answered', () => {
  it('returns a non-empty sentence for everything except `off`', () => {
    for (const source of [SYSTEM_SOUND_SOURCE, DEFAULT_DEVICE_SOURCE, NAMED_DEVICE]) {
      for (const status of ALL) {
        const msg = soundStatusMessage(status, source, EN);
        if (status === 'off') {
          // The caller owns the idle wording, which differs by surface.
          expect(msg, `${status}`).toBeNull();
        } else {
          expect(msg, `${status} / ${source.kind}`).toBeTruthy();
          expect(typeof msg).toBe('string');
        }
      }
    }
  });

  it('never leaks a raw status token into a sentence', () => {
    // A missed case falling through to a default that stringifies the status is
    // the way this fails without anyone noticing in review.
    for (const status of ALL) {
      const msg = soundStatusMessage(status, SYSTEM_SOUND_SOURCE, EN);
      if (msg) expect(msg, status).not.toContain(status);
    }
  });
});

describe('the two sources keep their own vocabulary', () => {
  it('says "listening" for a share and names the microphone for a device', () => {
    // The live/starting wording is what tells the user WHAT is being captured.
    // Collapsing these would have the node claim it is listening to a
    // microphone while a screen share is what is actually feeding it.
    expect(soundStatusMessage('on', SYSTEM_SOUND_SOURCE, EN)).not.toMatch(/[Mm]icrophone/);
    expect(soundStatusMessage('on', DEFAULT_DEVICE_SOURCE, EN)).toMatch(/[Mm]icrophone/);
    expect(soundStatusMessage('starting', SYSTEM_SOUND_SOURCE, EN)).toMatch(/share/i);
    expect(soundStatusMessage('starting', DEFAULT_DEVICE_SOURCE, EN)).toMatch(/permission/i);
  });

  it('distinguishes a cancelled SHARE from a blocked MICROPHONE', () => {
    // Both arrive as `denied`, and the fix is completely different: one is a
    // picker the user dismissed, the other a permission they have to go and
    // change.
    const share = soundStatusMessage('denied', SYSTEM_SOUND_SOURCE, EN)!;
    const device = soundStatusMessage('denied', DEFAULT_DEVICE_SOURCE, EN)!;
    expect(share).toMatch(/cancelled|blocked/i);
    expect(share).toMatch(/tab, window or screen/i);
    expect(device).toMatch(/^Microphone blocked\./);
    expect(share).not.toBe(device);
  });

  it('keeps the MICROPHONE wording for a loopback device, on purpose', () => {
    // A `device` may well be BlackHole or VB-Cable rather than a real mic, but
    // it is `getUserMedia` either way — so the permission the user has to find
    // really is the one their OS labels "Microphone". Naming the setting to
    // flip is the whole point of these sentences.
    expect(soundStatusMessage('denied', NAMED_DEVICE, EN)).toMatch(/^Microphone blocked\./);
  });
});

describe('no-audio-track — the likeliest first run', () => {
  const msg = soundStatusMessage('no-audio-track', SYSTEM_SOUND_SOURCE, EN)!;

  it('names BOTH causes, because the fix differs', () => {
    // A missed checkbox is retryable; a browser that ignores the audio
    // constraint is not. A sentence carrying only one of them sends half the
    // users in a circle.
    expect(msg).toMatch(/Share (tab|system) audio/i);
    expect(msg).toMatch(/Safari/);
    expect(msg).toMatch(/Firefox/);
    expect(msg).toMatch(/loopback/i);
  });

  it('does not blame the user or invite a pointless retry', () => {
    // The share SUCCEEDED and carried no audio, so "try again" would just
    // repeat it verbatim.
    expect(msg).not.toMatch(/try again/i);
  });

  it('is the same sentence whichever source asked', () => {
    // It is the `system` path's own outcome; a device capture cannot produce
    // it. Branching would only create a second wording nothing can reach.
    for (const source of [DEFAULT_DEVICE_SOURCE, NAMED_DEVICE]) {
      expect(soundStatusMessage('no-audio-track', source, EN)).toBe(msg);
    }
  });
});

describe('a NAMED device can go missing; the default input cannot', () => {
  it('tells a named source to choose another, and reports none for the default', () => {
    // `getUserMedia` really does report these differently — OverconstrainedError
    // on an exact deviceId vs NotFoundError with no constraint — so the two
    // sentences point at the two real causes rather than hedging one.
    expect(soundStatusMessage('no-device', NAMED_DEVICE, EN)).toMatch(/Choose another source/i);
    expect(soundStatusMessage('no-device', DEFAULT_DEVICE_SOURCE, EN)).toBe('No microphone found.');
  });

  it('does the same for a device already in use', () => {
    expect(soundStatusMessage('in-use', NAMED_DEVICE, EN)).toMatch(/That audio input/i);
    expect(soundStatusMessage('in-use', DEFAULT_DEVICE_SOURCE, EN)).toMatch(/The microphone/i);
  });

  it('treats the empty deviceId as the DEFAULT input, not as a named one', () => {
    // The empty id is the useful spelling of "whatever the OS considers the
    // default" and is the only device entry a pre-permission browser can offer
    // — so it must never take the "that input is gone" wording.
    expect(soundStatusMessage('no-device', { kind: 'device', deviceId: '' }, EN))
      .toBe(soundStatusMessage('no-device', DEFAULT_DEVICE_SOURCE, EN));
  });
});

describe('the two source-independent failures stay one sentence', () => {
  it('gives insecure-context and unsupported the same answer for every source', () => {
    // `getDisplayMedia` and `getUserMedia` alike need a secure context, and
    // neither exists in a browser that cannot capture audio — so the fix does
    // not depend on which source was asked for.
    for (const status of ['insecure-context', 'unsupported'] as const) {
      const via = soundStatusMessage(status, SYSTEM_SOUND_SOURCE, EN);
      expect(soundStatusMessage(status, DEFAULT_DEVICE_SOURCE, EN)).toBe(via);
      expect(soundStatusMessage(status, NAMED_DEVICE, EN)).toBe(via);
    }
  });

  it('names the LAN bench server in the insecure-context message', () => {
    // Plain HTTP is deliberate there (a self-signed cert would interstitial
    // anyway), so this is a real dead end users hit and cannot diagnose.
    expect(soundStatusMessage('insecure-context', DEFAULT_DEVICE_SOURCE, EN)).toMatch(/LAN bench/i);
  });
});
