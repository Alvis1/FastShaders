import { useAppStore } from '@/store/useAppStore';
import { getCostTextColor } from '@/utils/colorUtils';

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
 * The colour comes from the user's own cost gradient, matching NodePreviewCard.
 * Note the badge keeps that gradient colour here: the contrast override in
 * NodeBase.css is scoped to `.react-flow`, and these tiles live in the asset
 * bar, outside the canvas.
 */
export function AssetCostBadge({ cost }: { cost: number }) {
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  if (cost <= 0) return null;
  return (
    <span
      className="node-base__cost-badge"
      style={{ color: getCostTextColor(cost, costColorLow, costColorHigh) }}
    >
      {cost}
    </span>
  );
}
