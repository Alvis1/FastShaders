import { useAppStore } from '@/store/useAppStore';
import { getDeviceBudget, toBudgetPoints } from '@/utils/budgetPoints';

/**
 * The selected device's budget in table points — what a point figure is
 * divided by to print against the fixed 100 (utils/budgetPoints.ts).
 *
 * Read from the module singleton the store sets on every device selection,
 * re-rendering on `costVersion`, which that selection bumps — the same idiom
 * the price table's readers use (ShaderNode's live price), so a component
 * never divides by one budget while pricing under another device's table.
 */
export function useDeviceBudget(): number {
  useAppStore((s) => s.costVersion);
  return getDeviceBudget();
}

/** `raw` table points as the budget points a surface prints, under the selected device. */
export function useBudgetPoints(raw: number): number {
  return toBudgetPoints(raw, useDeviceBudget());
}
