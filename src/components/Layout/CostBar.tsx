import { useCallback, type ChangeEvent } from 'react';
import { useAppStore, VR_HEADSETS } from '@/store/useAppStore';
import './CostBar.css';

export function CostBar() {
  const totalCost = useAppStore((s) => s.totalCost);
  const selectedHeadsetId = useAppStore((s) => s.selectedHeadsetId);
  const setSelectedHeadsetId = useAppStore((s) => s.setSelectedHeadsetId);
  const costColorLow = useAppStore((s) => s.costColorLow);
  const costColorHigh = useAppStore((s) => s.costColorHigh);
  const setCostColorLow = useAppStore((s) => s.setCostColorLow);
  const setCostColorHigh = useAppStore((s) => s.setCostColorHigh);
  const headset = VR_HEADSETS.find((h) => h.id === selectedHeadsetId) ?? VR_HEADSETS[0];
  const maxBudget = headset.maxPoints;
  const percentage = Math.min(totalCost / maxBudget, 1);
  const over = totalCost > maxBudget;

  const handleHeadsetChange = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      setSelectedHeadsetId(e.target.value);
    },
    [setSelectedHeadsetId],
  );

  return (
    <div className="cost-bar">
      <select
        className="cost-bar__headset-select"
        value={selectedHeadsetId}
        onChange={handleHeadsetChange}
      >
        {VR_HEADSETS.map((h) => (
          <option key={h.id} value={h.id}>
            {h.label} ({h.maxPoints} pts)
          </option>
        ))}
      </select>
      <div className="cost-bar__labels">
        <span className="cost-bar__label-end">0</span>
        <span className={`cost-bar__value ${over ? 'cost-bar__value--over' : ''}`}>
          {totalCost} / {maxBudget}
        </span>
        <span className="cost-bar__label-end">{maxBudget}</span>
      </div>
      <div className="cost-bar__track-row">
        <input
          type="color"
          className="cost-bar__pole-picker"
          value={costColorLow}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setCostColorLow(e.target.value)}
          title="Low impact color"
        />
        <div
          className="cost-bar__track"
          style={{
            background: `linear-gradient(to right, ${costColorLow} 0%, ${costColorHigh} 100%)`,
          }}
        >
          <div
            className="cost-bar__indicator"
            style={{ left: `${percentage * 100}%` }}
          />
        </div>
        <input
          type="color"
          className="cost-bar__pole-picker"
          value={costColorHigh}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setCostColorHigh(e.target.value)}
          title="High impact color"
        />
      </div>
    </div>
  );
}
