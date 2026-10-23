import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * The device-comparison page's WIRING, from source — the page cannot mount
 * under the `node` env, and what can rot here is plumbing, not logic
 * (compareModel.test.ts holds the logic; bootWave.test.ts the static import
 * graph: no store, no Babel).
 *
 *  1. compare/index.html is a Vite ENTRY at a DIRECTORY url (<base>compare/):
 *     vite.config names it, it loads the module, and it carries what the two
 *     HTML plugins transform in every entry — the version meta and a bare
 *     `<head>` the CSP meta is spliced after.
 *  2. its pre-paint guard resolves theme and language by index.html's rules;
 *  3. no public/compare/ copy (Vite copies public/ verbatim, so one would ship
 *     beside the built page and shadow it — the designer's lesson);
 *  4. the page writes NO storage key: a dropped file is session state, and
 *     the selection lives in the link;
 *  5. both host deploy scripts curl the page after the upload, by the title
 *     the HTML carries.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const HTML = read('compare/index.html');
const CONFIG = read('vite.config.ts');

describe('compare/index.html is a Vite entry', () => {
  it('loads the page module and nothing inline but the pre-paint guard', () => {
    expect(HTML).toMatch(/<script type="module" src="\/src\/compare\/main\.tsx"><\/script>/);
    expect(HTML.match(/<script\b/g)).toHaveLength(2);
  });

  it('carries the version meta and a bare <head> for the CSP splice, like every entry', () => {
    expect(HTML).toContain('<meta name="version" content="%APP_VERSION%" />');
    expect(HTML).toContain('<head>');
    // The CSP plugin and the version plugin transform EVERY entry's html: their
    // hooks take the html alone, so no per-entry filter (which needs the
    // second, context argument) can creep in and skip this page.
    const plugin = (name: string) => CONFIG.slice(CONFIG.indexOf(`name: '${name}'`), CONFIG.indexOf(`name: '${name}'`) + 400);
    expect(plugin('fs-csp-html')).toMatch(/transformIndexHtml\(html\)/);
    expect(plugin('fs-version-html')).toMatch(/transformIndexHtml\(html\)/);
  });

  it('is named in rollupOptions.input and redirected to its slash in dev', () => {
    expect(CONFIG).toMatch(/compare: path\.resolve\(__dirname, 'compare\/index\.html'\)/);
    expect(CONFIG).toMatch(/const ENTRY_DIRS = \['compare'\];/);
    expect(CONFIG).toMatch(/entryDirDevRedirectPlugin\(\),/);
  });

  it('stamps theme and language before paint by index.html’s rules', () => {
    expect(HTML).toContain("localStorage.getItem('fs:codeEditorTheme') === 'vs-dark'");
    const lang = HTML.split('\n').find((l) => l.includes("setAttribute('lang'"));
    expect(lang, 'compare/index.html no longer stamps <html lang>').toBeTruthy();
    expect(lang, "an absent fs:lang must resolve to 'en'").toContain("=== 'lv' ? 'lv' : 'en'");
  });

  it('has no public/ copy to shadow it', () => {
    expect(existsSync(path.join(ROOT, 'public/compare')), 'public/compare/ would ship beside (and shadow) the built page').toBe(false);
  });
});

describe('the page writes no storage', () => {
  it('no source under src/compare writes or clears a key', () => {
    const dir = path.join(ROOT, 'src/compare');
    const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'));
    expect(sources.length).toBeGreaterThan(2);
    for (const f of sources) {
      const src = readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/\.(setItem|removeItem|clear)\(/);
      expect(src, f).not.toMatch(/sessionStorage|indexedDB/);
    }
  });
});

describe('the host deploys verify it', () => {
  // The title is what the scripts grep for: a fallback to index.html answers
  // 200 at the right version too, so only the page's own title proves it.
  const title = HTML.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';

  it('the page title names it', () => {
    expect(title).toContain('Device comparison');
  });

  it.each([
    ['scripts/deploy-sferas.sh', '"$ORIGIN/compare/?cb='],
    ['scripts/deploy-alvismisjuns.sh', 'https://alvismisjuns.lv/fastshaders/compare/'],
  ])('%s checks the served page, its version and its title', (script, url) => {
    const src = read(script);
    expect(src).toContain(url);
    expect(src).toContain('[ "$COMPARE_CODE" = "200" ]');
    expect(src).toContain('[ "$COMPARE_VER" = "$EXPECTED" ]');
    expect(src).toContain("grep -c 'Device comparison'");
  });
});
