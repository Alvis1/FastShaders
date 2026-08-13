/**
 * The decisions behind the Palettes modal, kept OUT of the component.
 *
 * The vitest environment is `node` with no jsdom, so a React dialog cannot be
 * rendered in a test at all. Everything here is therefore the part that can
 * actually be wrong — the pre-decode file-size gate, the export file name, how
 * many palettes of an imported file fit, and the four colour-array edits — and
 * every one of them is a pure function with a unit test (`paletteUi.test.ts`).
 * The component is left as wiring.
 *
 * TWO CONVENTIONS RUN THROUGH THIS FILE.
 *
 * 1. The colour edits return the ORIGINAL object reference when the edit is a
 *    no-op (index out of range, would empty the palette, or the per-palette cap
 *    is reached). `updatePalette` already refuses an unchanged write, but an
 *    identity return lets the caller skip the store round-trip entirely and
 *    makes "this button did nothing" testable rather than inferred.
 *
 * 2. Nothing here calls `t()`. These functions return counts and discriminated
 *    reasons; the modal turns them into sentences, so the Latvian overlay stays
 *    a display concern and the logic stays testable without a language.
 */

import { toKebabCase } from '@/utils/nameUtils';
import {
  MAX_COLORS_PER_PALETTE,
  MAX_PALETTE_FILE_BYTES,
  MAX_PALETTES_PER_SHADER,
  type Palette,
  type PaletteParseResult,
} from '@/utils/palettes';

/* ============================================================
 * Import: the gate, then the plan
 * ============================================================ */

/** Why a picked file was refused before a single byte was decoded. */
export type PaletteFileRefusal = 'empty' | 'too-large';

/**
 * The pre-decode size gate. MUST be called on the `File` BEFORE
 * `await file.text()`: by the time text exists, a 500 MB file has already been
 * turned into a ~1 GB JS string, so a cap applied to the decoded text is not a
 * cap — it is a measurement taken after the damage.
 *
 * Takes the two `File` fields it needs rather than a `File`, so the rule is
 * testable in the `node` environment.
 */
export function refusePaletteFile(file: { size: number }): PaletteFileRefusal | null {
  const size = file?.size;
  // A non-finite / negative size is not a file we can reason about; treat it
  // the same as empty rather than letting it through the `>` comparison.
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return 'empty';
  if (size > MAX_PALETTE_FILE_BYTES) return 'too-large';
  return null;
}

export interface PaletteImportPlan {
  /** The palettes there is room for, in file order. */
  accept: Palette[];
  /** How many were dropped because the shader is already at its cap. */
  overflow: number;
  /** Non-fatal notes from the parser, passed through untouched. */
  notes: string[];
}

/**
 * Decide how much of a parsed file actually lands. The per-shader cap is
 * enforced HERE as well as in `addPalette` so the report can say how many did
 * not fit — the store action only ever answers null, which cannot be told apart
 * from "this palette had no usable colour".
 */
export function planPaletteImport(
  existingCount: number,
  parsed: PaletteParseResult,
): PaletteImportPlan {
  const have = Number.isFinite(existingCount) ? Math.max(0, Math.trunc(existingCount)) : 0;
  const room = Math.max(0, MAX_PALETTES_PER_SHADER - have);
  const incoming = Array.isArray(parsed?.palettes) ? parsed.palettes : [];
  const accept = incoming.slice(0, room);
  return {
    accept,
    overflow: incoming.length - accept.length,
    notes: Array.isArray(parsed?.notes) ? [...parsed.notes] : [],
  };
}

/** How the post-import message should read: plain confirmation, a warning that
 *  something was lost, or a flat failure. */
export type ImportOutcome = 'nothing' | 'partial' | 'ok';

/**
 * `hadNotes` covers the parser's own truncation/skip notes — a file whose
 * palettes all landed but whose colours were clipped at
 * MAX_COLORS_PER_PALETTE still lost something, and reporting that as a clean
 * success is how a silently halved palette becomes a bug report.
 */
export function importOutcome(added: number, overflow: number, hadNotes: boolean): ImportOutcome {
  if (added <= 0) return 'nothing';
  if (overflow > 0 || hadNotes) return 'partial';
  return 'ok';
}

/* ============================================================
 * Export
 * ============================================================ */

export type PaletteExportKind = 'json' | 'gpl';

/**
 * Download file name for a palette export.
 *
 * `palette: null` means "every palette in this shader", which is JSON-only —
 * a `.gpl` holds exactly ONE palette by construction (`emitGpl` takes a single
 * `Palette`), so the modal offers GPL per row and JSON for the whole set.
 *
 * Both halves go through `toKebabCase`, which is also what strips anything a
 * user-typed shader/palette name could smuggle into a download attribute.
 */
