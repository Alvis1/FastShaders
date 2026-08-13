/**
 * The Palettes modal's pure decisions. The dialog itself cannot be covered —
 * the vitest environment is `node` with no jsdom — so everything that could
 * actually be wrong was moved into `paletteUi.ts` and is tested here.
 *
 * The load-bearing case is `refusePaletteFile`: it exists to be called on a
 * `File` BEFORE `await file.text()`, and an audit specifically found that
 * gating after the decode is not a gate at all.
 *
 * The colour edits carry the second one. `names[i]` labels `colors[i]`, so
 * every insert, removal and move has to shift BOTH arrays in lockstep. The
 * realistic regression is an off-by-one — touch `colors` and forget `names`,
 * and every later label slides one swatch over — which renders perfectly and
 * looks like working software. So the edits are asserted as (colour, label)
 * PAIRS rather than as two arrays that happen to look plausible side by side.
 */
import { describe, it, expect } from 'vitest';
import {
  canAddColor,
  canAddPalette,
  importOutcome,
  nextPaletteColor,
  paletteExportFileName,
  planPaletteImport,
  refusePaletteFile,
  withColorAt,
  withColorInserted,
  withColorMoved,
  withColorNameAt,
  withColorRemoved,
  type ColorList,
} from './paletteUi';
import {
  MAX_COLORS_PER_PALETTE,
  MAX_PALETTE_FILE_BYTES,
  MAX_PALETTES_PER_SHADER,
  type Palette,
} from './palettes';

const pal = (name: string, colors: string[] = ['#ff0000']): Palette => ({
  id: `id-${name}`,
  name,
  colors,
});

/** A colour list. `names` is OMITTED when not given, because an absent key is
 *  exactly what an unlabelled palette carries — passing `undefined` explicitly
 *  would test a shape the model never stores. */
const list = (colors: string[], names?: string[]): ColorList =>
  names ? { colors, names } : { colors };

/** (colour, label) pairs — the only form in which a misalignment is visible.
 *  `colors` and `names` can each be individually correct while every label
 *  sits on the wrong swatch. */
const pairs = (l: ColorList): Array<[string, string]> =>
  l.colors.map((c, i) => [c, l.names?.[i] ?? '']);

describe('refusePaletteFile', () => {
  it('accepts a file at the cap and refuses one byte over', () => {
    expect(refusePaletteFile({ size: MAX_PALETTE_FILE_BYTES })).toBeNull();
    expect(refusePaletteFile({ size: MAX_PALETTE_FILE_BYTES + 1 })).toBe('too-large');
  });

  it('refuses a huge file — the case the gate exists for', () => {
    expect(refusePaletteFile({ size: 500 * 1024 * 1024 })).toBe('too-large');
  });

  it('refuses an empty or nonsensical size rather than letting it through', () => {
    expect(refusePaletteFile({ size: 0 })).toBe('empty');
    expect(refusePaletteFile({ size: -1 })).toBe('empty');
    expect(refusePaletteFile({ size: NaN })).toBe('empty');
    expect(refusePaletteFile({ size: undefined as unknown as number })).toBe('empty');
  });

  it('accepts an ordinary palette file', () => {
    expect(refusePaletteFile({ size: 2048 })).toBeNull();
  });
});

describe('planPaletteImport', () => {
  const parsed = (n: number, notes: string[] = []) => ({
    palettes: Array.from({ length: n }, (_, i) => pal(`p${i}`)),
    notes,
  });

  it('accepts everything when there is room', () => {
    const plan = planPaletteImport(0, parsed(3));
    expect(plan.accept).toHaveLength(3);
    expect(plan.overflow).toBe(0);
  });

  it('truncates to the remaining room and reports the overflow', () => {
    const plan = planPaletteImport(MAX_PALETTES_PER_SHADER - 2, parsed(5));
    expect(plan.accept).toHaveLength(2);
    expect(plan.overflow).toBe(3);
    // File order is preserved — the first two, not an arbitrary two.
    expect(plan.accept.map((p) => p.name)).toEqual(['p0', 'p1']);
  });

  it('accepts nothing when the shader is already full', () => {
    const plan = planPaletteImport(MAX_PALETTES_PER_SHADER, parsed(2));
    expect(plan.accept).toEqual([]);
    expect(plan.overflow).toBe(2);
  });

  it('passes the parser notes through as a copy', () => {
    const notes = ['2 palette(s) skipped or truncated.'];
    const plan = planPaletteImport(0, parsed(1, notes));
    expect(plan.notes).toEqual(notes);
    expect(plan.notes).not.toBe(notes);
  });

  it('survives a junk count and a junk parse result', () => {
    expect(planPaletteImport(NaN, parsed(1)).accept).toHaveLength(1);
    expect(planPaletteImport(-5, parsed(1)).accept).toHaveLength(1);
    const junk = { palettes: undefined, notes: undefined } as unknown as ReturnType<typeof parsed>;
    expect(planPaletteImport(0, junk)).toEqual({ accept: [], overflow: 0, notes: [] });
  });
});

