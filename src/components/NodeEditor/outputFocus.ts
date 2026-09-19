import type { FitViewOptions } from '@xyflow/react';
import type { AppEdge, AppNode } from '@/types';
import { activeSink, MARCH_OUTPUT_TYPE } from '@/utils/sdfPartition';
import { contributingOutputs } from '@/utils/outputMaterials';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { nodeCentre } from './keyboardNav';

/**
 * Every GLIDE on the canvas: the "take me there" framing — the cost pill's
 * total (→ the active sink), the F key (→ the selection, or the whole graph
 * when nothing is selected) — and the canvas bar's view buttons (fit, zoom
 * in, zoom out). One module so every control that moves the view moves it
 * the same way: the same duration, and React Flow's one easing (d3's
 * cubic-in-out, which `fitView`, `zoomTo` and `setViewport` all share once a
 * duration is given). `outputFocus.test.ts` pins the call sites.
 *
 * (Until 2026-09-03 the Output was a SINGLETON and every add surface
 * redirected here instead of adding a second one. Several output nodes may
 * coexist now, exactly one ACTIVE — utils/sdfPartition.ts `activeSink` — so
 * the add surfaces simply add, and the redirect helpers are gone.)
 */
/**
 * How long every view glide takes, in ms. The canvas bar's −/+/fit buttons
 * used to SNAP (React Flow's defaults take no duration) while the cost pill
 * and the F key glided, so the same kind of move looked like two different
 * controls depending on which one you pressed (owner, 2026-09-16: "keep
 * zooming style consistent").
 */
export const VIEW_GLIDE_MS = 500;

