/**
 * The text the code panel KEEPS when an Apply could not put all of it into the
 * graph (owner, 2026-11-26: "keep the typed text in the panel when Apply drops
 * something").
 *
 * Before this, every successful Apply was followed within a moment by the
 * graph→code pass writing the graph's own code over what was typed (React Flow
 * re-measures the replaced nodes, which arms that pass). For code that reached
 * the graph whole, that is a re-spelling. For code that did NOT — a line a
 * dropped-code warning quotes (docs/dev/codegen.md) — it deleted the very
 * lines the warnings said to rewrite, and their line numbers pointed into text
 * that was no longer there.
 *
 * The kept text is held BESIDE the graph's code, never instead of it. The
 * store's `code` and `previewCode` are still what the graph generates, so the
 * 3D view, every export, the A-Frame and Three.js pages, the study package and
 * the VR popup keep following the graph. Only the panel shows the draft, a
 * keystroke edits it, and Apply reads it — under its OWN scope (`emitted`,
 * `names`: what the parse that made it built), since `codeEmitted` now
 * describes the graph's code, a different text.
 *
 * It ends when the graph's code CHANGES — a graph edit, an undo, an import,
 * New — and never on a pass that writes the same text again (a re-measure, a
 * selection, a cost badge, a moved node): the panel follows the graph, as it
 * always has, the moment the graph says something new.
 *
 * Pure: no store, no DOM. Session-only: never persisted, never in history.
 */
import type { ParseError } from '@/types';

export interface CodeDraft {
  /** What the panel shows, and what a keystroke edits. */
  readonly code: string;
  /** The text the last Apply read: applying it again unchanged does nothing. */
  readonly applied: string;
  /**
   * The graph's own code this text is held against — written by the first
   * graph→code pass after the Apply (null until it runs). A pass that
   * generates anything else ends the hold.
   */
  readonly graph: string | null;
  /** The nodes the last parse of this text built: the scope its next Apply
   *  reads (utils/panelCarry.ts), as `codeEmitted` is for generated text. */
  readonly emitted: ReadonlySet<string>;
  /** Their declared names, as `codeNames` is for generated text. */
  readonly names: ReadonlyMap<string, string>;
}

/** What the code panel shows: a kept text, else the graph's own code. */
export const panelText = (s: { code: string; codeDraft: CodeDraft | null }): string =>
  s.codeDraft ? s.codeDraft.code : s.code;

/**
 * True when an Apply's report says code did not reach the graph. Every warning
 * says so except the one whose code survives as written (`ParseError.kept`, an
 * unknown function), so this is the code panel's own "did not reach the graph"
 * test (CodeEditor.tsx) — one rule for the hint and for the hold.
 */
export const dropsCode = (errors: readonly ParseError[]): boolean =>
  errors.some((e) => e.severity === 'warning' && e.kept !== true);

/**
 * The draft after a graph→code pass wrote `code`. The first pass after the
 * Apply sets what it is held against; a later one keeps it only while it
 * writes that same text. `sameGraph` is a pass that re-read an UNCHANGED graph
 * (the unknown-expression validator landing, engine/unknownExpression.ts): its
 * text may differ with no edit behind it, so the hold moves to it.
 */
export function draftAfterGraphWrite(draft: CodeDraft | null, code: string, sameGraph: boolean): CodeDraft | null {
  if (draft === null) return null;
  if (draft.graph === code) return draft;
  return draft.graph === null || sameGraph ? { ...draft, graph: code } : null;
}

/**
 * The panel's report after that pass: it describes the text ON the panel, and
 * goes when that text does. While a text is kept, the report is that text's
 * and stays whole. When the pass replaced the panel's text: a BLOCKING error
 * described the text a failed Apply left there, so it goes. A dropped-code
 * warning of a hold that just ENDED goes the same way — it quotes lines of a
 * text the panel no longer shows, and left up it stood over the next graph
 * edit, a New and an opened file alike until the next Apply (Monaco's undo
 * brings the text back, and an Apply of it the warnings). Only what the
 * regenerated text still holds stays: a `kept` unknown function. The same
 * array when nothing changes (a scrub frame writes here 60 times a second).
 */
export function errorsAfterGraphWrite(
  errors: ParseError[],
  before: CodeDraft | null,
  after: CodeDraft | null,
): ParseError[] {
  if (after !== null) return errors;
  const stays = (e: ParseError): boolean =>
    e.severity === 'warning' && (before === null || e.kept === true);
  return errors.every(stays) ? errors : errors.filter(stays);
}
