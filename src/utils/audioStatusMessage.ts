import { t } from '@/i18n';
import type { Language } from '@/i18n';
import type { AudioStatus } from './audioSession';
import type { AudioSourceRef } from './audioSource';

/**
 * The one wording for every Audio Input failure — the sibling of
 * `micStatusMessage`, kept separate because the two nodes fail differently
 * enough that a shared switch would have to hedge every sentence.
 *
 * Messages name the cause AND what to do about it. That matters more here than
 * for the microphone, because the most COMMON outcome on this path is not an
 * error at all: the user shares a tab, everything succeeds, and no sound
 * arrives because the picker's audio checkbox was left unticked — or because
 * their browser does not implement it. A control that silently does nothing in
 * that case is indistinguishable from a bug, and it is the single likeliest
 * first-run experience.
 *
 * `source` is taken so the wording can name what actually happened: "blocked"
 * means a screen-share prompt was refused for `system` and a microphone
 * permission for `device`, and those are fixed in different places.
 */
export function audioStatusMessage(
  status: AudioStatus,
  source: AudioSourceRef,
  language: Language,
): string | null {
  const system = source.kind === 'system';
  switch (status) {
    case 'on':
      return t('Listening — click to stop', language);
    case 'starting':
      return system
        ? t('Waiting for you to choose what to share…', language)
        : t('Waiting for permission to use this input…', language);
    case 'no-audio-track':
      // The important one. The share SUCCEEDED and carried no audio, so this is
      // not a failure the user caused and telling them to "try again" would
      // just repeat it. Name both reasons, because the fix differs: a missed
      // checkbox is retryable, a browser that ignores audio is not.
      return t(
        'That share carried no audio. Tick the “Share tab audio” / “Share system audio” box in the picker — and note that Safari and Firefox cannot share audio at all, so there you need a loopback input device instead.',
        language,
      );
    case 'denied':
      if (system) {
        return t('Sharing was cancelled or blocked. Click again and choose a tab, window or screen — with its audio box ticked.', language);
      }
      return __FS_DESKTOP__
        ? t('Audio input blocked. Allow FastShaders access in your system privacy settings, then click again.', language)
        : t('Audio input blocked. Allow it for this site in your browser’s address bar, then click again.', language);
    case 'insecure-context':
      return t('Audio capture needs a secure connection (https). It is unavailable over plain HTTP, including the LAN bench server.', language);
    case 'unsupported':
      return t('This browser cannot capture audio.', language);
    case 'no-device':
      return t('That audio input is no longer available. Choose another source.', language);
    case 'in-use':
      return t('That audio input is being used by another application.', language);
    case 'timeout':
      return system
        ? t('The share picker timed out. Click to try again.', language)
        : t('The audio request timed out. Click to try again.', language);
    case 'failed':
      return t('Could not start audio capture. Click to try again.', language);
    default:
      // 'off' — the caller owns the idle wording, which differs by surface.
      return null;
  }
}
