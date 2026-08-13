import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { normalizeHex } from './colorUtils';
import {
  sanitizeRecentColors,
  pushRecentColor,
  getRecentColors,
  noteColorUsed,
  clearRecentColors,
  MAX_RECENT_COLORS,
  RECENT_COLOR_ROWS,
  SWATCHES_PER_ROW,
  RECENT_COLORS_KEY,
} from './recentColors';

/** n DISTINCT valid colours. Every cap assertion needs more distinct entries
 *  than the cap itself, so the fixture must be derived from it and never sized
 *  by hand — see the cap tests below for what a hand-sized one costs. */
const distinctHexes = (n: number) =>
  Array.from({ length: n }, (_, i) => `#${i.toString(16).padStart(6, '0')}`);

describe('recents grid', () => {
  it('is two rows of six — twelve slots', () => {
    // Pinned as LITERALS deliberately. `.palette-pop__row` in
    // PaletteColorPicker.css declares `grid-template-columns: repeat(6, 20px)`
    // and the popover's 169px width is derived from that count; CSS cannot read
    // a TS const, so the six is ONE decision expressed twice, and moving it
    // here without moving it there reflows every row to 5 + 1.
    expect(SWATCHES_PER_ROW).toBe(6);
    expect(RECENT_COLOR_ROWS).toBe(2);
    // Twelve because the shipped palettes are 12 colours and 12 = 2 x 6: each
    // built-in fills exactly two full rows, so the recents beneath them line up
    // instead of ending in the ragged 5 + 5 + 2 a five-column grid drew.
    expect(MAX_RECENT_COLORS).toBe(12);
  });

  it('remembers exactly as many colours as the picker can draw', () => {
    // A longer tail would be persisted but unreachable, which reads as colours
    // going missing rather than as a bounded MRU.
    expect(MAX_RECENT_COLORS).toBe(RECENT_COLOR_ROWS * SWATCHES_PER_ROW);
  });
});

describe('normalizeHex', () => {
  it('accepts exactly 6-digit hex and canonicalizes case', () => {
    expect(normalizeHex('#ff0000')).toBe('#ff0000');
    expect(normalizeHex('#FF0000')).toBe('#ff0000');
    expect(normalizeHex('  #AbCdEf  ')).toBe('#abcdef');
  });

  it.each([
    ['shorthand', '#abc'],
    ['8-digit alpha', '#ff0000aa'],
    ['no hash', 'ff0000'],
    ['named colour', 'red'],
    ['css function', 'rgb(255,0,0)'],
    // Rendered into style.background — a non-hex string would be CSS injection.
    ['css injection', '#ff0000;background:url(//evil)'],
    ['number', 0xff0000],
    ['null', null],
    ['object', {}],
  ])('rejects %s', (_label, bad) => {
    expect(normalizeHex(bad)).toBeNull();
  });
});

describe('sanitizeRecentColors', () => {
  it('drops invalid entries, dedupes, and preserves order', () => {
    expect(
      sanitizeRecentColors(['#ff0000', 'red', '#FF0000', null, '#00ff00']),
    ).toEqual(['#ff0000', '#00ff00']);
  });

  it('caps the list at the head, dropping the tail', () => {
    // The fixture must hold more DISTINCT colours than the cap. It used to
    // cycle `i % 10`, so it only ever produced ten distinct entries and the
    // assertion held for any cap of ten or more — it stopped exercising the cap
    // the moment the grid grew from 5x2 to 6x2.
    const many = distinctHexes(MAX_RECENT_COLORS * 4);
    expect(sanitizeRecentColors(many)).toEqual(many.slice(0, MAX_RECENT_COLORS));
  });

  it('dedupes BEFORE capping, so repeats do not eat slots', () => {
    // A stored list is written head-first and re-read on every popover open; if
    // the cap were applied to the raw input, a run of repeats near the head
    // would truncate the list short of the two rows the picker draws.
    const uniques = distinctHexes(MAX_RECENT_COLORS);
    const withRepeats = uniques.flatMap((c) => [c, c.toUpperCase(), c]);
    expect(sanitizeRecentColors(withRepeats)).toEqual(uniques);
  });

  it.each([[null], [undefined], ['nope'], [42], [{}]])('returns [] for non-array %s', (bad) => {
    expect(sanitizeRecentColors(bad)).toEqual([]);
  });
});