export const OUTPUT_FOCUS_FIT = {
  duration: VIEW_GLIDE_MS,
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

/**
 * Glide the viewport onto ONE node (or the collapsed-group pill standing in for
 * it — see {@link outputFocusTarget}). The single-node case of
 * {@link focusNodes}.
 *
 * Named `focusOutputNode` until 2026-09-08, from when the Output was a
 * singleton and this was its redirect. It is type-agnostic and always was:
 * today the cost pill, the Output tile and the Sound node's singleton redirect
 * all call it. The old name made an anti-regression pin in outputFocus.test.ts
 * unreadable — "no focusOutputNode in the add path" looked like it meant "the
 * Output is not redirected" when it had come to mean "nothing is redirected".
 */
export function focusNode(
  fitView: (options?: FitViewOptions) => Promise<boolean> | void,
  nodes: readonly AppNode[],
  id: string,
): void {
  focusNodes(fitView, nodes, [id]);
}

/**
 * Glide to the WHOLE graph — the canvas bar's fit button, and the F key when
 * nothing is selected. No `nodes`, so React Flow frames every node, under the
 * same zoom ceiling every other fit uses (a two-node graph must not fill the
 * screen). Padding stays React Flow's default: this frames a graph, not one
 * node, and `OUTPUT_FOCUS_FIT`'s generous 0.4 is about giving a single card
 * room to breathe.
 */
export function glideFitAll(fitView: (options?: FitViewOptions) => Promise<boolean> | void): void {
  void fitView({ maxZoom: OUTPUT_FOCUS_FIT.maxZoom, duration: VIEW_GLIDE_MS });
}

/** One zoom-button press — React Flow's own zoomIn/zoomOut factor. */
export const ZOOM_STEP = 1.2;

/** The zoom a button glide is heading for, and when it will have arrived. */
export interface ZoomGlide {
  target: number;
  /** `performance.now()` after which the glide is over (or was abandoned). */
  until: number;
}

/**
 * Where one −/+ press should glide to.
 *
 * Stepped from the TARGET of a glide still in flight, not from the live zoom.
 * React Flow's own `zoomIn({ duration })` scales the CURRENT transform, and a
 * second press mid-glide interrupts the first at whatever zoom it had reached
 * — so two quick presses landed well short of two steps, and the amount
 * depended on how fast you clicked. Stepping from the target makes N presses
 * exactly N steps however quickly they come. (The glide's promise is no help
 * here: an interrupted d3 transition never resolves it.)
 *
 * A glide past its `until` is treated as over, and callers drop the record
 * when the user takes the view themselves (a wheel, a drag), so a stale
 * target can never be stepped from. Clamped to the viewport's zoom limits.
 */
export function zoomStepTarget(
  liveZoom: number,
  glide: ZoomGlide | null,
  now: number,
  direction: 1 | -1,
  minZoom: number,
  maxZoom: number,
): number {
  const base = glide && now < glide.until ? glide.target : liveZoom;
  const next = direction > 0 ? base * ZOOM_STEP : base / ZOOM_STEP;
  return Math.min(maxZoom, Math.max(minZoom, next));
}

/**
 * The node the COST PILL's total should glide to: the ACTIVE SINK — the one
 * where the points are actually spent (utils/sdfPartition.ts `activeSink`:
 * the flagged Output or Raymarch Output, else the historical rule) — else the
 * FIRST contributing Output in emit order. Null only when nothing contributes
 * at all, and the pill then renders inert.
 *
 * The fallback exists because `activeSink` is null for a document whose every
 * plain Output is TARGETED, which is an ordinary state (target a mesh on
 * material 0, or import a GLB whose default is parked) — and the total is
 * still a real number there, so a pill that silently does nothing would be the
 * "never offer a control that does nothing" rule broken from the other side.
 * `contributingOutputs` is ordered, so the choice is stable under a layout
 * gesture, which is exactly what `activeSink`'s retired array-order last
 * resort was not. (Step 9 makes repeated presses CYCLE all of them.)
 */
export function costFocusId(nodes: readonly AppNode[], edges: readonly AppEdge[]): string | null {
  const real = unwrapCollapsedGroupEdges(nodes as AppNode[], edges as AppEdge[]);
  return (activeSink(nodes, real) ?? contributingOutputs(nodes)[0])?.id ?? null;
}

/**
 * Every SINK node on the canvas, in a STABLE TOTAL ORDER — what the cost
 * pill's total CYCLES through once a document has more than one (owner
 * decision D4, 2026-09-18: "when clicked on the top point counter — the view
 * focus cycles through output nodes").
 *
 * WHICH NODES. Plain Outputs AND Raymarch Outputs, i.e. every node the cost
 * pill's own single-press target can be. `costFocusId` resolves to
 * `activeSink`, which returns a Raymarch Output whenever one drives — so a
 * cycle over plain Outputs alone could not contain its own starting point, and
 * the second press would jump out of the set the first press was in. The
 * shared badge rule says the same thing from the other side: `sinkCosts` gives
 * every sink its own "what the shader would cost with this node active"
 * figure, so every sink is a place the pill's number is spent, which is the
 * pill's entire subject. The app's own vocabulary agrees — both live in the
 * `output` category and both are named "… Output".
 *
 * WHY A TOTAL ORDER, AND WHY NOT THE NODES ARRAY. `liftChildrenAfterParents`
 * splices a node into a new array slot on an ordinary drag-into-a-group and
 * `useSyncEngine` reorders on every Apply, so an array-order cycle would visit
 * a different sequence after a gesture that changed nothing the user can see —
 * and could revisit one node twice while skipping another. The rule is
 * `keyboardNav.ts`'s `tabOrder` idiom, restated rather than reused because
 * that one filters to NAVIGABLE nodes: 24px centre-y banding (nodes within a
 * row read as a row even when their tops differ by a few px), then x, then id
 * so ties are still a total order. Centres are ABSOLUTE (`nodeCentre` walks
 * `parentId`), or a grouped Output would sort by its offset inside its frame.
 *
 * A collapsed group's members are deliberately NOT filtered out: `focusNode`
 * maps each through `outputFocusTarget`, which frames the PILL standing in for
 * it, so the node is still reachable. Two sinks inside ONE collapsed group is
 * the only redundant case — two presses frame the same pill — and that is
 * honest (there really are two in there) where dropping them from the cycle
 * would make an Output unreachable from this control.
 */
export function outputCycleOrder(nodes: readonly AppNode[]): AppNode[] {
  const all = nodes as AppNode[];
  return all
    .filter((n) => n.data.registryType === 'output' || n.data.registryType === MARCH_OUTPUT_TYPE)
    .map((n) => ({ n, c: nodeCentre(n, all) }))
    .sort((a, b) => {
      const rowA = Math.round(a.c.y / 24);
      const rowB = Math.round(b.c.y / 24);
      if (rowA !== rowB) return rowA - rowB;
      if (a.c.x !== b.c.x) return a.c.x - b.c.x;
      return a.n.id < b.n.id ? -1 : 1;
    })
    .map((e) => e.n);
}

/**
 * The next sink after `previousId` in `order`, wrapping — so N presses visit N
 * sinks exactly once each.
 *
 * `previousId` is where the LAST press landed, not an index: the order is
 * rebuilt at click time from the live graph (it has to be — nodes are added,
 * deleted and dragged between presses), and an index into a list that has
 * since changed length names an arbitrary node. A `previousId` that is no
 * longer a sink — deleted, or converted — falls back to the first, which is
 * the same answer a fresh cycle gives.
 */
export function nextOutputFocus(
  order: readonly AppNode[],
  previousId: string | null,
): string | null {
  if (order.length === 0) return null;
  const i = previousId ? order.findIndex((n) => n.id === previousId) : -1;
  return order[(i + 1) % order.length].id;
}
