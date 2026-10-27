import { describe, it, expect } from 'vitest';
import { foldSearchText } from './searchFold';

describe('foldSearchText — the one fold every search box applies', () => {
  it('drops every Latvian diacritic, in both cases', () => {
    expect(foldSearchText('ĀČĒĢĪĶĻŅŠŪŽ āčēģīķļņšūž')).toBe('acegiklnsuz acegiklnsuz');
    expect(foldSearchText('Krāsa')).toBe('krasa');
  });

  it('only lower-cases plain ASCII', () => {
    expect(foldSearchText('Perlin Noise (vec3)')).toBe('perlin noise (vec3)');
  });

  it('is idempotent, so a query folded by its caller and again by the ranker still matches', () => {
    const once = foldSearchText('Pozīcija (pasaules)');
    expect(foldSearchText(once)).toBe(once);
  });
});
