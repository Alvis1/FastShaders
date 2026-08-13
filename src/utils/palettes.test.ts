import { describe, it, expect } from 'vitest';
import {
  sanitizePalettes,
  sanitizePaletteName,
  sanitizeColorName,
  parsePaletteFile,
  parseGpl,
  parseHexList,
  emitPaletteJson,
  emitGpl,
  collectGraphColors,
  mintPaletteId,
  MAX_PALETTES_PER_SHADER,
  MAX_COLORS_PER_PALETTE,
  MAX_PALETTE_NAME,
  MAX_COLOR_NAME,
  MAX_PASTE_CHARS,
  type Palette,
} from './palettes';
import { BUILTIN_PALETTES, isBuiltinPaletteId } from '@/registry/builtinPalettes';

const pal = (over: Partial<Palette> = {}): Palette => ({
  id: 'p1', name: 'P', colors: ['#ff0000'], ...over,
});

describe('sanitizePaletteName', () => {
  it('keeps ordinary names', () => {
    expect(sanitizePaletteName('Sunset Ramp')).toBe('Sunset Ramp');
  });

  it('falls back for non-strings and empties', () => {
    expect(sanitizePaletteName(null)).toBe('Palette');
    expect(sanitizePaletteName('   ')).toBe('Palette');
    expect(sanitizePaletteName(42)).toBe('Palette');
  });

  it('strips control characters and bidi overrides', () => {
    // A bidi override in a label reorders the surrounding UI text.
    expect(sanitizePaletteName('a\u202eb\u0000c')).toBe('abc');
  });

  it('caps by CODE POINTS so an emoji counts as one', () => {
    const emoji = '🎨'.repeat(MAX_PALETTE_NAME + 10);
    expect([...sanitizePaletteName(emoji)]).toHaveLength(MAX_PALETTE_NAME);
  });
});

describe('sanitizeColorName', () => {
  it('keeps an ordinary label, qualifier and all', () => {
    // The qualifier IS the label's point ("approx." says the value is not a
    // measurement), so the cap has to be generous enough to keep it.
    expect(sanitizeColorName('Brass (alloy, approx.)')).toBe('Brass (alloy, approx.)');
  });

  it('returns "" rather than a fallback — a colour may simply have no label', () => {
    // The palette NAME falls back to 'Palette'; a colour label must not, or
    // every unlabelled swatch would grow a meaningless tooltip.
    expect(sanitizeColorName(null)).toBe('');
    expect(sanitizeColorName(undefined)).toBe('');
    expect(sanitizeColorName(42)).toBe('');
    expect(sanitizeColorName('   ')).toBe('');
    expect(sanitizeColorName('\u0000\u0000')).toBe('');
  });

  it('turns whitespace controls into a SPACE, collapsing runs', () => {
    // Deleting them would weld words together ("Deep\tGold" -> "DeepGold"),
    // which is why this range is replaced rather than stripped.
    expect(sanitizeColorName('Deep\tGold')).toBe('Deep Gold');
    expect(sanitizeColorName('Deep\r\n\u000b\u000cGold')).toBe('Deep Gold');
    // Leading/trailing ones collapse to spaces and are then trimmed away.
    expect(sanitizeColorName('\tGold\n')).toBe('Gold');
  });

  it('DELETES NUL and bidi overrides rather than spacing them', () => {
    // A right-to-left override reorders the surrounding UI text (the classic
    // filename-spoofing trick) and a NUL makes the whole source file read as
    // binary to grep — neither is a word separator, so neither becomes a space.
    expect(sanitizeColorName('a\u202eb\u0000c')).toBe('abc');
    expect(sanitizeColorName('Go\u200eld')).toBe('Gold');
  });

  it('caps by CODE POINTS so an emoji counts as one', () => {
    const emoji = '🎨'.repeat(MAX_COLOR_NAME + 10);
    expect([...sanitizeColorName(emoji)]).toHaveLength(MAX_COLOR_NAME);
  });
});

