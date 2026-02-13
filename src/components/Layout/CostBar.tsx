import { useAppStore } from '@/store/useAppStore';
import './CostBar.css';

const MAX_BUDGET = 200;

export function CostBar() {
  const totalCost = useAppStore((s) => s.totalCost);
  const percentage = Math.min(totalCost / MAX_BUDGET, 1);

  return (
    <div className="cost-bar">
      <div className="cost-bar__labels">
        <span className="cost-bar__label-end">Low</span>
        <span className="cost-bar__value">{totalCost}</span>
        <span className="cost-bar__label-end">High</span>
      </div>
      <div className="cost-bar__track">
        <div
          className="cost-bar__indicator"
          style={{ left: `${percentage * 100}%` }}
        />
      </div>
    </div>
  );
}
