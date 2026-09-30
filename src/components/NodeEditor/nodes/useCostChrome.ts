import { useAppStore } from '@/store/useAppStore';
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
