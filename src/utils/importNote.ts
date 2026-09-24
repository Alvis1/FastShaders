/**
 * The canvas IMPORT NOTE — the top-centre one-liner that reports something an
 * import did on the user's behalf without asking (a requested WebP conversion
 * that this browser could not perform, a remembered "never optimize" that
 * silently kept the original format, or a zip whose 3D model was skipped).
 *
 * It lives in the STORE (`importNote`, `showImportNote`, `dismissImportNote`)
 * rather than in NodeEditor's local state so that any surface can post to it —
 * the canvas drop, a zip import, the preview. It holds structured LINES, never
 * pre-rendered strings, so it re-renders in the active language, and it is
 * session-only: never in undo history, the autosave or localStorage.
 * `showImportNote` REPLACES the current note, so a later import wins. The one
 * exception is `showImageDropReports`, which re-composes a still-visible note
 * from the SAME image drop (an "Add anyway" landing before or after the rest
 * of its batch), so a batch still reports once.
 *
 * Pure apart from `t()`; the store and NodeEditor are the only writers/readers.
 */
import { t, type Language } from '@/i18n';
import type { MeshRefusal } from './previewMesh';
import type { ImageDropReport } from './imageImportNote';
import { formatImageBudget } from './imageNode';
import { zipModelSkippedLine } from './zipImportNotices';
import { fillTemplate } from './fillTemplate';
import type { GlbReportLine } from './glbImportReport';
import { glbReportLineText, glbRestoredLineText } from './glbImportCopy';
import { glbExportNoteLineText, type GlbExportNoteLine } from './glbExportCopy';
import { formatMiB } from './formatSize';

/** One line of the note. Later packages widen this union; each new member
 *  gets its `case` in `importNoteLineText`. */
export type ImportNoteLine =
  | { kind: 'no-webp' | 'preference'; storedAs: string }
  /** A zip's model entry was refused (empty, bad GLB, too large, compressed).
   *  `shaderLoaded` false = a model-only zip, so nothing was imported at all. */
  | { kind: 'zip-model-skipped'; shaderLoaded: boolean; fileName: string; refusal: MeshRefusal }
  /** N5: a dropped image was HALVED to fit the per-image budget (one image;
   *  width/height are what was placed). The `-many` form counts a batch. */
  | { kind: 'budget-scaled'; width: number; height: number; budgetChars: number }
  | { kind: 'budget-scaled-many'; count: number; budgetChars: number }
  /** N5: a source that wanted to stay lossless was stored lossy, because no
   *  lossless encode fit the per-image budget. */
  | { kind: 'lossless-dropped'; storedAs: string; budgetChars: number }
  | { kind: 'lossless-dropped-many'; count: number; budgetChars: number }
  /** GLB Phase 5: the lines of ONE build-from-materials report
   *  (utils/glbImportReport.ts; rendered by glbImportCopy.glbReportLineText). */
  | GlbReportLine
  /** N1's desktop variant: an export was DELIVERED that only the desktop
   *  editor can open again (between the web reader's cap and the desktop
   *  one). Posted by `announceExportDelivered` after the download or write. */
  | { kind: 'export-desktop-only'; sizeBytes: number; webLimitBytes: number }
  /** GLB Phase 7: the shader stored in a FastShaders GLB was restored —
   *  `project` = its node graph, `script` = its module as shader code. The
   *  `glb-` prefix gives the note the report's 30 s. `fileName` is sanitized. */
  | { kind: 'glb-restored'; fileName: string; imported: 'project' | 'script' }
  /** A dropped shader was ADDED beside the graph instead of replacing it
   *  (the dialog's second answer). `droppedSinks` counts the Output nodes the
   *  add left out — the thing it did without asking, and the reason the
   *  arriving group drives nothing. `name` is the group's label, already
   *  bounded by `sanitizeDroppedName`. */
  | { kind: 'shader-added'; name: string; nodes: number; droppedSinks: number }
  /** GLB Phase 7: what a DELIVERED single-GLB export reports — textures
   *  written WebP-only, slots other viewers will show untextured, an
   *  approximated placement (utils/glbExportCopy.ts). The `glb-` prefix gives
   *  the note the report's 30 s. */
  | GlbExportNoteLine;

export interface ImportNote {
  /** Fresh per `showImportNote`, so the 12 s self-clear and the ✕ can only
   *  ever dismiss the note they were armed for. */
  id: string;
  lines: ImportNoteLine[];
  /** Set when the note reports an image DROP: which drop, and every report it
   *  was composed from, so a later report from the same drop re-composes the
   *  whole set instead of replacing it. */
  dropId?: string;
  reports?: readonly ImageDropReport[];
}

