import type { CSSProperties } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { getNodeValues, getNodeExposedPorts } from '@/types';
import type { NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { generateId } from '@/utils/idGenerator';
import { removeEdgesForPort } from '@/utils/edgeUtils';

/** Categories whose nodes always show all ports — no expose/hide checkboxes
 *  needed. Rows-layout ShaderNode ignores exposedPorts for these, so a
 *  checkbox would be a dead switch whose uncheck silently deletes edges.
 *  `texture` (the Image node) is NOT here: it follows the same opt-in
 *  exposedPorts rules as the noise nodes (params hidden until exposed;
 *  ShaderNode filters imageNode inputs by exposedPorts). */
const ALWAYS_EXPOSED_CATEGORIES: Set<NodeCategory> = new Set([
  'input', 'math', 'type', 'arithmetic', 'interpolation', 'logic', 'vector', 'color',
]);

interface NodeSettingsMenuProps {
  nodeId: string;
}

export function NodeSettingsMenu({ nodeId }: NodeSettingsMenuProps) {
  const nodes = useAppStore((s) => s.nodes);
  const addNode = useAppStore((s) => s.addNode);
  const removeNode = useAppStore((s) => s.removeNode);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const def = NODE_REGISTRY.get(node.data.registryType);

  const handleDuplicate = () => {
    const clone: typeof node = {
      ...structuredClone(node),
      id: generateId(),
      position: { x: node.position.x + 30, y: node.position.y + 30 },
      selected: false,
    };
    addNode(clone);
    closeContextMenu();
  };

  const handleDelete = () => {
    removeNode(nodeId);
    closeContextMenu();
  };

  const exposedPorts: string[] = getNodeExposedPorts(node);
  const showPortToggles = def ? !ALWAYS_EXPOSED_CATEGORIES.has(def.category as NodeCategory) : false;

  const handleValueChange = (key: string, value: string | number) => {
    // For the property name field, keep as string (don't parse as number)
    if (key === 'name' && node.data.registryType === 'property_float') {
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
    const current = new Set(exposedPorts);
    if (current.has(key)) {
      current.delete(key);
      // Remove edges connected to the port being hidden
      removeEdgesForPort(nodeId, key);
    } else {
      current.add(key);
    }
    updateNodeData(nodeId, { exposedPorts: Array.from(current) });
  };

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">Node Settings</div>
      <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-2)' }}>
          {def?.label ?? node.data.registryType}
        </div>
      </div>

      {/* Input ports not in defaultValues (tslRef params like position, time) — only show toggles for non-basic categories */}
      {showPortToggles && def?.inputs
        .filter((inp) => !def.defaultValues || !(inp.id in def.defaultValues))
        .map((inp) => {
          const isExposed = exposedPorts.includes(inp.id);
          return (
            <div
              key={inp.id}
              style={{
                padding: 'var(--space-1) var(--space-3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-2)',
              }}
            >
              <label
                style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                <input
                  type="checkbox"
                  checked={isExposed}
                  onChange={() => handleTogglePort(inp.id)}
                  title="Expose as input socket"
                  style={{ width: '12px', height: '12px', margin: 0 }}
                />
                {inp.label}
              </label>
            </div>
          );
        })}

      {def?.defaultValues &&
        Object.entries(def.defaultValues).map(([key, defaultVal]) => {
          const isColor = typeof defaultVal === 'string' && defaultVal.startsWith('#');
          const isPropertyName = key === 'name' && node.data.registryType === 'property_float';
          const isPort = typeof defaultVal === 'string' && !defaultVal.startsWith('#') && !isPropertyName;
          const currentValue = getNodeValues(node)[key] ?? defaultVal;
          const isExposed = exposedPorts.includes(key);

          return (
            <div
              key={key}
              style={{
                padding: 'var(--space-1) var(--space-3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-2)',
              }}
            >
              <label
                style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}
              >
                {showPortToggles && (
                  <input
                    type="checkbox"
                    checked={isExposed}
                    onChange={() => handleTogglePort(key)}
                    title="Expose as input socket"
                    style={{ width: '12px', height: '12px', margin: 0 }}
                  />
                )}
                {key}
              </label>
              {isPropertyName ? (
                <input
                  type="text"
                  value={String(currentValue)}
                  onChange={(e) => handleValueChange(key, e.target.value)}
                  style={{
                    width: '100px',
                    padding: '2px 6px',
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--border-radius-sm)',
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--text-primary)',
                  }}
                />
              ) : isColor ? (
                <input
                  type="color"
                  value={String(currentValue)}
                  onChange={(e) => handleValueChange(key, e.target.value)}
                  style={{
                    width: '80px',
                    padding: '2px 4px',
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--border-radius-sm)',
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--text-primary)',
                  }}
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

        const rowStyle: CSSProperties = {
          padding: 'var(--space-1) var(--space-3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
        };
        const labelStyle: CSSProperties = {
          fontSize: 'var(--font-size-xs)',
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        };
        const checkStyle: CSSProperties = { width: '12px', height: '12px', margin: 0 };

        const checkboxRow = (label: string, key: string, dflt: boolean, title: string) => (
          <div style={rowStyle}>
            <label style={labelStyle}>
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
        return (
          <>
            <div className="context-menu__divider" />
            <div className="context-menu__category">Image</div>
            {checkboxRow('Repeat (tile the image)', 'repeat', true,
              'On: the image wraps/tiles. Off: edge pixels clamp beyond 0–1 UV.')}
            {checkboxRow('Flip X', 'flipX', false, 'Mirror the image left–right')}
            {checkboxRow('Flip Y', 'flipY', false, 'Mirror the image top–bottom')}
            {/* colorSpace keeps its string contract ('color' | 'data') — the
                emission branch and makeImageNodeData both read it that way. */}
            <div style={rowStyle}>
              <label style={labelStyle}>
                <input
                  type="checkbox"
                  checked={vals.colorSpace === 'data'}
                  onChange={() => setVal('colorSpace', vals.colorSpace === 'data' ? 'color' : 'data')}
                  title="Sample as linear data (normal/height maps) instead of sRGB color"
                  style={checkStyle}
                />
                Data map (linear, no mipmaps)
              </label>
            </div>
          </>
        );
      })()}

      <div className="context-menu__divider" />
      <button className="context-menu__item" onClick={handleDuplicate}>
        Duplicate Node
      </button>
      <button className="context-menu__item" onClick={handleDelete} style={{ color: '#e74c3c' }}>
        Delete Node
      </button>
    </div>
  );
}
