/**
 * `formatMiB` — the one MiB formatter every size notice prints through.
 *
 * Every byte count here is an INTEGER on purpose: a real file size is one, and
 * a fractional count (`70.2 * 2**20`) lands a hair above or below a tenth
 * boundary, which under round-UP flips the printed digit for no reason a
 * reader could see.
 */
import { describe, it, expect } from 'vitest';
import { formatMiB } from './formatSize';

const MiB = 1048576;

describe('formatMiB', () => {
  it('rounds a size just over a limit UP, so it never prints equal to the limit', () => {
    expect(formatMiB(64 * MiB + 1, 'lv')).toBe('64,1');
    expect(formatMiB(64 * MiB + 1, 'en')).toBe('64.1');
    // 'nearest' is the explicit opt-out, for a figure that is not compared
    // against a cap.
    expect(formatMiB(64 * MiB + 1, 'en', 'nearest')).toBe('64');
  });

  it('prints an exact MiB count with no decimal', () => {
    expect(formatMiB(64 * MiB, 'en')).toBe('64');
    expect(formatMiB(64 * MiB, 'lv')).toBe('64');
  });

  it('uses a decimal comma in Latvian', () => {
    expect(formatMiB(84410368, 'lv')).toBe('80,5'); // exactly 80.5 MiB
    expect(formatMiB(84410368, 'en')).toBe('80.5');
  });

  it('never groups thousands', () => {
    expect(formatMiB(1024 * MiB, 'en')).toBe('1024');
    expect(formatMiB(1024 * MiB, 'lv')).toBe('1024');
  });

  it('shows a small but non-zero size as the first tenth, not 0', () => {
    expect(formatMiB(20000, 'en')).toBe('0.1');
  });

  it('prints junk as 0', () => {
    for (const junk of [0, NaN, -5, Infinity, -Infinity]) {
      expect(formatMiB(junk, 'en')).toBe('0');
      expect(formatMiB(junk, 'lv')).toBe('0');
    }
  });

  it('never prints the limit itself for any size in (96 MiB, 96 MiB + 1 MiB]', () => {
    const lo = 96 * MiB;
    const sizes: number[] = [lo + 1, lo + 2, lo + MiB];
    for (let b = lo + 1; b <= lo + MiB; b += 4099) sizes.push(b);
    for (const b of sizes) {
      expect(formatMiB(b, 'en')).not.toBe('96');
      expect(formatMiB(b, 'lv')).not.toBe('96');
    }
  });
});

describe('formatMiB: separators', () => {
  it('uses a decimal comma and no dot in Latvian, even for a large figure', () => {
    const out = formatMiB(Math.round(12345.6 * MiB), 'lv');
    expect(out).toContain(',');
    expect(out).not.toContain('.');
  });
});

describe('formatMiB: the export pre-flight (N1) prints against the 96 MiB reader cap', () => {
  it('prints the cap itself as a whole number and one byte over it as the next tenth', () => {
    expect(formatMiB(96 * MiB, 'lv')).toBe('96');
    expect(formatMiB(96 * MiB, 'en')).toBe('96');
    expect(formatMiB(96 * MiB + 1, 'lv')).toBe('96,1');
    expect(formatMiB(96 * MiB + 1, 'en')).toBe('96.1');
  });

  it('never prints a non-empty model as "0 MB"', () => {
    expect(formatMiB(1, 'en')).toBe('0.1');
    expect(formatMiB(1, 'lv')).toBe('0,1');
  });
});
