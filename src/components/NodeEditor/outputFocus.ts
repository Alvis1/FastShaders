import type { FitViewOptions } from '@xyflow/react';
import type { AppEdge, AppNode } from '@/types';
import { activeSink } from '@/utils/sdfPartition';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';

/**
 * "Take me there" framing, shared by every glide on the canvas: the cost
 * pill's total (→ the active sink), the F key (→ the selection) and the
 * Output-related focus helpers. One module so every such gesture lands on
 * the same framing; `outputFocus.test.ts` pins the call sites.
 *
 * (Until 2026-09-03 the Output was a SINGLETON and every add surface
 * redirected here instead of adding a second one. Several output nodes may
 * coexist now, exactly one ACTIVE — utils/sdfPartition.ts `activeSink` — so
 * the add surfaces simply add, and the redirect helpers are gone.)
 */
export const OUTPUT_FOCUS_FIT = {
  duration: 500,
  padding: 0.4,
  // The app-wide fit ceiling (NodeEditor's FIT_VIEW_OPTIONS): uncapped, fitting
  // a single ~140px node would slam the zoom to its maximum.
  maxZoom: 1.5,
} as const;

/**
 * Where fitView should actually aim. Usually the Output itself — but a
 * collapsed group hides its members with a `display: none` className, NOT
 * React Flow's `hidden` prop (unmounting would kill member rAF loops — the
 * Groups convention), so fitView's hidden-node filter never skips such a
 * member and would happily glide to an invisible stale box: empty canvas,
 * no Output anywhere, exactly the broken-affordance impression this module
 * exists to remove. Aim at the TOPMOST collapsed ancestor's pill instead —
 * that is the element standing in for the node on screen.
 *
 * The visited-set guard exists because `parentId` arrives from tampered
 * `fs:graph` / shared `.fastshader` payloads, where a parent cycle is legal
 * bytes and an unguarded walk never terminates.
 */
export function outputFocusTarget(nodes: readonly AppNode[], outputId: string): string {
  let target = outputId;
  let cur = nodes.find((n) => n.id === outputId);
  const seen = new Set<string>();
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const parent = nodes.find((n) => n.id === cur!.parentId);
    if (!parent) break;
    if (parent.type === 'group' && (parent.data as { collapsed?: boolean }).collapsed) {
      target = parent.id;
    }
    cur = parent;
  }
  return target;
}

/**
 * The nodes fitView should frame for a set of node ids: each mapped through
 * {@link outputFocusTarget} (a member hidden inside a collapsed group is
 * represented by the pill), unknown ids dropped, duplicates collapsed —
 * two selected members of one collapsed group are one pill on screen, and
 * listing it twice is harmless to fitView but wrong as a description of
 * what is being framed. Order follows the input.
 */
export function focusTargets(nodes: readonly AppNode[], ids: readonly string[]): { id: string }[] {
  const out: { id: string }[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!nodes.some((n) => n.id === id)) continue;
    const target = outputFocusTarget(nodes, id);
    if (seen.has(target)) continue;
    seen.add(target);
    out.push({ id: target });
  }
  return out;
}

/**
 * Glide the viewport onto a set of nodes — the ONE framing every "take me
 * there" gesture uses: the Output singleton redirects, the cost pill's total,
 * and the F key framing the selection. Returns false (and moves nothing) when
 * none of the ids is a node, so a caller can fall back rather than send
 * fitView an empty list, which would frame the whole graph and read as the
 * key doing something unrelated.
 */
export function focusNodes(
  fitView: (options?: FitViewOptions) => Promise<boolean> | void,
  nodes: readonly AppNode[],
  ids: readonly string[],
): boolean {
  const targets = focusTargets(nodes, ids);
  if (targets.length === 0) return false;
  void fitView({ ...OUTPUT_FOCUS_FIT, nodes: targets });
  return true;
}

/** Glide the viewport onto the existing Output node (or the collapsed-group
 *  pill standing in for it — see {@link outputFocusTarget}). */
export function focusOutputNode(
  fitView: (options?: FitViewOptions) => Promise<boolean> | void,
  nodes: readonly AppNode[],
  id: string,
): void {
  focusNodes(fitView, nodes, [id]);
}

/**
 * The node the COST PILL's total should glide to: the ACTIVE SINK — the one
 * where the points are actually spent (utils/sdfPartition.ts `activeSink`:
 * the flagged Output or Raymarch Output, else the historical rule). Null when
 * the graph has no output node at all, and the pill then renders inert.
 */
export function costFocusId(nodes: readonly AppNode[], edges: readonly AppEdge[]): string | null {
  return activeSink(nodes, unwrapCollapsedGroupEdges(nodes as AppNode[], edges as AppEdge[]))?.id ?? null;
}
