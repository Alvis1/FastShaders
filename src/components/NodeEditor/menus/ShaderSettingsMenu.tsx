import { useAppStore, VR_HEADSETS } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { OUTPUT_DEFAULT_EXPOSED } from '../nodes/OutputNode';
import type { MaterialSettings, OutputNodeData } from '@/types';

/** Ports that can be toggled on/off in the output node settings. */
const OPTIONAL_OUTPUT_PORTS = ['emissive', 'normal', 'opacity'];

export function ShaderSettingsMenu() {
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const totalCost = useAppStore((s) => s.totalCost);
  const selectedHeadsetId = useAppStore((s) => s.selectedHeadsetId);
  const nodes = useAppStore((s) => s.nodes);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const headset = VR_HEADSETS.find((h) => h.id === selectedHeadsetId) ?? VR_HEADSETS[0];

  const outputNode = nodes.find((n) => n.data.registryType === 'output');
  const outputData = outputNode?.data as OutputNodeData | undefined;
  const settings: MaterialSettings = outputData?.materialSettings ?? {};

  const exposedPorts = outputData?.exposedPorts ?? OUTPUT_DEFAULT_EXPOSED;
  const exposedSet = new Set(exposedPorts);

  const outputDef = NODE_REGISTRY.get('output');

  const updateSettings = (patch: Partial<MaterialSettings>) => {
    if (!outputNode) return;
    const merged = { ...settings, ...patch };
    updateNodeData(outputNode.id, { materialSettings: merged } as Partial<OutputNodeData>);
  };

  const handleTogglePort = (portId: string) => {
    if (!outputNode) return;
    const current = new Set(exposedPorts);
    if (current.has(portId)) {
      current.delete(portId);
    } else {
      current.add(portId);
    }
    updateNodeData(outputNode.id, { exposedPorts: Array.from(current) } as Partial<OutputNodeData>);
  };

  const checkboxStyle: React.CSSProperties = {
    width: 14,
    height: 14,
    cursor: 'pointer',
    accentColor: 'var(--border-focus)',
  };

  const labelStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    padding: '4px var(--space-3)',
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  };

  const selectStyle: React.CSSProperties = {
    padding: '2px 4px',
    fontSize: 'var(--font-size-sm)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--border-radius-sm)',
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  };

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">Shader Settings</div>
      <div
        style={{
          padding: 'var(--space-2) var(--space-3)',
          fontSize: 'var(--font-size-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        <div>Total Cost: <strong style={{ color: 'var(--text-primary)' }}>{totalCost}</strong> pts</div>
        <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
          Budget: {headset.maxPoints} pts max ({headset.label})
        </div>
      </div>

      {/* Output port visibility toggles */}
      {outputDef && (
        <>
          <div className="context-menu__divider" />
          <div className="context-menu__category">Output Ports</div>
          {OPTIONAL_OUTPUT_PORTS.map((portId) => {
            const port = outputDef.inputs.find((p) => p.id === portId);
            if (!port) return null;
            return (
              <label key={portId} style={labelStyle}>
                <input
                  type="checkbox"
                  checked={exposedSet.has(portId)}
                  onChange={() => handleTogglePort(portId)}
                  style={checkboxStyle}
                />
                {port.label}
              </label>
            );
          })}
        </>
      )}

      {/* Displacement mode — only relevant when position port is exposed */}
      {exposedSet.has('position') && (
        <>
          <div className="context-menu__divider" />
          <div className="context-menu__category">Displacement</div>
          <label style={labelStyle}>
            <input
              type="checkbox"
              checked={(settings.displacementMode ?? 'normal') === 'normal'}
              onChange={(e) =>
                updateSettings({ displacementMode: e.target.checked ? 'normal' : 'offset' })
              }
              style={checkboxStyle}
            />
            Along Normal
          </label>
        </>
      )}

      <div className="context-menu__divider" />
      <div className="context-menu__category">Material</div>

      <label style={labelStyle}>
        <input
          type="checkbox"
          checked={!!settings.transparent}
          onChange={(e) => updateSettings({ transparent: e.target.checked })}
          style={checkboxStyle}
        />
        Transparent
      </label>

      <div style={{ ...labelStyle, cursor: 'default' }}>
        <span>Side</span>
        <select
          value={settings.side ?? 'front'}
          onChange={(e) => updateSettings({ side: e.target.value as MaterialSettings['side'] })}
          style={selectStyle}
        >
          <option value="front">Front</option>
          <option value="back">Back</option>
          <option value="double">Double</option>
        </select>
      </div>

      {settings.transparent && (
        <label style={labelStyle}>
          <input
            type="checkbox"
            checked={settings.depthWrite !== false}
            onChange={(e) => updateSettings({ depthWrite: e.target.checked })}
            style={checkboxStyle}
          />
          Depth Write
        </label>
      )}

      <div className="context-menu__divider" />
      <button className="context-menu__item" onClick={closeContextMenu}>
        Close
      </button>
    </div>
  );
}
