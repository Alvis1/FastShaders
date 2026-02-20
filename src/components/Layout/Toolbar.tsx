import { useCallback } from 'react';
import { useAppStore, VR_HEADSETS } from '@/store/useAppStore';
import './Toolbar.css';

export function Toolbar() {
  const shaderName = useAppStore((s) => s.shaderName);
  const setShaderName = useAppStore((s) => s.setShaderName);
  const selectedHeadsetId = useAppStore((s) => s.selectedHeadsetId);
  const setSelectedHeadsetId = useAppStore((s) => s.setSelectedHeadsetId);

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setShaderName(e.target.value);
    },
    [setShaderName]
  );

  const handleHeadsetChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedHeadsetId(e.target.value);
    },
    [setSelectedHeadsetId]
  );

  const headset = VR_HEADSETS.find((h) => h.id === selectedHeadsetId) ?? VR_HEADSETS[0];

  return (
    <div className="toolbar">
      <div className="toolbar__left">
        <span className="toolbar__brand">FastShaders</span>
      </div>
      <div className="toolbar__center">
        <input
          className="toolbar__name-input"
          type="text"
          value={shaderName}
          onChange={handleNameChange}
          placeholder="Shader name..."
          spellCheck={false}
        />
      </div>
      <div className="toolbar__right">
        <label className="toolbar__headset-label">
          Target
          <select
            className="toolbar__headset-select"
            value={selectedHeadsetId}
            onChange={handleHeadsetChange}
          >
            {VR_HEADSETS.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label} ({h.maxPoints} pts)
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
