/**
 * Pins how the three tab icons are referenced and what is inside them.
 *
 * Two failure modes, both silent — a wrong favicon looks like "no favicon",
 * which nobody files a bug about:
 *
 *  1. **The reference form differs per page, and swapping them 404s.**
 *     index.html / node-designer.html are Vite entries, so a root-absolute
 *     `/images/favicon-app.svg` is the documented public-asset form and Vite prefixes the
 *     deploy base (`/FastShaders/`, `/fastshaders/`, or `/` on desktop).
 *     podest.html and ShaderCarousel/index.html are copied VERBATIM — nothing
 *     rewrites them — so they must be relative, or they resolve against the
 *     server root and miss every deployment that is not at `/`.
 *
 *  2. **Off-canvas residue.** The authored icons came from one document with
 *     the three artboards side by side (FS at x≈213, Podest at x≈960, SC at
 *     x≈1733), and each export kept its neighbours' artwork parked outside its
 *     own viewBox — ~750 units left in the Podest file, ~1519 in the SC one.
 *     It rendered nowhere and cost ~2.5 KB per file, and a later re-crop would
 *     have dragged half an unrelated logo into frame. The FastShaders "S" path
 *     is unmistakable, so its presence in a derived icon is the check.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), 'utf8');

/** First 20 chars of the FastShaders "S" outline — unique to that mark. */
const FS_S_PATH = 'M1086.106,2086.788';

const ICONS = [
  { file: 'public/images/favicon-app.svg', ownMark: FS_S_PATH },
  { file: 'public/images/favicon-podest.svg', ownMark: 'M1420.734,1949.375' },
  { file: 'ShaderCarousel/images/favicon-carousel.svg', ownMark: 'M1054.547,2086.562' },
] as const;

const PAGES = [
  // Vite entries — root-absolute, base-prefixed at build.
  { file: 'index.html', href: '/images/favicon-app.svg', asset: 'public/images/favicon-app.svg' },
  { file: 'node-designer.html', href: '/images/favicon-app.svg', asset: 'public/images/favicon-app.svg' },
  { file: 'node-editor.html', href: '/images/favicon-app.svg', asset: 'public/images/favicon-app.svg' },
  // Copied verbatim — must be relative. `images/` sits beside each of these
  // pages (public/images, ShaderCarousel/images), which is why each suite
  // keeps its OWN folder rather than sharing one: the carousel is copied as a
  // self-contained tree (dist, the desktop LAN server, any static host), so an
  // icon reaching up into the app's public/ would 404 everywhere but dist.
  { file: 'public/podest.html', href: 'images/favicon-podest.svg', asset: 'public/images/favicon-podest.svg' },
  { file: 'ShaderCarousel/index.html', href: 'images/favicon-carousel.svg', asset: 'ShaderCarousel/images/favicon-carousel.svg' },
  // The eval-mode redirector sits one level DOWN inside public/, so its
  // relative ref reaches UP — still relative, still verbatim-copied.
  { file: 'public/eval/index.html', href: '../images/favicon-app.svg', asset: 'public/images/favicon-app.svg' },
  { file: 'public/evalp/index.html', href: '../images/favicon-app.svg', asset: 'public/images/favicon-app.svg' },
  { file: 'public/evalpro/index.html', href: '../images/favicon-app.svg', asset: 'public/images/favicon-app.svg' },
] as const;

describe('favicons', () => {
  it.each(PAGES)('$file points at an icon that exists', ({ file, href, asset }) => {
    const html = read(file);
    expect(html, `${file} has no <link rel="icon">`).toContain('rel="icon"');
    expect(html).toContain(`href="${href}"`);
    expect(existsSync(root(asset)), `${asset} is missing`).toBe(true);
  });

  it('keeps the verbatim-copied pages on RELATIVE hrefs', () => {
    // A leading slash here resolves to the server root, which is wrong on every
    // deployment except the desktop shell's.
    for (const file of ['public/podest.html', 'ShaderCarousel/index.html', 'public/eval/index.html', 'public/evalp/index.html']) {
      const links = read(file).split('\n').filter((l) => l.includes('rel="icon"'));
      expect(links.length, `${file} icon links`).toBeGreaterThan(0);
      for (const l of links) expect(l, file).not.toMatch(/href="\//);
    }
  });

  it.each(ICONS)('$file is square, self-contained and carries its own mark', ({ file, ownMark }) => {
    const svg = read(file);
    const vb = svg.match(/viewBox="([^"]+)"/)?.[1].split(/\s+/).map(Number);
    expect(vb, `${file} has no viewBox`).toBeTruthy();
    expect(vb!).toHaveLength(4);
    expect(Math.abs(vb![2] - vb![3]), 'a non-square viewBox letterboxes in the tab strip').toBeLessThan(1);
    expect(svg).toContain(ownMark);
    // Offline rule: an icon may never reach for the network. Namespace URIs
    // are declarations, not fetches, so they are stripped before the check.
    const fetchable = svg.replace(/xmlns(:\w+)?="[^"]*"/g, '');
    expect(fetchable).not.toMatch(/https?:\/\//);
  });

  it('carries no neighbouring artboard in the derived icons', () => {
    for (const file of ['public/images/favicon-podest.svg', 'ShaderCarousel/images/favicon-carousel.svg']) {
      expect(read(file), `${file} still contains the FastShaders mark`).not.toContain(FS_S_PATH);
    }
  });

  it('flips its black shapes for a dark tab strip', () => {
    // Only the derived icons have black shapes; the app mark is brand colours
    // that read on either background.
    for (const file of ['public/images/favicon-podest.svg', 'ShaderCarousel/images/favicon-carousel.svg']) {
      const svg = read(file);
      expect(svg).toContain('class="ink"');
      expect(svg).toMatch(/@media \(prefers-color-scheme: dark\)/);
    }
  });
});
