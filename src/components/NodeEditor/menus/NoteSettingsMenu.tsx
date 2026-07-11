import { useAppStore } from '@/store/useAppStore';
import type { NoteFlowNode } from '@/types';
import { rowStyle, labelStyle, colorFieldStyle, wideFieldStyle } from './menuShared';

interface NoteSettingsMenuProps {
  nodeId: string;
}

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
          style={wideFieldStyle}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>header color</label>
        <input
          type="color"
          value={headerColor ?? '#ffd24a'}
          onChange={(e) => updateNoteData(nodeId, { headerColor: e.target.value })}
          style={colorFieldStyle}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>body color</label>
        <input
          type="color"
          value={color ?? '#fff7cc'}
          onChange={(e) => updateNoteData(nodeId, { color: e.target.value })}
          style={colorFieldStyle}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>text size</label>
        <select
          value={scale ?? 1}
          onChange={(e) => updateNoteData(nodeId, { scale: Number(e.target.value) })}
          style={colorFieldStyle}
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
