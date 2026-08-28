import type { FitViewOptions } from '@xyflow/react';
import type { AppEdge, AppNode } from '@/types';
import { outputNodes } from '@/utils/outputMaterials';
import { effectiveExposedPorts } from '@/utils/exposedPorts';

/**
 * The Output node is a SINGLETON — per-mesh shading lives INSIDE it as stacked
 * materials, so a second node has nothing to express (only the first would
 * emit, and `foldExtraOutputs` deletes the copy on the next restore anyway).
 *
 * Every surface that OFFERS the Output therefore stays offered when one already
 * exists, and turns into a "take me to it" affordance: the palette tile's drop,
 * the tile's click/Enter activation, and the Add-node menu's row (browse AND
 * search) all glide the viewport to the existing node instead of silently
 * doing nothing — a silent no-op on a visible control reads as the app being
 * broken, and hiding the control reads as the node not existing at all.
 *
 * Both surfaces route through THIS module so the two gestures land on the same
 * framing; `outputFocus.test.ts` pins the call sites.
 */
export const OUTPUT_FOCUS_FIT = {
  duration: 500,
  padding: 0.4,
  // The app-wide fit ceiling (NodeEditor's FIT_VIEW_OPTIONS): uncapped, fitting
  // a single ~140px node would slam the zoom to its maximum.
  maxZoom: 1.5,
} as const;

/** The node an add-Output gesture should be redirected to, if any. */
export function existingOutputId(nodes: readonly AppNode[]): string | null {
  return outputNodes(nodes)[0]?.id ?? null;
}

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
 * The bare (material-0) channel a wire dropped on the Add-node menu should
 * land on when the user picks Output while one exists: the first
 * registry-order channel that is EXPOSED on the node and carries no edge.
 * Exposure matters — an edge aimed at a hidden channel points at a socket
 * that never mounts, the documented silent-failure shape. Null when every
 * exposed channel is taken: the caller then only focuses, because silently
 * replacing a wire the user can see would be worse than not connecting.
 */
export function firstFreeOutputChannel(
  node: AppNode,
  edges: readonly AppEdge[],
  inputs: readonly { id: string }[],
): string | null {
  const exposed = new Set(effectiveExposedPorts(node));
  const taken = new Set(
    edges.filter((e) => e.target === node.id).map((e) => e.targetHandle),
  );
  for (const p of inputs) {
    if (exposed.has(p.id) && !taken.has(p.id)) return p.id;
  }
  return null;
}

/** Glide the viewport onto the existing Output node (or the collapsed-group
 *  pill standing in for it — see {@link outputFocusTarget}). */
export function focusOutputNode(
  fitView: (options?: FitViewOptions) => Promise<boolean> | void,
  nodes: readonly AppNode[],
  id: string,
): void {
  void fitView({ ...OUTPUT_FOCUS_FIT, nodes: [{ id: outputFocusTarget(nodes, id) }] });
}
