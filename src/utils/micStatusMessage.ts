import { t } from '@/i18n';
import type { Language } from '@/i18n';
import type { MicStatus } from '@/components/Preview/useMicPump';

/**
 * The one wording for every microphone failure, shared by the node's arm light
 * and the preview's MicControl — the two (and only two) click paths into
 * `armMic`. They previously carried byte-identical copies of this switch, which
 * is how the desktop build ended up telling users to fix a permission in an
 * address bar the desktop shell does not have.
 *
 * Messages name the cause AND what to do about it: a `getUserMedia` rejection
 * is otherwise a bare DOMException nobody sees, and a mic button that silently
 * does nothing is indistinguishable from a bug.
 *
 * `denied` is the one message that has to differ per build. In a browser the
 * grant is per-origin and revocable from the URL bar; in the Tauri shell it is
 * an OS-level decision (macOS System Settings → Privacy & Security →
 * Microphone; Windows Settings → Privacy → Microphone, including the separate
 * "let desktop apps access your microphone" switch), and the app cannot
 * re-prompt once TCC has an answer on file.
 */
export function micStatusMessage(status: MicStatus, language: Language): string | null {
  switch (status) {
    case 'on':
      return t('Microphone is live — click to stop', language);
    case 'starting':
      return t('Waiting for microphone permission…', language);
    case 'denied':
      return __FS_DESKTOP__
        ? t('Microphone blocked. Allow FastShaders access in your system privacy settings, then click again.', language)
        : t('Microphone blocked. Allow it for this site in your browser’s address bar, then click again.', language);
    case 'insecure-context':
      return t('Microphone needs a secure connection (https). It is unavailable over plain HTTP, including the LAN bench server.', language);
    case 'unsupported':
      return t('This browser cannot capture audio.', language);
    case 'no-device':
      return t('No microphone found.', language);
    case 'in-use':
      return t('The microphone is being used by another application.', language);
    case 'timeout':
      return t('The microphone request timed out. Click to try again.', language);
    case 'failed':
      return t('Could not start the microphone. Click to try again.', language);
    default:
      // 'off' — the caller owns the idle wording, which differs by surface.
      return null;
  }
}
