/**
 * Every lesson string, and every literal the panel, the tile and the browser
 * pass to `t()` for the Tutorials tab, has a Latvian entry in lv.json `ui` that
 * is not the English (the `builtinAssetsI18n.test.ts` rule, for the strings
 * that live in `ui` instead of `assets`). `ui` has NO orphan guard by design
 * (i18n/index.ts), so a reworded English literal fails HERE, not silently.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import lv from '@/i18n/lv.json';
import { TUTORIALS } from './tutorialDefs';
import { MAX_CAPTION_CHARS } from './tutorialTypes';

const SRC = fileURLToPath(new URL('./', import.meta.url));
const read = (f: string) => readFileSync(SRC + f, 'utf8');
const UI = lv.ui as Record<string, string>;
const ASSETS = lv.assets as Record<string, string>;

/** The `t('…')` / `t("…")` literals a source file passes. */
function tLiterals(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) out.push(m[1].replace(/\\'/g, "'"));
  for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) out.push(m[1]);
  return out;
}

function expectLatvian(en: string, where: string) {
  const lvText = UI[en];
  expect(lvText, `${where}: no Latvian for "${en}"`).toBeTypeOf('string');
  expect(lvText.trim(), where).toBe(lvText);
  expect(lvText.length, where).toBeGreaterThan(0);
  expect(lvText, where).not.toBe(en);
}

describe('the lessons speak Latvian', () => {
  it.each(TUTORIALS.map((d) => [d.id, d] as const))('%s: title, summary, every caption and hint', (_id, def) => {
    expectLatvian(def.title, `${def.id} title`);
    expectLatvian(def.summary, `${def.id} summary`);
    for (const s of def.steps) {
      expectLatvian(s.caption, `${def.id}/${s.id}`);
      // The panel never scrolls: a Latvian caption may run longer than the
      // English, but not past what three lines hold.
      expect(UI[s.caption].length, `${def.id}/${s.id} LV caption length`).toBeLessThanOrEqual(Math.round(MAX_CAPTION_CHARS * 1.35));
      if (s.hint) expectLatvian(s.hint, `${def.id}/${s.id} hint`);
    }
    // The finish screen names the recipe through assetText — the preset
    // library's own translation table.
    if (def.recipeName) expect(ASSETS[def.recipeName], `${def.id}: recipe name ${def.recipeName}`).toBeTypeOf('string');
  });

  it('the panel, the tile and the browser\'s tab strings', () => {
    const literals = new Set<string>([
      ...tLiterals(read('TutorialPanel.tsx')),
      ...tLiterals(read('TutorialCard.tsx')),
      'Step by step',
      'No tutorials match “{query}”.',
    ]);
    expect(literals.size).toBeGreaterThan(10);
    for (const en of literals) expectLatvian(en, 'tutorials UI');
  });
});
