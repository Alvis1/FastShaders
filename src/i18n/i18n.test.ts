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
    expect(nodeLabelLV('mul')).toBe('Reizināt');
    expect(formatNodeLabel('Multiply', 'mul', 'lv')).toBe('Reizināt (Multiply)');
    // bilingual=false → Latvian word alone (for tight palette tiles)
    expect(formatNodeLabel('Multiply', 'mul', 'lv', false)).toBe('Reizināt');
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
});
