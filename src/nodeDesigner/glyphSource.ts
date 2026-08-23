/**
 * Pure SVG-source helpers for the Node Designer's glyph modal: a tolerant
 * TOKENIZER over the raw markup, the element RANGES it yields (which shape lives
 * at which byte offset), and a FORMATTER that puts every element on its own line.
 *
 * WHY A SCANNER AND NOT THE DOM. The modal's single source of truth is the
 * `#mSvg` textarea; the preview is `innerHTML` of that text, and every gesture
 * commits by writing `root.innerHTML` straight back. So the DOM knows the art's
 * STRUCTURE and the textarea knows its TEXT, and nothing connects the two — which
 * is exactly what "highlight the selected shape in the source" needs. Rather than
 * re-serialize an element and search for it (attribute order and quoting would
 * have to match byte-for-byte, and two identical `<line>`s are indistinguishable),
 * the tokenizer walks the raw text once and records where each element starts and
 * ends. Document order is the join: `querySelectorAll` returns document order and
 * so does a linear scan, so the Nth drawable in the text IS the Nth drawable in
 * the DOM.
 *
 * That join is VERIFIED, never assumed — see `tagsAlign`. The preview is built by
 * the HTML parser (`div.innerHTML = '<svg …>' + text + '</svg>'`), and HTML
 * foreign-content rules can close the `<svg>` early on a breakout tag (`<p>`,
 * `<b>`, `<font>`…), which would silently shift every index by one and highlight
 * the wrong shape. Comparing the two tag sequences costs one pass and turns that
 * into a clean "cannot map" instead of a lie.
 *
 * Pure and import-free so the vitest node env can cover it: `designerApp.ts` is
 * @ts-nocheck vanilla with no other automated coverage, and these are all
 * string→string functions whose every correctness property is testable without a
 * DOM (`socketScale.ts` is the precedent).
 */

/**
 * The tags `collectGlyphPoints` gives handles to — i.e. exactly what a canvas
 * selection can refer to. Kept in the same order as the CSS selector in
 * designerApp.ts so the two read as the one list they are.
 */
export const DRAWABLE_TAGS = ['line', 'circle', 'ellipse', 'rect', 'polyline', 'polygon', 'text', 'path'];
const DRAWABLE = new Set(DRAWABLE_TAGS);

/**
 * Elements whose CONTENT is significant and must survive the formatter byte for
 * byte. `<text>` renders its own whitespace, so re-indenting inside one moves the
 * glyph's lettering; `<tspan>` only ever appears inside a `<text>`, but naming it
 * costs nothing and makes the rule readable.
 */
const PRESERVE = new Set(['text', 'tspan']);

type TokKind = 'open' | 'close' | 'self' | 'comment' | 'text' | 'other';

interface Tok {
  kind: TokKind;
  /** offset of the token's first character */
  start: number;
  /** offset one past its last character */
  end: number;
  /** lower-case tag name, '' for non-element tokens */
  tag: string;
}

export interface GlyphElementRange {
  /** lower-case tag name */
  tag: string;
  /** offset of the '<' that opens the element */
  start: number;
  /** offset one past the element's final '>' (its end tag's, when it has one) */
  end: number;
  /** nesting depth, 0 = top level */
  depth: number;
  /** true when `collectGlyphPoints` would give this element handles */
  drawable: boolean;
}

export interface GlyphScan {
  /** every element found, in document order (pre-order, same as querySelectorAll) */
  elements: GlyphElementRange[];
  /** the drawable subset, in document order — index-aligned with the DOM query */
  drawables: GlyphElementRange[];
  /**
   * null when the text scanned cleanly. A string when the scanner hit something
   * it could not resolve (an unterminated comment or tag, a stray end tag). The
   * ranges found so far are still returned, but every consumer here declines on a
   * non-null error — a half-typed document must never highlight, or reformat,
   * the wrong shape.
   */
  error: string | null;
}

