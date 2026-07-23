import { useAppStore, VR_HEADSETS } from '@/store/useAppStore';
import { t, portLabel } from '@/i18n';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { OUTPUT_DEFAULT_EXPOSED } from '../nodes/OutputNode';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { getNodeValues } from '@/types';
import type { MaterialSettings, OutputNodeData, ShaderNodeData } from '@/types';
import { removeEdgesForPort } from '@/utils/edgeUtils';
import { toggleExposedPort } from '@/utils/exposedPorts';

/** Ports that can be toggled on/off in the output node settings.
 *  Opacity is excluded — it's auto-managed by transparent/alphaTest. */
const OPTIONAL_OUTPUT_PORTS = ['roughness', 'emissive', 'normal', 'discard'];

export function ShaderSettingsMenu() {
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const language = useAppStore((s) => s.language);
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

  // Collect every property_float (uniform) node so the user can tweak default
  // values + rename uniforms from one place instead of hunting them down.
  const uniformNodes = nodes.filter((n) => n.data.registryType === 'property_float');

  const updateUniform = (nodeId: string, key: 'name' | 'value', value: string | number) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const current = getNodeValues(node);
    const next = key === 'name'
      ? { ...current, name: String(value) }
      : { ...current, value: Number(value) };
    updateNodeData(nodeId, { values: next } as Partial<ShaderNodeData>);
  };

  const updateSettings = (patch: Partial<MaterialSettings>) => {
    if (!outputNode) return;
    const merged = { ...settings, ...patch };
    updateNodeData(outputNode.id, { materialSettings: merged } as Partial<OutputNodeData>);
  };

  /** Show or hide the opacity port based on transparent/alphaTest state. */
  const setOpacityPort = (show: boolean) => {
    if (!outputNode) return;
    const current = new Set(exposedPorts);
    if (show) {
      current.add('opacity');
    } else {
      current.delete('opacity');
      removeEdgesForPort(outputNode.id, 'opacity');
    }
    updateNodeData(outputNode.id, { exposedPorts: Array.from(current) } as Partial<OutputNodeData>);
  };

  const handleTransparentChange = (checked: boolean) => {
    if (checked) {
      updateSettings({ transparent: true });
      setOpacityPort(true);
    } else {
      updateSettings({ transparent: false });
      if (!settings.alphaTest) setOpacityPort(false);
    }
  };

  const handleAlphaClipChange = (checked: boolean) => {
    if (checked) {
      updateSettings({ alphaTest: 0.5 });
      setOpacityPort(true);
    } else {
      updateSettings({ alphaTest: 0 });
      if (!settings.transparent) setOpacityPort(false);
    }
  };

  const handleTogglePort = (portId: string) => {
    if (!outputNode) return;
    updateNodeData(outputNode.id, {
      exposedPorts: toggleExposedPort(outputNode.id, exposedPorts, portId),
    } as Partial<OutputNodeData>);
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
      <div className="context-menu__category">{t('Shader Settings', language)}</div>
      <div
        style={{
          padding: 'var(--space-2) var(--space-3)',
          fontSize: 'var(--font-size-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        <div>{t('Total Cost:', language)} <strong style={{ color: 'var(--text-primary)' }}>{totalCost}</strong> {t('pts', language)}</div>
        <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
          {t('Budget:', language)} {headset.maxPoints} {t('pts max', language)} ({headset.label})
        </div>
      </div>

      {/* Output port visibility toggles */}
      {outputDef && (
        <>
          <div className="context-menu__divider" />
          <div className="context-menu__category">{t('Output Ports', language)}</div>
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
                {portLabel(port.label, language)}
              </label>
            );
          })}
        </>
      )}

      {/* Displacement mode — only relevant when position port is exposed */}
      {exposedSet.has('position') && (
        <>
          <div className="context-menu__divider" />
          <div className="context-menu__category">{t('Displacement', language)}</div>
          <label style={labelStyle}>
            <input
              type="checkbox"
              checked={(settings.displacementMode ?? 'normal') === 'normal'}
              onChange={(e) =>
                updateSettings({ displacementMode: e.target.checked ? 'normal' : 'offset' })
              }
              style={checkboxStyle}
            />
            {t('Along Normal', language)}
          </label>
          <label
            style={labelStyle}
            title={t("Weld shared vertices so the surface deforms as one skin. Off: a cube's faces split apart (each face displaces on its own).", language)}
          >
            <input
              type="checkbox"
              checked={settings.mergeVertices !== false}
              onChange={(e) => updateSettings({ mergeVertices: e.target.checked })}
              style={checkboxStyle}
            />
            {t('Merge Vertices', language)}
          </label>
        </>
      )}

      <div className="context-menu__divider" />
      <div className="context-menu__category">{t('Material', language)}</div>

      <label style={labelStyle}>
        <input
          type="checkbox"
          checked={!!settings.transparent}
          onChange={(e) => handleTransparentChange(e.target.checked)}
          style={checkboxStyle}
        />
        {t('Transparent', language)}
      </label>

      <label style={labelStyle}>
        <input
          type="checkbox"
          checked={!!settings.alphaTest}
          onChange={(e) => handleAlphaClipChange(e.target.checked)}
          style={checkboxStyle}
        />
        {t('Alpha Clip', language)}
      </label>

      {!!settings.alphaTest && (
        <div style={{ padding: '2px var(--space-3)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <input
            type="range"
            min={0.01}
            max={1}
            step={0.01}
            value={settings.alphaTest}
            onChange={(e) => updateSettings({ alphaTest: parseFloat(e.target.value) })}
            style={{ flex: 1, cursor: 'pointer', accentColor: 'var(--border-focus)' }}
          />
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', minWidth: 28, textAlign: 'right' }}>
            {settings.alphaTest.toFixed(2)}
          </span>
        </div>
      )}

      <div style={{ ...labelStyle, cursor: 'default' }}>
        <span>{t('Side', language)}</span>
        <select
          value={settings.side ?? 'front'}
          onChange={(e) => updateSettings({ side: e.target.value as MaterialSettings['side'] })}
          style={selectStyle}
        >
          <option value="front">{t('Front', language)}</option>
          <option value="back">{t('Back', language)}</option>
          <option value="double">{t('Double', language)}</option>
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
          {t('Depth Write', language)}
        </label>
      )}

      {/* Uniforms — every property_float node, editable by name + value
          without leaving the shader settings menu. */}
      {uniformNodes.length > 0 && (
        <>
          <div className="context-menu__divider" />
          <div className="context-menu__category">{t('Uniforms', language)}</div>
          {uniformNodes.map((n) => {
            const v = getNodeValues(n);
            const name = String(v.name ?? 'property');
            const value = Number(v.value ?? 0);
            return (
              <div
                key={n.id}
                style={{
                  padding: '4px var(--space-3)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                }}
              >
                <input
                  type="text"
                  value={name}
                  onChange={(e) => updateUniform(n.id, 'name', e.target.value)}
                  title={t('Uniform name', language)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '2px 6px',
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--border-radius-sm)',
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--text-primary)',
                  }}
                />
                <DragNumberInput
                  value={value}
                  onChange={(nv) => updateUniform(n.id, 'value', nv)}
                />
              </div>
            );
          })}
        </>
      )}

      <div className="context-menu__divider" />
      <button className="context-menu__item" onClick={closeContextMenu}>
        {t('Close', language)}
      </button>
    </div>
  );
}
