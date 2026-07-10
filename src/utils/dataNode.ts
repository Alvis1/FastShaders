/**
 * Build / decode the `dataNode` payload.
 *
 * A dropped CSV becomes one Data node whose numeric columns are stored
 * column-major in a single base64 Float32 blob on `data.values` (so the whole
 * node round-trips through localStorage and the embedded `.js` project snapshot
 * with no special handling). Column *names* live only as port labels — they are
 * never emitted into generated code, which addresses outputs as `col0`, `col1`,
 * … Each output samples its column's DataTexture at uv.x (see graphToCode).
 */

import type { PortDefinition, ShaderNodeData } from '@/types';
import type { ParsedCsv } from './csvParser';
import { float32ToBase64, base64ToFloat32 } from './binaryCodec';
import { capToWidth, MAX_TEXTURE_WIDTH } from './dataViz';

export interface DecodedDataNode {
  columnNames: string[];
  rowCount: number;
  /** One Float32Array view per column (column-major slices of the blob). */
  columns: Float32Array[];
}

/** Construct the `ShaderNodeData` for a Data node from a parsed CSV. The
 *  `fileName` is display-only (shown under the node header). */
export function makeDataNodeData(parsed: ParsedCsv, cost: number, fileName = ''): ShaderNodeData {
  const { columnNames, columns } = parsed;
  const columnCount = columns.length;

  // Downsample each column to the texture budget BEFORE storing. graphToCode
  // only ever bakes `capToWidth(col, MAX_TEXTURE_WIDTH)`, so storing the full
  // (up to 1M-row) column is pure waste — it inflates the base64 payload that
  // rides in every localStorage autosave and 50-deep undo snapshot, exhausting
  // the storage quota far sooner than necessary. Capping here is output-
  // identical (graphToCode's later capToWidth becomes a no-op copy).
  const cappedCols = columns.map((c) => capToWidth(c, MAX_TEXTURE_WIDTH));
  const storedRows = cappedCols.length > 0 ? cappedCols[0].length : 0;

  // Pack columns end-to-end (column-major) into one Float32Array.
  const flat = new Float32Array(storedRows * columnCount);
  for (let c = 0; c < columnCount; c++) flat.set(cappedCols[c], c * storedRows);

  const dynamicOutputs: PortDefinition[] = columnNames.map((name, i) => ({
    id: `col${i}`,
    label: name,
    dataType: 'float',
  }));

  return {
    registryType: 'dataNode',
    label: 'Data',
    cost,
    values: {
      columnNames: JSON.stringify(columnNames),
      rowCount: storedRows,
      columnCount,
      dataB64: float32ToBase64(flat),
      fileName,
    },
    dynamicOutputs,
  };
}

/** Decode a Data node's stored columns. Returns null if the payload is missing
 *  or malformed (graphToCode then emits an inert fallback). */
export function decodeDataNode(values: Record<string, string | number>): DecodedDataNode | null {
  const rowCount = Number(values.rowCount);
  const columnCount = Number(values.columnCount);
  const dataB64 = String(values.dataB64 ?? '');
  if (!Number.isInteger(rowCount) || rowCount <= 0) return null;
  if (!Number.isInteger(columnCount) || columnCount <= 0) return null;
  if (!dataB64) return null;

  let flat: Float32Array;
  try {
    flat = base64ToFloat32(dataB64);
  } catch {
    return null;
  }
  if (flat.length < rowCount * columnCount) return null;

  const columns: Float32Array[] = [];
  for (let c = 0; c < columnCount; c++) {
    columns.push(flat.subarray(c * rowCount, (c + 1) * rowCount));
  }

  let columnNames: string[] = [];
  try {
    const parsed = JSON.parse(String(values.columnNames ?? '[]'));
    if (Array.isArray(parsed)) columnNames = parsed.map((s) => String(s));
  } catch {
    // Fall back to synthesized names below.
  }
  if (columnNames.length !== columnCount) {
    columnNames = Array.from({ length: columnCount }, (_, i) => `col${i}`);
  }

  return { columnNames, rowCount, columns };
}