describe('pushRecentColor', () => {
  it('inserts at the head', () => {
    expect(pushRecentColor(['#00ff00'], '#ff0000')).toEqual(['#ff0000', '#00ff00']);
  });

  it('moves an existing colour to the head without duplicating it', () => {
    expect(pushRecentColor(['#00ff00', '#ff0000'], '#ff0000')).toEqual(['#ff0000', '#00ff00']);
  });

  it('returns the SAME reference when the colour is already at the head', () => {
    const list = ['#ff0000', '#00ff00'];
    expect(pushRecentColor(list, '#ff0000')).toBe(list);
    // Case-insensitively, too — otherwise one colour occupies two slots.
    expect(pushRecentColor(list, '#FF0000')).toBe(list);
  });

  it('returns the SAME reference for an invalid colour', () => {
    const list = ['#ff0000'];
    expect(pushRecentColor(list, 'red')).toBe(list);
  });

  it('never grows past the cap, and evicts the oldest first', () => {
    const picks = distinctHexes(MAX_RECENT_COLORS * 3);
    let list: string[] = [];
    for (const hex of picks) list = pushRecentColor(list, hex);
    expect(list).toHaveLength(MAX_RECENT_COLORS);
    // Newest-first, holding exactly the last cap-full of picks: an MRU that
    // dropped from the head instead would forget the colour just chosen.
    expect(list).toEqual([...picks.slice(-MAX_RECENT_COLORS)].reverse());
  });
});

describe('persistence', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
  });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('round-trips through localStorage', () => {
    expect(getRecentColors()).toEqual([]);
    noteColorUsed('#ff0000');
    noteColorUsed('#00ff00');
    expect(getRecentColors()).toEqual(['#00ff00', '#ff0000']);
  });

  it('noteColorUsed returns null and writes nothing on a repeat pick', () => {
    noteColorUsed('#ff0000');
    expect(noteColorUsed('#ff0000')).toBeNull();
    expect(noteColorUsed('bogus')).toBeNull();
  });

  it('sanitizes a tampered stored value rather than trusting it', () => {
    localStorage.setItem(
      RECENT_COLORS_KEY,
      JSON.stringify(['#ff0000', 'javascript:alert(1)', '#zzzzzz', '#00ff00']),
    );
    expect(getRecentColors()).toEqual(['#ff0000', '#00ff00']);
  });

  it('caps a longer list left by another build on READ, not just on write', () => {
    // The key outlives the grid: a hand-edited value — or one written by a
    // build with different row/column counts — must not be trusted, or the
    // picker would draw a third, clipped row of recents.
    const many = distinctHexes(MAX_RECENT_COLORS * 2);
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(many));
    expect(getRecentColors()).toEqual(many.slice(0, MAX_RECENT_COLORS));
  });

  it('survives malformed JSON and a non-array payload', () => {
    localStorage.setItem(RECENT_COLORS_KEY, '{not json');
    expect(getRecentColors()).toEqual([]);
    localStorage.setItem(RECENT_COLORS_KEY, '"a string"');
    expect(getRecentColors()).toEqual([]);
  });

  it('strips prototype-polluting keys on read', () => {
    localStorage.setItem(RECENT_COLORS_KEY, '{"__proto__":{"polluted":1}}');
    expect(getRecentColors()).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not throw when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('denied'); },
    });
    expect(getRecentColors()).toEqual([]);
    expect(() => noteColorUsed('#ff0000')).not.toThrow();
    expect(() => clearRecentColors()).not.toThrow();
  });

  it('clearRecentColors empties the list', () => {
    noteColorUsed('#ff0000');
    clearRecentColors();
    expect(getRecentColors()).toEqual([]);
  });
});
