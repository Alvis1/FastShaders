import { describe, it, expect } from 'vitest';
import { toKebabCase } from './nameUtils';

describe('toKebabCase', () => {
  it('lowercases plain words', () => {
    expect(toKebabCase('Shader')).toBe('shader');
  });

  it('replaces spaces with hyphens', () => {
    expect(toKebabCase('my cool shader')).toBe('my-cool-shader');
  });

  it('collapses runs of non-alphanumerics into a single hyphen', () => {
    expect(toKebabCase('hello   world')).toBe('hello-world');
    expect(toKebabCase('foo___bar')).toBe('foo-bar');
    expect(toKebabCase('mix !@# of stuff')).toBe('mix-of-stuff');
  });

  it('strips leading and trailing hyphens', () => {
    expect(toKebabCase('---wrapped---')).toBe('wrapped');
    expect(toKebabCase('  padded  ')).toBe('padded');
  });

  it('preserves digits', () => {
    expect(toKebabCase('Shader 2 Final')).toBe('shader-2-final');
  });

  it('uses the default fallback when input has no alphanumerics', () => {
    expect(toKebabCase('!!!')).toBe('shader');
    expect(toKebabCase('')).toBe('shader');
  });

  it('respects a custom fallback', () => {
    expect(toKebabCase('', 'untitled')).toBe('untitled');
    expect(toKebabCase('   ', 'untitled')).toBe('untitled');
  });

  it('handles CamelCase as a single token (no case-boundary split)', () => {
    expect(toKebabCase('CamelCase')).toBe('camelcase');
  });
});