describe('sanitizePalettes', () => {
  it('keeps only 6-digit hex, in order, allowing duplicates (ramps)', () => {
    const [p] = sanitizePalettes([
      { name: 'R', colors: ['#FF0000', 'red', '#abc', '#ff0000aa', '#00ff00', null] },
    ]);
    expect(p.colors).toEqual(['#ff0000', '#00ff00']);
  });

  it.each([[null], [undefined], ['x'], [42], [{}]])('returns [] for non-array %s', (bad) => {
    expect(sanitizePalettes(bad)).toEqual([]);
  });

  it('drops a palette with no usable colour', () => {
    expect(sanitizePalettes([{ name: 'empty', colors: ['red', 'blue'] }])).toEqual([]);
    expect(sanitizePalettes([{ name: 'nocolors' }])).toEqual([]);
  });

  it('caps palettes and colours', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ name: `p${i}`, colors: ['#ff0000'] }));
    expect(sanitizePalettes(many)).toHaveLength(MAX_PALETTES_PER_SHADER);
    const wide = [{ name: 'w', colors: Array.from({ length: 500 }, () => '#123456') }];
    expect(sanitizePalettes(wide)[0].colors).toHaveLength(MAX_COLORS_PER_PALETTE);
  });

  // `_` is in the id charset, so these MATCH it — safeJsonReviver does not
  // help, because it strips keys named __proto__, not string VALUES.
  it.each(['__proto__', 'constructor', 'prototype'])('never adopts the reserved id %s', (bad) => {
    const [p] = sanitizePalettes([{ id: bad, name: 'x', colors: ['#ff0000'] }]);
    expect(p.id).not.toBe(bad);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects ids outside the charset and de-duplicates collisions', () => {
    const out = sanitizePalettes([
      { id: 'has space', name: 'a', colors: ['#ff0000'] },
      { id: 'same', name: 'b', colors: ['#00ff00'] },
      { id: 'same', name: 'c', colors: ['#0000ff'] },
    ]);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((p) => p.id)).size).toBe(3);
    expect(out[0].id).not.toBe('has space');
  });

  it('mints unique ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintPaletteId()));
    expect(ids.size).toBe(200);
  });
});

describe('per-colour names: the alignment', () => {
  it('drops a rejected colour TOGETHER WITH ITS LABEL', () => {
    // THE regression guard for this whole feature. A second-pass or
    // slice-based `names` read keeps one colour and labels it "Sky" — the hex
    // that was thrown away — which looks like working software right up until
    // someone reads the tooltip. One loop over the SOURCE indices is what
    // makes that impossible.
    const [p] = sanitizePalettes([{ colors: ['bogus', '#ff0000'], names: ['Sky', 'Gold'] }]);
    expect(p.colors).toEqual(['#ff0000']);
    expect(p.names).toEqual(['Gold']);
  });

  it('holds the alignment across several rejections, not just one', () => {
    const [p] = sanitizePalettes([{
      colors: ['#ff0000', 'red', '#00ff00', '#abc', null, '#0000ff'],
      names: ['Red', 'REJECTED', 'Green', 'REJECTED', 'REJECTED', 'Blue'],
    }]);
    expect(p.colors).toEqual(['#ff0000', '#00ff00', '#0000ff']);
    expect(p.names).toEqual(['Red', 'Green', 'Blue']);
  });

  it('pads a SHORT names array with "" instead of going ragged', () => {
    const [p] = sanitizePalettes([{ colors: ['#ff0000', '#00ff00', '#0000ff'], names: ['Red'] }]);
    expect(p.names).toEqual(['Red', '', '']);
    expect(p.names).toHaveLength(p.colors.length);
  });

  it('ignores the tail of a LONG names array', () => {
    // `names` is built from `colors`, so surplus labels have no colour to
    // attach to and simply never enter the palette.
    const [p] = sanitizePalettes([{ colors: ['#ff0000'], names: ['Red', 'Green', 'Blue'] }]);
    expect(p.names).toEqual(['Red']);
  });

  it.each([['a string'], [42], [{ 0: 'Sky' }], [null]])(
    'treats a non-array names (%s) as no labels at all',
    (bad) => {
      const [p] = sanitizePalettes([{ colors: ['#ff0000'], names: bad }]);
      expect(p.colors).toEqual(['#ff0000']);
      expect('names' in p).toBe(false);
    },
  );

  it('sanitizes each label, and holes/non-strings become ""', () => {
    // A hole (index 1 was never assigned) reads as undefined, which is the
    // same "no label" answer as a number or a control-only string.
    const sparse: unknown[] = ['Red'];
    sparse[3] = 'Blue';
    sparse[2] = 42;
    const [p] = sanitizePalettes([{
      colors: ['#ff0000', '#00ff00', '#0000ff', '#ffff00'],
      names: sparse,
    }]);
    expect(p.names).toEqual(['Red', '', '', 'Blue']);
  });

  it('runs every label through sanitizeColorName', () => {
    const [p] = sanitizePalettes([{ colors: ['#ff0000'], names: ['Deep\tGo\u0000ld'] }]);
    expect(p.names).toEqual(['Deep Gold']);
  });

  it('stops BOTH arrays together at the per-palette colour cap', () => {
    // The cap breaks the loop mid-way, so it is the other place the two arrays
    // could part company. The leading reject also shifts every label by one,
    // which pins that the cap counts KEPT colours while the labels are still
    // read at their SOURCE index.
    const colors = ['bogus', ...Array.from({ length: MAX_COLORS_PER_PALETTE + 5 }, () => '#123456')];
    const names = colors.map((_, i) => `n${i}`);
    const [p] = sanitizePalettes([{ colors, names }]);
    expect(p.colors).toHaveLength(MAX_COLORS_PER_PALETTE);
    expect(p.names).toHaveLength(MAX_COLORS_PER_PALETTE);
    expect(p.names![0]).toBe('n1');
    expect(p.names![MAX_COLORS_PER_PALETTE - 1]).toBe(`n${MAX_COLORS_PER_PALETTE}`);
  });
});

