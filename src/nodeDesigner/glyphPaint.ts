/**
 * The glyph editor's paint vocabulary: the design palette its art is drawn from,
 * and the pure value handling behind the fill / stroke / width controls.
 *
 * WHY A FIXED PALETTE AND NOT A COLOUR PICKER. Glyphs must render IDENTICALLY in
 * the light and dark themes (CLAUDE.md's theme rule: node bodies read the
 * theme-invariant `--node-bg`, and `--shadow-node*`/`--type-*`/`--cat-*` are
 * deliberately not redefined in the dark block), so a glyph colour is not a
 * preference — it is part of a fixed dark-on-light illustration system. Every
 * shipped glyph draws from the eight constants in `NodeGlyph.tsx`, and those
 * carry meaning: orange is the plotted function, grey the construction lines,
 * blue the second operand, green the result. A free-form picker would let an
 * author put a mid-grey on a node nobody can read in either theme, silently.
 * Hand-typing `fill="#123456"` in the SVG box stays available for the rare case —
 * it is deliberately the slower path, and deliberately not policed by a test
 * (a drift guard there would turn the escape hatch into a release-blocking
 * failure the moment someone used it).
 *
 * Pure and import-free so the vitest node env can cover it.
 */

export interface PaletteEntry { name: string; hex: string; note: string }

/**
 * The eight constants from `components/NodeEditor/nodes/glyphs/NodeGlyph.tsx`
 * plus white, in the order the bar shows them: ink and greys first (structure),
 * then the warm accent pair (the subject), then the cool trio (operands and
 * results). Keep the hexes in sync with that file — they are the same palette,
 * written twice because `designerApp.ts` is vanilla and cannot import a React
 * module's private constants.
 */
export const GLYPH_PALETTE: PaletteEntry[] = [
  { name: 'Ink', hex: '#2B2B2B', note: 'strong strokes / glyph text' },
  { name: 'Construct', hex: '#8A8F9C', note: 'construction & reference lines' },
  { name: 'Axis', hex: '#B4B7C0', note: 'plot axes' },
  { name: 'Accent', hex: '#F57C00', note: 'primary curve / accent' },
  { name: 'Area', hex: '#FF9800', note: 'area fill under curves' },
  { name: 'Blue', hex: '#2D6CDF', note: 'secondary operand' },
  { name: 'Green', hex: '#2E9E5B', note: 'result vector' },
  { name: 'Teal', hex: '#1796A0', note: 'int / knob accent' },
  { name: 'White', hex: '#FFFFFF', note: 'knockout' },
];

const PALETTE_SET = new Set(GLYPH_PALETTE.map((p) => p.hex.toLowerCase()));

/** Is this a colour the bar can show as a pressed swatch? */
export function isPaletteColor(v: string | null): boolean {
  return !!v && PALETTE_SET.has(v.toLowerCase());
}

function hex2(n: number): string { const s = Math.max(0, Math.min(255, Math.round(n))).toString(16); return s.length < 2 ? '0' + s : s; }

/**
 * Canonicalise a paint value for COMPARISON.
 *
 * `getComputedStyle` is the only honest way to read what a shape is actually
 * painted with — presentation attributes, inline `style`, and inheritance from a
 * parent `<g fill="none" stroke="#2B2B2B">` (23 of the 50 shipped groups carry
 * paint) all resolve there and nowhere else. But CSSOM answers in `rgb()`, so
 * without this a shape painted the palette's own `#2D6CDF` reads back as
 * `rgb(45, 108, 223)`, matches no swatch, and the bar shows nothing pressed for a
 * colour that IS in the palette.
 *
 * Returns lower-case `#rrggbb`, the literal `none`, or null for anything it
 * cannot reduce (a gradient `url(#…)`, `currentColor`, a named colour) — null
 * means "show it as unknown", never "assume black".
 */
export function normalizePaintValue(raw: string | null | undefined): string | null {
  const v = (raw || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'none' || v === 'transparent') return 'none';
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return '#' + m[1].split('').map((c) => c + c).join('');
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return '#' + m[1];
  m = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*(?:[,/]\s*([0-9.%]+)\s*)?\)$/.exec(v);
  if (m) {
    /* A fully transparent paint is `none` to the eye, which is what the bar has
       to show — `rgba(0,0,0,0)` is what CSSOM returns for `fill="transparent"`. */
    if (m[4] != null && parseFloat(m[4]) === 0) return 'none';
    return '#' + hex2(parseFloat(m[1])) + hex2(parseFloat(m[2])) + hex2(parseFloat(m[3]));
  }
  return null;
}

/**
 * Canonicalise a stroke width for WRITING.
 *
 * Adversarial in the ordinary sense: the value arrives from a number input the
 * user can type anything into, and it is written straight into art that is
 * serialized and shipped. `fmtN(NaN)` would emit the literal `NaN`, which renders
 * as nothing with no parse error and a happily-enabled Apply — the failure the
 * scale gesture's zero-extent guard exists to prevent, one attribute over.
 *
 * Returns null when there is no usable number, which callers treat as "leave the
 * attribute alone".
 */
export function normalizePaintNumber(raw: string | number | null | undefined, max = 24): string | null {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw == null ? '' : raw).trim());
  if (!Number.isFinite(n)) return null;
  const c = Math.max(0, Math.min(max, n));
  return String(Math.round(c * 100) / 100);
}

/**
 * A stored number as an `<input type="number">` can display it.
 *
 * Twelve of the 84 shipped `stroke-width` values are written leading-dot (`.8`,
 * `.6`, `.7`, `.9`), and the HTML valid-floating-point grammar requires a digit
 * before the point — so assigning `'.8'` to a number input sanitizes it to the
 * EMPTY STRING, which is visually identical to the bar's "mixed" state. Selecting
 * a `.8`-stroked shape would show a blank width box.
 */
export function displayPaintNumber(raw: string | null | undefined): string {
  const n = normalizePaintNumber(raw);
  return n == null ? '' : n;
}

export interface PaintSummary {
  /** the shared value, or null when the targets disagree / none is known */
  value: string | null;
  /** true when the targets carry more than one distinct value */
  mixed: boolean;
}

/**
 * Fold what N selected shapes are painted with into what one control can show.
 * An empty selection is `{value: null, mixed: false}` — "nothing to report",
 * distinct from `{value: null, mixed: true}`, which is "they disagree".
 */
export function summarizePaint(values: Array<string | null>): PaintSummary {
  if (!values.length) return { value: null, mixed: false };
  const first = values[0];
  for (let i = 1; i < values.length; i++) { if (values[i] !== first) return { value: null, mixed: true }; }
  return { value: first, mixed: false };
}
