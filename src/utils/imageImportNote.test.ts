/**
 * N5 — what an image drop reports on the canvas import note, and how one
 * drop's reports become ONE note (utils/imageImportNote.ts). The lines are
 * rendered by `importNoteLineText` (utils/importNote.ts), pinned here in both
 * languages for the four budget kinds.
 */
import { describe, it, expect } from 'vitest';
import type { Language } from '@/i18n';
import { importNoteLineText, type ImportNoteLine } from './importNote';
import {
  composeImportNoteLines,
  formatStoredAs,
  imageDropReport,
  type ImageDropReport,
} from './imageImportNote';
import { MAX_IMAGE_ENCODED_CHARS, HARD_MAX_IMAGE_ENCODED_CHARS } from './imageNode';

const PNG = 'data:image/png;base64,AAAA';
const JPG = 'data:image/jpeg;base64,AAAA';
const WEBP = 'data:image/webp;base64,AAAA';

function report(over: Partial<ImageDropReport> = {}): ImageDropReport {
  return {
    storedAs: 'WebP',
    convertNote: null,
    budgetScaled: null,
    losslessDropped: false,
    budgetChars: MAX_IMAGE_ENCODED_CHARS,
    ...over,
  };
}

const res = (over: Partial<{ preferLossless: boolean; budgetScaled: boolean; budgetChars: number }> = {}) => ({
  preferLossless: false,
  budgetScaled: false,
  budgetChars: MAX_IMAGE_ENCODED_CHARS,
  ...over,
});

describe('formatStoredAs', () => {
  it('names the format the payload is stored in', () => {
    expect(formatStoredAs(PNG)).toBe('PNG');
    expect(formatStoredAs(JPG)).toBe('JPEG');
    expect(formatStoredAs(WEBP)).toBe('WebP');
  });

  it('names nothing for anything else', () => {
    expect(formatStoredAs('data:image/gif;base64,AAAA')).toBe('');
    expect(formatStoredAs('')).toBe('');
    expect(formatStoredAs('image/png')).toBe('');
  });
});

describe('imageDropReport', () => {
  it('reads the format off the PLACED payload, not the encoder', () => {
    // A refused stash places the unsnapped original, whose format can differ.
    expect(imageDropReport(res(), { dataUrl: JPG, width: 4, height: 4 }, null).storedAs).toBe('JPEG');
  });

  it('names the PLACED dimensions when the budget cost pixels, else null', () => {
    const placed = { dataUrl: WEBP, width: 512, height: 256 };
    expect(imageDropReport(res({ budgetScaled: true }), placed, null).budgetScaled).toEqual({ width: 512, height: 256 });
    expect(imageDropReport(res({ budgetScaled: false }), placed, null).budgetScaled).toBeNull();
  });

  it('flags lossy only when the source wanted lossless AND what was placed is lossy', () => {
    const lossy = { dataUrl: WEBP, width: 4, height: 4, lossless: false };
    const lossless = { dataUrl: PNG, width: 4, height: 4, lossless: true };
    expect(imageDropReport(res({ preferLossless: true }), lossy, null).losslessDropped).toBe(true);
    // A refused stash that placed a LOSSLESS original is not flagged, whatever
    // the snapped encode was.
    expect(imageDropReport(res({ preferLossless: true }), lossless, null).losslessDropped).toBe(false);
    expect(imageDropReport(res({ preferLossless: false }), lossy, null).losslessDropped).toBe(false);
    // Unknown losslessness is not a claim of lossy.
    expect(imageDropReport(res({ preferLossless: true }), { dataUrl: WEBP, width: 4, height: 4 }, null).losslessDropped).toBe(false);
  });

  it('carries the budget and the WebP reason through', () => {
    const r = imageDropReport(res({ budgetChars: HARD_MAX_IMAGE_ENCODED_CHARS }), { dataUrl: PNG, width: 4, height: 4 }, 'no-webp');
    expect(r.budgetChars).toBe(HARD_MAX_IMAGE_ENCODED_CHARS);
    expect(r.convertNote).toBe('no-webp');
  });
});

