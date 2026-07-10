import { describe, it, expect } from 'vitest';
import { parseCsv, transposeCsv, MAX_COLUMNS, COLUMN_WARN_THRESHOLD } from './csvParser';

describe('parseCsv', () => {
  it('parses a headered 2-column CSV (F1.csv shape)', () => {
    const res = parseCsv('x [m],y [m]\n0,0.0036878816\n1e-06,0.004197372\n2e-06,0.0042072801\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.columnNames).toEqual(['x [m]', 'y [m]']);
    expect(res.data.rowCount).toBe(3);
    expect(res.data.columns).toHaveLength(2);
    expect(res.data.columns[0]).toEqual([0, 1e-6, 2e-6]);
    expect(res.data.columns[1][0]).toBeCloseTo(0.0036878816, 9);
  });

  it('synthesizes names when the first row is all numeric (no header)', () => {
    const res = parseCsv('0,1\n2,3\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.columnNames).toEqual(['col0', 'col1']);
    expect(res.data.rowCount).toBe(2);
    expect(res.data.columns[0]).toEqual([0, 2]);
  });

  it('skips a units row (multi-row header) and merges it into the names', () => {
    // AU2.csv shape: a name row, then a units row, then data.
    const res = parseCsv('x,y\n[m],[m]\n0,0.1\n1e-06,0.2\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.columnNames).toEqual(['x [m]', 'y [m]']);
    expect(res.data.rowCount).toBe(2);
    expect(res.data.columns[0]).toEqual([0, 1e-6]);
    expect(res.data.columns[1]).toEqual([0.1, 0.2]);
  });

  it('skips several leading metadata rows before numeric data', () => {
    const res = parseCsv('Distance,Height\n[m],[m]\nsensor A,sensor B\n0,5\n1,6\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rowCount).toBe(2);
    expect(res.data.columnNames).toEqual(['Distance [m] sensor A', 'Height [m] sensor B']);
  });

  it('still rejects a non-numeric cell in the MIDDLE of the data', () => {
    const res = parseCsv('x,y\n[m],[m]\n0,0.1\n1,oops\n');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/not a finite number/i);
  });

  it('detects a semicolon delimiter', () => {
    const res = parseCsv('a;b\n1;2\n3;4\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.columns[1]).toEqual([2, 4]);
  });

  it('detects the delimiter from data rows, not a comma-bearing title row', () => {
    // Title line contains a comma but the data is semicolon-delimited; the
    // delimiter must be picked from the numeric rows, not line 0.
    const res = parseCsv('Sensor log, run 3\nx;y\n1;2\n3;4\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.columns).toHaveLength(2);
    expect(res.data.columns[0]).toEqual([1, 3]);
    expect(res.data.columns[1]).toEqual([2, 4]);
  });

  it('does not silently skip a real first data row with an empty cell', () => {
    // The `0,` row has a numeric first cell, so it IS the first data row and
    // must be rejected (empty second cell) — never swallowed as a header.
    const res = parseCsv('x,y\n0,\n1,2\n3,4');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/not a finite number/i);
  });

  it('rejects a non-numeric data cell (no silent hole-filling)', () => {
    const res = parseCsv('x,y\n0,0.1\n1,oops\n');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/not a finite number/i);
  });

  it('rejects Infinity / NaN cells', () => {
    expect(parseCsv('x,y\n0,Infinity\n').ok).toBe(false);
    expect(parseCsv('x,y\n0,NaN\n').ok).toBe(false);
  });

  it('rejects ragged rows', () => {
    const res = parseCsv('x,y\n1,2\n3\n');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/expected 2/i);
  });

  it('rejects an empty file and a header-only file', () => {
    expect(parseCsv('').ok).toBe(false);
    expect(parseCsv('   \n  \n').ok).toBe(false);
    expect(parseCsv('x,y\n').ok).toBe(false);
  });

  it('ignores blank trailing lines', () => {
    const res = parseCsv('x,y\n1,2\n\n\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rowCount).toBe(1);
  });

  it('enforces the column cap', () => {
    const wide = Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => i).join(',');
    const res = parseCsv(`${wide}\n${wide}\n`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/too many columns/i);
  });
});

describe('transposeCsv', () => {
  it('swaps rows and columns and synthesizes row names', () => {
    // 3 columns × 2 rows → 2 columns × 3 rows
    const res = transposeCsv({ columnNames: ['a', 'b', 'c'], columns: [[1, 2], [3, 4], [5, 6]], rowCount: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.columnNames).toEqual(['row0', 'row1']);
    expect(res.data.rowCount).toBe(3);
    expect(res.data.columns).toEqual([[1, 3, 5], [2, 4, 6]]);
  });

  it('round-trips a parsed CSV (original rows become new columns)', () => {
    const parsed = parseCsv('x,y,z\n1,2,3\n4,5,6\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const t = transposeCsv(parsed.data);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.data.columns).toHaveLength(2);
    expect(t.data.rowCount).toBe(3);
    expect(t.data.columns[0]).toEqual([1, 2, 3]); // first original row → first new column
  });

  it('rejects when transposing would exceed MAX_COLUMNS', () => {
    const rows = MAX_COLUMNS + 1; // → rows becomes the new column count
    const res = transposeCsv({
      columnNames: ['a', 'b'],
      columns: [Array.from({ length: rows }, (_, i) => i), Array.from({ length: rows }, (_, i) => i * 2)],
      rowCount: rows,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/max/i);
  });

  it('keeps the soft threshold below the hard cap', () => {
    expect(COLUMN_WARN_THRESHOLD).toBeLessThan(MAX_COLUMNS);
  });
});
