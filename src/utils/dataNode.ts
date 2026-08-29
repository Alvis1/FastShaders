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

import type { AppNode, PortDefinition, ShaderNodeData } from '@/types';
import { getNodeValues } from '@/types';
import { MAX_COLUMNS, type ParsedCsv } from './csvParser';
import { float32ToBase64, base64ToFloat32 } from './binaryCodec';
import { capToWidth, MAX_TEXTURE_WIDTH } from './dataViz';

/**
 * Largest `dataB64` a legitimately-constructed Data node can hold — a CAP
 * DERIVED FROM THE CONSTRUCTION PATH, not a policy number, so it moves
 * automatically if either input bound does.
 *
 * `parseCsv` refuses more than MAX_COLUMNS (16) columns and `makeDataNodeData`
 * runs every column through `capToWidth(col, MAX_TEXTURE_WIDTH)` (8192) BEFORE
 * storing, so the packed Float32 blob is at most 16 × 8192 × 4 = 524,288 bytes
 * → 4·ceil(524288/3) = 699,052 base64 chars. A longer payload can only come
 * from a tampered file, and it buys nothing on screen: graphToCode re-caps to
 * MAX_TEXTURE_WIDTH before baking. What it does buy is ~51 `structuredClone`
 * history copies, a `JSON.stringify` in every 300 ms autosave, a re-embed in
 * every export, and an `atob` on every graphToCode pass.
 */
export const MAX_DATA_ENCODED_CHARS = 4 * Math.ceil((MAX_COLUMNS * MAX_TEXTURE_WIDTH * 4) / 3);

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

/**
 * The Data column an edge leaves from, capped to the texture budget — i.e.
 * exactly the samples that get baked into the shader, so statistics computed
 * from it describe what is actually rendered rather than the pre-cap CSV.
 *
 * Returns null unless the source really is a Data node emitting a `colN`
 * handle: the trace is deliberately one hop, so an intervening node means "no
 * statistics available" rather than a guess. Shared by graphToCode (which needs
 * the values) and the settings menus (which show the numbers), so the two can
 * never disagree about which samples are in play.
 */
export function columnForHandle(
  data: ShaderNodeData | undefined,
  sourceHandle: string | null | undefined,
): Float32Array | null {
  if (!data || data.registryType !== 'dataNode') return null;
  const m = /^col(\d+)$/.exec(sourceHandle ?? '');
  if (!m) return null;
  const col = decodeDataNode(data.values)?.columns[Number(m[1])];
  if (!col || col.length <= 1) return null;
  return capToWidth(col, MAX_TEXTURE_WIDTH);
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
  // Three O(1) ceilings BEFORE the decode — same first-check discipline as
  // `decodeImageNode`. `atob` + the byte loop are linear in the payload, and
  // this runs on EVERY graphToCode pass (the decode happens before it even
  // checks whether a column is wired), so an unbounded string out of a
  // tampered file is re-decoded on every graph edit.
  //
  // The COLUMN ceiling is not redundant with the length one: a blob of exactly
  // the legal size declared as `rowCount: 1, columnCount: 131072` passes both
  // the length cap and the `flat.length >= rowCount * columnCount` check below,
  // then allocates 131k Float32Array views plus 131k synthesized names per pass
  // (measured 13.5 ms vs 0.1 ms for the legitimate 16x8192 shape).
  //
  // None of the three can reject anything this app wrote: `parseCsv` /
  // `transposeCsv` cap real files at MAX_COLUMNS and `makeDataNodeData` stores
  // `capToWidth(col, MAX_TEXTURE_WIDTH)`, so the construction worst case is
  // exactly MAX_DATA_ENCODED_CHARS at MAX_COLUMNS x MAX_TEXTURE_WIDTH.
  if (dataB64.length > MAX_DATA_ENCODED_CHARS) return null;
  if (columnCount > MAX_COLUMNS) return null;
  if (rowCount > MAX_TEXTURE_WIDTH) return null;

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

export interface DataSanitizeResult {
  nodes: AppNode[];
  /** How many Data payloads were emptied (node kept, columns dropped). */
  strippedCount: number;
}

/**
 * Bound Data-node payloads on graphs entering the store from outside the CSV
 * drop path (project import, the localStorage graph, the saved-group library)
 * — the data-side twin of `sanitizeImageNodes`.
 *
 * `dataB64` was the last unbounded attacker-controlled string on a node.
 * Unlike `imageB64` nothing capped it on any load path, yet it rides ~51
 * `structuredClone` history copies, is `JSON.stringify`'d into every 300 ms
 * autosave, re-embeds into every export, and is `atob`-decoded on every
 * `graphToCode` pass. A hand-edited 60 MB payload OOMs the tab within a few
 * dozen edits.
 *
 * There is deliberately NO soft/hard split (the shape `sanitizeImageNodes`
 * has): images need one because the user can opt out of the soft caps via
 * `ignoreImageLimits`, and there is no data equivalent — `makeDataNodeData`
 * caps unconditionally, so `MAX_DATA_ENCODED_CHARS` is a construction bound
 * rather than a policy limit and nothing above it can be legitimate.
 *
 * Stripping empties `dataB64` and KEEPS the node: `dynamicOutputs` still
 * renders every socket, and graphToCode degrades each consumed column to the
 * inert `float(0.0)` an undecodable payload already gets. The array identity
 * is preserved when nothing changed, so an untouched graph doesn't look like
 * a mutation to the store's reference comparisons.
 */
export function sanitizeDataNodes(nodes: AppNode[]): DataSanitizeResult {
  let strippedCount = 0;
  let changed = false;
  const out = nodes.map((n) => {
    if (n.data?.registryType !== 'dataNode') return n;
    const values = getNodeValues(n);
    const b64 = values.dataB64;
    if (typeof b64 !== 'string' || b64.length <= MAX_DATA_ENCODED_CHARS) return n;
    strippedCount++;
    changed = true;
    return { ...n, data: { ...n.data, values: { ...values, dataB64: '' } } } as AppNode;
  });
  return { nodes: changed ? out : nodes, strippedCount };
}
