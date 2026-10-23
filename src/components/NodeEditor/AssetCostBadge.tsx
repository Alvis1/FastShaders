import type { AppNode } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { useDeviceBudget } from '@/hooks/useDeviceBudget';
import { assetCostPoints } from '@/utils/nodeCost';
import { toBudgetPoints } from '@/utils/budgetPoints';
import { getCostTextColor } from '@/utils/colorUtils';
import { Points } from '@/components/Points/Points';

/**
 * The GPU-cost badge for a content-browser asset tile (TextureCard, PresetCard).
 *
 * Reuses `.node-base__cost-badge` — the very same class the node cards use — so
 * an asset tile reads its cost exactly the way a node does: a coloured number
 * floating above the card, rather than a caption buried inside it. Before this,
 * textures and presets spelled their cost as "N nodes · M pts" body text, which
 * made a bundle's price the only cost in the app you had to read instead of
 * glance at.
 *
 * The price is the group's own, re-read under the SELECTED device's table
 * (`assetCostPoints` — the number the strip sorts by), never the asset's
 * `totalCost`: that sum was stamped once, when the library was built, under
 * whichever device was selected then. `useDeviceBudget` re-renders this on a
 * device change, which is also what moves the table. Printed in budget points,
 * the selected device's frame being 100 (utils/budgetPoints.ts), and coloured
 * by the same budget points.
 *
 * The colour comes from the user's own cost gradient, matching NodePreviewCard.
 * Note the badge keeps that gradient colour here: the contrast override in
 * NodeBase.css is scoped to `.react-flow`, and these tiles live in the asset
 * bar, outside the canvas.
 */
export function AssetCostBadge({ nodes }: { nodes: readonly AppNode[] }) {
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const budget = useDeviceBudget();
  const cost = assetCostPoints(nodes);
  if (cost <= 0) return null;
  const points = toBudgetPoints(cost, budget);
  return (
    <span
      className="node-base__cost-badge"
      style={{ color: getCostTextColor(points, costColorLow, costColorHigh) }}
    >
      <Points value={points} />
    </span>
  );
}
