import { useCallback } from 'react';
import { useAppStore } from '@/store/useAppStore';
import './Toolbar.css';

export function Toolbar() {
  const shaderName = useAppStore((s) => s.shaderName);
  const setShaderName = useAppStore((s) => s.setShaderName);

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setShaderName(e.target.value);
    },
    [setShaderName]
  );

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
      <div className="toolbar__right" />
    </div>
  );
}