describe('composeImportNoteLines', () => {
  it('has nothing to say for no reports, or reports with nothing to say', () => {
    expect(composeImportNoteLines([])).toEqual([]);
    expect(composeImportNoteLines([report(), report()])).toEqual([]);
  });

  it('names ONE scaled image by its placed size, and counts several', () => {
    expect(composeImportNoteLines([report({ budgetScaled: { width: 512, height: 256 } })])).toEqual([
      { kind: 'budget-scaled', width: 512, height: 256, budgetChars: MAX_IMAGE_ENCODED_CHARS },
    ]);
    expect(
      composeImportNoteLines([
        report({ budgetScaled: { width: 512, height: 256 } }),
        report(),
        report({ budgetScaled: { width: 64, height: 64 } }),
      ]),
    ).toEqual([{ kind: 'budget-scaled-many', count: 2, budgetChars: MAX_IMAGE_ENCODED_CHARS }]);
  });

  it('names ONE lossy image by its format, and counts several', () => {
    expect(composeImportNoteLines([report({ losslessDropped: true, storedAs: 'JPEG' })])).toEqual([
      { kind: 'lossless-dropped', storedAs: 'JPEG', budgetChars: MAX_IMAGE_ENCODED_CHARS },
    ]);
    expect(
      composeImportNoteLines([report({ losslessDropped: true }), report({ losslessDropped: true })]),
    ).toEqual([{ kind: 'lossless-dropped-many', count: 2, budgetChars: MAX_IMAGE_ENCODED_CHARS }]);
  });

  it('takes the budget from the first contributing report', () => {
    const lines = composeImportNoteLines([
      report(),
      report({ budgetScaled: { width: 8, height: 8 }, budgetChars: HARD_MAX_IMAGE_ENCODED_CHARS }),
      report({ budgetScaled: { width: 8, height: 8 } }),
    ]);
    expect(lines).toEqual([{ kind: 'budget-scaled-many', count: 2, budgetChars: HARD_MAX_IMAGE_ENCODED_CHARS }]);
  });

  it('orders budget, then lossy, then ONE WebP line listing distinct formats in first-seen order', () => {
    const lines = composeImportNoteLines([
      report({ convertNote: 'no-webp', storedAs: 'JPEG' }),
      report({ losslessDropped: true, storedAs: 'PNG', convertNote: 'no-webp' }),
      report({ budgetScaled: { width: 16, height: 16 }, convertNote: 'no-webp', storedAs: 'JPEG' }),
    ]);
    expect(lines.map((l) => l.kind)).toEqual(['budget-scaled', 'lossless-dropped', 'no-webp']);
    expect(lines[2]).toEqual({ kind: 'no-webp', storedAs: 'JPEG, PNG' });
  });

  it('the WebP line takes the first reporting image’s reason', () => {
    const lines = composeImportNoteLines([
      report({ convertNote: 'preference', storedAs: 'PNG' }),
      report({ convertNote: 'no-webp', storedAs: 'PNG' }),
    ]);
    expect(lines).toEqual([{ kind: 'preference', storedAs: 'PNG' }]);
  });
});

describe('importNoteLineText renders the budget lines', () => {
  const lines: ImportNoteLine[] = [
    { kind: 'budget-scaled', width: 512, height: 256, budgetChars: MAX_IMAGE_ENCODED_CHARS },
    { kind: 'budget-scaled-many', count: 3, budgetChars: MAX_IMAGE_ENCODED_CHARS },
    { kind: 'lossless-dropped', storedAs: 'WebP', budgetChars: MAX_IMAGE_ENCODED_CHARS },
    { kind: 'lossless-dropped-many', count: 2, budgetChars: HARD_MAX_IMAGE_ENCODED_CHARS },
  ];

  it('in English, with every placeholder filled', () => {
    expect(importNoteLineText(lines[0], 'en')).toBe('Reduced to 512×256 to fit the 439 KB per-image budget');
    expect(importNoteLineText(lines[1], 'en')).toBe('Images reduced to fit the 439 KB per-image budget: 3');
    expect(importNoteLineText(lines[2], 'en')).toBe(
      'Stored lossy (WebP) — the lossless version did not fit the 439 KB per-image budget',
    );
    expect(importNoteLineText(lines[3], 'en')).toBe(
      'Images stored lossy because the lossless version did not fit the 5859 KB per-image budget: 2',
    );
  });

  for (const line of lines) {
    it(`${line.kind} has a Latvian entry and fills every placeholder`, () => {
      for (const lang of ['en', 'lv'] as Language[]) {
        expect(importNoteLineText(line, lang)).not.toMatch(/[{}]/);
      }
      expect(importNoteLineText(line, 'lv')).not.toBe(importNoteLineText(line, 'en'));
    });
  }

  it('keeps the numbers in Latvian too', () => {
    const lv = importNoteLineText(lines[0], 'lv');
    expect(lv).toContain('512×256');
    expect(lv).toContain('439 KB');
    expect(importNoteLineText(lines[1], 'lv')).toMatch(/: 3$/);
  });
});