/** whitespace per the XML spec — the only characters that may end a tag name */
function isSpace(c: string): boolean { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'; }
function isNameStart(c: string): boolean { return /[A-Za-z_:]/.test(c); }

/**
 * Find the '>' that closes a tag opened at `from`, skipping any inside quoted
 * attribute values. `indexOf('>')` is wrong here: a hand-written `title` or a
 * transform may contain one, and truncating the tag desynchronises every element
 * after it.
 */
function tagClose(text: string, from: number): number {
  let quote = '';
  for (let k = from; k < text.length; k++) {
    const c = text.charAt(k);
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return k;
  }
  return -1;
}

/**
 * One linear pass producing every token in the source. Deliberately tolerant
 * rather than validating: `svgError()` already owns "does this parse" and runs on
 * every keystroke, so this only has to agree with the DOM about ORDER — and to
 * say so when it cannot.
 */
function tokenize(text: string): { toks: Tok[]; error: string | null } {
  const toks: Tok[] = [];
  let i = 0;
  const pushText = (from: number, to: number) => { if (to > from) toks.push({ kind: 'text', start: from, end: to, tag: '' }); };
  const fail = (msg: string) => { pushText(i, text.length); return { toks: toks, error: msg }; };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { pushText(i, text.length); break; }
    pushText(i, lt);
    i = lt;
    const next = text.charAt(lt + 1);

    if (next === '!') {
      if (text.startsWith('<!--', lt)) {
        const close = text.indexOf('-->', lt + 4);
        if (close < 0) return fail('unterminated comment');
        toks.push({ kind: 'comment', start: lt, end: close + 3, tag: '' }); i = close + 3; continue;
      }
      if (text.startsWith('<![CDATA[', lt)) {
        const close = text.indexOf(']]>', lt + 9);
        if (close < 0) return fail('unterminated CDATA');
        toks.push({ kind: 'other', start: lt, end: close + 3, tag: '' }); i = close + 3; continue;
      }
      const gt = text.indexOf('>', lt);                 // doctype / other declaration
      if (gt < 0) return fail('unterminated declaration');
      toks.push({ kind: 'other', start: lt, end: gt + 1, tag: '' }); i = gt + 1; continue;
    }

    if (next === '?') {                                 // processing instruction
      const close = text.indexOf('?>', lt + 2);
      if (close < 0) return fail('unterminated processing instruction');
      toks.push({ kind: 'other', start: lt, end: close + 2, tag: '' }); i = close + 2; continue;
    }

    if (next === '/') {
      let j = lt + 2;
      while (j < text.length && !isSpace(text.charAt(j)) && text.charAt(j) !== '>') j++;
      const tag = text.slice(lt + 2, j).toLowerCase();
      const gt = tagClose(text, j);
      if (gt < 0) return fail('unterminated </' + tag + '>');
      toks.push({ kind: 'close', start: lt, end: gt + 1, tag: tag }); i = gt + 1; continue;
    }

    if (!isNameStart(next)) {                           // a bare '<' in content
      pushText(lt, lt + 1); i = lt + 1; continue;
    }

    let j = lt + 1;
    while (j < text.length && !isSpace(text.charAt(j)) && text.charAt(j) !== '>' && text.charAt(j) !== '/') j++;
    const tag = text.slice(lt + 1, j).toLowerCase();
    const gt = tagClose(text, j);
    if (gt < 0) return fail('unterminated <' + tag + '>');
    const self = text.charAt(gt - 1) === '/';
    toks.push({ kind: self ? 'self' : 'open', start: lt, end: gt + 1, tag: tag });
    i = gt + 1;
  }
  return { toks: toks, error: null };
}

/** Walk `src` and record every element's byte range, in document order. */
export function scanGlyphSource(src: string): GlyphScan {
  const text = src || '';
  const { toks, error } = tokenize(text);
  const elements: GlyphElementRange[] = [];
  const stack: GlyphElementRange[] = [];
  let err = error;

  toks.forEach((t) => {
    if (t.kind === 'self') {
      elements.push({ tag: t.tag, start: t.start, end: t.end, depth: stack.length, drawable: DRAWABLE.has(t.tag) });
      return;
    }
    if (t.kind === 'open') {
      const rec: GlyphElementRange = { tag: t.tag, start: t.start, end: -1, depth: stack.length, drawable: DRAWABLE.has(t.tag) };
      elements.push(rec); stack.push(rec);
      return;
    }
    if (t.kind !== 'close') return;
    let hit = -1;
    for (let k = stack.length - 1; k >= 0; k--) { if (stack[k].tag === t.tag) { hit = k; break; } }
    if (hit < 0) { err = err || 'stray </' + t.tag + '>'; return; }
    if (hit !== stack.length - 1) err = err || 'mismatched </' + t.tag + '>';
    /* Anything still open above the match was never closed. Give each one an
       honest range up to this end tag and report the document as malformed. */
    for (let k = stack.length - 1; k > hit; k--) { stack[k].end = t.start; stack.pop(); }
    stack[hit].end = t.end;
    stack.pop();
  });

  for (let k = 0; k < stack.length; k++) { stack[k].end = text.length; }
  if (stack.length) err = err || 'unclosed <' + stack[stack.length - 1].tag + '>';
  return { elements: elements, drawables: elements.filter((e) => e.drawable), error: err };
}

/**
 * Does the scanner's drawable sequence match the DOM's? Pass
 * `Array.from(root.querySelectorAll(DRAWABLE_TAGS.join(','))).map(e => e.tagName.toLowerCase())`.
 *
 * A mismatch means the HTML parser built something other than what the text says
 * (a foreign-content breakout, a dropped element), so every index would be off by
 * one and the highlight would point at the wrong shape. Callers treat false as
 * "mapping unavailable" — no highlight at all, which is honest.
 */
export function tagsAlign(scan: GlyphScan, domTags: string[]): boolean {
  if (scan.error) return false;
  if (scan.drawables.length !== domTags.length) return false;
  for (let i = 0; i < domTags.length; i++) { if (scan.drawables[i].tag !== domTags[i]) return false; }
  return true;
}

