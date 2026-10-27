/**
 * Pure text model for the on-node "value arriving on this edge" labels —
 * shared by the static `edgeValueLabel` (ShaderNode) and the animated
 * `LiveEdgeValue` span, so the ticking path can never format differently
 * from the resting one. Node-env testable; no DOM.
 */
import { evaluateNodeOutput, evaluateEdgeSource, evaluateEdgeRange } from '@/engine/cpuEvaluator';

type Nodes = Parameters<typeof evaluateNodeOutput>[1];
type Edges = Parameters<typeof evaluateNodeOutput>[2];

/**
 * A number too small for two decimals but not zero, at ONE significant digit
 * ("0.003", "-0.0003"; a very small one may read "3e-7") — or null for 0 and
 * for |n| ≥ 0.01. Shared by the on-node labels and the EdgeInfoCard chip so a
 * tiny constant never prints as a flat "0" / "0.00" on either.
 */
export function tinyNum(n: number): string | null {
  const a = Math.abs(n);
  // String() of a number never spells "-0", so neither can this.
  return a > 0 && a < 0.01 ? String(Number(n.toPrecision(1))) : null;
}

/** Up to 2 decimals, trailing zeros trimmed ("3.69", "5", "-0.7"); a value
 *  below 0.01 keeps one significant digit ("0.003"); never "-0"; a
 *  non-finite value reads "0". */
export function fmtEdgeNum(n: number): string {
  if (!Number.isFinite(n)) return '0';
  // `String(-0)` is "0", so a negative value that rounds to zero loses its sign.
  return tinyNum(n) ?? String(+n.toFixed(2));
}

/** Decimals a range prints at, from its span and magnitude (full mode). */
function rangeDecimals(lo: number, hi: number): number {
  const span = hi - lo;
  const mag = Math.max(Math.abs(lo), Math.abs(hi));
  if (span >= 10 || mag >= 100) return 0;
  if (span >= 0.2 || mag >= 10) return 1;
  return 2;
}

/**
 * `x` rounded OUTWARD at `d` decimals — down for a range's low end, up for its
 * high end — so the printed interval always CONTAINS the true one. Float noise
 * snaps first: a value within 1e-9 of a printable step IS that step, so
 * `0.1 * 3` (0.30000000000000004) prints 0.3, never 0.4.
 */
function roundOutward(x: number, d: number, up: boolean): string {
  const f = 10 ** d;
  const s = x * f;
  const r = Math.round(s);
  const k = Math.abs(s - r) < 1e-9 ? r : up ? Math.ceil(s) : Math.floor(s);
  // An integer over a power of ten prints its shortest decimal form, and
  // String() of a -0 (Math.ceil(-0.4)) is "0".
  return String(k / f);
}

/**
 * On-node form for a channel interval [lo, hi]:
 *  - a non-finite end, or lo > hi → "…" (never an inverted or invented
 *    interval);
 *  - ends that FORMAT alike (`fmtEdgeNum`) → that one number: the span is
 *    below display precision ("3.687…3.694" → "3.69");
 *  - otherwise ALWAYS two ends, rounded outward so the printed interval holds
 *    the true one. Full mode prints 0 decimals when the span is ≥ 10 or the
 *    magnitude ≥ 100, 1 when the span is ≥ 0.2 or the magnitude ≥ 10, else 2:
 *    (0, 0.3) → "0…0.3", (-0.5, 0.5) → "-0.5…0.5", (0, 10.4) → "0…11",
 *    (0, 0.04) → "0…0.04", (0.0008, 1.52) → "0…1.6".
 *
 * `compact` is for a FIXED-width value cell (~4 characters — the Output,
 * Splat Output and SDF Output rows): whole numbers, still rounded outward and
 * still never collapsing a true range — (0, 0.3) → "0…1", (-0.4, 0.4) →
 * "-1…1", (0.6, 1.4) → "0…2". Precise figures are the EdgeInfoCard's job.
 */
export function edgeRangeText(lo: number, hi: number, compact = false): string {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return '…';
  const a = fmtEdgeNum(lo), b = fmtEdgeNum(hi);
  if (a === b) return a;
  const d = compact ? 0 : rangeDecimals(lo, hi);
  const pa = roundOutward(lo, d, false), pb = roundOutward(hi, d, true);
  // Only the float-noise snap can land both ends on one step — float noise
  // around a value ([-1e-12, 1e-12] would print "0…0"): that IS one number.
  return pa === pb ? pa : `${pa}…${pb}`;
}

/**
 * The interval spanning every channel of a range result — or null when there
 * is none to print honestly: no channels, a non-finite end, or an inverted
 * channel (min above max). A union over a garbage channel would be an
 * invented interval.
 */
export function rangeSpan(
  r: { readonly min: readonly number[]; readonly max: readonly number[] } | null | undefined,
): [number, number] | null {
  if (!r || r.min.length === 0) return null;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < r.min.length; i++) {
    const a = r.min[i], b = r.max[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return null;
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  return [lo, hi];
}

/** Live label text for `sourceId` at time `t` — the POINT value (a
 *  multi-channel one prints min…max across its channels) — or null when the
 *  upstream chain isn't CPU-evaluable there (texture chains etc.). */
export function liveEdgeText(
  sourceId: string,
  nodes: Nodes,
  edges: Edges,
  t: number,
  /** Socket the edge leaves — projects a multi-output source (HSL's h/s/l)
   *  onto the channel that wire actually carries. */
  sourceHandle?: string | null,
  /** Format for a fixed-width cell (see `edgeRangeText`). */
  compact = false,
): string | null {
  const out = evaluateEdgeSource({ source: sourceId, sourceHandle }, nodes, edges, t);
  if (out && out.length >= 1 && out.every((v) => Number.isFinite(v))) {
    return edgeRangeText(Math.min(...out), Math.max(...out), compact);
  }
  return null;
}

/**
 * Live label text for a FIELD-fed wire at time `t`: the INTERVAL the evaluator
 * infers there (`evaluateEdgeRange`), never a probe point — UV + Time reads
 * [t, t + 1], not the t = 0 "0…1" forever. Null when there is no honest
 * interval (`rangeSpan`); the caller prints "…".
 */
export function liveEdgeRangeText(
  sourceId: string,
  nodes: Nodes,
  edges: Edges,
  t: number,
  sourceHandle?: string | null,
  compact = false,
): string | null {
  const span = rangeSpan(evaluateEdgeRange({ source: sourceId, sourceHandle }, nodes, edges, t));
  return span ? edgeRangeText(span[0], span[1], compact) : null;
}
