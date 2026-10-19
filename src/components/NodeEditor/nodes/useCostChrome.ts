import { useAppStore, resolveDeviceBudget } from '@/store/useAppStore';
import { getCostColor, getCostScale, getCostTextColor, getContrastColor } from '@/utils/colorUtils';

/**
 * The cost-driven chrome every node card wears: header fill and its text
 * colour, the badge colour, and the card's scale.
 *
 * Three primitive selectors, so a store notify allocates nothing here.
 */
export function useCostChrome(cost: number) {
  const low = useAppStore((s) => s.costColorLow);
  const high = useAppStore((s) => s.costColorHigh);
  // The header mixes into the card, which follows the theme. `codeEditorTheme`
  // is the app-wide dark switch; the store field keeps its historical name.
  const dark = useAppStore((s) => s.codeEditorTheme === 'vs-dark');
  const costColor = getCostColor(cost, low, high, dark);
  return {
    costColor,
    headerTextColor: getContrastColor(costColor),
    costTextColor: getCostTextColor(cost, low, high),
    costScale: getCostScale(cost),
  };
}

/**
 * The class of a SINK's cost badge — the number above an Output, Raymarch or
 * Splat Output, which is what the whole shader costs with that sink driving.
 * Past the selected device's point budget it turns red, as the cost bar's
 * total does (`.cost-bar__value--over`; owner, 2026-10-18), so the figure
 * printed beside the Output says the same thing as the one in the corner.
 * A per-node badge never does: one node's price is not a total.
 */
export function useSinkBadgeClass(cost: number): string {
  const max = useAppStore((s) => resolveDeviceBudget(s.selectedHeadsetId, s.costProfiles, s.costBudgetOverrides).maxPoints);
  return `node-base__cost-badge${cost > max ? ' node-base__cost-badge--over' : ''}`;
}
