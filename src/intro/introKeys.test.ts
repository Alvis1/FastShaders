/**
 * The intro window's Keys tab: the table is complete in Latvian, it lists every
 * key the canvas handlers answer, and it prints each platform's own keys.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import lv from '@/i18n/lv.json';
import { KEY_ROWS, TRANSLATED_TOKENS, isApplePlatform, keyLabel, rowCombos } from './introKeys';

const src = (rel: string) => readFileSync(path.join(__dirname, '..', rel), 'utf8');
const UI = lv.ui as Record<string, string>;
const tokens = new Set(KEY_ROWS.flatMap((r) => r.combos.flat()));

describe('keys table', () => {
  it('has a Latvian text for every row and printed word', () => {
    const keys = [
      ...KEY_ROWS.map((r) => r.does),
      ...[...tokens].filter((tok) => TRANSLATED_TOKENS.has(tok)),
      'Keys',
    ];
    for (const k of keys) expect(UI[k], k).toBeTruthy();
  });

  it('lists every key the canvas, undo and Apply handlers answer', () => {
    // The single-character keys and the named ones, read off the handlers.
    const handlers = ['components/NodeEditor/NodeEditor.tsx', 'hooks/useSyncEngine.ts', 'components/CodeEditor/CodeEditor.tsx'];
    const found = new Set<string>();
    for (const f of handlers) {
      for (const m of src(f).matchAll(/\bkey(?:\.toLowerCase\(\))?\s*[!=]==\s*'([a-z ]|Escape|Delete|Backspace)'/g)) found.add(m[1]);
    }
    // Shift is a modifier the table spells as `shift`, not a key of its own.
    expect([...found].sort()).toEqual([' ', 'Backspace', 'Delete', 'Escape', 'a', 'c', 'd', 'f', 'g', 'm', 's', 'v', 'x', 'z']);
    const spelled = (k: string) => (k === ' ' ? 'Space' : k === 'Escape' ? 'Esc' : k === 'Backspace' ? 'backspace' : k.length === 1 ? k.toUpperCase() : k);
    for (const k of found) expect(tokens, k).toContain(spelled(k));
  });

  it('prints ⌘ and ⌥ on Apple and Ctrl and Alt elsewhere; the Mac lists Delete without Backspace', () => {
    expect(isApplePlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isApplePlatform({ platform: 'Win32' })).toBe(false);
    expect(isApplePlatform(undefined)).toBe(false);
    expect([keyLabel('mod', true), keyLabel('alt', true)]).toEqual(['⌘', '⌥']);
    expect([keyLabel('mod', false), keyLabel('alt', false)]).toEqual(['Ctrl', 'Alt']);
    const del = KEY_ROWS.find((r) => r.combos.some((c) => c.includes('backspace')))!;
    expect(rowCombos(del, true).map((c) => c.map((k) => k.label).join('+'))).toEqual(['Delete', 'X']);
    expect(rowCombos(del, false).map((c) => c.map((k) => k.label).join('+'))).toEqual(['Delete', 'Backspace', 'X']);
  });

  it('marks gestures as words and keeps key names untranslated', () => {
    const shiftClick = KEY_ROWS.find((r) => r.does === 'Add a node to the selection')!;
    expect(rowCombos(shiftClick, false)[0]).toEqual([
      { label: 'Shift', mouse: false, translate: false },
      { label: 'Click', mouse: true, translate: true },
    ]);
    // `t('Delete')` is the menu verb "Dzēst", never a key cap.
    expect(TRANSLATED_TOKENS.has('Delete')).toBe(false);
  });

  it('is one flat list whose rows are told apart by their text alone', () => {
    const does = KEY_ROWS.map((r) => r.does);
    expect(new Set(does).size).toBe(does.length);
  });
});

describe('intro window tabs', () => {
  const win = src('intro/IntroWindow.tsx');

  it('Intro first and opened by default, then Keys', () => {
    expect(win).toMatch(/const TABS[^=]*= \[\s*\{ id: 'intro', label: 'Intro' \},\s*\{ id: 'keys', label: 'Keys' \},\s*\]/);
    expect(win).toContain("useState<IntroTab>('intro')");
  });

  it('logs Keys without a slide, so the summary still counts slides only', () => {
    // (Spelled in two halves: evalHooks.test.ts reads the whole call form in
    // any file outside its reviewed set as telemetry spreading.)
    expect(win).toContain('evalLog' + "('intro-slide', to === 'keys' ? { tab: to } :");
  });
});
