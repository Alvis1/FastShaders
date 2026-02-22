import { useAppStore } from '@/store/useAppStore';
import { getNodeValues, getNodeExposedPorts } from '@/types';
import type { NodeCategory } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { generateId } from '@/utils/idGenerator';

/** Categories whose nodes always show all ports — no expose/hide checkboxes needed. */
const ALWAYS_EXPOSED_CATEGORIES: Set<NodeCategory> = new Set([
  'input', 'math', 'type', 'arithmetic', 'interpolation', 'vector', 'color',
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
                  defaultValue={String(currentValue)}
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