describe('importOutcome', () => {
  it('reports nothing when nothing landed', () => {
    expect(importOutcome(0, 0, false)).toBe('nothing');
    expect(importOutcome(0, 3, true)).toBe('nothing');
  });

  it('reports partial when something was dropped or truncated', () => {
    expect(importOutcome(2, 1, false)).toBe('partial');
    // Every palette landed, but the parser clipped colours — still a loss.
    expect(importOutcome(2, 0, true)).toBe('partial');
  });

  it('reports ok only for a clean import', () => {
    expect(importOutcome(2, 0, false)).toBe('ok');
  });
});

describe('paletteExportFileName', () => {
  it('names a single-palette export after the shader and the palette', () => {
    expect(paletteExportFileName('My Shader', pal('Sunset Ramp'), 'gpl')).toBe(
      'my-shader-sunset-ramp.gpl',
    );
    expect(paletteExportFileName('My Shader', pal('Sunset Ramp'), 'json')).toBe(
      'my-shader-sunset-ramp.json',
    );
  });

  it('names an export-all after the shader alone', () => {
    expect(paletteExportFileName('My Shader', null, 'json')).toBe('my-shader-palettes.json');
  });

  it('falls back rather than emitting a bare extension', () => {
    expect(paletteExportFileName('', null, 'json')).toBe('shader-palettes.json');
    expect(paletteExportFileName('   ', pal('***'), 'gpl')).toBe('shader-palette.gpl');
    expect(paletteExportFileName(undefined as unknown as string, null, 'json')).toBe(
      'shader-palettes.json',
    );
  });

  it('strips path and quote characters a typed name could carry', () => {
    expect(paletteExportFileName('a/../b', pal('c"d'), 'json')).toBe('a-b-c-d.json');
  });
});

describe('colour edits', () => {
  const base = list(['#ff0000', '#00ff00', '#0000ff']);

  // The identity return is the ORIGINAL OBJECT, not merely an equal one:
  // `PalettesModal.editColors` compares `next === current` to skip the store
  // round-trip entirely, so returning a fresh `{colors}` here would quietly
  // turn every refused edit into a real (no-op) write plus an undo entry.
  it('withColorAt replaces, and returns the SAME OBJECT on a no-op', () => {
    expect(withColorAt(base, 1, '#ffffff').colors).toEqual(['#ff0000', '#ffffff', '#0000ff']);
    expect(withColorAt(base, 1, '#00ff00')).toBe(base); // unchanged value
    expect(withColorAt(base, 9, '#ffffff')).toBe(base); // out of range
    expect(withColorAt(base, -1, '#ffffff')).toBe(base);
  });

  it('withColorInserted inserts at a clamped index and stops at the cap', () => {
    expect(withColorInserted(base, 0, '#ffffff').colors[0]).toBe('#ffffff');
    expect(withColorInserted(base, 99, '#ffffff').colors).toHaveLength(4);
    expect(withColorInserted(base, 99, '#ffffff').colors[3]).toBe('#ffffff');
    // The index comes from a drag-and-drop, so it is not guaranteed to be a
    // usable number at all; a non-finite one lands at the front rather than
    // splicing at NaN (which appends silently and looks like a clamp bug).
    expect(withColorInserted(base, NaN, '#ffffff').colors[0]).toBe('#ffffff');
    const full = list(Array.from({ length: MAX_COLORS_PER_PALETTE }, () => '#000000'));
    expect(withColorInserted(full, 0, '#ffffff')).toBe(full);
  });

  it('withColorRemoved refuses to empty the palette', () => {
    expect(withColorRemoved(base, 1).colors).toEqual(['#ff0000', '#0000ff']);
    const one = list(['#ff0000']);
    expect(withColorRemoved(one, 0)).toBe(one);
    expect(withColorRemoved(base, 9)).toBe(base);
  });

  it('withColorMoved reorders without sorting', () => {
    expect(withColorMoved(base, 0, 2).colors).toEqual(['#00ff00', '#0000ff', '#ff0000']);
    expect(withColorMoved(base, 2, 0).colors).toEqual(['#0000ff', '#ff0000', '#00ff00']);
    expect(withColorMoved(base, 1, 1)).toBe(base);
    expect(withColorMoved(base, 0, 9)).toBe(base);
  });

  it('withColorNameAt renames, clears on empty, and no-ops off the ends', () => {
    const labelled = list(['#ff0000', '#00ff00'], ['Red', 'Green']);
    expect(withColorNameAt(labelled, 1, 'Leaf').names).toEqual(['Red', 'Leaf']);
    expect(withColorNameAt(labelled, 0, '').names).toEqual(['', 'Green']);
    expect(withColorNameAt(labelled, 1, 'Green')).toBe(labelled); // unchanged
    expect(withColorNameAt(labelled, 9, 'Nope')).toBe(labelled);
    // Asking an unlabelled palette for the label it already has (none).
    expect(withColorNameAt(base, 0, '')).toBe(base);
  });

  it('carries the raw label through — sanitizing is the STORE boundary', () => {
    // These are list edits, not a trust boundary. Every write reaches the model
    // through `updatePalette` -> `sanitizePalettes` -> `sanitizeColorName`,
    // which is where the bidi override and MAX_COLOR_NAME are enforced. Pinning
    // the pass-through is what keeps a second, divergent sanitizer from growing
    // here — two of them disagreeing is how a label survives one path and not
    // the other.
    const labelled = list(['#ff0000'], ['Red']);
    // Escaped, never literal: `sourceControlBytes.test.ts` fails the build on a
    // raw bidi override in a source file.
    expect(withColorNameAt(labelled, 0, 'a\u202eb').names).toEqual(['a\u202eb']);
  });

  it('never mutates the input arrays', () => {
    const colors = ['#ff0000', '#00ff00', '#0000ff'];
    const names = ['Red', '', 'Blue'];
    const src: ColorList = { colors, names };
    withColorAt(src, 0, '#ffffff');
    withColorNameAt(src, 0, 'Crimson');
    withColorInserted(src, 0, '#ffffff');
    withColorRemoved(src, 0);
    withColorMoved(src, 0, 2);
    expect(colors).toEqual(['#ff0000', '#00ff00', '#0000ff']);
    expect(names).toEqual(['Red', '', 'Blue']);
  });
});

