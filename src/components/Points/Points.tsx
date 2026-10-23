import { formatPoints } from '@/utils/budgetPoints';
import './Points.css';

/**
 * A point figure as every surface prints it — two decimals at most, trailing
 * zeros dropped (utils/budgetPoints.ts `formatPoints`). `value` is in BUDGET
 * points: the caller has already divided by the device budget (useCostChrome's
 * `points`, `useBudgetPoints`, `toBudgetPoints`).
 *
 * A figure the 0.01 rounding changed carries a small centred dot after it, and
 * hovering it shows the value to six decimals: the app-wide TooltipLayer reads
 * the `title`. The span takes the pointer back with `pointer-events: auto`,
 * because the badges it sits in ignore the pointer and a title on an element
 * the pointer passes through is dead. An exact figure is bare text: nothing to
 * mark, nothing to hover.
 *
 * `tip={false}` where the host element's own title already states the exact
 * figure (the cost bar's total) — two tooltips would fight over one hover.
 */
export function Points({ value, tip = true }: { value: number; tip?: boolean }) {
  const { text, rounded, exact } = formatPoints(value);
  if (!rounded) return <>{text}</>;
  return (
    <span className={`fs-points${tip ? ' fs-points--tip' : ''}`} title={tip ? exact : undefined}>
      {text}
      <span className="fs-points__dot" aria-hidden="true">·</span>
    </span>
  );
}
