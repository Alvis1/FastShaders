/**
 * The desktop release assets have ONE list (utils/desktopDownloads.ts), and
 * .github/workflows/release.yml uploads under exactly those names. A rename on
 * either side makes /releases/latest/download/<name> a 404 for every user of
 * the "Download app" dropdown and of the web build's desktop-app note, with
 * nothing failing anywhere — so this file reads the workflow and fails first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import lv from '@/i18n/lv.json';
import {
  DESKTOP_DOWNLOADS,
  MAC_FIRST_LAUNCH_ROUTE_VERIFIED,
  RELEASE_DOWNLOAD_BASE,
  downloadsFor,
  releaseDownloadUrl,
} from './desktopDownloads';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const release = read('../../.github/workflows/release.yml');
const toolbar = read('../components/Layout/Toolbar.tsx');

const ASSET_RE = /FastShaders-[A-Za-z0-9-]+\.(?:dmg|exe|zip)/g;
const files = DESKTOP_DOWNLOADS.map((d) => d.file);

describe('DESKTOP_DOWNLOADS ↔ release.yml', () => {
  it('lists each asset once, under a unique key', () => {
    expect(new Set(files).size).toBe(files.length);
    expect(new Set(DESKTOP_DOWNLOADS.map((d) => d.key)).size).toBe(DESKTOP_DOWNLOADS.length);
  });

  it('names every asset in the workflow header comment', () => {
    const header = new Set(
      release
        .split('\n')
        .map((l) => /^#\s+-\s+(FastShaders-\S+)/.exec(l)?.[1])
        .filter((f): f is string => f !== undefined),
    );
    for (const f of files) expect(header.has(f), f).toBe(true);
  });

  it('uploads EXACTLY the listed assets — no more, no fewer', () => {
    const uploaded = new Set(
      release
        .split('\n')
        .filter((l) => l.includes('gh release upload'))
        .flatMap((l) => l.match(ASSET_RE) ?? []),
    );
    expect([...uploaded].sort()).toEqual([...files].sort());
  });

  it('describes every asset in the release-notes table, on its own OS row', () => {
    for (const d of DESKTOP_DOWNLOADS) {
      const row = release.split('\n').find((l) => l.includes(`| \`${d.file}\` |`));
      expect(row, d.file).toBeDefined();
      expect(row!.trim().startsWith(`| ${d.os} |`), d.file).toBe(true);
    }
  });

  it('calls the dropdown "Download app" and points at the list', () => {
    expect(release).not.toContain('"Local"');
    expect(release).not.toContain('Local dropdown');
    expect(release).toContain('src/utils/desktopDownloads.ts');
  });
});

describe('the Toolbar dropdown renders the list', () => {
  it('imports it rather than carrying a copy', () => {
    expect(toolbar).toContain("from '@/utils/desktopDownloads'");
    expect(toolbar).not.toContain('FastShaders-');
    expect(toolbar).not.toMatch(/const\s+(RELEASE_DOWNLOAD_BASE|DESKTOP_DOWNLOADS)\b/);
    expect(toolbar).toContain('href={releaseDownloadUrl(d.file)}');
  });

  it('translates the row details', () => {
    expect(toolbar).toContain('t(d.detail, language)');
  });
});

describe('the list itself', () => {
  it('points at the permanent latest-release redirect', () => {
    expect(RELEASE_DOWNLOAD_BASE).toMatch(/^https:\/\/github\.com\/Alvis1\/FastShaders\/releases\/latest\/download$/);
    expect(releaseDownloadUrl('FastShaders-macOS.dmg')).toBe(`${RELEASE_DOWNLOAD_BASE}/FastShaders-macOS.dmg`);
  });

  it('partitions by platform: two Windows builds, one macOS build', () => {
    expect(downloadsFor('windows').map((d) => d.key)).toEqual(['win', 'win-portable']);
    expect(downloadsFor('mac').map((d) => d.key)).toEqual(['mac']);
    expect(downloadsFor('windows').length + downloadsFor('mac').length).toBe(DESKTOP_DOWNLOADS.length);
    for (const d of DESKTOP_DOWNLOADS) expect(d.os).toBe(d.platform === 'mac' ? 'macOS' : 'Windows');
  });

  it('every detail has a Latvian entry that differs from the English', () => {
    const ui = lv.ui as Record<string, string>;
    for (const d of DESKTOP_DOWNLOADS) {
      expect(Object.prototype.hasOwnProperty.call(ui, d.detail), d.detail).toBe(true);
      expect(ui[d.detail]).not.toBe(d.detail);
    }
  });

  it('ships the macOS first-launch sentence OFF until a quarantined download confirms it', () => {
    // Owner default (GLB Phase 6, Q6): flip only after the check in the plan's
    // owner checklist. A deliberate change edits this pin too.
    expect(MAC_FIRST_LAUNCH_ROUTE_VERIFIED).toBe(false);
  });
});
