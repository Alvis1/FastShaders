import { t } from '@/i18n';
import type { Language } from '@/i18n';
import type { SoundStatus } from './soundSession';
import type { SoundSourceRef } from './soundSource';

/**
 * The one wording for every Sound-node capture failure, shared by the node's
 * arm light and the preview's SoundControl — the two (and only two) click paths
 * into `armSound`. They previously carried byte-identical copies of this switch,
 * which is how the desktop build ended up telling users to fix a permission in
 * an address bar the desktop shell does not have.
 *
 * Messages name the cause AND what to do about it: a `getUserMedia` /
 * `getDisplayMedia` rejection is otherwise a bare DOMException nobody sees, and
 * a sound button that silently does nothing is indistinguishable from a bug.
 *
 * This is the merge of two tables — the Audio Input node's was folded in with
 * the node itself on 2026-09-08. They were separate because the two SOURCES
 * fail differently, and that is still true inside one node, so `source` is
 * taken and most cases branch on it. The two vocabularies that must survive:
 *
 *   - `no-audio-track`, the `system` path's own outcome and the single likeliest
 *     first run. The share SUCCEEDED and carried no audio, so it is not a
 *     failure the user caused and "try again" would just repeat it. It names
 *     both reasons because the fix differs: a missed checkbox is retryable, a
 *     browser that ignores the audio constraint (Safari, Firefox) is not.
 *   - `denied` on the `device` path, which still branches on `__FS_DESKTOP__`.
 *     In a browser the grant is per-origin and revocable from the URL bar; in
 *     the Tauri shell it is an OS-level decision (macOS System Settings →
 *     Privacy & Security → Microphone; Windows Settings → Privacy → Microphone,
 *     including the separate "let desktop apps access your microphone" switch),
 *     and the app cannot re-prompt once TCC has an answer on file.
 *
 * The `device` path keeps the MICROPHONE wording even though a device may be a
 * loopback driver: it is `getUserMedia` either way, so the permission the user
 * has to find really is the one their OS and browser label "Microphone" — the
 * whole point of these sentences is naming the setting to flip.
 *
 * Every string here already existed in one of the two tables, so the Latvian
 * overlay keeps translating them; a rewording is a new key and an English
 * fallback for LV users until `lv.json` catches up.
 */
export function soundStatusMessage(
  status: SoundStatus,
  source: SoundSourceRef,
  language: Language,
): string | null {
  const system = source.kind === 'system';
  // A NAMED device can go missing or be taken by another app; the default input
  // cannot go missing without there being no input at all. `getUserMedia` really
  // does report those as different rejections (OverconstrainedError on an exact
  // deviceId vs NotFoundError with no constraint), so the two sentences point at
  // the two real causes rather than hedging one.
  const namedDevice = source.kind === 'device' && source.deviceId !== '';
  switch (status) {
    case 'on':
      return system
        ? t('Listening — click to stop', language)
        : t('Microphone is live — click to stop', language);
    case 'starting':
      return system
        ? t('Waiting for you to choose what to share…', language)
        : t('Waiting for microphone permission…', language);
    case 'no-audio-track':
      return t(
        'That share carried no audio. Tick the “Share tab audio” / “Share system audio” box in the picker — and note that Safari and Firefox cannot share audio at all, so there you need a loopback input device instead.',
        language,
      );
    case 'denied':
      if (system) {
        return t('Sharing was cancelled or blocked. Click again and choose a tab, window or screen — with its audio box ticked.', language);
      }
      return __FS_DESKTOP__
        ? t('Microphone blocked. Allow FastShaders access in your system privacy settings, then click again.', language)
        : t('Microphone blocked. Allow it for this site in your browser’s address bar, then click again.', language);
    case 'insecure-context':
      // One sentence for both paths: `getDisplayMedia` and `getUserMedia` alike
      // need a secure context, and the fix is the same for either.
      return t('Audio capture needs a secure connection (https). It is unavailable over plain HTTP, including the LAN bench server.', language);
    case 'unsupported':
      return t('This browser cannot capture audio.', language);
    case 'no-device':
      return namedDevice
        ? t('That audio input is no longer available. Choose another source.', language)
        : t('No microphone found.', language);
    case 'in-use':
      return namedDevice
        ? t('That audio input is being used by another application.', language)
        : t('The microphone is being used by another application.', language);
    case 'timeout':
      return system
        ? t('The share picker timed out. Click to try again.', language)
        : t('The microphone request timed out. Click to try again.', language);
    case 'failed':
      return system
        ? t('Could not start audio capture. Click to try again.', language)
        : t('Could not start the microphone. Click to try again.', language);
    default:
      // 'off' — the caller owns the idle wording, which differs by surface.
      return null;
  }
}
