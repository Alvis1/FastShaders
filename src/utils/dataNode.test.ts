import { describe, it, expect } from 'vitest';
import { makeDataNodeData, decodeDataNode, sanitizeDataNodes, MAX_DATA_ENCODED_CHARS } from './dataNode';
import type { AppNode } from '@/types';
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

describe('adversarial dataNode payloads', () => {
  it('MAX_DATA_ENCODED_CHARS matches the construction worst case', () => {
    // 16 cols x 8192 rows x 4 bytes, base64-expanded.
    expect(MAX_DATA_ENCODED_CHARS).toBe(699052);
  });

  it('decodeDataNode rejects an over-cap payload without decoding it', () => {
    const big = 'A'.repeat(MAX_DATA_ENCODED_CHARS + 1);
    expect(decodeDataNode({ rowCount: 1, columnCount: 1, dataB64: big })).toBeNull();
  });

  it('decodeDataNode rejects an absurd column count that passes the length cap', () => {
    // The 131072-column shape: legal-size blob, but 131k subarray views + names.
    const blob = 'A'.repeat(699052);
    expect(decodeDataNode({ rowCount: 1, columnCount: 131072, dataB64: blob })).toBeNull();
  });

  it('decodeDataNode rejects an over-budget row count', () => {
    expect(decodeDataNode({ rowCount: 8193, columnCount: 1, dataB64: 'AAAA' })).toBeNull();
  });

  it('still decodes a legitimately-constructed payload', () => {
    const data = makeDataNodeData(
      { columnNames: ['a', 'b'], columns: [[1, 2], [3, 4]], rowCount: 2 },
      0,
      't.csv',
    );
    const decoded = decodeDataNode(data.values);
    expect(decoded).not.toBeNull();
    expect(decoded!.columns).toHaveLength(2);
    expect(Array.from(decoded!.columns[1])).toEqual([3, 4]);
  });

  it('sanitizeDataNodes empties an over-cap payload but keeps the node', () => {
    const big = 'A'.repeat(MAX_DATA_ENCODED_CHARS + 1);
    const nodes = [
      { id: 'd', type: 'shader', position: { x: 0, y: 0 },
        data: { registryType: 'dataNode', label: 'Data', cost: 0, values: { dataB64: big, rowCount: 1, columnCount: 1 } } },
    ] as unknown as AppNode[];
    const r = sanitizeDataNodes(nodes);
    expect(r.strippedCount).toBe(1);
    expect(r.nodes).toHaveLength(1);
    expect((r.nodes[0].data as { values: Record<string, unknown> }).values.dataB64).toBe('');
    // Input must not be mutated.
    expect((nodes[0].data as { values: Record<string, unknown> }).values.dataB64).toBe(big);
  });

  it('sanitizeDataNodes preserves array identity when nothing is over-cap', () => {
    const data = makeDataNodeData(
      { columnNames: ['a'], columns: [[1, 2, 3]], rowCount: 3 }, 0, 'ok.csv',
    );
    const nodes = [
      { id: 'd', type: 'shader', position: { x: 0, y: 0 }, data },
    ] as unknown as AppNode[];
    const r = sanitizeDataNodes(nodes);
    expect(r.nodes).toBe(nodes);
    expect(r.strippedCount).toBe(0);
  });
});
