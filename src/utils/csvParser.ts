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

/** Soft UX gate: above this column count, prompt the user before placing a
 *  Data node (vs. the hard MAX_COLUMNS cap, which rejects outright). */
export const COLUMN_WARN_THRESHOLD = 10;

/**
 * Transpose a parsed CSV: rows become columns and vice-versa. Used by the
 * >10-column import warning ("convert rows to columns") for datasets that are
 * really row-oriented. Original column headers are dropped — the new columns
 * are synthesized `row0`, `row1`, … (header strings never reach codegen anyway).
 * Returns a discriminated result so the caller can surface a message when the
 * transpose would exceed MAX_COLUMNS (transposed column count = original rows).
 */
export function transposeCsv(
  parsed: ParsedCsv,
): { ok: true; data: ParsedCsv } | { ok: false; error: string } {
  const { columns, rowCount } = parsed; // columns[c][r], column-major
  const newColumnCount = rowCount; // each old row → a new column
  const newRowCount = columns.length; // each old column → a new row

  if (newColumnCount < 1) return { ok: false, error: 'Nothing to transpose.' };
  if (newColumnCount > MAX_COLUMNS) {
    return {
      ok: false,
      error:
        `Transposing would produce ${newColumnCount} columns (max ${MAX_COLUMNS}). ` +
        `This CSV has too many rows to convert to columns.`,
    };
  }

  const newColumns: number[][] = Array.from({ length: newColumnCount }, (_, nc) =>
    columns.map((oldCol) => oldCol[nc]),
  );
  const columnNames = Array.from({ length: newColumnCount }, (_, i) => `row${i}`);
  return { ok: true, data: { columnNames, columns: newColumns, rowCount: newRowCount } };
}

/** Pick the delimiter that yields the most *data-shaped* rows — rows that split
 *  into ≥2 cells which are ALL finite numbers — across the first several lines.
 *  Scoring on the data rows (not the title/header) means a ';'- or tab-delimited
 *  file whose title line happens to contain a comma is still detected correctly.
 *  Ties break toward ',' (candidate order + strict `>`), preserving old behavior. */
function detectDelimiter(lines: string[]): string {
  const candidates = [',', ';', '\t'];
  const sample = lines.slice(0, 10);
  let best = ',';
  let bestScore = -1;
  for (const d of candidates) {
    let score = 0;
    for (const line of sample) {
      const cells = line.split(d).map((c) => c.trim());
      if (cells.length >= 2 && cells.every(isFiniteNumberCell)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
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

  const delimiter = detectDelimiter(lines);
  const splitRow = (line: string) => line.split(delimiter).map((c) => c.trim());

  // A row is pure header/metadata only when it has ZERO numeric cells (every
  // cell empty or non-numeric). The first row carrying AT LEAST ONE finite
  // number begins the data — from there, the strict all-cells-finite rule below
  // rejects the whole file on any bad cell (no silent hole-filling).
  const rowHasNoNumericCells = (cells: string[]) =>
    cells.every((c) => !isFiniteNumberCell(c));

  // Skip leading header/metadata rows — a column-name row, a separate units row
  // (e.g. `[m],[m]`), or several of them — and start data at the first row that
  // contains a number.
  let dataStart = 0;
  while (dataStart < lines.length && rowHasNoNumericCells(splitRow(lines[dataStart]))) {
    dataStart++;
  }
  if (dataStart >= lines.length) {
    return { ok: false, error: 'No numeric data rows found.' };
  }

  const columnCount = splitRow(lines[dataStart]).length; // ≥ 1 (splitRow always yields a cell)
  if (columnCount > MAX_COLUMNS) {
    return { ok: false, error: `Too many columns (${columnCount}); max ${MAX_COLUMNS}.` };
  }

  const rowCount = lines.length - dataStart;
  if (rowCount > MAX_ROWS) {
    return { ok: false, error: `Too many rows (${rowCount}); max ${MAX_ROWS}.` };
  }

  // Column names: join each column's cells across ALL header rows (a name row +
  // a units row → "x [m]"). Fall back to col0/col1… when a column has no header.
  const headerRows = lines.slice(0, dataStart).map(splitRow);
  const columnNames = Array.from({ length: columnCount }, (_, c) => {
    const name = headerRows
      .map((hr) => hr[c] ?? '')
      .filter((s) => s !== '')
      .join(' ')
      .trim();
    return name || `col${c}`;
  });

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
