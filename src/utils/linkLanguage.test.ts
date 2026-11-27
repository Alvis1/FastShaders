import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { linkLanguage, searchWithoutLang } from './linkLanguage';

/**
 * `?lang=en|lv` (owner, 2026-11-27). ONE rule spelled in six places: the leaf,
 * the two pre-paint guards (index.html, compare/index.html) and the three study
 * redirectors. Every copy is RUN here against the same table, so a drift shows
 * as a wrong answer rather than a wrong spelling.
 */

const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const inlineScript = (rel: string): string => {
  const html = readFileSync(root(rel), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error(`no inline script in ${rel}`);
  return script;
};

/** [query, the language it asks for]. */
const TABLE: [string, 'en' | 'lv' | null][] = [
  ['?lang=lv', 'lv'],
  ['?lang=en', 'en'],
  ['lang=lv', 'lv'],
  ['?lang=LV', 'lv'],
  ['?lang=%20lv%20', 'lv'],
  ['?intro&lang=lv&embed=1', 'lv'],
  ['?lang=lv&lang=en', 'lv'], // the FIRST occurrence, as URLSearchParams.get answers
  ['?lang=de', null],
  ['?lang=lv-LV', null],
  ['?lang=', null],
  ['?lang', null],
  ['?language=lv', null],
  ['', null],
];

describe('linkLanguage', () => {
  it.each(TABLE)('%s → %s', (search, want) => {
    expect(linkLanguage(search)).toBe(want);
  });
});

describe('searchWithoutLang', () => {
  it('removes every lang parameter and keeps the rest exactly as written', () => {
    expect(searchWithoutLang('?lang=lv')).toBe('');
    expect(searchWithoutLang('?intro&lang=lv&embed=1')).toBe('?intro&embed=1');
    expect(searchWithoutLang('?lang=lv&lang=en&d=a%2Cb')).toBe('?d=a%2Cb');
    expect(searchWithoutLang('?la%6Eg=lv&x=1')).toBe('?x=1');
    expect(searchWithoutLang('?language=lv')).toBe('?language=lv');
    expect(searchWithoutLang('')).toBe('');
  });
});

describe('the pre-paint guards follow the same rule', () => {
  for (const page of ['index.html', 'compare/index.html']) {
    it.each(TABLE)(`${page}: %s`, (search, want) => {
      for (const stored of [null, 'lv', 'en']) {
        const attrs: Record<string, string> = {};
        const el = { setAttribute: (k: string, v: string) => { attrs[k] = v; }, style: {} };
        runInNewContext(inlineScript(page), {
          document: { documentElement: el },
          localStorage: { getItem: (k: string) => (k === 'fs:lang' ? stored : null) },
          location: { search },
          URLSearchParams,
        });
        expect(attrs.lang).toBe(want ?? (stored === 'lv' ? 'lv' : 'en'));
      }
    });
  }
});

describe('the study redirectors hand the language on to the app', () => {
  for (const entry of ['eval', 'evalp', 'evalpro']) {
    it.each(TABLE)(`/${entry}%s`, (search, want) => {
      let target = '';
      runInNewContext(inlineScript(`public/${entry}/index.html`), {
        sessionStorage: { setItem: () => {}, removeItem: () => {}, getItem: () => null },
        location: { search, hash: '', replace: (u: string) => { target = u; } },
        URLSearchParams,
        decodeURIComponent,
      });
      expect(target).toBe(want ? `../?lang=${want}` : '../');
    });
  }
});

describe('the store adopts the link', () => {
  it('reads it before the stored choice, saves it, and strips it from the address', () => {
    const src = readFileSync(root('src/store/useAppStore.ts'), 'utf8');
    expect(src).toContain("language: LINK_LANGUAGE ?? (loadString('fs:lang', 'en') === 'lv' ? 'lv' : 'en')");
    const fn = src.slice(src.indexOf('function adoptLinkLanguage'), src.indexOf('const LINK_LANGUAGE'));
    expect(fn).toContain("saveString('fs:lang', lang)");
    expect(fn).toContain('searchWithoutLang(search)');
    expect(fn).toContain('replaceState');
  });

  it('the comparison page reads it but writes nothing', () => {
    const src = readFileSync(root('src/compare/ComparePage.tsx'), 'utf8');
    expect(src).toContain('linkLanguage(window.location.search)');
  });
});
