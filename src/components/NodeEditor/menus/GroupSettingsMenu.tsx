import { useAppStore } from '@/store/useAppStore';
import type { GroupFlowNode } from '@/types';
import { rowStyle, labelStyle, colorFieldStyle, wideFieldStyle } from './menuShared';

interface GroupSettingsMenuProps {
  nodeId: string;
}

export function GroupSettingsMenu({ nodeId }: GroupSettingsMenuProps) {
  const nodes = useAppStore((s) => s.nodes);
  const updateGroupData = useAppStore((s) => s.updateGroupData);
  const ungroup = useAppStore((s) => s.ungroup);
  const deleteGroup = useAppStore((s) => s.deleteGroup);
  const saveGroupToLibrary = useAppStore((s) => s.saveGroupToLibrary);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);

  const node = nodes.find((n) => n.id === nodeId) as GroupFlowNode | undefined;
  if (!node || node.type !== 'group') return null;

  const { label, color, titleSize } = node.data;

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">Group</div>

      <div style={rowStyle}>
        <label style={labelStyle}>name</label>
        <input
          type="text"
          value={label}
          onChange={(e) => updateGroupData(nodeId, { label: e.target.value })}
          autoFocus
          style={wideFieldStyle}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>color</label>
        <input
          type="color"
          value={color}
          onChange={(e) => updateGroupData(nodeId, { color: e.target.value })}
          style={colorFieldStyle}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>title size</label>
        <select
          value={titleSize ?? 1}
          onChange={(e) => updateGroupData(nodeId, { titleSize: Number(e.target.value) })}
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
      <button
        className="context-menu__item context-menu__item--danger"
        onClick={() => {
          deleteGroup(nodeId);
          closeContextMenu();
        }}
      >
        Delete Group
      </button>
    </div>
  );
}
