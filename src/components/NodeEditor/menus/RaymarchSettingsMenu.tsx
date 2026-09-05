import { useAppStore } from '@/store/useAppStore';
import { t, portLabel } from '@/i18n';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getNodeValues } from '@/types';
import type { AppNode, ShaderNodeData } from '@/types';
import { effectiveExposedPorts, toggleExposedPort } from '@/utils/exposedPorts';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import { NumberRow, NodeActions } from './menuShared';
import { MARCH_NODE_CONFIG, MARCH_COLOR_DEFAULTS } from '../nodes/RaymarchOutputNode';

/**
 * The Raymarch Output's settings menu — the Output's `ShaderSettingsMenu`
 * shape, with VALUES: every socket the node has, grouped as the node groups
 * them, each row a checkbox that shows or hides the SOCKET on the node plus
 * the socket's value editor (a number field with the node's own step and
 * clamp, or a colour swatch). The main chains (Field, Density, …) carry no
 * value, so their rows are the checkbox alone.
 *
 * The one rule that differs from the Output: hiding a socket drops its wires
 * (`toggleExposedPort`, the documented rule) but KEEPS its stored value — a
 * setting such as Steps applies whether or not it is wired, and this menu is
 * exactly where a hidden one is meant to be edited.
 */
export function RaymarchSettingsMenu({ nodeId }: { nodeId: string }) {
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const language = useAppStore((s) => s.language);
  const nodes = useAppStore((s) => s.nodes);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const node = nodes.find((n) => n.id === nodeId) as AppNode | undefined;
  const def = NODE_REGISTRY.get('raymarchOutput');
  if (!node || !def) return null;

  const config = MARCH_NODE_CONFIG;
  const values = getNodeValues(node);
  const exposedPorts = effectiveExposedPorts(node);
  const exposedSet = new Set(exposedPorts);

  const setValue = (key: string, v: string | number) => {
    updateNodeData(nodeId, { values: { ...values, [key]: v } } as Partial<ShaderNodeData>);
  };
  const clearValue = (key: string) => {
    const next = { ...values };
    delete next[key];
    updateNodeData(nodeId, { values: next } as Partial<ShaderNodeData>);
  };
  const handleTogglePort = (portId: string) => {
    // toggleExposedPort drops the hidden port's edges with its own history
    // push; one bracket makes the whole toggle a single undo entry.
    asOneHistoryEntry(() => {
      updateNodeData(nodeId, { exposedPorts: toggleExposedPort(nodeId, exposedPorts, portId) } as Partial<ShaderNodeData>);
    });
  };

  const checkboxStyle: React.CSSProperties = { width: 14, height: 14, cursor: 'pointer', accentColor: 'var(--border-focus)', margin: 0 };
  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: '2px var(--space-3)',
    fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)',
  };

  const valueEditor = (portId: string) => {
    if (config.colorPorts.includes(portId)) {
      const stored = values[portId];
      const dflt = MARCH_COLOR_DEFAULTS[portId] ?? '#ffffff';
      return (
        <PaletteColorPicker
          className="context-menu__color"
          history="bracket"
          value={typeof stored === 'string' ? stored : dflt}
          clearColor={dflt}
          onClear={() => clearValue(portId)}
          onPick={(hex) => setValue(portId, hex)}
        />
      );
    }
    const setting = config.settings[portId];
    if (!setting) return null;
    const raw = Number(values[portId]);
    const shown = Number.isFinite(raw) && values[portId] !== undefined ? raw : Number(def.defaultValues?.[portId] ?? 0);
    return (
      <NumberRow
        label=""
        value={shown}
        step={setting.step}
        onCommit={(v) => setValue(portId, setting.clamp(v))}
      />
    );
  };

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">{t('Raymarch Settings', language)}</div>
      <div
        style={{ padding: '2px var(--space-3) var(--space-2)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}
      >
        {t('Tick a socket to wire it on the node; the value applies either way', language)}
      </div>
      {config.sections.map((section) => (
        <div key={section.label}>
          <div className="context-menu__divider" />
          <div className="context-menu__category">{t(section.label, language)}</div>
          {section.ports.map((portId) => {
            const port = def.inputs.find((p) => p.id === portId);
            if (!port) return null;
            return (
              <div key={portId} style={rowStyle}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', minWidth: 120 }} title={t('Show socket', language)}>
                  <input
                    type="checkbox"
                    checked={exposedSet.has(portId)}
                    onChange={() => handleTogglePort(portId)}
                    style={checkboxStyle}
                  />
                  {portLabel(port.label, language)}
                </label>
                {valueEditor(portId)}
              </div>
            );
          })}
        </div>
      ))}
      <div className="context-menu__divider" />
      <NodeActions nodeId={nodeId} />
      <button className="context-menu__item" onClick={closeContextMenu}>
        {t('Close', language)}
      </button>
    </div>
  );
}
