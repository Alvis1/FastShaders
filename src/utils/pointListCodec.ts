/**
 * The ONE grammar of the point-list strings Color Ramp and RGB Curves store in
 * `values` AND write into the generated code as a plain string argument
 * (`fsColorRamp(fac, "0 #000000 1,1 #ffffff 1", "linear")`). Two
 * implementations exist by necessity: this module (the editor, the card art,
 * the CPU evaluator, codeToGraph's reader) and `fsLut`'s `unit`/`hex`/`word`/
 * `rows` in `engine/lutHelperText.ts`, which bakes the texture at module load
 * inside the preview, the export and podest. `lutHelpers.test.ts` holds the two
 * to one adversarial corpus, so a token one side accepts the other refuses is a
 * test failure, not a ramp that renders differently in the export.
 *
 * PARSE-THEN-RE-EMIT (the Data Range formula's rule): the emitted string is
 * always `formatUnit` + lowercased hex re-written from the parse, never the
 * stored text, so its alphabet is `[0-9.#a-f, ]` — it cannot close the string
 * literal, a block comment or a `<script>`, whatever a `.fastshader` holds.
 *
 * Everything is tested by EXPLICIT code-unit ranges: `Number()` alone accepts
 * ' 1 ', '0x10', '1e3' and 'Infinity', and `charCode | 32` maps U+0010–U+0019
 * onto '0'–'9' (a hex token of control characters decoded to NaN texels).
 * LEAF — imports nothing.
 */

/** Checked BEFORE any split, so a multi-megabyte value costs one length read. */
export const POINT_LIST_MAX_CHARS = 1024;
/** Blender's MAXCOLORBAND; also the curve-point cap. */
export const POINT_LIST_MAX_RECORDS = 32;

/** 1..12 chars of [0-9.], at most one dot, at least one digit → Number, then > 1 clamps to 1. Never negative,
 *  never exponent/hex/Infinity/whitespace/non-ASCII digits. Mirrors fsLut.unit char-for-char. */
export function unitToken(s: string): number | null {
  let dots = 0;
  let digits = 0;
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    if (k === 46) dots++;
    else if (k >= 48 && k <= 57) digits++;
    else return null;
  }
  if (dots > 1 || digits === 0 || s.length > 12) return null;
  const num = Number(s);
  return num > 1 ? 1 : num;
}

/** '#' + 6 hex digits, either case, tested by EXPLICIT code ranges 48–57, 65–70, 97–102 — never `charCode | 32`,
 *  which maps U+0010–U+0019 onto '0'–'9'. Returns the LOWERCASED hex or null. Mirrors fsLut.hex. */
export function hexToken(s: string): string | null {
  if (s.length !== 7 || s.charCodeAt(0) !== 35) return null;
  for (let i = 1; i < 7; i++) {
    const k = s.charCodeAt(i);
    if (!((k >= 48 && k <= 57) || (k >= 65 && k <= 70) || (k >= 97 && k <= 102))) return null;
  }
  return s.toLowerCase();
}

/** 1..12 lowercase ASCII letters — the tolerated 3rd curve token (a future handle type). Mirrors fsLut.word. */
export function wordToken(s: string): boolean {
  if (s.length < 1 || s.length > 12) return false;
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    if (k < 97 || k > 122) return false;
  }
  return true;
}

/** null unless raw is a non-empty string ≤ 1024 chars; split on ',', each record trimmed and split on ' ' with
 *  empty tokens dropped; null unless min ≤ records ≤ max. Mirrors fsLut.rows. */
export function splitRecords(raw: unknown, min: number, max: number): string[][] | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > POINT_LIST_MAX_CHARS) return null;
  const recs = raw.split(',');
  if (recs.length < min || recs.length > max) return null;
  return recs.map((rec) => rec.trim().split(' ').filter((tok) => tok !== ''));
}

/** THE canonical writer: non-finite → 0, clamp to [0,1], round to 1e-4, String(). Never an exponent
 *  (smallest non-zero is "0.0001"), always re-parses by unitToken to the same number (idempotent). */
export function formatUnit(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const v = n < 0 ? 0 : n > 1 ? 1 : n;
  // `+ 0` folds a -0 from Math.round into 0 (String(-0) is "0" anyway; this keeps the number clean too).
  return String(Math.round(v * 1e4) / 1e4 + 0);
}