describe('an unlabelled palette carries NO names key', () => {
  // Not cosmetic. Whole-object `toEqual` assertions elsewhere —
  // engine/paletteProject.test.ts and store/palettes.store.test.ts both compare
  // against bare `{ id, name, colors }` literals — pass only because the key is
  // OMITTED rather than emitted empty. That omission is also what keeps every
  // pre-names autosave, history entry and project block byte-identical.
  it('omits the key when `names` was never supplied', () => {
    const [p] = sanitizePalettes([{ name: 'Ramp', colors: ['#ff0000'] }]);
    expect('names' in p).toBe(false);
    expect(p).toEqual({ id: p.id, name: 'Ramp', colors: ['#ff0000'] });
  });

  it('omits the key when every supplied label sanitizes away', () => {
    // An all-empty array is the same information as no array, so storing one
    // would move a byte in every payload for nothing.
    const [p] = sanitizePalettes([{ colors: ['#ff0000', '#00ff00'], names: ['', '\u0000'] }]);
    expect('names' in p).toBe(false);
  });

  it('KEEPS the key as soon as one colour is labelled', () => {
    const [p] = sanitizePalettes([{ colors: ['#ff0000', '#00ff00'], names: ['', 'Green'] }]);
    expect(p.names).toEqual(['', 'Green']);
  });
});

