import { useAppStore } from '@/store/useAppStore';
import { t, formatNodeLabel, portLabel } from '@/i18n';
import { getNodeValues, getNodeExposedPorts } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { toggleExposedPort, usesExposedPorts } from '@/utils/exposedPorts';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { rowStyle, labelStyle, nameFieldStyle, NodeActions } from './menuShared';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import { uniformTypeFor, constantTypeFor, convertPropertyNode } from '@/utils/propertyConvert';
import { useHistoryBracket } from '@/hooks/useHistoryBracket';
import { ImageNodeSettings } from './ImageNodeSettings';
import { MicNodeSettings } from './MicNodeSettings';
import { NoiseNodeSettings } from './NoiseNodeSettings';
import { DataNodeStats } from './DataColumnStats';
import { hasNoiseRangeFlag } from '@/utils/noiseRange';

const checkLabelStyle = { ...labelStyle, display: 'flex', alignItems: 'center', gap: '4px' } as const;
const checkStyle = { width: '12px', height: '12px', margin: 0 } as const;

interface NodeSettingsMenuProps {
  nodeId: string;
}

export function NodeSettingsMenu({ nodeId }: NodeSettingsMenuProps) {
  const nodes = useAppStore((s) => s.nodes);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);
  // Color swatches fire an input event per frame while their picker is
  // dragged, and the property-name field fires one per keystroke — each would
  // otherwise pushHistory a full-graph structuredClone. Bracket them so a
  // burst lands as one undo entry (DragNumberInput brackets its own drags).
  const { bracket, closeBracket } = useHistoryBracket();

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const def = NODE_REGISTRY.get(node.data.registryType);

  const exposedPorts: string[] = getNodeExposedPorts(node);
  // Only opt-in-socket nodes get expose/hide checkboxes. Everywhere else the
  // ports are always rendered, so a checkbox would be a dead switch whose
  // uncheck silently deletes edges. This used to be a second, hand-maintained
  // category list here; it is the shared rule now, so adding a node to
  // usesExposedPorts can't leave its checkboxes behind.
  const showPortToggles = usesExposedPorts(def);

  const handleValueChange = (key: string, value: string | number) => {
    // For the property name field, keep as string (don't parse as number)
    if (key === 'name' && (node.data.registryType === 'property_float' || node.data.registryType === 'property_color')) {
      updateNodeData(nodeId, {
        values: { ...getNodeValues(node), [key]: String(value) },
      });
      return;
    }
    const numVal = typeof value === 'number' ? value : parseFloat(value);
    updateNodeData(nodeId, {
      values: {
        ...getNodeValues(node),
        [key]: isNaN(numVal) ? value : numVal,
      },
    });
  };

  const handleTogglePort = (key: string) => {
    // `toggleExposedPort` deletes the hidden port's edges (its own pushHistory)
    // and is evaluated BEFORE `updateNodeData` (argument order), which pushes
    // again — two entries per click, the first of which lands on "socket still
    // exposed, wire already gone", a state the user never authored. One
    // bracket around the whole statement makes it one undoable act.
    asOneHistoryEntry(() => {
      updateNodeData(nodeId, { exposedPorts: toggleExposedPort(nodeId, exposedPorts, key) });
    });
  };

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">{t('Node Settings', language)}</div>
      <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-2)' }}>
          {def ? formatNodeLabel(def.label, node.data.registryType, language) : node.data.registryType}
        </div>
      </div>

      {/* Input ports not in defaultValues (tslRef params like position, time) — only show toggles for non-basic categories */}
      {showPortToggles && def?.inputs
        .filter((inp) => !def.defaultValues || !(inp.id in def.defaultValues))
        .map((inp) => {
          const isExposed = exposedPorts.includes(inp.id);
          return (
            <div key={inp.id} style={rowStyle}>
              <label style={checkLabelStyle}>
                <input
                  type="checkbox"
                  checked={isExposed}
                  onChange={() => handleTogglePort(inp.id)}
                  title={t('Expose as input socket', language)}
                  style={checkStyle}
                />
                {portLabel(inp.label, language)}
              </label>
            </div>
          );
        })}

      {def?.defaultValues &&
        Object.entries(def.defaultValues).map(([key, defaultVal]) => {
          const isColor = typeof defaultVal === 'string' && defaultVal.startsWith('#');
          const isPropertyName =
            key === 'name' &&
            (node.data.registryType === 'property_float' || node.data.registryType === 'property_color');
          const isPort = typeof defaultVal === 'string' && !defaultVal.startsWith('#') && !isPropertyName;
          const currentValue = getNodeValues(node)[key] ?? defaultVal;
          const isExposed = exposedPorts.includes(key);

          return (
            <div key={key} style={rowStyle}>
              <label style={checkLabelStyle}>
                {showPortToggles && (
                  <input
                    type="checkbox"
                    checked={isExposed}
                    onChange={() => handleTogglePort(key)}
                    title={t('Expose as input socket', language)}
                    style={checkStyle}
                  />
                )}
                {key}
              </label>
              {isPropertyName ? (
                <input
                  type="text"
                  value={String(currentValue)}
                  onChange={(e) => { bracket(); handleValueChange(key, e.target.value); }}
                  onBlur={closeBracket}
                  style={nameFieldStyle}
                />
              ) : isColor ? (
                // `history="bracket"`: handleValueChange -> updateNodeData ->
                // an unconditional pushHistory, so this is a real graph edit
                // and the picker owns the coalescing bracket the row used to
                // open by hand for the native input's per-frame stream.
                <PaletteColorPicker
                  className="context-menu__color"
                  history="bracket"
                  value={String(currentValue)}
                  onPick={(hex) => handleValueChange(key, hex)}
                />
              ) : isPort ? null : (
                <DragNumberInput
                  value={Number(currentValue)}
                  onChange={(v) => handleValueChange(key, v)}
                />
              )}
            </div>
          );
        })}

      {/* Image node: image-specific toggles, provenance, and the revert for
          the drop-time power-of-two snap. Tile/offset values + their
          expose-as-socket checkboxes render through the GENERIC sections above
          (same rules as the noise nodes' params); only what has no registry
          default lives in that component. Its own component because it needs
          hooks — see ImageNodeSettings. */}
      {node.data.registryType === 'imageNode' && <ImageNodeSettings nodeId={nodeId} />}

      {/* Mic node: which input device to capture from. Session-only — it never
          reaches node.data.values, so it has no undo entry and never ships in a
          shared project. See MicNodeSettings. */}
      {node.data.registryType === 'micNode' && <MicNodeSettings />}

      {/* The noise RANGE mode. Its own component (and its own values key rather
          than a defaultValues entry) because on a noise node defaultValues is
          the socket list — see NoiseNodeSettings. */}
      {hasNoiseRangeFlag(node.data.registryType) && <NoiseNodeSettings nodeId={nodeId} />}

      {/* Data node: what is actually IN each column. Every downstream tone and
          domain control is expressed in normalized units, so without the real
          ranges here the user is tuning against numbers they cannot see. */}
      {node.data.registryType === 'dataNode' && <DataNodeStats nodeId={nodeId} />}

      {/* Constant ↔ uniform conversion: Float/Color become a named Property
          (uniform) node in place — same id, position and outgoing edges — and
          Property nodes convert back. One history entry, undoable. */}
      {(() => {
        const registryType = node.data.registryType;
        const target = uniformTypeFor(registryType) ?? constantTypeFor(registryType);
        if (!target) return null;
        const toUniform = uniformTypeFor(registryType) !== null;
        const handleConvert = () => {
          const store = useAppStore.getState();
          const converted = convertPropertyNode(node, target, store.nodes);
          if (!converted) return;
          store.pushHistory();
          store.setNodes(store.nodes.map((n) => (n.id === nodeId ? converted : n)));
          store.closeContextMenu();
        };
        return (
          <>
            <div className="context-menu__divider" />
            <button className="context-menu__item" onClick={handleConvert}>
              {toUniform ? t('Convert to Property (uniform)', language) : t('Convert to Constant', language)}
            </button>
          </>
        );
      })()}

      <NodeActions nodeId={nodeId} />
    </div>
  );
}
