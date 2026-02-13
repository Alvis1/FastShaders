import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';

interface NodeSettingsMenuProps {
  nodeId: string;
}

export function NodeSettingsMenu({ nodeId }: NodeSettingsMenuProps) {
  const nodes = useAppStore((s) => s.nodes);
  const removeNode = useAppStore((s) => s.removeNode);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const def = NODE_REGISTRY.get(node.data.registryType);

  const handleDelete = () => {
    removeNode(nodeId);
    closeContextMenu();
  };

  const handleValueChange = (key: string, value: string) => {
    const numVal = parseFloat(value);
    updateNodeData(nodeId, {
      values: {
        ...(node.data as { values?: Record<string, string | number> }).values,
        [key]: isNaN(numVal) ? value : numVal,
      },
    });
  };

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">Node Settings</div>
      <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-2)' }}>
          {def?.label ?? node.data.registryType}
        </div>
      </div>

      {def?.defaultValues &&
        Object.entries(def.defaultValues).map(([key, defaultVal]) => (
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
              style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}
            >
              {key}
            </label>
            <input
              type={typeof defaultVal === 'string' && defaultVal.startsWith('#') ? 'color' : 'number'}
              defaultValue={
                ((node.data as { values?: Record<string, string | number> }).values?.[key] ??
                  defaultVal) as string | number
              }
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
          </div>
        ))}

      <div className="context-menu__divider" />
      <button className="context-menu__item" onClick={handleDelete} style={{ color: '#e74c3c' }}>
        Delete Node
      </button>
    </div>
  );
}
