import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { t } from '@/i18n';
import { splatCountLine, SPLAT_COUNT_ONE_KEY, SPLAT_COUNT_MANY_KEY, SPLAT_COUNT_HINT_KEY } from './splatCount';
import { SPLAT_MAX_COUNT } from './splatLimits';

/**
 * The Splat Output menu's splat-count figure (utils/splatCount.ts) — the
 * textureMemoryLine pattern: one line, two plural keys, a hint, both
 * languages, and nothing printed for a count that is not an honest count.
 */
describe('splatCountLine', () => {
  it('prints the count, grouped per language, with the singular for exactly one', () => {
    expect(splatCountLine({ count: 1 }, 'en')).toBe('Loaded scene: 1 splat');
    expect(splatCountLine({ count: 2 }, 'en')).toBe('Loaded scene: 2 splats');
    expect(splatCountLine({ count: 987_654 }, 'en')).toBe('Loaded scene: 987,654 splats');
    expect(splatCountLine({ count: SPLAT_MAX_COUNT }, 'en')).toBe('Loaded scene: 1,000,000 splats');
    expect(splatCountLine({ count: 0 }, 'en')).toBe('Loaded scene: 0 splats');
    expect(splatCountLine({ count: 1 }, 'lv')).toBe('Ielādētajā ainā: 1 pleķis');
    // Latvian groups with a (no-break) space and states the count as a
    // quantity, so no plural ending is ever needed.
    expect(splatCountLine({ count: 21 }, 'lv')).toBe('Pleķu skaits ielādētajā ainā: 21');
    expect(splatCountLine({ count: 250_000 }, 'lv')).toMatch(/^Pleķu skaits ielādētajā ainā: 250\s000$/);
  });

  it('prints NOTHING for no facts or a count that is not a safe integer in range', () => {
    // The count crosses out of the sandbox, which runs model code; the parent
    // validates it, and this formatter is total on its own anyway.
    expect(splatCountLine(null, 'en')).toBeNull();
    expect(splatCountLine(undefined, 'en')).toBeNull();
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, SPLAT_MAX_COUNT + 1, '12', null, undefined, { valueOf: () => 3 }, 2 ** 53]) {
      expect(splatCountLine({ count: bad }, 'en'), String(bad)).toBeNull();
    }
  });

  it('every key has a Latvian entry and every template placeholder is filled', () => {
    for (const key of [SPLAT_COUNT_ONE_KEY, SPLAT_COUNT_MANY_KEY, SPLAT_COUNT_HINT_KEY]) {
      expect(t(key, 'lv'), key).not.toBe(key);
    }
    for (const lang of ['en', 'lv'] as const) {
      for (const n of [1, 2, 21, 100_000]) expect(splatCountLine({ count: n }, lang)).not.toContain('{');
    }
  });

  it('the settings menu shows it only when there is one, with the hint as its title (source pin)', () => {
    const menu = readFileSync(new URL('../components/NodeEditor/menus/SplatSettingsMenu.tsx', import.meta.url), 'utf8');
    expect(menu).toContain('const countLine = splatCountLine(splatFacts, language);');
    expect(menu).toContain('{countLine && (');
    expect(menu).toContain('title={t(SPLAT_COUNT_HINT_KEY, language)}');
  });
});
