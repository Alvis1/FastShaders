import { useAppStore } from '@/store/useAppStore';
import type { NoteFlowNode } from '@/types';

interface NoteSettingsMenuProps {
  nodeId: string;
}

const rowStyle = {
  padding: 'var(--space-1) var(--space-3)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-2)',
} as const;

const labelStyle = {
  fontSize: 'var(--font-size-xs)',
  color: 'var(--text-secondary)',
} as const;

const fieldStyle = {
  width: '140px',
  padding: '2px 6px',
  background: 'var(--bg-input)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--border-radius-sm)',
  fontSize: 'var(--font-size-xs)',
  color: 'var(--text-primary)',
} as const;

export function NoteSettingsMenu({ nodeId }: NoteSettingsMenuProps) {
  const nodes = useAppStore((s) => s.nodes);
  const updateNoteData = useAppStore((s) => s.updateNoteData);
  const removeNode = useAppStore((s) => s.removeNode);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);

  const node = nodes.find((n) => n.id === nodeId) as NoteFlowNode | undefined;
  if (!node || node.type !== 'note') return null;

  const { heading, color, headerColor, scale } = node.data;

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">Note</div>

      <div style={rowStyle}>
        <label style={labelStyle}>heading</label>
        <input
          type="text"
          value={heading ?? ''}
          onChange={(e) => updateNoteData(nodeId, { heading: e.target.value })}
          autoFocus
          style={fieldStyle}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>header color</label>
        <input
          type="color"
          value={headerColor ?? '#ffd24a'}
          onChange={(e) => updateNoteData(nodeId, { headerColor: e.target.value })}
          style={{ ...fieldStyle, width: '80px', padding: '2px 4px' }}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>body color</label>
        <input
          type="color"
          value={color ?? '#fff7cc'}
          onChange={(e) => updateNoteData(nodeId, { color: e.target.value })}
          style={{ ...fieldStyle, width: '80px', padding: '2px 4px' }}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>text size</label>
        <select
          value={scale ?? 1}
          onChange={(e) => updateNoteData(nodeId, { scale: Number(e.target.value) })}
          style={{ ...fieldStyle, width: '80px', padding: '2px 4px' }}
        >
          <option value={1}>1x</option>
          <option value={1.5}>1.5x</option>
          <option value={2}>2x</option>
          <option value={3}>3x</option>
        </select>
      </div>

      <div className="context-menu__divider" />
      <button
        className="context-menu__item context-menu__item--danger"
        onClick={() => {
          removeNode(nodeId);
          closeContextMenu();
        }}
      >
        Delete Note
      </button>
    </div>
  );
}
