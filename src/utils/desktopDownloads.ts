/**
 * The desktop builds' release assets — the ONE list, read by the toolbar's
 * "Download app" dropdown and by the web build's desktop-app note
 * (components/Modals/DesktopAppNote.tsx).
 *
 * `/releases/latest/download/<name>` is a permanent GitHub redirect to the
 * newest release, so the app always offers the current build with no
 * per-release code change — but only because .github/workflows/release.yml
 * uploads the assets under these FIXED names. `desktopDownloads.test.ts` reads
 * the workflow and fails when the two lists drift.
 *
 * Plain anchors everywhere: GitHub serves release assets with
 * `Content-Disposition: attachment`, so the page stays where it is, and CSP
 * does not gate navigation.
 *
 * A ZERO-IMPORT LEAF: it reads nothing but its arguments, so the node tests
 * and any bare-node probe can load it without the app's module graph.
 */

export const RELEASE_DOWNLOAD_BASE = 'https://github.com/Alvis1/FastShaders/releases/latest/download';

export type DesktopPlatform = 'mac' | 'windows';

export interface DesktopDownload {
  readonly key: 'win' | 'win-portable' | 'mac';
  readonly platform: DesktopPlatform;
  readonly os: 'Windows' | 'macOS';
  /** The English `t()` key (lv.json carries its Latvian twin). */
  readonly detail: string;
  /** The release asset name, exactly as release.yml uploads it. */
  readonly file: string;
}

export const DESKTOP_DOWNLOADS: readonly DesktopDownload[] = [
  { key: 'win', platform: 'windows', os: 'Windows', detail: 'installer (.exe)', file: 'FastShaders-Windows-Setup.exe' },
  { key: 'win-portable', platform: 'windows', os: 'Windows', detail: 'portable (.zip, no install)', file: 'FastShaders-Windows-Portable.zip' },
  { key: 'mac', platform: 'mac', os: 'macOS', detail: 'disk image (.dmg)', file: 'FastShaders-macOS.dmg' },
];

export const releaseDownloadUrl = (file: string): string => `${RELEASE_DOWNLOAD_BASE}/${file}`;

export const downloadsFor = (p: DesktopPlatform): readonly DesktopDownload[] =>
  DESKTOP_DOWNLOADS.filter((d) => d.platform === p);

/**
 * Which build this device can run, or null when there is none for it (iPad,
 * iPhone, Android, Quest, Linux, ChromeOS). iPadOS in desktop mode reports
 * `MacIntel` with touch points — the same rule
 * `feedbackReport.platformWebGL2Reason` applies — and must not be offered a
 * .dmg it cannot open.
 */
export function desktopDownloadPlatform(
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
): DesktopPlatform | null {
  if (/iPad|iPhone|iPod/.test(userAgent)) return null;
  if (platform === 'MacIntel' && maxTouchPoints > 1) return null;
  if (/Android|OculusBrowser|Quest|CrOS|Linux|X11/.test(userAgent) && !/Windows NT/.test(userAgent)) return null;
  if (/Windows NT/.test(userAgent) || platform.startsWith('Win')) return 'windows';
  if (/Macintosh|Mac OS X/.test(userAgent) || platform === 'MacIntel') return 'mac';
  return null;
}

/**
 * Flip only after the owner has confirmed, on a QUARANTINED Apple Silicon
 * download, that System Settings → Privacy & Security offers "Open Anyway"
 * (research doc §4.2). Until then macOS gets the generic line and the .dmg
 * link without the first-launch sentence. Typed `boolean`, not the literal
 * `false`, so both branches of the gate keep type-checking.
 */
export const MAC_FIRST_LAUNCH_ROUTE_VERIFIED: boolean = false;