/** The text of one line in `lang`. Placeholders are filled in ONE pass
 *  (`fillTemplate`), so a stored format name can never be read as a `$&`
 *  pattern, nor capture a placeholder filled after it. */
export function importNoteLineText(line: ImportNoteLine, lang: Language): string {
  switch (line.kind) {
    case 'preference':
      // A REMEMBERED "no" — the one line that names the preference behind it.
      return fillTemplate(t('Not optimized (set to “Never”) — stored as {fmt}', lang), { fmt: line.storedAs });
    case 'no-webp':
      return fillTemplate(t('Not optimized — stored as {fmt}', lang), { fmt: line.storedAs });
    case 'zip-model-skipped':
      return zipModelSkippedLine(line, lang);
    // N5 — the per-image budget. Caps announce themselves, so these ignore
    // `hideImageConvertNotice`, which silences only the WebP line above.
    case 'budget-scaled':
      return fillTemplate(t('Reduced to {w}×{h} to fit the {limit} per-image budget', lang), {
        limit: formatImageBudget(line.budgetChars),
        w: line.width,
        h: line.height,
      });
    case 'budget-scaled-many':
      return fillTemplate(t('Images reduced to fit the {limit} per-image budget: {n}', lang), {
        limit: formatImageBudget(line.budgetChars),
        n: line.count,
      });
    case 'lossless-dropped':
      return fillTemplate(t('Stored lossy ({fmt}) — the lossless version did not fit the {limit} per-image budget', lang), {
        limit: formatImageBudget(line.budgetChars),
        fmt: line.storedAs,
      });
    case 'lossless-dropped-many':
      return fillTemplate(t('Images stored lossy because the lossless version did not fit the {limit} per-image budget: {n}', lang), {
        limit: formatImageBudget(line.budgetChars),
        n: line.count,
      });
    // The GLB build report (N10/N14): one `case` per kind, so tsc still fails
    // on a kind neither side lists; the words live in glbImportCopy.
    case 'glb-import':
    case 'glb-kept-authored':
    case 'glb-decode-downscaled':
    case 'glb-not-imported':
    case 'glb-texture-downscaled':
    case 'glb-texture-skipped':
    case 'glb-texture-more':
      return glbReportLineText(line, lang);
    case 'glb-restored':
      return glbRestoredLineText(line, lang);
    case 'glb-export-fallback-missing':
    case 'glb-export-slots-empty':
    case 'glb-export-approximated':
    case 'glb-export-ktx2':
    case 'glb-export-ktx2-skipped':
      return glbExportNoteLineText(line, lang);
    case 'shader-added':
      // Two sentences in one line, because the second is the surprise: the
      // arriving chain is on the canvas but drives nothing until it is wired.
      return line.droppedSinks > 0
        ? fillTemplate(
            t('Added {name} — {n} nodes. Its Output was left out, so it is not connected yet.', lang),
            { name: '\u201c' + line.name + '\u201d', n: line.nodes },
          )
        : fillTemplate(t('Added {name} — {n} nodes, not connected yet.', lang), {
            name: '\u201c' + line.name + '\u201d',
            n: line.nodes,
          });
    case 'export-desktop-only':
      return fillTemplate(
        t('Saved ({size} MB). Only the desktop editor can open it again — Podest and the web editor open up to {limit} MB.', lang),
        { size: formatMiB(line.sizeBytes, lang), limit: formatMiB(line.webLimitBytes, lang) },
      );
  }
}

/** Whether the note carries a line about drop-time CONVERSION — the only kind
 *  its "?" (ImageConvertInfoModal) explains, so the button shows only then. */
export function importNoteHasConvertLine(note: ImportNote): boolean {
  return note.lines.some((l) => l.kind === 'no-webp' || l.kind === 'preference');
}

/** How long an ordinary note stays up before it clears itself. */
export const IMPORT_NOTE_MS = 12000;
/** How long a note carrying a GLB build report stays up: it is several lines
 *  long, and it is the only place the build says what it did. */
export const GLB_REPORT_NOTE_MS = 30000;

/** The note's lifetime: 30 s when it carries any `glb-` line, else 12 s. */
export function importNoteLifetimeMs(note: ImportNote): number {
  const lines: readonly ImportNoteLine[] = Array.isArray(note?.lines) ? note.lines : [];
  return lines.some((l) => typeof l?.kind === 'string' && l.kind.startsWith('glb-')) ? GLB_REPORT_NOTE_MS : IMPORT_NOTE_MS;
}
