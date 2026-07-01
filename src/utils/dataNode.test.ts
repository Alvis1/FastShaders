import { describe, it, expect } from 'vitest';
import { makeDataNodeData, decodeDataNode } from './dataNode';
import type { ParsedCsv } from './csvParser';

const sample: ParsedCsv = {
  columnNames: ['x [m]', 'y [m]'],
  columns: [
    [0, 1e-6, 2e-6],
    [0.0036878816, 0.004197372, 0.0042072801],
  ],
  rowCount: 3,
};

describe('makeDataNodeData → decodeDataNode round-trip', () => {
  it('builds a Data node with one output per column', () => {
    const data = makeDataNodeData(sample, 2);
    expect(data.registryType).toBe('dataNode');
    expect(data.cost).toBe(2);
    expect(data.dynamicOutputs).toEqual([
      { id: 'col0', label: 'x [m]', dataType: 'float' },
      { id: 'col1', label: 'y [m]', dataType: 'float' },
    ]);
    expect(data.values.rowCount).toBe(3);
    expect(data.values.columnCount).toBe(2);
  });

  it('decodes the columns back with float32 fidelity', () => {
    const data = makeDataNodeData(sample, 2);
    const decoded = decodeDataNode(data.values);
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    expect(decoded.columnNames).toEqual(['x [m]', 'y [m]']);
    expect(decoded.rowCount).toBe(3);
    expect(decoded.columns).toHaveLength(2);
    // float32 storage → compare with tolerance (1e-6 is not exactly representable).
    expect(decoded.columns[0][0]).toBe(0);
    expect(decoded.columns[0][1]).toBeCloseTo(1e-6, 12);
    expect(decoded.columns[0][2]).toBeCloseTo(2e-6, 12);
    expect(decoded.columns[1][0]).toBeCloseTo(0.0036878816, 6);
  });

  it('returns null on a malformed payload', () => {
    expect(decodeDataNode({})).toBeNull();
    expect(decodeDataNode({ rowCount: 3, columnCount: 2, dataB64: '' })).toBeNull();
    expect(decodeDataNode({ rowCount: 0, columnCount: 2, dataB64: 'AAAA' })).toBeNull();
  });

  it('synthesizes names when columnNames is missing/mismatched', () => {
    const data = makeDataNodeData(sample, 2);
    const decoded = decodeDataNode({ ...data.values, columnNames: '[]' });
    expect(decoded?.columnNames).toEqual(['col0', 'col1']);
  });
});
