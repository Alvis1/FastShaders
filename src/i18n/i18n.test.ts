import { describe, it, expect } from 'vitest';
import {
  formatNodeLabel,
  formatCategoryLabel,
  nodeDescription,
  nodeDescLV,
  nodeLabelLV,
  portLabel,
  nodeSearchLV,
  t,
} from './index';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Runtime behaviour of the i18n helpers against the REAL translation data
 * (node-i18n.json + lv.json). Covers the two invariants that matter: English
 * mode / missing keys fall back to canonical English, and Latvian mode returns
 * the "Latviešu (English)" bilingual form for labels while descriptions and UI
 * strings return Latvian-only.
 */
describe('i18n helpers', () => {
  it('English mode returns the canonical English unchanged', () => {
    expect(formatNodeLabel('Multiply', 'mul', 'en')).toBe('Multiply');
    expect(formatCategoryLabel('Arithmetic', 'arithmetic', 'en')).toBe('Arithmetic');
    expect(nodeDescription('Multiplies inputs', 'mul', 'en')).toBe('Multiplies inputs');
    expect(portLabel('Color', 'en')).toBe('Color');
    expect(t('Save', 'en')).toBe('Save');
  });

  it('Latvian node labels are bilingual "Latviešu (English)"', () => {
    // Read the Latvian word from the table rather than pinning the literal: `mul` is
    // designable, so the Node Designer's Name (LV) field can legitimately rewrite this
    // entry in node-i18n.json, and a hardcoded 'Reizināt' would turn a correct rename
    // into a red suite — which gates the release workflow. The FORM is what this test
    // is about ("LV (EN)" vs bare LV), and the form survives any rename.
    const lv = nodeLabelLV('mul');
    expect(lv).toBeTruthy();
    expect(formatNodeLabel('Multiply', 'mul', 'lv')).toBe(`${lv} (Multiply)`);
    // bilingual=false → Latvian word alone (for tight palette tiles)
    expect(formatNodeLabel('Multiply', 'mul', 'lv', false)).toBe(lv);
  });

  it('falls back to English when a node has no Latvian entry', () => {
    expect(formatNodeLabel('Whatever', '__no_such_type__', 'lv')).toBe('Whatever');
    expect(nodeLabelLV('__no_such_type__')).toBe('');
  });

  it('descriptions return Latvian-only in LV mode and preserve undefined', () => {
    const lv = nodeDescription('Multiplies inputs per channel', 'mul', 'lv');
    expect(lv).toBe(nodeDescLV('mul'));
    expect(lv).not.toBe('Multiplies inputs per channel');
    expect(lv && lv.length).toBeGreaterThan(0);
    // undefined English description stays undefined (no fabricated string)
    expect(nodeDescription(undefined, '__no_such_type__', 'en')).toBeUndefined();
    expect(nodeDescription(undefined, '__no_such_type__', 'lv')).toBeUndefined();
  });

  it('categories: Latvian-only by default, bilingual on request', () => {
    expect(formatCategoryLabel('Arithmetic', 'arithmetic', 'lv')).toBe('Aritmētika');
    expect(formatCategoryLabel('Arithmetic', 'arithmetic', 'lv', true)).toBe('Aritmētika (Arithmetic)');
  });

  it('ports translate known labels and fall back on single-letter ids', () => {
    expect(portLabel('Color', 'lv')).toBe('Krāsa');
    expect(portLabel('A', 'lv')).toBe('A'); // no translation → unchanged
  });

  it('UI strings key off the English text and fall back to it', () => {
    expect(t('Save', 'lv')).toBe('Saglabāt');
    expect(t('__string with no translation__', 'lv')).toBe('__string with no translation__');
  });

  it('Latvian search haystack lets a Latvian term match a node', () => {
    expect(nodeSearchLV('mul')).toContain('reizināt');
    expect(nodeSearchLV('dot')).toContain('skalārais');
  });

  it('the Discard truthiness hint is translated', () => {
    const en = NODE_REGISTRY.get('output')!.inputs.find((p) => p.id === 'discard')!.description!;
    expect(t(en, 'en')).toBe(en);
    expect(t(en, 'lv')).not.toBe(en); // fails if the lv.json key drifts by one char
    expect(t(en, 'lv')).toContain('Lielāks par');
  });
});

/**
 * Latvian is the app's DEFAULT language (a Latvian research project; the user
 * study runs in Latvian), with English one click away on the toolbar's EN
 * button. That is a product decision a refactor of the store's boot-time
 * `loadString` call could silently flip, and nothing would fail — the app
 * would simply come up in the wrong language for every new user.
 */
describe('default UI language', () => {
  it('is Latvian for a browser with no stored preference', () => {
    const src = readFileSync(fileURLToPath(new URL('../store/useAppStore.ts', import.meta.url)), 'utf8');
    const line = src.split('\n').find((l) => l.includes("loadString('fs:lang'"));
    expect(line, "the store no longer reads fs:lang").toBeTruthy();
    expect(line, 'the fs:lang fallback must be lv').toContain("'fs:lang', 'lv'");
  });

  it("index.html's pre-paint guard resolves an absent fs:lang to lv, like the store", () => {
    // The guard is the ONLY writer of <html lang> for a first-time visitor, and it
    // used to default to 'en' while the store defaulted to 'lv' — so the default
    // population of a Latvian-first app got a document advertising English (wrong
    // screen-reader phonetics, a browser translate prompt, an English spellcheck
    // dictionary over Latvian text input). WCAG 3.1.1 Level A. The two resolutions
    // must stay mirror images; nothing at runtime fails when they drift.
    const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
    const line = html.split('\n').find((l) => l.includes("setAttribute('lang'"));
    expect(line, 'index.html no longer stamps <html lang>').toBeTruthy();
    expect(line, "an absent fs:lang must resolve to 'lv'").toContain("=== 'en' ? 'en' : 'lv'");
  });

  it('the store applies <html lang> at init, not only on toggle', () => {
    // `applyLangAttribute` had exactly ONE call site — inside setLanguage — so on
    // node-editor.html and node-designer.html (neither of which carries the inline
    // guard) the attribute never matched the UI until the user toggled the language,
    // while two source comments claimed the store re-applied it on init.
    const src = readFileSync(fileURLToPath(new URL('../store/useAppStore.ts', import.meta.url)), 'utf8');
    expect(src).toContain('applyLangAttribute(useAppStore.getState().language);');
  });

  it('offers the OTHER language on the toolbar button, so the label is an action', () => {
    const toolbar = readFileSync(fileURLToPath(new URL('../components/Layout/Toolbar.tsx', import.meta.url)), 'utf8');
    expect(toolbar).toContain("{language === 'lv' ? 'EN' : 'LV'}");
    // A flipping label beside aria-pressed reads as a contradiction.
    expect(toolbar).not.toMatch(/toolbar__lang[\s\S]{0,400}aria-pressed/);
  });
});
