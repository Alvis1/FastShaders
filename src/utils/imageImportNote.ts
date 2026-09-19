/**
 * What an image DROP reports on the canvas import note (N5 + the WebP line).
 *
 * Every limit announces itself. A drop that had to HALVE for the per-image
 * budget, or store a lossless source lossy, says so — and one drop reports
 * ONCE: the drop loop collects an `ImageDropReport` per image and posts the
 * lines `composeImportNoteLines` builds from all of them, so a batch gets
 * count-neutral lines ("…: 3") instead of one note per image replacing the
 * last. The text itself is `importNoteLineText` (utils/importNote.ts).
 *
 * Pure and node-safe: `EncodeImageResult` is imported as a TYPE, so this
 * module never loads the DOM-only encoder.
 */
import type { EncodeImageResult } from './imageImport';
import type { ImportNoteLine } from './importNote';

/** Why a drop that could have been converted to WebP was not. */
export type ConvertNoteReason = 'no-webp' | 'preference';

/** One placed image's contribution to the drop's note. */
export interface ImageDropReport {
  /** The format the node HOLDS ('JPEG' / 'PNG' / 'WebP'). */
  storedAs: string;
  /** The WebP line this image asks for, or null (also null while the user has
   *  hidden that line — `hideImageConvertNotice` governs ONLY it). */
  convertNote: ConvertNoteReason | null;
  /** The PLACED dimensions when the per-image budget cost pixels, else null. */
  budgetScaled: { width: number; height: number } | null;
  /** A source that wanted to stay exact was stored lossy. */
  losslessDropped: boolean;
  /** The per-image budget the encode was held to (the {limit} printed). */
  budgetChars: number;
}

/** The format a payload is stored in, read off its `data:` prefix — never off
 *  the encoder's MIME, because a refused stash places the unsnapped original,
 *  whose format can differ from the snapped one. '' for anything else. */
export function formatStoredAs(dataUrl: string): string {
  const m = /^data:image\/(png|jpeg|webp);/.exec(dataUrl);
  if (!m) return '';
  return m[1] === 'jpeg' ? 'JPEG' : m[1] === 'png' ? 'PNG' : 'WebP';
}

/**
 * The report for one finished drop. `placed` is what the node actually got
 * (`resolveImageDrop`'s payload): its dimensions are the ones a "Reduced to"
 * line names, and its own `lossless` decides the lossy line — a refused stash
 * that placed a LOSSLESS original is not flagged even when the snapped encode
 * was lossy.
 */
export function imageDropReport(
  res: Pick<Extract<EncodeImageResult, { ok: true }>, 'preferLossless' | 'budgetScaled' | 'budgetChars'>,
  placed: { dataUrl: string; width: number; height: number; lossless?: boolean },
  convertNote: ConvertNoteReason | null,
): ImageDropReport {
  return {
    storedAs: formatStoredAs(placed.dataUrl),
    convertNote,
    budgetScaled: res.budgetScaled ? { width: placed.width, height: placed.height } : null,
    losslessDropped: res.preferLossless && placed.lossless === false,
    budgetChars: res.budgetChars,
  };
}

/**
 * The lines one drop posts, in this order: the budget line, the lossy line,
 * then at most ONE WebP line. Each budget kind names the image (its size or
 * format) when a single report carries it and falls back to a count when
 * several do; the WebP line lists the DISTINCT stored formats in first-seen
 * order. `budgetChars` comes from the first contributing report. An empty
 * result means the drop has nothing to say, and no note is posted.
 */
export function composeImportNoteLines(reports: readonly ImageDropReport[]): ImportNoteLine[] {
  const lines: ImportNoteLine[] = [];

  const scaled = reports.filter((r) => r.budgetScaled !== null);
  if (scaled.length === 1) {
    const r = scaled[0];
    lines.push({ kind: 'budget-scaled', width: r.budgetScaled!.width, height: r.budgetScaled!.height, budgetChars: r.budgetChars });
  } else if (scaled.length > 1) {
    lines.push({ kind: 'budget-scaled-many', count: scaled.length, budgetChars: scaled[0].budgetChars });
  }

  const lossy = reports.filter((r) => r.losslessDropped);
  if (lossy.length === 1) {
    lines.push({ kind: 'lossless-dropped', storedAs: lossy[0].storedAs, budgetChars: lossy[0].budgetChars });
  } else if (lossy.length > 1) {
    lines.push({ kind: 'lossless-dropped-many', count: lossy.length, budgetChars: lossy[0].budgetChars });
  }

  const converted = reports.filter((r) => r.convertNote !== null);
  if (converted.length > 0) {
    const formats: string[] = [];
    for (const r of converted) if (r.storedAs && !formats.includes(r.storedAs)) formats.push(r.storedAs);
    lines.push({ kind: converted[0].convertNote!, storedAs: formats.join(', ') });
  }

  return lines;
}