describe('colour edits keep every label on its own colour', () => {
  // Every slot carries a DISTINCT label on purpose: with two empty ones, the
  // classic off-by-one (shift the colours, leave `names` alone) still passes.
  const labelled = list(['#ff0000', '#00ff00', '#0000ff'], ['Red', 'Green', 'Blue']);

  it('withColorAt moves nothing — only the hex under one label changes', () => {
    expect(pairs(withColorAt(labelled, 1, '#123456'))).toEqual([
      ['#ff0000', 'Red'],
      ['#123456', 'Green'],
      ['#0000ff', 'Blue'],
    ]);
  });

  it('withColorInserted shifts every later label along with its colour', () => {
    expect(pairs(withColorInserted(labelled, 1, '#123456'))).toEqual([
      ['#ff0000', 'Red'],
      ['#123456', ''],
      ['#00ff00', 'Green'],
      ['#0000ff', 'Blue'],
    ]);
    // Both ends too — a clamped index is the one most likely to splice `names`
    // at a different place than `colors`.
    expect(pairs(withColorInserted(labelled, 0, '#123456'))).toEqual([
      ['#123456', ''],
      ['#ff0000', 'Red'],
      ['#00ff00', 'Green'],
      ['#0000ff', 'Blue'],
    ]);
    expect(pairs(withColorInserted(labelled, 99, '#123456'))).toEqual([
      ['#ff0000', 'Red'],
      ['#00ff00', 'Green'],
      ['#0000ff', 'Blue'],
      ['#123456', ''],
    ]);
  });

  it('withColorRemoved takes the removed colour\'s label with it', () => {
    expect(pairs(withColorRemoved(labelled, 0))).toEqual([
      ['#00ff00', 'Green'],
      ['#0000ff', 'Blue'],
    ]);
    // Removing from the middle is where a stale `names` array shows up as
    // "Green" on the blue swatch.
    expect(pairs(withColorRemoved(labelled, 1))).toEqual([
      ['#ff0000', 'Red'],
      ['#0000ff', 'Blue'],
    ]);
  });

  it('withColorMoved carries the label with the colour, both directions', () => {
    expect(pairs(withColorMoved(labelled, 0, 2))).toEqual([
      ['#00ff00', 'Green'],
      ['#0000ff', 'Blue'],
      ['#ff0000', 'Red'],
    ]);
    expect(pairs(withColorMoved(labelled, 2, 0))).toEqual([
      ['#0000ff', 'Blue'],
      ['#ff0000', 'Red'],
      ['#00ff00', 'Green'],
    ]);
  });

  it('pads a short `names` array rather than going ragged', () => {
    // A partially-labelled palette is the normal case (you name the two colours
    // that matter). Padding on the edit path is what stops the unlabelled tail
    // from being filled by whatever the splice shifted into it.
    const partial = list(['#ff0000', '#00ff00', '#0000ff'], ['Red']);
    expect(pairs(withColorInserted(partial, 1, '#123456'))).toEqual([
      ['#ff0000', 'Red'],
      ['#123456', ''],
      ['#00ff00', ''],
      ['#0000ff', ''],
    ]);
    // And a names array LONGER than colors is truncated, not carried forward as
    // a label with no swatch to sit on.
    const overlong = list(['#ff0000', '#00ff00'], ['Red', 'Green', 'Ghost']);
    expect(withColorMoved(overlong, 0, 1).names).toEqual(['Green', 'Red']);
  });
});

