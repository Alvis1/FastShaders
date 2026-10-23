import { useEffect, useRef } from 'react';
import { useUpdateNodeInternals } from '@xyflow/react';
import type { AppNode } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { useDeviceBudget } from '@/hooks/useDeviceBudget';
import { nodeCostPoints } from '@/utils/nodeCost';
import { toBudgetPoints } from '@/utils/budgetPoints';
import { getCostColor, getCostScale, getCostTextColor, getContrastColor } from '@/utils/colorUtils';

/**
 * The cost-driven chrome every node card wears: header fill and its text
 * colour, the badge colour, the card's scale — and `points`, the figure its
 * badge prints (`<Points value={points} />`).
 *
 * `cost` is in TABLE points; everything returned is judged in BUDGET points,
 * its share of the selected device's 100 (utils/budgetPoints.ts), so a card
 * looks the same wherever its price is the same share of the frame.
 *
 * Primitive selectors, so a store notify allocates nothing here.
 */
export function useCostChrome(cost: number) {
  const low = useAppStore((s) => s.costColorLow);
  const high = useAppStore((s) => s.costColorHigh);
  // The header mixes into the card, which follows the theme. `codeEditorTheme`
  // is the app-wide dark switch; the store field keeps its historical name.
  const dark = useAppStore((s) => s.codeEditorTheme === 'vs-dark');
  const points = toBudgetPoints(cost, useDeviceBudget());
  const costColor = getCostColor(points, low, high, dark);
  return {
    costColor,
    headerTextColor: getContrastColor(costColor),
    costTextColor: getCostTextColor(points, low, high),
    costScale: getCostScale(points),
    points,
  };
}

/**
 * A node card's LIVE price in table points — the override-aware table through
 * `nodeCostPoints`, so a device change or a dropped benchmark reprices the
 * badge — for every card that prints one (ShaderNode, and the Preview /
 * MathPreview / Clock / Sound cards, which drew the creation-time `data.cost`
 * snapshot until 2026-10-23: under the Steam Frame row a noise card kept its
 * shipped price while the total used the measured one). Reading `costVersion`
 * re-runs the selector when the table changes. Non-chainable nodes
 * short-circuit inside nodeCostPoints (no edge scan); only variadic
 * arithmetic pays the O(E) operand count. The number result bails re-renders.
 *
 * …but the SELECTOR still runs on every store notification, and a node drag
 * notifies at pointer rate while changing nothing this answer depends on:
 * `setNodes` rebuilds the nodes array and keeps each node's `data` AND the
 * whole `edges` array by reference (the same identity contract
 * `selectionOnlyGraphChange` and ShaderNode's edgeKey selectors rely on). So a
 * chainable node re-walked every edge in the graph, per node, per frame, to
 * return the number it returned last frame. Four inputs decide it — this
 * node's id and `data`, the edges array, and the cost table's version — so a
 * one-slot cache keyed on exactly those turns a position-only notify into
 * four reference compares.
 *
 * A cache written from inside a selector is safe here because the selector
 * stays a pure function of that key: a StrictMode double-invoke, or a
 * notification arriving outside render, can only ever recompute the same
 * number for the same key, and `useSyncExternalStore` still sees a stable
 * snapshot. It must NOT be turned into a useMemo — the value has to be read
 * through the store subscription, or a cost-table swap (which touches
 * neither `data` nor `edges`) would never re-render the badge.
 */
export function useLiveNodeCost(id: string, data: AppNode['data']): number {
  const costMemo = useRef<
    { id: string; data: unknown; edges: unknown; version: number; cost: number } | null
  >(null);
  return useAppStore((s) => {
    const m = costMemo.current;
    if (m && m.id === id && m.data === data && m.edges === s.edges && m.version === s.costVersion) {
      return m.cost;
    }
    const points = nodeCostPoints({ id, position: { x: 0, y: 0 }, data } as AppNode, s.edges);
    costMemo.current = { id, data, edges: s.edges, version: s.costVersion, cost: points };
    return points;
  });
}

/**
 * Re-measure a cost-scaled card's sockets when its drawn scale changes — for
 * every COST_SCALED_TYPES card (shader, preview, mathPreview, clock, sound).
 * The scale is a `transform` on the card inside React Flow's node wrapper, and
 * React Flow re-measures handle bounds only when that wrapper's box resizes or
 * on `updateNodeInternals`; so once a device change (a new budget, a new
 * price) or a repriced node (an RGB Curves bend, an Image resolution) rescaled
 * a card, every wire on it stopped short of its socket until a reload
 * (measured 2026-10-23: a Perlin card's out-wire 4.3 px off its socket on
 * Quest 3, 9.1 px after picking Steam Frame). Skips the mount, which React
 * Flow measures anyway — a graph load would otherwise measure every card
 * twice.
 */
export function useRemeasureOnScale(id: string, costScale: number): void {
  const updateNodeInternals = useUpdateNodeInternals();
  const drawn = useRef(costScale);
  useEffect(() => {
    if (drawn.current === costScale) return;
    drawn.current = costScale;
    updateNodeInternals(id);
  }, [id, costScale, updateNodeInternals]);
}

/**
 * The class of a SINK's cost badge — the number above an Output, Raymarch or
 * Splat Output, which is what the whole shader costs with that sink driving.
 * Past the selected device's point budget it turns red, as the cost bar's
 * total does (`.cost-bar__value--over`; owner, 2026-10-18), so the figure
 * printed beside the Output says the same thing as the one in the corner.
 * A per-node badge never does: one node's price is not a total. `cost` is in
 * table points, compared against the device's budget in the same currency —
 * the printed form of that test is "over 100".
 */
export function useSinkBadgeClass(cost: number): string {
  const max = useDeviceBudget();
  return `node-base__cost-badge${cost > max ? ' node-base__cost-badge--over' : ''}`;
}