/**
 * Which drawable element (by index into `scan.drawables`) contains `offset`?
 * −1 when the caret sits between elements. Drawables never nest — `<tspan>` is
 * not one — so the first containing range is the only one.
 */
export function drawableIndexAtOffset(scan: GlyphScan, offset: number): number {
  for (let i = 0; i < scan.drawables.length; i++) {
    const r = scan.drawables[i];
    if (offset >= r.start && offset <= r.end) return i;
  }
  return -1;
}

/**
 * Merge overlapping/adjacent ranges and sort them, so a highlight of N selected
 * shapes can be painted as a single ordered walk of the source.
 */
export function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  ranges.slice()
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start)
    .forEach((r) => {
      const last = out[out.length - 1];
      if (last && r.start <= last.end) { last.end = Math.max(last.end, r.end); return; }
      out.push({ start: r.start, end: r.end });
    });
  return out;
}

/**
 * One element per line, `<g>` children indented.
 *
 * WHAT IT MUST NOT DO. Every byte of every tag is COPIED from the source: no
 * attribute reordering, no number reformatting, no quote or entity rewriting. The
 * only thing it rewrites is whitespace that sits BETWEEN tags, and only outside a
 * `<text>` subtree. That matters because the modal's own gestures already
 * re-serialize the document through `root.innerHTML` on every drag, and a
 * formatter that changed anything else would fight them: the user would format,
 * drag one point, and watch their formatting turn back into the browser's.
 * (Whitespace between elements survives that round trip — it is text nodes, and
 * innerHTML re-emits them — which is exactly why formatting sticks.)
 *
 * Idempotent by construction: inter-tag whitespace is dropped and re-inserted
 * canonically, so formatting formatted text returns it unchanged.
 */
export function formatGlyphSource(src: string, indentUnit = '  '): string {
  const text = src || '';
  const { toks, error } = tokenize(text);
  /* Never reformat what we could not read: a half-typed document would come back
     with its tags "tidied" into positions the user did not type, and the caret
     somewhere else entirely. */
  if (error) return text;
  if (!toks.some((t) => t.kind === 'open' || t.kind === 'self')) return text.trim();

  /* Match each open token to its close, so an element that CONTAINS no elements
     can be emitted on one line. That case is the common one, not an edge: the
     modal commits through `root.innerHTML`, and the HTML serializer writes every
     shape in paired form — `<rect …/>` comes back as `<rect …></rect>`. Without
     this, "one element per line" would put every shape on TWO lines and a plain
     six-shape glyph would read as twelve. */
  const match = new Array<number>(toks.length).fill(-1);
  const stack: number[] = [];
  toks.forEach((t, i) => {
    if (t.kind === 'open') { stack.push(i); return; }
    if (t.kind !== 'close') return;
    for (let k = stack.length - 1; k >= 0; k--) {
      if (toks[stack[k]].tag !== t.tag) continue;
      match[stack[k]] = i; match[i] = stack[k];
      stack.length = k;
      break;
    }
  });
  const hasElementChild = (open: number) => {
    const close = match[open];
    if (close < 0) return true;                // unmatched: keep the old layout
    for (let i = open + 1; i < close; i++) { if (toks[i].kind === 'open' || toks[i].kind === 'self') return true; }
    return false;
  };

  const lines: string[] = [];
  let depth = 0;
  let preserve = 0;                            // >0 while inside a <text>/<tspan> subtree
  let inline = 0;                              // >0 while inside a childless element kept on one line
  const push = (s: string) => { lines.push(depth > 0 ? indentUnit.repeat(depth) + s : s); };
  const append = (s: string) => { if (lines.length) lines[lines.length - 1] += s; else lines.push(s); };

  toks.forEach((t, i) => {
    const raw = text.slice(t.start, t.end);
    if (preserve > 0) {
      /* Inside a preserved subtree every byte goes through untouched, appended to
         the line its <text> opened on. */
      append(raw);
      if (t.kind === 'open' && PRESERVE.has(t.tag)) preserve++;
      else if (t.kind === 'close' && PRESERVE.has(t.tag)) preserve--;
      return;
    }
    if (inline > 0) {
      /* A childless element's own content and its end tag ride the line its open
         tag started. Whitespace-only content is dropped, exactly as it is between
         elements — the element draws the same either way. */
      if (t.kind === 'text') { if (raw.trim()) append(raw.trim()); return; }
      append(raw);
      if (t.kind === 'close') inline--;
      return;
    }
    if (t.kind === 'text') {
      if (!raw.trim()) return;                 // inter-tag whitespace: dropped and re-inserted
      push(raw.trim());                        // stray content: kept, on its own line
      return;
    }
    if (t.kind === 'close') { depth = Math.max(0, depth - 1); push(raw); return; }
    push(raw);
    if (t.kind === 'open') {
      if (PRESERVE.has(t.tag)) { preserve = 1; return; }   // stays on ONE line, depth unchanged
      if (!hasElementChild(i)) { inline = 1; return; }     // ditto, and far more common
      depth++;
    }
  });
  return lines.join('\n');
}