describe('the decisions the colour edits pin', () => {
  it('withColorAt KEEPS the label — the palette is the user\'s to rename', () => {
    // Nudging a hex says nothing about the name, and the editor offers a rename
    // beside each swatch. Clearing the label on every colour tweak would make
    // naming something you have to redo rather than something you set once.
    const labelled = list(['#ff0000'], ['Gold']);
    expect(withColorAt(labelled, 0, '#ffe39d').names).toEqual(['Gold']);
  });

  it('withColorInserted gives the NEW colour an EMPTY label and disturbs no neighbour', () => {
    // There is nothing true to call a colour that has just appeared. Borrowing
    // a neighbour's name — precisely the shape an un-shifted `names` array
    // produces — would be a confident lie rather than a missing label.
    const labelled = list(['#ff0000', '#0000ff'], ['Red', 'Blue']);
    expect(withColorInserted(labelled, 1, '#00ff00').names).toEqual(['Red', '', 'Blue']);
  });

  it('drops the `names` key entirely once nothing is labelled', () => {
    // `updatePalette` reads an ABSENT `names` as "keep the ones you have". An
    // edit that left an all-empty array behind would therefore hand the store a
    // list it treats as real, and on a SHORTER colour list the old labels slide
    // one swatch over. (`PalettesModal` converts absent to `[]` for exactly this
    // reason — but the stale array must not exist here in the first place.)
    const onlyLabel = list(['#ff0000', '#00ff00'], ['Red', '']);

    const cleared = withColorNameAt(onlyLabel, 0, '');
    expect('names' in cleared).toBe(false);
    expect(cleared.names).toBeUndefined();

    // Same when a removal is what takes the last label away.
    expect('names' in withColorRemoved(onlyLabel, 0)).toBe(false);

    // And the stale shape itself — an explicitly all-empty array — is not
    // carried forward by an unrelated edit.
    const allEmpty = list(['#ff0000', '#00ff00'], ['', '']);
    expect('names' in withColorAt(allEmpty, 0, '#ffffff')).toBe(false);
    expect('names' in withColorMoved(allEmpty, 0, 1)).toBe(false);
  });

  it('an UNLABELLED palette never grows a `names` key through any edit', () => {
    // The absent key is what keeps every pre-names payload byte-identical (the
    // `anyName` rule in `sanitizeOne`). An edit that materialized `['','','']`
    // would move bytes in the autosave, every history entry and the project
    // block of a palette nobody has named.
    const plain = list(['#ff0000', '#00ff00', '#0000ff']);
    const edits: ColorList[] = [
      withColorAt(plain, 0, '#ffffff'),
      withColorInserted(plain, 1, '#ffffff'),
      withColorRemoved(plain, 1),
      withColorMoved(plain, 0, 2),
      withColorNameAt(plain, 0, ''),
    ];
    for (const next of edits) expect('names' in next).toBe(false);
  });
});

describe('caps and the new-colour seed', () => {
  it('nextPaletteColor is visibly different from the last swatch', () => {
    expect(nextPaletteColor(['#ff0000'])).toBe('#ffffff');
    expect(nextPaletteColor(['#ffffff'])).toBe('#808080');
    expect(nextPaletteColor([])).toBe('#ffffff');
  });

  it('canAddPalette / canAddColor gate exactly at the documented caps', () => {
    expect(canAddPalette(MAX_PALETTES_PER_SHADER - 1)).toBe(true);
    expect(canAddPalette(MAX_PALETTES_PER_SHADER)).toBe(false);
    expect(canAddColor(MAX_COLORS_PER_PALETTE - 1)).toBe(true);
    expect(canAddColor(MAX_COLORS_PER_PALETTE)).toBe(false);
  });
});
