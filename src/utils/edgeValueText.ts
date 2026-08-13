/**
 * Pure text model for the on-node "value arriving on this edge" labels —
 * shared by the static `edgeValueLabel` (ShaderNode) and the animated
 * `LiveEdgeValue` span, so the ticking path can never format differently
 * from the resting one. Node-env testable; no DOM.
 */
import { evaluateNodeOutput, evaluateEdgeSource } from '@/engine/cpuEvaluator';

type Nodes = Parameters<typeof evaluateNodeOutput>[1];
type Edges = Parameters<typeof evaluateNodeOutput>[2];

/** Up to 2 decimals, trailing zeros trimmed ("3.69", "5", "-0.7"). */
export function fmtEdgeNum(n: number): string {
  return Number.isFinite(n) ? String(+n.toFixed(2)) : '0';
}

/**
 * Compact on-node form for a channel interval: single values keep decimals;
 * true ranges round to whole numbers ("-0.8…0.8" → "-1…1"); endpoints are
 * compared after formatting so "3.687…3.694" collapses to one "3.69"; a range
 * whose rounded ends meet collapses to that integer. Precise figures live in
 * the EdgeInfoCard.
 */
export function edgeRangeText(lo: number, hi: number): string {
  const a = fmtEdgeNum(lo), b = fmtEdgeNum(hi);
  if (a === b) return a;
  const ra = Math.round(lo), rb = Math.round(hi);
  return ra === rb ? String(ra) : `${ra}…${rb}`;
}

/** Live label text for `sourceId` at time `t`, or null when the upstream
 *  chain isn't CPU-evaluable (texture chains etc.). */
export function liveEdgeText(
  sourceId: string,
  nodes: Nodes,
  edges: Edges,
  t: number,
  /** Socket the edge leaves — projects a multi-output source (HSL's h/s/l)
   *  onto the channel that wire actually carries. */
  sourceHandle?: string | null,
): string | null {
  const out = evaluateEdgeSource({ source: sourceId, sourceHandle }, nodes, edges, t);
  if (out && out.length >= 1 && out.every((v) => Number.isFinite(v))) {
    return edgeRangeText(Math.min(...out), Math.max(...out));
  }
  return null;
}
