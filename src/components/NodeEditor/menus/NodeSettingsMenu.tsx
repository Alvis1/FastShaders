import { useAppStore } from '@/store/useAppStore';
import { t, formatNodeLabel, portLabel } from '@/i18n';
import { getNodeValues, getNodeExposedPorts } from '@/types';
import type { NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { toggleExposedPort } from '@/utils/exposedPorts';
import { rowStyle, labelStyle, colorFieldStyle, nameFieldStyle, NodeActions } from './menuShared';
import { uniformTypeFor, constantTypeFor, convertPropertyNode } from '@/utils/propertyConvert';

/** Categories whose nodes always show all ports — no expose/hide checkboxes
 *  needed. Rows-layout ShaderNode ignores exposedPorts for these, so a
 *  checkbox would be a dead switch whose uncheck silently deletes edges.
 *  `texture` (the Image node) is NOT here: it follows the same opt-in
 *  exposedPorts rules as the noise nodes (params hidden until exposed;
 *  ShaderNode filters imageNode inputs by exposedPorts). */
const ALWAYS_EXPOSED_CATEGORIES: Set<NodeCategory> = new Set([
  'input', 'math', 'type', 'arithmetic', 'interpolation', 'logic', 'vector', 'color',
]);

const checkLabelStyle = { ...labelStyle, display: 'flex', alignItems: 'center', gap: '4px' } as const;
const checkStyle = { width: '12px', height: '12px', margin: 0 } as const;

interface NodeSettingsMenuProps {
  nodeId: string;
}

export function NodeSettingsMenu({ nodeId }: NodeSettingsMenuProps) {
  const nodes = useAppStore((s) => s.nodes);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const def = NODE_REGISTRY.get(node.data.registryType);

  const exposedPorts: string[] = getNodeExposedPorts(node);
  const showPortToggles = def ? !ALWAYS_EXPOSED_CATEGORIES.has(def.category as NodeCategory) : false;

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
    updateNodeData(nodeId, { exposedPorts: toggleExposedPort(nodeId, exposedPorts, key) });
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
                  onChange={(e) => handleValueChange(key, e.target.value)}
                  style={nameFieldStyle}
                />
              ) : isColor ? (
                <input
                  type="color"
                  value={String(currentValue)}
                  onChange={(e) => handleValueChange(key, e.target.value)}
                  style={colorFieldStyle}
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

      {/* Image node: image-specific toggles. Tile/offset values + their
          expose-as-socket checkboxes render through the GENERIC sections above
          (same rules as the noise nodes' params); only the toggles without a
          registry default live here. Values are read Number-coerced by the
          graphToCode emission branch. */}
      {node.data.registryType === 'imageNode' && (() => {
        const vals = getNodeValues(node);
        const flagOf = (key: string, dflt: boolean) =>
          vals[key] === undefined ? dflt : Number(vals[key]) >= 0.5;
        const setVal = (key: string, value: string | number) =>
          updateNodeData(nodeId, { values: { ...getNodeValues(node), [key]: value } });

        const checkboxRow = (label: string, key: string, dflt: boolean, title: string) => (
          <div style={rowStyle}>
            <label style={checkLabelStyle}>
              <input
                type="checkbox"
                checked={flagOf(key, dflt)}
                onChange={() => setVal(key, flagOf(key, dflt) ? 0 : 1)}
                title={title}
                style={checkStyle}
              />
              {label}
            </label>
          </div>
        );

        // Read-only source info: format, encoded (post-downscale) resolution,
        // and payload size (base64 chars → ~3/4 bytes). Reflects what's actually
        // stored/emitted, so it also shows the effect of the device downscale.
        const url = typeof vals.imageB64 === 'string' ? vals.imageB64 : '';
        const mimeMatch = /^data:image\/(png|jpeg|webp);base64,/.exec(url);
        const format = mimeMatch ? (mimeMatch[1] === 'jpeg' ? 'JPEG' : mimeMatch[1].toUpperCase()) : '—';
        const w = Number(vals.width) || 0;
        const h = Number(vals.height) || 0;
        const resolution = w && h ? `${w} × ${h}` : '—';
        const bytes = mimeMatch ? Math.round((url.length - url.indexOf(',') - 1) * 0.75) : 0;
        const size =
          bytes <= 0 ? '—'
            : bytes < 1024 ? `${bytes} B`
              : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB`
                : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        const infoRow = (label: string, value: string) => (
          <div style={rowStyle}>
            <span style={labelStyle}>{label}</span>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
              {value}
            </span>
          </div>
        );
        return (
          <>
            <div className="context-menu__divider" />
            <div className="context-menu__category">{t('Image', language)}</div>
            {infoRow(t('Format', language), format)}
            {infoRow(t('Resolution', language), resolution)}
            {infoRow(t('Size', language), size)}
            {checkboxRow(t('Repeat (tile the image)', language), 'repeat', true,
              t('On: the image wraps/tiles. Off: edge pixels clamp beyond 0–1 UV.', language))}
            {checkboxRow(t('Flip X', language), 'flipX', false, t('Mirror the image left–right', language))}
            {checkboxRow(t('Flip Y', language), 'flipY', false, t('Mirror the image top–bottom', language))}
            {/* colorSpace keeps its string contract ('color' | 'data') — the
                emission branch and makeImageNodeData both read it that way. */}
            <div style={rowStyle}>
              <label style={checkLabelStyle}>
                <input
                  type="checkbox"
                  checked={vals.colorSpace === 'data'}
                  onChange={() => setVal('colorSpace', vals.colorSpace === 'data' ? 'color' : 'data')}
                  title={t('Sample as linear data (normal/height maps) instead of sRGB color', language)}
                  style={checkStyle}
                />
                {t('Data map (linear, no mipmaps)', language)}
              </label>
            </div>
          </>
        );
      })()}

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
