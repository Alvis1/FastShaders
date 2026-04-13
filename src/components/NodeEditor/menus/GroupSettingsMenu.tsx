import { useAppStore } from '@/store/useAppStore';
import type { GroupFlowNode } from '@/types';

interface GroupSettingsMenuProps {
  nodeId: string;
}

export function GroupSettingsMenu({ nodeId }: GroupSettingsMenuProps) {
  const nodes = useAppStore((s) => s.nodes);
  const updateGroupData = useAppStore((s) => s.updateGroupData);
  const ungroup = useAppStore((s) => s.ungroup);
  const saveGroupToLibrary = useAppStore((s) => s.saveGroupToLibrary);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);

  const node = nodes.find((n) => n.id === nodeId) as GroupFlowNode | undefined;
  if (!node || node.type !== 'group') return null;

  const { label, color, titleSize } = node.data;

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">Group</div>

      <div
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
          name
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => updateGroupData(nodeId, { label: e.target.value })}
          autoFocus
          style={{
            width: '140px',
            padding: '2px 6px',
            background: 'var(--bg-input)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--border-radius-sm)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-primary)',
          }}
        />
      </div>

      <div
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
          color
        </label>
        <input
          type="color"
          value={color}
          onChange={(e) => updateGroupData(nodeId, { color: e.target.value })}
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

      <div
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
          title size
        </label>
        <select
          value={titleSize ?? 1}
          onChange={(e) => updateGroupData(nodeId, { titleSize: Number(e.target.value) })}
          style={{
            width: '80px',
            padding: '2px 4px',
            background: 'var(--bg-input)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--border-radius-sm)',
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-primary)',
          }}
        >
          <option value={1}>1x</option>
          <option value={1.5}>1.5x</option>
          <option value={2}>2x</option>
          <option value={3}>3x</option>
        </select>
      </div>

      <div className="context-menu__divider" />
      <button
        className="context-menu__item"
        onClick={() => {
          saveGroupToLibrary(nodeId);
          closeContextMenu();
        }}
      >
        Save to Library
      </button>
      <button
        className="context-menu__item"
        onClick={() => {
          ungroup(nodeId);
          closeContextMenu();
        }}
      >
        Ungroup
      </button>
    </div>
  );
}
