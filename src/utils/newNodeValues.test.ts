import { describe, it, expect } from 'vitest';
import { initialNodeValues, randomColorHex, NEW_COLOR_PALETTE } from './newNodeValues';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { hexToRgb } from '@/utils/colorUtils';
import { makeNode } from '@/test-utils';
import type { AppNode, NodeDefinition } from '@/types';

const def = (type: string): NodeDefinition => {
  const d = NODE_REGISTRY.get(type);
  if (!d) throw new Error(`missing registry def: ${type}`);
  return d;
};

/** Deterministic stand-in for Math.random — cycles the given values. */
const seeded = (...vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

describe('NEW_COLOR_PALETTE', () => {
  it('is the Vibrant Color Fiesta palette, in order', () => {
    // Pinned against the source: coolors.co encodes the palette in its own URL
    // — https://coolors.co/palette/ffbe0b-fb5607-ff006e-8338ec-3a86ff
    expect([...NEW_COLOR_PALETTE]).toEqual([
      '#ffbe0b', '#fb5607', '#ff006e', '#8338ec', '#3a86ff',
    ]);
  });

  it('is all 6-digit lowercase hex, with no duplicates', () => {
    for (const c of NEW_COLOR_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(NEW_COLOR_PALETTE).size).toBe(NEW_COLOR_PALETTE.length);
  });

  it('is vivid enough to read as a swatch on either canvas', () => {
    // Why a curated palette at all: no entry may be a near-black, near-white,
    // or a grey, since those are useless as a starting colour.
    for (const c of NEW_COLOR_PALETTE) {
      const [r, g, b] = hexToRgb(c);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      expect(max).toBeGreaterThan(60);
      expect(max - min).toBeGreaterThan(40);
    }
  });
});

describe('randomColorHex', () => {
  it('only ever returns palette entries', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(randomColorHex());
    for (const c of seen) expect(NEW_COLOR_PALETTE).toContain(c);
  });

  it('can reach every entry', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(randomColorHex());
    expect(seen.size).toBe(NEW_COLOR_PALETTE.length);
  });

  it('is driven entirely by the injected rand (no hidden entropy)', () => {
    expect(randomColorHex(seeded(0.1))).toBe(randomColorHex(seeded(0.1)));
    expect(randomColorHex(seeded(0.1))).not.toBe(randomColorHex(seeded(0.9)));
  });

  it('stays in range at rand() === 1 (the exclusive-upper-bound edge)', () => {
    // Math.random() never returns 1, but an injected rand might — and an
    // unclamped floor would index one past the end.
    expect(randomColorHex(seeded(1))).toBe(NEW_COLOR_PALETTE[NEW_COLOR_PALETTE.length - 1]);
  });
});

describe('initialNodeValues', () => {
  it('gives a constant color node a palette color, not the registry default', () => {
    const values = initialNodeValues(def('color'), [], seeded(0.33));
    expect(NEW_COLOR_PALETTE).toContain(values.hex);
    expect(values.hex).not.toBe(def('color').defaultValues?.hex);
  });

  it('colors property_color too, and still auto-names it', () => {
    const values = initialNodeValues(def('property_color'), [], seeded(0.33));
    expect(NEW_COLOR_PALETTE).toContain(values.hex);
    expect(values.name).toBe('color1');
  });

  it('avoids colors already on the canvas', () => {
    // rand is pinned to 0, so without the used-filter this would return the
    // palette's first entry every time.
    const used: AppNode[] = [];
    const picked: unknown[] = [];
    for (let i = 0; i < NEW_COLOR_PALETTE.length; i++) {
      const hex = initialNodeValues(def('color'), used, seeded(0)).hex;
      picked.push(hex);
      used.push(makeNode(`c${i}`, 'color', { hex: hex as string }));
    }
    expect(new Set(picked).size).toBe(NEW_COLOR_PALETTE.length);
  });

  it('matches used colors case-insensitively', () => {
    const used = [makeNode('a', 'color', { hex: '#FFBE0B' })];
    expect(initialNodeValues(def('color'), used, seeded(0)).hex).not.toBe('#ffbe0b');
  });

  it('falls back to a plain roll once every palette color is taken', () => {
    const used = NEW_COLOR_PALETTE.map((hex, i) => makeNode(`c${i}`, 'color', { hex }));
    const hex = initialNodeValues(def('color'), used, seeded(0.5)).hex;
    expect(NEW_COLOR_PALETTE).toContain(hex);
  });

  it('leaves non-color defs on their registry defaults', () => {
    expect(initialNodeValues(def('float'), [])).toEqual(def('float').defaultValues);
    expect(initialNodeValues(def('perlin'), [])).toEqual(def('perlin').defaultValues);
  });

  it('does not mutate the registry default values', () => {
    const before = { ...def('color').defaultValues };
    initialNodeValues(def('color'), []);
    initialNodeValues(def('color'), []);
    expect(def('color').defaultValues).toEqual(before);
  });

  it('continues the shared property-name sequence across both property kinds', () => {
    const existing: AppNode[] = [
      makeNode('a', 'property_color', { name: 'color3', hex: '#ffffff' }),
    ];
    expect(initialNodeValues(def('property_color'), existing).name).toBe('color4');
    expect(initialNodeValues(def('property_float'), existing).name).toBe('property1');
  });
});
