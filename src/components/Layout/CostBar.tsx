import { useAppStore, VR_HEADSETS } from '@/store/useAppStore';
import './CostBar.css';

export function CostBar() {
  const totalCost = useAppStore((s) => s.totalCost);
  const selectedHeadsetId = useAppStore((s) => s.selectedHeadsetId);
  const headset = VR_HEADSETS.find((h) => h.id === selectedHeadsetId) ?? VR_HEADSETS[0];
  const maxBudget = headset.maxPoints;
  const percentage = Math.min(totalCost / maxBudget, 1);
  const over = totalCost > maxBudget;

  return (
    <div className="cost-bar">
      <div className="cost-bar__labels">
        <span className="cost-bar__label-end">0</span>
        <span className={`cost-bar__value ${over ? 'cost-bar__value--over' : ''}`}>
          {totalCost} / {maxBudget}
        </span>
        <span className="cost-bar__label-end">{maxBudget}</span>
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
