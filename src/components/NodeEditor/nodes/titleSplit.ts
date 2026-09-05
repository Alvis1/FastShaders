/**
 * Where a node title may break — the ONE rule behind "a title wraps to two
 * lines at most, and the node stays at its designed width".
 *
 * The canvas header shows the generated var name (`cameraPosition1`), a single
 * unbreakable token; `.node-base__title` refuses to split words
 * (`overflow-wrap: normal`), so its min-content contribution was the WHOLE
 * name and the node's `min-width: min-content` floor grew a 47px-wide design
 * to ~95px to fit it on one line. Breaking anywhere is worse: `camera` /
 * `Position` / `1` on three rows, taller than the body.
 *
 * So the title gets exactly ONE break opportunity, at its most balanced seam:
 * a space, the character after `_`/`-`, or a camelCase boundary (a lower-case
 * letter or digit followed by an upper-case letter — Unicode-aware, so
 * `vektoriālaisReizinājums` seams too). One opportunity means two lines at
 * most by construction, and the min-content floor becomes the longer HALF, so
 * the design width holds whenever both halves fit it. Digits stay attached to
 * the fragment before them (`Position1`, never a lone `1`). Every other space
 * in the text is rendered non-breaking by NodeTitle, or a three-word label
 * could still take three rows and hit the clamp's ellipsis.
 *
 * Pure and node-tested (titleSplit.ts — not nodeTitle.ts, which would differ from NodeTitle.tsx only by case and collide on a case-insensitive filesystem); NodeTitle.tsx is the one renderer.
 */

export interface TitleSplit {
  head: string;
  tail: string;
  /** True when the seam was a space (rendered as a real, breakable space);
   *  false for an in-word seam (rendered as `<wbr>`). */
  space: boolean;
}

const LOWER_OR_DIGIT = /[\p{Ll}\p{Nd}]/u;
const UPPER = /\p{Lu}/u;

/** The most balanced two-way split of `text`, or null when it has no seam. */
export function splitTitle(text: string): TitleSplit | null {
  let best: TitleSplit | null = null;
  let bestLen = Infinity;
  const consider = (head: string, tail: string, space: boolean) => {
    if (!head.trim() || !tail.trim()) return;
    const len = Math.max(head.length, tail.length);
    if (len < bestLen) {
      bestLen = len;
      best = { head, tail, space };
    }
  };
  for (let i = 1; i < text.length; i++) {
    const prev = text[i - 1];
    const ch = text[i];
    if (ch === ' ') consider(text.slice(0, i), text.slice(i + 1), true);
    else if (prev === '_' || prev === '-') consider(text.slice(0, i), text.slice(i), false);
    else if (LOWER_OR_DIGIT.test(prev) && UPPER.test(ch)) consider(text.slice(0, i), text.slice(i), false);
  }
  return best;
}