describe('JSON format', () => {
  it('round-trips through emit -> parse', () => {
    const src = [pal({ name: 'Ramp', colors: ['#ff0000', '#00ff00'] })];
    const { palettes, notes } = parsePaletteFile(emitPaletteJson(src));
    expect(notes).toEqual([]);
    expect(palettes).toHaveLength(1);
    expect(palettes[0].name).toBe('Ramp');
    expect(palettes[0].colors).toEqual(['#ff0000', '#00ff00']);
  });

  it('does not emit local ids', () => {
    expect(emitPaletteJson([pal({ id: 'secret-local-id' })])).not.toContain('secret-local-id');
  });

  it('REFUSES a json without the format discriminator', () => {
    // A bare object could be a cost profile or a shader project; importing one
    // as colours silently is worse than a clear message.
    const r = parsePaletteFile(JSON.stringify({ palettes: [{ name: 'x', colors: ['#ff0000'] }] }));
    expect(r.palettes).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/FastShaders palette/i);
  });

  it('survives malformed json, empty input and a bare array', () => {
    expect(parsePaletteFile('{not json').palettes).toEqual([]);
    expect(parsePaletteFile('').palettes).toEqual([]);
    expect(parsePaletteFile('[1,2,3]').palettes).toEqual([]);
  });

  it('round-trips per-colour names', () => {
    const src = [pal({ name: 'Metals', colors: ['#ffe39d', '#fcfaf5'], names: ['Gold', 'Silver'] })];
    const [back] = parsePaletteFile(emitPaletteJson(src)).palettes;
    expect(back.colors).toEqual(['#ffe39d', '#fcfaf5']);
    expect(back.names).toEqual(['Gold', 'Silver']);
  });

  it('emits no names key for an unlabelled palette', () => {
    // Such a file is byte-identical to one written before names existed.
    expect(emitPaletteJson([pal({ colors: ['#ff0000'] })])).not.toContain('"names"');
    // Same for a palette whose labels are all empty — the array carries no
    // information, so writing it would move a byte for nothing.
    expect(emitPaletteJson([pal({ colors: ['#ff0000'], names: [''] })])).not.toContain('"names"');
  });

  it('re-aligns a SHORT names array on the way back in', () => {
    // `emitPaletteJson` does not pad, so the file really is ragged; the padding
    // happens at the trust boundary on parse.
    const json = emitPaletteJson([
      pal({ colors: ['#ff0000', '#00ff00', '#0000ff'], names: ['Red'] }),
    ]);
    const [back] = parsePaletteFile(json).palettes;
    expect(back.names).toEqual(['Red', '', '']);
  });

  it('cannot be misaligned by a hostile / ragged names array in the file text', () => {
    // Hand-written rather than emitted: an attacker writes the file, not us.
    const text = JSON.stringify({
      format: 'fastshaders-palette',
      version: 1,
      palettes: [{
        name: 'Ragged',
        colors: ['bogus', '#ff0000', '#00ff00'],
        names: ['Sky', 'Go\u0000ld'],
      }],
    });
    const [back] = parsePaletteFile(text).palettes;
    expect(back.colors).toEqual(['#ff0000', '#00ff00']);
    // 'Sky' belonged to the rejected colour and dies with it; the surviving
    // label is stripped like any other untrusted string; the unlabelled tail
    // pads rather than going ragged.
    expect(back.names).toEqual(['Gold', '']);
  });

  it('strips prototype pollution from an imported file', () => {
    const r = parsePaletteFile(
      '{"format":"fastshaders-palette","version":1,"__proto__":{"polluted":1},"palettes":[{"name":"a","colors":["#ff0000"]}]}',
    );
    expect(r.palettes).toHaveLength(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('GPL interop', () => {
  const GPL = `GIMP Palette
Name: Sunset
Columns: 4
#
255   0   0\tff0000
  0 255   0\t00ff00
# a comment line
 18  52  86\t123456
`;

  it('parses a real .gpl', () => {
    const p = parseGpl(GPL)!;
    expect(p.name).toBe('Sunset');
    expect(p.colors).toEqual(['#ff0000', '#00ff00', '#123456']);
  });

  it('round-trips emit -> parse', () => {
    const src = pal({ name: 'Ramp', colors: ['#010203', '#fffefd'] });
    const back = parseGpl(emitGpl(src))!;
    expect(back.name).toBe('Ramp');
    expect(back.colors).toEqual(src.colors);
  });

  it('rejects a file without the GIMP header', () => {
    expect(parseGpl('255 0 0\tff0000')).toBeNull();
  });

  it('clamps too-large channels and skips malformed lines', () => {
    // 999/300 are digit-shaped but out of range -> clamped to ff.
    expect(parseGpl('GIMP Palette\n#\n999 300 300\n')!.colors).toEqual(['#ffffff']);
    // A negative channel is not a GPL colour line at all -> line skipped, and
    // with nothing else in the file there is no palette to make.
    expect(parseGpl('GIMP Palette\n#\n999 -5 300\n')).toBeNull();
    // ...but a malformed line must not poison the valid ones around it.
    expect(parseGpl('GIMP Palette\n#\n1 2 3\nbroken\n4 5 6\n')!.colors)
      .toEqual(['#010203', '#040506']);
  });

  it('caps colours', () => {
    const huge = 'GIMP Palette\n#\n' + '1 2 3\n'.repeat(500);
    expect(parseGpl(huge)!.colors).toHaveLength(MAX_COLORS_PER_PALETTE);
  });

  it('is dispatched by parsePaletteFile on content, not extension', () => {
    expect(parsePaletteFile(GPL).palettes[0].colors).toEqual(['#ff0000', '#00ff00', '#123456']);
  });

  it('carries per-colour names through GPL\'s 4th field', () => {
    // The whole reason names are worth exporting: GIMP, Krita and Aseprite all
    // read this column, so a labelled palette arrives labelled.
    const src = sanitizePalettes([
      { name: 'Metals', colors: ['#ffe39d', '#fcfaf5'], names: ['Gold', 'Silver'] },
    ])[0];
    const back = parseGpl(emitGpl(src))!;
    expect(back.colors).toEqual(['#ffe39d', '#fcfaf5']);
    expect(back.names).toEqual(['Gold', 'Silver']);
  });

  it('keeps a PARTLY labelled palette aligned', () => {
    const src = sanitizePalettes([
      { name: 'Mixed', colors: ['#010203', '#040506', '#070809'], names: ['', 'Middle', ''] },
    ])[0];
    expect(parseGpl(emitGpl(src))!.names).toEqual(['', 'Middle', '']);
  });

  it('an UNLABELLED palette still writes the hex there, and reads back unlabelled', () => {
    // Every .gpl FastShaders has already exported puts the hex in the name
    // column (as do most other writers), so reading that back as a LABEL would
    // tag every swatch with its own hex — noise in a tooltip that shows the
    // hex anyway.
    const text = emitGpl(pal({ name: 'Ramp', colors: ['#010203', '#fffefd'] }));
    expect(text).toContain('\t010203');
    expect(text).toContain('\tfffefd');
    const back = parseGpl(text)!;
    expect(back.colors).toEqual(['#010203', '#fffefd']);
    expect('names' in back).toBe(false);
  });

  it('reads a foreign hex-in-the-name-column file as unlabelled too', () => {
    // The fixture above is exactly that shape, in upper case — the comparison
    // is case-insensitive because other writers are not consistent.
    const back = parseGpl('GIMP Palette\n#\n255 0 0\t#FF0000\n0 255 0\t00FF00\n')!;
    expect(back.colors).toEqual(['#ff0000', '#00ff00']);
    expect('names' in back).toBe(false);
  });

  it('leaves a colour line with no 4th field unlabelled', () => {
    expect('names' in parseGpl('GIMP Palette\n#\n1 2 3\n')!).toBe(false);
  });

  it('a label cannot forge an extra colour row or rename the palette', () => {
    // The defence is at the TRUST BOUNDARY, not in emitGpl: sanitizeColorName
    // turns the newline into a space, so the injected text stays inside the
    // label field of the row it was typed into. Routing through
    // sanitizePalettes is therefore the honest test — that is the only way a
    // palette with names ever reaches the exporter.
    const hostile = sanitizePalettes([{
      name: 'Safe',
      colors: ['#010203', '#040506'],
      names: ['Gold\n255 0 0\tInjected', 'Silver\nName: Pwned'],
    }])[0];
    const text = emitGpl(hostile);
    // 4 header lines + one row per colour, and nothing else.
    expect(text.trim().split('\n')).toHaveLength(6);
    const back = parseGpl(text)!;
    expect(back.name).toBe('Safe');
    expect(back.colors).toEqual(['#010203', '#040506']);
    expect(back.names).toEqual(['Gold 255 0 0 Injected', 'Silver Name: Pwned']);
  });
});

describe('paste box (lenient hex scan)', () => {
  it('reads a coolors.co URL', () => {
    const p = parseHexList('https://coolors.co/ffbe0b-fb5607-ff006e-8338ec-3a86ff')!;
    expect(p.colors).toEqual(['#ffbe0b', '#fb5607', '#ff006e', '#8338ec', '#3a86ff']);
  });

  it('reads a CSS block and a plain list', () => {
    expect(parseHexList('--a: #FF0000; --b: #00ff00;')!.colors).toEqual(['#ff0000', '#00ff00']);
  });

  it('returns null when there is nothing to find', () => {
    expect(parseHexList('no colours here')).toBeNull();
    expect(parseHexList(null)).toBeNull();
  });

  it('bounds an oversized paste before scanning', () => {
    // No File.size to gate on here, so the cap must be applied to the text.
    const huge = '#ff0000 '.repeat(MAX_PASTE_CHARS);
    expect(parseHexList(huge)!.colors.length).toBeLessThanOrEqual(MAX_COLORS_PER_PALETTE);
  });
});

describe('collectGraphColors', () => {
  it('gathers colour-bearing values in node order, deduped', () => {
    const nodes = [
      { data: { values: { hex: '#ff0000' } } },
      { data: { values: { hex: '#FF0000' } } }, // same colour, different case
      { data: { values: { lowColor: '#00ff00', highColor: '#0000ff' } } },
      { data: { values: { color: '#123456', emissive: 'not-a-colour' } } },
      { data: {} },
      {},
    ];
    expect(collectGraphColors(nodes)).toEqual(['#ff0000', '#00ff00', '#0000ff', '#123456']);
  });

  it('returns [] for an empty graph', () => {
    expect(collectGraphColors([])).toEqual([]);
  });
});

describe('builtin palettes', () => {
  it('ships four read-only palettes with unique ids and valid colours', () => {
    expect(BUILTIN_PALETTES).toHaveLength(4);
    expect(new Set(BUILTIN_PALETTES.map((p) => p.id)).size).toBe(4);
    for (const p of BUILTIN_PALETTES) {
      expect(sanitizePalettes([p])).toHaveLength(1);
      expect(isBuiltinPaletteId(p.id)).toBe(true);
    }
  });

  it('ships the four expected groups, twelve colours each', () => {
    expect(BUILTIN_PALETTES.map((p) => p.id)).toEqual([
      'builtin-emissive',
      'builtin-metals',
      'builtin-organics',
      'builtin-dielectrics',
    ]);
    for (const p of BUILTIN_PALETTES) expect(p.colors).toHaveLength(12);
  });

  it('names EVERY shipped colour, one label per hex', () => {
    // The name is the reason these palettes exist: '#ffe39d' means nothing,
    // "Gold" means everything. A hex that lost its label is content lost, and
    // a names array out of step with colors mislabels every swatch after it.
    for (const p of BUILTIN_PALETTES) {
      expect(p.names).toHaveLength(p.colors.length);
      for (const n of p.names!) expect(n).not.toBe('');
    }
  });

  it('ships no name the sanitizer would alter', () => {
    // MAX_COLOR_NAME is 40 and the longest shipped name is well under it, so
    // this passes today — it exists to fail LOUDLY if someone cuts the cap or
    // widens the strip set, either of which would silently truncate shipped
    // content ("Brass (alloy, approx.)" -> "Brass (alloy,") with nothing on
    // screen to say a label had been edited.
    for (const p of BUILTIN_PALETTES) {
      for (const n of p.names!) expect(sanitizeColorName(n)).toBe(n);
    }
  });

  it('survives sanitizePalettes with its labels intact', () => {
    // Builtins go through the same trust boundary as user data on every read,
    // so a shipped name that the sanitizer rejects would vanish in the UI
    // while still looking correct in this file.
    for (const p of BUILTIN_PALETTES) {
      const [clean] = sanitizePalettes([p]);
      expect(clean.colors).toEqual(p.colors);
      expect(clean.names).toEqual(p.names);
    }
  });

  it('isBuiltinPaletteId is false for a user palette', () => {
    expect(isBuiltinPaletteId(mintPaletteId())).toBe(false);
  });
});
