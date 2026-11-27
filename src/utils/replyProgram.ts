/**
 * The program inside a pasted AI reply (owner, 2026-11-26: more compatibility
 * when pasting in). A chat AI answers with a sentence or two and the code in a
 * ```js fence; pasted whole into the TSL panel that was a syntax error on the
 * first line of prose — and a reply that is ONLY the fenced block parsed as
 * valid JavaScript holding nothing (three backticks open an empty template
 * literal, so the block reads as a tagged template), which Apply then turned
 * into an empty graph without a word.
 *
 * So Apply reads the code out of the fence (hooks/useSyncEngine.ts) and puts
 * that text on the panel, where its line numbers are the report's.
 *
 * A fence here is a LINE: an opening line of three backticks and an optional
 * language word, a closing line of three backticks, both at the start of a
 * line. That is stricter than the generator's own reader (llm/dialect.ts
 * `extractProgram`, which reads a model's raw output and takes a fence
 * anywhere): this text may be real code, and a backtick run inside a comment
 * or a template literal must not be read as one. With several blocks the
 * program is the last one that returns something — the generator's rule — or
 * the last one.
 *
 * Pure, a LEAF: no store, no parser. The text is as adversarial as any pasted
 * source; this only cuts a substring out of it, which the same parser then
 * reads. ONE pass over the lines, never a regular expression across them: a
 * lazy match from every opening fence to a closing one that never comes is
 * quadratic, and a pasted megabyte of opening fences would hang the tab.
 */

/** An opening fence line: three backticks and an optional language word. */
const OPEN_RE = /^[ \t]*```[A-Za-z0-9_+-]*[ \t]*\r?$/;
/** A closing fence line: three backticks alone. */
const CLOSE_RE = /^[ \t]*```[ \t]*\r?$/;

/**
 * The fenced program in `text`, or null when it holds no fenced block (then
 * the text is the code, as typed). An unclosed or an empty block is no block:
 * there is nothing in it to read.
 */
export function programInReply(text: string): string | null {
  if (!text.includes('```')) return null;
  const lines = text.split('\n');
  const blocks: string[] = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    if (open < 0) {
      if (OPEN_RE.test(lines[i])) open = i;
    } else if (CLOSE_RE.test(lines[i])) {
      // Lines keep the `\r` of a Windows line end; the last one's belongs to
      // the line break before the closing fence, not to the program.
      const block = lines.slice(open + 1, i).join('\n').replace(/\r$/, '');
      if (block.trim() !== '') blocks.push(block);
      open = -1;
    }
  }
  if (blocks.length === 0) return null;
  for (let i = blocks.length - 1; i >= 0; i--) if (/\breturn\b/.test(blocks[i])) return blocks[i];
  return blocks[blocks.length - 1];
}
