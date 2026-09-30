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
import { valueNum, valueStr } from './valueCoerce';
import { getNodeValues } from '@/types';
import { MAX_COLUMNS, type ParsedCsv } from './csvParser';
import { float32ToBase64, base64ToFloat32 } from './binaryCodec';
import { capToWidth, MAX_TEXTURE_WIDTH } from './dataViz';
import { safeJsonReviver } from './safeJson';

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
 * MAX_TEXTURE_WIDTH before baking. What it does buy is a `JSON.stringify` in
 * every 300 ms autosave (against a localStorage budget the whole graph shares),
 * a re-embed in every export, and an `atob` per decode. History shares the
 * string by reference (`cloneNodesSharingPayloads`), so undo depth costs nothing.
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

  // Downsample to the texture budget BEFORE storing: graphToCode only ever
  // bakes `capToWidth(col, MAX_TEXTURE_WIDTH)`, so the full (up to 1M-row)
  // column would only inflate every autosave and export. Output-identical.
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

// One decode per `values` object: every edit path replaces `values` wholesale,
// and the columns are read-only views (both consumers copy via capToWidth).
const DECODE_MEMO = new WeakMap<object, DecodedDataNode | null>();

/** Decode a Data node's stored columns. Returns null if the payload is missing
 *  or malformed (graphToCode then emits an inert fallback). */
export function decodeDataNode(values: Record<string, string | number>): DecodedDataNode | null {
  if (typeof values !== 'object' || values === null) return null;
  let decoded = DECODE_MEMO.get(values);
  if (decoded === undefined) {
    decoded = decodeUncached(values);
    DECODE_MEMO.set(values, decoded);
  }
  return decoded;
}

function decodeUncached(values: Record<string, string | number>): DecodedDataNode | null {
  const rowCount = valueNum(values.rowCount);
  const columnCount = valueNum(values.columnCount);
  const dataB64 = valueStr(values.dataB64 ?? '');
  if (!Number.isInteger(rowCount) || rowCount <= 0) return null;
  if (!Number.isInteger(columnCount) || columnCount <= 0) return null;
  if (!dataB64) return null;
  // Three O(1) ceilings BEFORE the linear decode; none can reject anything this
  // app wrote (see MAX_DATA_ENCODED_CHARS). The COLUMN one is not redundant: a
  // legal-size blob declared `rowCount: 1, columnCount: 131072` passes the
  // other checks and allocates 131k views (measured 13.5 ms vs 0.1 ms).
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
    // A trust boundary (`.fastshader` / localStorage), hence the shared
    // deny-list reviver — pinned by safeJson.test.ts.
    const parsed = JSON.parse(valueStr(values.columnNames ?? '[]'), safeJsonReviver);
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
 * An unbounded `dataB64` is `JSON.stringify`'d into every 300 ms autosave,
 * re-embedded into every export and `atob`-decoded; a hand-edited 60 MB
 * payload OOMs the tab within a few dozen edits.
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
