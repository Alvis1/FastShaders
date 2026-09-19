/**
 * The web build's desktop-app note (DesktopAppNote.tsx) and the two decisions
 * behind it: which device has a build (utils/desktopDownloads.ts) and which
 * limits the desktop app lifts (utils/desktopAppNoteRules.ts).
 *
 * The note is rendered with react-dom/server under a stubbed `navigator` (the
 * vitest env is `node`; `__FS_DESKTOP__` is false there, i.e. the web profile).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import lv from '@/i18n/lv.json';
import type { Language } from '@/i18n';
import type { LimitNotice } from '@/store/useAppStore';
import { desktopDownloadPlatform, releaseDownloadUrl, type DesktopPlatform } from '@/utils/desktopDownloads';
import { desktopLiftsLimit, exportLiftedByDesktop } from '@/utils/desktopAppNoteRules';
import { DESKTOP_MAX_TOTAL_UNCOMPRESSED, MAX_TOTAL_UNCOMPRESSED } from '@/utils/zipReader';
import { DesktopAppNote } from './DesktopAppNote';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const MiB = 1024 * 1024;

const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const WIN_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** [label, userAgent, navigator.platform, maxTouchPoints, expected] */
const UA_TABLE: readonly [string, string, string, number, DesktopPlatform | null][] = [
  ['macOS Safari 17', MAC_SAFARI, 'MacIntel', 0, 'mac'],
  ['macOS Chrome', MAC_CHROME, 'MacIntel', 0, 'mac'],
  ['iPadOS desktop mode', MAC_SAFARI, 'MacIntel', 5, null],
  [
    'iPhone Safari',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    'iPhone',
    5,
    null,
  ],
  ['Windows 10 Edge', `${WIN_CHROME} Edg/128.0.0.0`, 'Win32', 0, 'windows'],
  ['Windows 10 Chrome', WIN_CHROME, 'Win32', 0, 'windows'],
  ['Windows touch laptop', WIN_CHROME, 'Win32', 10, 'windows'],
  [
    'Android Chrome',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
    'Linux armv81',
    5,
    null,
  ],
  [
    'Quest Browser',
    'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.0.0.0 SamsungBrowser/4.0 Chrome/128.0.0.0 VR Safari/537.36',
    'Linux x86_64',
    5,
    null,
  ],
  ['Ubuntu Firefox', 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0', 'Linux x86_64', 0, null],
  [
    'ChromeOS',
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Linux x86_64',
    0,
    null,
  ],
  ['empty', '', '', 0, null],
];

describe('desktopDownloadPlatform: which devices have a build', () => {
  for (const [label, ua, platform, touch, expected] of UA_TABLE) {
    it(`${label} → ${expected ?? 'none'}`, () => {
      expect(desktopDownloadPlatform(ua, platform, touch)).toBe(expected);
    });
  }
});

/** What the desktop app lifts, per kind: [ignore limits off, ignore limits on].
 *  The mapped type makes this fail `tsc` when LimitNotice gains a kind. */
const EXPECTED: { readonly [K in LimitNotice['kind']]: readonly [boolean, boolean] } = {
  'image-too-large': [true, false],
  'image-too-many-pixels': [false, false],
  'image-total-cap': [true, true],
  'image-revert-cap': [true, true],
  'image-resolution-cap': [true, true],
  'image-pick-cap': [true, true],
  'image-library-cap': [true, true],
  'image-device-downscaled': [false, false],
  'images-stripped': [true, true],
  'storage-quota': [true, true],
  'images-stripped-on-load': [false, false],
  'images-missing': [false, false],
  // A zip-limit notice with no numbers is not lifted (see the zip cases below).
  'zip-limit': [false, false],
  // The section caps are the same on both builds (decision 9).
  'output-sections-trimmed': [false, false],
  // The desktop autosave's own notices: raised only inside the desktop app.
  'autosave-file-failed': [false, false],
  'autosave-file-read-failed': [false, false],
};

describe('desktopLiftsLimit', () => {
  it("covers exactly limitNoticeCopy.test.ts's KINDS", () => {
    const src = read('./limitNoticeCopy.test.ts');
    const block = src.slice(src.indexOf('const KINDS = ['), src.indexOf('] as const satisfies'));
    const kinds = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(0);
    expect([...kinds].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const kind of Object.keys(EXPECTED) as LimitNotice['kind'][]) {
    it(`${kind}: ${EXPECTED[kind].join(' / ')}`, () => {
      const n: LimitNotice = { id: 'n', kind };
      expect(desktopLiftsLimit(n, false)).toBe(EXPECTED[kind][0]);
      expect(desktopLiftsLimit(n, true)).toBe(EXPECTED[kind][1]);
    });
  }

  const zip = (kind: NonNullable<LimitNotice['zipLimit']>['kind'], value: number): LimitNotice => ({
    id: 'z',
    kind: 'zip-limit',
    zipLimit: { kind, limit: MAX_TOTAL_UNCOMPRESSED, value },
  });

  it('zip-limit: a total-size refusal the desktop reader would accept is lifted', () => {
    expect(desktopLiftsLimit(zip('total-size', 100 * MiB), false)).toBe(true);
    expect(desktopLiftsLimit(zip('total-size', DESKTOP_MAX_TOTAL_UNCOMPRESSED), false)).toBe(true);
    // The Ignore-limits preference is about images; it does not change the zip rule.
    expect(desktopLiftsLimit(zip('total-size', 100 * MiB), true)).toBe(true);
  });

  it('zip-limit: over the desktop cap, a non-size cap, or junk numbers are not', () => {
    expect(desktopLiftsLimit(zip('total-size', 300 * MiB), false)).toBe(false);
    expect(desktopLiftsLimit(zip('total-size', DESKTOP_MAX_TOTAL_UNCOMPRESSED + 1), false)).toBe(false);
    expect(desktopLiftsLimit(zip('total-size', Number.NaN), false)).toBe(false);
    expect(desktopLiftsLimit(zip('entry-count', 600), false)).toBe(false);
    expect(desktopLiftsLimit(zip('name', 600), false)).toBe(false);
    expect(desktopLiftsLimit(zip('method', 12), false)).toBe(false);
  });

  it('a notice whose kind is not one (a hand-built object) is never lifted', () => {
    const junk = { id: 'j', kind: 'not-a-kind' } as unknown as LimitNotice;
    expect(desktopLiftsLimit(junk, false)).toBe(false);
  });
});

describe('exportLiftedByDesktop', () => {
  const row = (overSize: boolean, overEntries: boolean, sizeBytes: number) => ({ overSize, overEntries, sizeBytes });

  it('lifts a size-only refusal that fits the desktop reader', () => {
    expect(exportLiftedByDesktop(row(true, false, 100 * MiB))).toBe(true);
    expect(exportLiftedByDesktop(row(true, false, DESKTOP_MAX_TOTAL_UNCOMPRESSED))).toBe(true);
  });

  it('never lifts the entry cap (512 on both builds), a size past 256 MiB, or junk', () => {
    expect(exportLiftedByDesktop(row(true, false, DESKTOP_MAX_TOTAL_UNCOMPRESSED + 1))).toBe(false);
    expect(exportLiftedByDesktop(row(true, true, 100 * MiB))).toBe(false);
    expect(exportLiftedByDesktop(row(false, true, 10 * MiB))).toBe(false);
    expect(exportLiftedByDesktop(row(false, false, 100 * MiB))).toBe(false);
    expect(exportLiftedByDesktop(row(true, false, Number.NaN))).toBe(false);
  });
});

describe('DesktopAppNote renders per platform', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const render = (ua: string, platform: string, touch: number, language: Language = 'en'): string => {
    vi.stubGlobal('navigator', { userAgent: ua, platform, maxTouchPoints: touch });
    return renderToStaticMarkup(createElement(DesktopAppNote, { language }));
  };
  const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

  it('Windows: both builds plus the SmartScreen route', () => {
    const html = render(WIN_CHROME, 'Win32', 0);
    expect(hrefs(html)).toEqual([
      releaseDownloadUrl('FastShaders-Windows-Setup.exe'),
      releaseDownloadUrl('FastShaders-Windows-Portable.zip'),
    ]);
    expect(html).toContain('The FastShaders desktop app opens much larger files.');
    expect(html).toContain('SmartScreen');
    expect(html).toContain('installer (.exe)');
  });

  it('macOS: the .dmg only, and no first-launch sentence while unverified', () => {
    const html = render(MAC_SAFARI, 'MacIntel', 0);
    expect(hrefs(html)).toEqual([releaseDownloadUrl('FastShaders-macOS.dmg')]);
    expect(html).not.toContain('Open Anyway');
    expect(html).not.toContain('SmartScreen');
  });

  it('Latvian: every string is the translated one', () => {
    const html = render(WIN_CHROME, 'Win32', 0, 'lv');
    const ui = lv.ui as Record<string, string>;
    expect(html).toContain(ui['The FastShaders desktop app opens much larger files.']);
    expect(html).toContain(ui['installer (.exe)']);
    expect(html).not.toContain('The FastShaders desktop app');
  });

  it('nothing on a device with no build', () => {
    expect(render(MAC_SAFARI, 'MacIntel', 5)).toBe('');
    expect(render('Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/35.0', 'Linux x86_64', 5)).toBe('');
  });
});

describe('DesktopAppNote source pins', () => {
  const note = read('./DesktopAppNote.tsx');
  const body = note.slice(note.indexOf('export function DesktopAppNote('));

  it('bails on the desktop build and in a study session BEFORE reading navigator', () => {
    const guard = body.indexOf('if (__FS_DESKTOP__ || isEvalMode()) return null;');
    expect(guard).toBeGreaterThan(-1);
    expect(body.indexOf('navigator')).toBeGreaterThan(guard);
  });

  it('gates the macOS route sentence on MAC_FIRST_LAUNCH_ROUTE_VERIFIED', () => {
    expect(body).toMatch(/MAC_FIRST_LAUNCH_ROUTE_VERIFIED\s*\?\s*t\('Download the \.dmg/);
  });

  it('links through the one list, never a literal asset name', () => {
    expect(body).toContain('href={releaseDownloadUrl(d.file)}');
    expect(note).not.toContain('FastShaders-');
  });

  it('is mounted only behind the lift decisions', () => {
    expect(read('./LimitModal.tsx')).toMatch(/\{desktopLiftsLimit\(head, ignoreLimits\) && <DesktopAppNote /);
    expect(read('./ExportPreflightModal.tsx')).toMatch(/\{exportLiftedByDesktop\(request\) && <DesktopAppNote /);
  });

  it('every sentence it draws has a Latvian entry that differs from the English', () => {
    const keys = [...note.matchAll(/t\(\s*'([^']+)',\s*language\)/g)].map((m) => m[1]);
    expect(keys).toHaveLength(3);
    const ui = lv.ui as Record<string, string>;
    for (const k of keys) {
      expect(Object.prototype.hasOwnProperty.call(ui, k), k).toBe(true);
      expect(ui[k]).not.toBe(k);
    }
  });
});
