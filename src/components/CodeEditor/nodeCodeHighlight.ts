/**
 * The pure half of the code panel's node → code highlight
 * (useNodeCodeHighlight.ts): which nodes a selection means, and which of
 * their spans to draw. No Monaco, no store, no DOM — node-tested.
 */
import type { AppNode, CodeNodeSpans, CodeSpan } from '@/types';

/** A group nested deeper than this is not walked (a `.fastshader` can nest anything). */
export const MAX_GROUP_DEPTH = 64;
/** At most this many decorations are drawn, whatever was selected. */
export const MAX_HIGHLIGHT_DECORATIONS = 2000;
/** Parent hops walked to find a selected ancestor (as utils/groupFrame.ts). */
const MAX_PARENT_HOPS = 100;

/**
 * The selected ids as ONE string, '' for none — the cheap key a store
 * subscription compares on every notify. `\n` cannot occur in a node id
 * (`isSelectorSafeId`), so the join is unambiguous.
 */
export function selectionKey(nodes: readonly AppNode[]): string {
  let key = '';
  for (const n of nodes) if (n.selected) key += `${n.id}\n`;
  return key;
}

export interface ExpandedSelection {
  /** Whose code to draw: every selected node, plus every DESCENDANT of a
   *  selected group frame (a collapsed pill shows its members' code), in
   *  `nodes` order, deduplicated. */
  ids: string[];
  /** The selected nodes no selected ANCESTOR already covers — a marquee that
   *  takes a frame and its members is ONE thing selected, not many. */
  units: string[];
}

export function expandSelection(nodes: readonly AppNode[]): ExpandedSelection {
  const byId = new Map<string, AppNode>();
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    if (n.parentId) {
      const list = childrenOf.get(n.parentId);
      if (list) list.push(n.id);
      else childrenOf.set(n.parentId, [n.id]);
    }
  }
  const selected = nodes.filter((n) => n.selected);
  const want = new Set<string>();
  for (const n of selected) {
    want.add(n.id);
    if (n.type !== 'group') continue;
    // Breadth-first, depth-capped, cycle-guarded: a parent chain read from a
    // file may name itself.
    let level = [n.id];
    const seen = new Set<string>([n.id]);
    for (let depth = 0; level.length > 0 && depth < MAX_GROUP_DEPTH; depth++) {
      const next: string[] = [];
      for (const id of level) {
        for (const child of childrenOf.get(id) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          want.add(child);
          next.push(child);
        }
      }
      level = next;
    }
  }
  const selectedIds = new Set(selected.map((n) => n.id));
  const units = selected
    .filter((n) => {
      let parentId = n.parentId;
      const seen = new Set<string>([n.id]);
      for (let hops = 0; parentId && !seen.has(parentId) && hops < MAX_PARENT_HOPS; hops++) {
        if (selectedIds.has(parentId)) return false;
        seen.add(parentId);
        parentId = byId.get(parentId)?.parentId;
      }
      return true;
    })
    .map((n) => n.id);
  return { ids: nodes.filter((n) => want.has(n.id)).map((n) => n.id), units };
}

/** A span at its CURRENT place in the editor (tracked through typing). */
export interface HighlightItem {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  kind: CodeSpan['kind'];
  inline: boolean;
}

/**
 * What to draw: sorted by position, exact duplicates dropped (a group and its
 * member both selected), touching or overlapping WHOLE-LINE items of one kind
 * merged into one run (a chain of selected nodes is one block, one ruler
 * mark), inline items kept apart, at most `cap` of them.
 */
export function planHighlight(items: readonly HighlightItem[], cap = MAX_HIGHLIGHT_DECORATIONS): HighlightItem[] {
  const sorted = [...items].sort(
    (a, b) =>
      a.startLineNumber - b.startLineNumber ||
      a.startColumn - b.startColumn ||
      a.endLineNumber - b.endLineNumber ||
      a.endColumn - b.endColumn,
  );
  const out: HighlightItem[] = [];
  for (const it of sorted) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.kind === it.kind &&
      prev.inline === it.inline &&
      prev.startLineNumber === it.startLineNumber &&
      prev.startColumn === it.startColumn &&
      prev.endLineNumber === it.endLineNumber &&
      prev.endColumn === it.endColumn
    ) continue;
    if (prev && !prev.inline && !it.inline && prev.kind === it.kind && it.startLineNumber <= prev.endLineNumber + 1) {
      if (
        it.endLineNumber > prev.endLineNumber ||
        (it.endLineNumber === prev.endLineNumber && it.endColumn > prev.endColumn)
      ) {
        out[out.length - 1] = { ...prev, endLineNumber: it.endLineNumber, endColumn: it.endColumn };
      }
      continue;
    }
    out.push({ ...it });
  }
  return out.length > cap ? out.slice(0, cap) : out;
}

/** Where a click's reveal goes: the first `own` span (a node's body, not its
 *  module-scope setup), else the first of any kind, else none. */
export function revealTarget(items: readonly HighlightItem[]): HighlightItem | null {
  return items.find((it) => it.kind === 'own') ?? items[0] ?? null;
}

const monacoTexts = new WeakMap<CodeNodeSpans, string>();

/**
 * A pair's text as Monaco HOLDS it: the panel's model is LF, and Monaco turns
 * every `\r\n`, `\r` and `\n` it is given into its own EOL. Codegen can emit
 * a CR — an unknown node's stored expression keeps the CRLF of the file it was
 * parsed from — and a pair compared byte for byte could then never match, so
 * the highlight was off for the whole document, for good (it is saved). The
 * spans need no change: they count each of those breaks as one, as Monaco
 * does. Cached per pair; a text with no CR is returned as it is.
 */
export function monacoText(pair: CodeNodeSpans): string {
  let text = monacoTexts.get(pair);
  if (text === undefined) {
    text = pair.code.includes('\r') ? pair.code.replace(/\r\n?/g, '\n') : pair.code;
    monacoTexts.set(pair, text);
  }
  return text;
}
