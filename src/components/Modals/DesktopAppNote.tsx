import type { ReactElement } from 'react';
import { t, type Language } from '@/i18n';
import { isEvalMode } from '@/eval/evalMode';
import {
  desktopDownloadPlatform,
  downloadsFor,
  MAC_FIRST_LAUNCH_ROUTE_VERIFIED,
  releaseDownloadUrl,
} from '@/utils/desktopDownloads';
import './LimitModal.css';

/**
 * The web build's pointer to the desktop app (research doc §4.2), mounted by
 * LimitModal and the N1 export dialog only on a limit the desktop room lifts
 * (utils/desktopAppNoteRules.ts decides). It renders nothing inside the desktop
 * app, nothing in a study session (what the editor offers is part of the
 * condition every participant must meet identically), and nothing on a
 * platform with no build — an iPad, a phone, a headset or Linux would be sent
 * to a download it cannot run.
 *
 * The links are plain anchors to the same release assets as the toolbar's
 * "Download app" dropdown (utils/desktopDownloads.ts is the one list). The
 * macOS first-launch sentence stays off until MAC_FIRST_LAUNCH_ROUTE_VERIFIED.
 */
export function DesktopAppNote({ language }: { language: Language }): ReactElement | null {
  if (__FS_DESKTOP__ || isEvalMode()) return null;
  const platform =
    typeof navigator === 'undefined'
      ? null
      : desktopDownloadPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints || 0);
  if (!platform) return null;
  const route =
    platform === 'windows'
      ? t('Download the installer or the portable .zip; if a SmartScreen warning appears, choose “More info”, then “Run anyway”.', language)
      : MAC_FIRST_LAUNCH_ROUTE_VERIFIED
        ? t('Download the .dmg; on first launch choose “Open Anyway” in System Settings → Privacy & Security.', language)
        : null;
  return (
    <div className="limit-modal__desktop">
      <span>{t('The FastShaders desktop app opens much larger files.', language)}</span>
      {route && (
        <>
          {' '}
          <span>{route}</span>
        </>
      )}
      <span className="limit-modal__desktop-links">
        {downloadsFor(platform).map((d) => (
          <a key={d.key} href={releaseDownloadUrl(d.file)}>
            {t(d.detail, language)}
          </a>
        ))}
      </span>
    </div>
  );
}
