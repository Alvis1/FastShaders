/**
 * Strict CSV parser for the drag-and-drop Data node.
 *
 * A `.fastshader` graph (and any CSV a user drops) is treated as adversarial
 * input, so the rules here are deliberately conservative:
 *  - every data cell MUST parse to a finite number; any non-numeric/empty cell
 *    rejects the whole file (no silent hole-filling).
 *  - column names are captured as UI-only strings; the engine never emits them
 *    into generated code (outputs are addressed as `col0`, `col1`, …), so a
 *    crafted header can't inject identifiers.
 *  - row/column counts are bounded so a pathological file can't lock the tab.
 *
 * The result is column-major (`columns[c][r]`) because every downstream
 * consumer (DataTexture bake, min/max, phase ramp) works one column at a time.
 */

export interface ParsedCsv {
  /** Display labels, one per column (from the header row, or synthesized). */
  columnNames: string[];
  /** Column-major numeric data: `columns[c]` is column c's values. */
  columns: number[][];
  rowCount: number;
}

export type CsvParseResult =
  | { ok: true; data: ParsedCsv }
  | { ok: false; error: string };

/** Hard caps — generous for real datasets, tight enough to refuse abuse. */
export const MAX_COLUMNS = 16;
export const MAX_ROWS = 1_000_000;

/** Pick the delimiter by counting candidates in the first non-empty line. */
function detectDelimiter(line: string): string {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    const count = line.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** True when a trimmed cell parses to a finite JS number. Rejects '', NaN,
 *  Infinity, and trailing-garbage like '1.2x' (Number('1.2x') is NaN). */
function isFiniteNumberCell(cell: string): boolean {
  if (cell === '') return false;
  const n = Number(cell);
  return Number.isFinite(n);
}

export function parseCsv(text: string): CsvParseResult {
  // Normalize newlines, split, and drop blank lines (trailing newline, etc.).
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  const lines: string[] = [];
  for (const l of rawLines) {
    if (l.trim() !== '') lines.push(l);
  }
  if (lines.length === 0) return { ok: false, error: 'CSV is empty.' };

  const delimiter = detectDelimiter(lines[0]);
  const splitRow = (line: string) => line.split(delimiter).map((c) => c.trim());

  const firstCells = splitRow(lines[0]);
  const columnCount = firstCells.length;
  if (columnCount < 1) return { ok: false, error: 'No columns found.' };
  if (columnCount > MAX_COLUMNS) {
    return { ok: false, error: `Too many columns (${columnCount}); max ${MAX_COLUMNS}.` };
  }

  // Header detection: if any first-row cell is non-numeric, treat row 0 as a
  // header. Otherwise synthesize names and keep row 0 as data.
  const headerIsLabels = firstCells.some((c) => !isFiniteNumberCell(c));
  const columnNames = headerIsLabels
    ? firstCells.map((c, i) => (c === '' ? `col${i}` : c))
    : firstCells.map((_, i) => `col${i}`);

  const dataStart = headerIsLabels ? 1 : 0;
  const rowCount = lines.length - dataStart;
  if (rowCount < 1) return { ok: false, error: 'CSV has a header but no data rows.' };
  if (rowCount > MAX_ROWS) {
    return { ok: false, error: `Too many rows (${rowCount}); max ${MAX_ROWS}.` };
  }

  const columns: number[][] = Array.from({ length: columnCount }, () => [] as number[]);

  for (let r = dataStart; r < lines.length; r++) {
    const cells = splitRow(lines[r]);
    if (cells.length !== columnCount) {
      return {
        ok: false,
        error: `Row ${r + 1} has ${cells.length} columns; expected ${columnCount}.`,
      };
    }
    for (let c = 0; c < columnCount; c++) {
      const cell = cells[c];
      if (!isFiniteNumberCell(cell)) {
        return {
          ok: false,
          error: `Row ${r + 1}, column ${c + 1} ("${cell}") is not a finite number.`,
        };
      }
      columns[c].push(Number(cell));
    }
  }

  return { ok: true, data: { columnNames, columns, rowCount } };
}
