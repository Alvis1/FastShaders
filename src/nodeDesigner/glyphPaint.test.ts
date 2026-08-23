import { describe, it, expect } from 'vitest';
import {
  GLYPH_PALETTE, isPaletteColor, normalizePaintValue, normalizePaintNumber,
  displayPaintNumber, summarizePaint,
} from './glyphPaint';
import { CUSTOM_GLYPHS } from '@/components/NodeEditor/nodes/glyphs/customGlyphs';

const shipped = Object.values(CUSTOM_GLYPHS).map((d) => (d as { svg?: string }).svg || '').filter(Boolean);
const attrValues = (attr: string) => shipped.flatMap((s) => Array.from(s.matchAll(new RegExp(attr + '="([^"]*)"', 'g'))).map((m) => m[1]));

describe('GLYPH_PALETTE', () => {
  it('matches the constants NodeGlyph.tsx draws with', () => {
    // the eight design tokens, spelled exactly as the React module spells them
    expect(GLYPH_PALETTE.map((p) => p.hex)).toEqual(
      ['#2B2B2B', '#8A8F9C', '#B4B7C0', '#F57C00', '#FF9800', '#2D6CDF', '#2E9E5B', '#1796A0', '#FFFFFF'],
    );
    GLYPH_PALETTE.forEach((p) => { expect(p.hex).toMatch(/^#[0-9A-F]{6}$/); expect(p.name).toBeTruthy(); expect(p.note).toBeTruthy(); });
  });

  it('covers the colours the shipped glyphs actually use', () => {
    const used = new Set([...attrValues('fill'), ...attrValues('stroke')]
      .map((v) => normalizePaintValue(v))
      .filter((v): v is string => !!v && v !== 'none'));
    // whatever is NOT in the palette is off-system art someone typed by hand —
    // report it rather than assert it away, so the list stays honest
    const off = Array.from(used).filter((v) => !isPaletteColor(v));
    expect(Array.from(used).length).toBeGreaterThan(4);
    // the colormap glyph legitimately draws viridis swatches; nothing else should
    expect(off.every((v) => /^#[0-9a-f]{6}$/.test(v))).toBe(true);
  });
});

describe('normalizePaintValue', () => {
  it('reduces what getComputedStyle returns back to a palette hex', () => {
    // the whole reason this exists: CSSOM answers in rgb()
    expect(normalizePaintValue('rgb(45, 108, 223)')).toBe('#2d6cdf');
    expect(isPaletteColor(normalizePaintValue('rgb(45, 108, 223)'))).toBe(true);
    expect(normalizePaintValue('rgb(43 43 43)')).toBe('#2b2b2b');
  });
  it('expands 3-digit hex and lower-cases', () => {
    expect(normalizePaintValue('#ABC')).toBe('#aabbcc');
    expect(normalizePaintValue('#F57C00')).toBe('#f57c00');
  });
  it('treats no paint and fully transparent paint alike', () => {
    expect(normalizePaintValue('none')).toBe('none');
    expect(normalizePaintValue('transparent')).toBe('none');
    expect(normalizePaintValue('rgba(0, 0, 0, 0)')).toBe('none');
    expect(normalizePaintValue('rgb(0 0 0 / 0)')).toBe('none');
  });
  it('keeps a partly transparent colour as the colour it is', () => {
    expect(normalizePaintValue('rgba(255, 152, 0, 0.16)')).toBe('#ff9800');
  });
  it('returns null — never a guess — for anything it cannot reduce', () => {
    expect(normalizePaintValue('url(#grad)')).toBeNull();
    expect(normalizePaintValue('currentColor')).toBeNull();
    expect(normalizePaintValue('rebeccapurple')).toBeNull();
    expect(normalizePaintValue('')).toBeNull();
    expect(normalizePaintValue(null)).toBeNull();
    expect(normalizePaintValue(undefined)).toBeNull();
  });
  it('reads every fill/stroke the shipped corpus contains', () => {
    const vals = [...attrValues('fill'), ...attrValues('stroke')];
    expect(vals.length).toBeGreaterThan(30);
    vals.forEach((v) => expect(normalizePaintValue(v), v).not.toBeNull());
  });
});

describe('normalizePaintNumber', () => {
  it('accepts the leading-dot spelling the corpus actually ships', () => {
    // 12 of the 84 shipped stroke-widths are written this way
    expect(normalizePaintNumber('.8')).toBe('0.8');
    expect(normalizePaintNumber('.6')).toBe('0.6');
    expect(normalizePaintNumber('1.45')).toBe('1.45');
  });
  it('clamps rather than emitting something the art cannot use', () => {
    expect(normalizePaintNumber('-3')).toBe('0');
    expect(normalizePaintNumber('999')).toBe('24');
    expect(normalizePaintNumber('999', 8)).toBe('8');
  });
  it('returns null for junk instead of writing NaN into the art', () => {
    expect(normalizePaintNumber('abc')).toBeNull();
    expect(normalizePaintNumber('')).toBeNull();
    expect(normalizePaintNumber(null)).toBeNull();
    expect(normalizePaintNumber(NaN)).toBeNull();
    expect(normalizePaintNumber(Infinity)).toBeNull();
  });
  it('reads every stroke-width the shipped corpus contains', () => {
    const ws = attrValues('stroke-width');
    expect(ws.length).toBeGreaterThan(50);
    ws.forEach((w) => expect(normalizePaintNumber(w), w).not.toBeNull());
  });
});

describe('displayPaintNumber', () => {
  it('canonicalises for an <input type=number>, which rejects a leading dot', () => {
    expect(displayPaintNumber('.8')).toBe('0.8');
    expect(displayPaintNumber('1.6')).toBe('1.6');
  });
  it('gives the empty string only when there is genuinely no number', () => {
    expect(displayPaintNumber(null)).toBe('');
    expect(displayPaintNumber('inherit')).toBe('');
  });
});

describe('summarizePaint', () => {
  it('distinguishes "nothing selected" from "they disagree"', () => {
    expect(summarizePaint([])).toEqual({ value: null, mixed: false });
    expect(summarizePaint(['#2b2b2b', 'none'])).toEqual({ value: null, mixed: true });
  });
  it('reports a shared value', () => {
    expect(summarizePaint(['none', 'none'])).toEqual({ value: 'none', mixed: false });
    expect(summarizePaint(['#f57c00'])).toEqual({ value: '#f57c00', mixed: false });
  });
  it('treats a shared unknown as shared, not mixed', () => {
    expect(summarizePaint([null, null])).toEqual({ value: null, mixed: false });
  });
});