export function paletteExportFileName(
  shaderName: string,
  palette: Palette | null,
  kind: PaletteExportKind,
): string {
  const base = toKebabCase(typeof shaderName === 'string' ? shaderName : '', 'shader');
  const tail = palette ? toKebabCase(palette.name, 'palette') : 'palettes';
  return `${base}-${tail}.${kind}`;
}

/* ============================================================
 * Colour-list edits (see the identity-return convention above)
 * ============================================================ */

/**
 * The pair these edits operate on.
 *
 * They take and return the PAIR rather than a bare `string[]` for one reason:
 * `names[i]` labels `colors[i]`, so every move, insert and removal has to touch
 * both arrays or the tooltips end up labelling the wrong swatches — a failure
 * that looks exactly like working software. Threading the pair through makes
 * that structural instead of a rule someone has to remember at four call sites.
 *
 * `names` is OPTIONAL and stays absent for an unlabelled palette, so nothing
 * about a palette without names changes shape.
 */
export type ColorList = Pick<Palette, 'colors' | 'names'>;

const inRange = (colors: readonly string[], i: number) =>
  Number.isInteger(i) && i >= 0 && i < colors.length;

/** Materialize `names` to the same length as `colors`, padding with `''`. Only
 *  called on an edit path, so an unlabelled palette never grows the array. */
function paddedNames(list: ColorList): string[] {
  const out = (list.names ?? []).slice(0, list.colors.length);
  while (out.length < list.colors.length) out.push('');
  return out;
}

/** Rebuild the pair, dropping `names` again when nothing is labelled — an edit
 *  must not leave an all-empty array behind on a palette that never had one. */
function makeList(colors: string[], names: string[]): ColorList {
  return names.some((n) => n) ? { colors, names } : { colors };
}

/** Replace one colour. The label is KEPT: on a palette the user owns, the name
 *  is theirs to maintain (the editor offers a rename beside each swatch), and
 *  silently clearing it on every nudge of the hex would make naming useless. */
export function withColorAt(list: ColorList, index: number, hex: string): ColorList {
  if (!inRange(list.colors, index) || list.colors[index] === hex) return list;
  const colors = [...list.colors];
  colors[index] = hex;
  return makeList(colors, paddedNames(list));
}

/** Rename one colour. `''` removes the label. */
export function withColorNameAt(list: ColorList, index: number, name: string): ColorList {
  if (!inRange(list.colors, index)) return list;
  const names = paddedNames(list);
  if (names[index] === name) return list;
  names[index] = name;
  return makeList([...list.colors], names);
}

/** Insert a colour at `index` (clamped to the ends). Refused at the cap. */
export function withColorInserted(list: ColorList, index: number, hex: string): ColorList {
  if (list.colors.length >= MAX_COLORS_PER_PALETTE) return list;
  const at = Math.max(
    0,
    Math.min(list.colors.length, Number.isFinite(index) ? Math.trunc(index) : 0),
  );
  const colors = [...list.colors];
  const names = paddedNames(list);
  colors.splice(at, 0, hex);
  names.splice(at, 0, '');
  return makeList(colors, names);
}

/**
 * Remove one colour. Removing the LAST remaining colour is refused: a palette
 * with no colours is not a palette (`sanitizePalettes` drops it, and
 * `updatePalette` refuses the write), so the caller must disable the control
 * and point at Delete instead — otherwise the button silently does nothing.
 */
export function withColorRemoved(list: ColorList, index: number): ColorList {
  if (!inRange(list.colors, index) || list.colors.length <= 1) return list;
  const names = paddedNames(list);
  return makeList(
    list.colors.filter((_, i) => i !== index),
    names.filter((_, i) => i !== index),
  );
}

/** Move one colour. Order is semantic (a palette is often a ramp), which is the
 *  whole reason this exists rather than a sort. */
export function withColorMoved(list: ColorList, from: number, to: number): ColorList {
  if (!inRange(list.colors, from) || !inRange(list.colors, to) || from === to) return list;
  const colors = [...list.colors];
  const names = paddedNames(list);
  const [movedColor] = colors.splice(from, 1);
  const [movedName] = names.splice(from, 1);
  colors.splice(to, 0, movedColor);
  names.splice(to, 0, movedName);
  return makeList(colors, names);
}

/**
 * The colour a fresh "+ colour" lands on. Deliberately NOT a copy of the last
 * one: an identical swatch appearing next to its twin is invisible, which reads
 * as the button having failed.
 */
export function nextPaletteColor(colors: readonly string[]): string {
  return colors[colors.length - 1] === '#ffffff' ? '#808080' : '#ffffff';
}

/** Room for one more palette in this shader. */
export function canAddPalette(count: number): boolean {
  return count < MAX_PALETTES_PER_SHADER;
}

/** Room for one more colour in this palette. */
export function canAddColor(count: number): boolean {
  return count < MAX_COLORS_PER_PALETTE;
}
