/**
 * `toAsciiStorageJson` is the ONE writer path for `fs:graph` and
 * `fs:savedGroups` (see its header for the WebKit measurements it answers).
 *
 * The node suite can only pin the ROUND TRIP and the byte arithmetic: whether
 * a string is stored 8-bit is invisible from here. The real-engine proof is
 * `scripts/verify-webkit-storage.mjs`, whose control write must FAIL.
 *
 * Every non-ASCII character below is built with String.fromCharCode, so the
 * fixtures say exactly which code units they hold.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeNonAscii, toAsciiStorageJson } from './asciiStorage';
import { safeJsonReviver } from './safeJson';

const ASCII_ONLY = /^[\x00-\x7f]*$/;
const ch = (...codes: number[]) => String.fromCharCode(...codes);

/** Every Latvian diacritic, lower then upper: a c e g i k l n s u z. */
const LATVIAN = ch(
  0x0101, 0x0100, 0x010d, 0x010c, 0x0113, 0x0112, 0x0123, 0x0122, 0x012b, 0x012a, 0x0137,
  0x0136, 0x013c, 0x013b, 0x0146, 0x0145, 0x0161, 0x0160, 0x016b, 0x016a, 0x017e, 0x017d,
);
const E_ACUTE = ch(0x00e9); // the latin1 / windows-1252 trap
const EMOJI = String.fromCodePoint(0x1f600); // a surrogate PAIR
const LONE_SURROGATE = ch(0xd800);

const parse = (s: string): unknown => JSON.parse(s, safeJsonReviver);
const nonAsciiUnits = (s: string) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x80) n++;
  return n;
};

describe('toAsciiStorageJson', () => {
  it('writes a pure-ASCII payload exactly as JSON.stringify did (byte-stable autosave)', () => {
    const v = { nodes: [{ id: 'n1', data: { label: 'mul1', values: { a: 2 } } }], edges: [] };
    const json = JSON.stringify(v);
    expect(toAsciiStorageJson(v)).toBe(json);
    // Nothing to escape: the SAME string comes back, not a copy.
    expect(escapeNonAscii(json)).toBe(json);
  });

  it('stores every Latvian diacritic, the latin1 range, separators, surrogates and NUL as ASCII that parses back', () => {
    const v = {
      note: LATVIAN,
      latin1: E_ACUTE + ch(0x0080) + ch(0x00ff),
      separators: ch(0x2028) + ch(0x2029),
      top: ch(0xffff),
      emoji: EMOJI,
      lone: LONE_SURROGATE,
      nul: ch(0x0000),
      del: ch(0x007f),
      nested: { [LATVIAN]: [LATVIAN, EMOJI] },
    };
    const out = toAsciiStorageJson(v);
    expect(out).toMatch(ASCII_ONLY);
    expect(parse(out)).toEqual(v);
  });

  it('escapes in JSON’s own lower-case spelling', () => {
    const out = toAsciiStorageJson({ s: E_ACUTE + ch(0x0101) });
    expect(out).toContain('\\u00e9');
    expect(out).toContain('\\u0101');
    expect(out).not.toContain('\\u00E9');
  });

  it('costs exactly five extra characters per non-ASCII code unit (an emoji costs 12 in all)', () => {
    const v = { a: LATVIAN, b: E_ACUTE, c: EMOJI, d: 'plain' };
    const json = JSON.stringify(v);
    expect(toAsciiStorageJson(v).length).toBe(json.length + 5 * nonAsciiUnits(json));
    expect(toAsciiStorageJson({ e: EMOJI }).length - JSON.stringify({ e: '' }).length).toBe(12);
  });

  it('never double-escapes: the TEXT backslash-u-0101 and a real U+0101 stay different strings', () => {
    const text = '\\u0101'; // six characters: backslash, u, 0, 1, 0, 1
    expect(text).toHaveLength(6);
    const v = { text, real: ch(0x0101) };
    const back = parse(toAsciiStorageJson(v)) as typeof v;
    expect(back.text).toBe(text);
    expect(back.real).toBe(ch(0x0101));
    expect(back.text).not.toBe(back.real);
  });

  it('fits the app’s own full image budget beside a Latvian note inside WebKit’s 8-bit quota', () => {
    const PREFIX = 'data:image/webp;base64,';
    const images = Array.from({ length: 5 }, () => PREFIX + 'A'.repeat(600_000 - PREFIX.length));
    const note = (LATVIAN + ' ').repeat(Math.ceil(20_000 / (LATVIAN.length + 1))).slice(0, 20_000);
    const v = {
      nodes: [
        ...images.map((imageB64, i) => ({ id: `i${i}`, data: { values: { imageB64 } } })),
        { id: 'note', data: { text: note } },
      ],
      edges: [],
    };
    const json = JSON.stringify(v);
    const out = toAsciiStorageJson(v);
    const QUOTA = 5 * 1024 * 1024; // WebKit: bytes per origin, key + value
    // The failure being fixed: one 16-bit character makes the whole value 2 bytes a char.
    expect(json.length * 2).toBeGreaterThan(QUOTA);
    // Escaped, it is 8-bit and fits (1 byte a char, key included).
    expect(out.length + 'fs:graph'.length).toBeLessThanOrEqual(QUOTA);
    expect(out).toMatch(ASCII_ONLY);
    expect(parse(out)).toEqual(v);
  });
});

describe('asciiStorage.ts source', () => {
  const src = readFileSync(join(__dirname, 'asciiStorage.ts'), 'utf8');

  it('is pure ASCII itself', () => {
    expect(nonAsciiUnits(src)).toBe(0);
  });

  it('never spells the parse call (safeJson.test.ts scans comments too)', () => {
    expect(src).not.toContain('JSON.parse(');
  });

  it('re-encodes through TextEncoder/TextDecoder, never a latin1 decoder', () => {
    expect(src).toContain('new TextDecoder().decode(new TextEncoder().encode(escaped))');
    expect(src).not.toMatch(/TextDecoder\(\s*['"]/);
  });
});
