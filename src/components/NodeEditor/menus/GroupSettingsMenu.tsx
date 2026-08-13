import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import type { GroupFlowNode } from '@/types';
import { rowStyle, labelStyle, colorFieldStyle, wideFieldStyle } from './menuShared';
import { useHistoryBracket } from '@/hooks/useHistoryBracket';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';

interface GroupSettingsMenuProps {
  nodeId: string;
}

export function GroupSettingsMenu({ nodeId }: GroupSettingsMenuProps) {
  const nodes = useAppStore((s) => s.nodes);
  const language = useAppStore((s) => s.language);
  const updateGroupData = useAppStore((s) => s.updateGroupData);
  const ungroup = useAppStore((s) => s.ungroup);
  const deleteGroup = useAppStore((s) => s.deleteGroup);
  const saveGroupToLibrary = useAppStore((s) => s.saveGroupToLibrary);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  // updateGroupData pushes history per call — bracket the per-keystroke /
  // per-picker-frame bursts into one undo entry (see useHistoryBracket).
  const { bracket, closeBracket } = useHistoryBracket();

  const node = nodes.find((n) => n.id === nodeId) as GroupFlowNode | undefined;
  if (!node || node.type !== 'group') return null;

  const { label, color, titleSize } = node.data;

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">{t('Group', language)}</div>

      <div style={rowStyle}>
        <label style={labelStyle}>{t('name', language)}</label>
        <input
          type="text"
          value={label}
          onChange={(e) => { bracket(); updateGroupData(nodeId, { label: e.target.value }); }}
          onBlur={closeBracket}
          autoFocus
          style={wideFieldStyle}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>{t('color', language)}</label>
        {/* `history="bracket"`: the frame colour is group node data written by
            `updateGroupData`, which pushHistory's on every call — so the pick
            is a real undoable graph edit and the picker owns the coalescing
            bracket (this row used to open one by hand around the native
            input's per-frame stream). */}
        <PaletteColorPicker
          className="context-menu__color"
          history="bracket"
          value={color}
          onPick={(hex) => updateGroupData(nodeId, { color: hex })}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>{t('title size', language)}</label>
        <select
          value={titleSize ?? 1}
          onChange={(e) => updateGroupData(nodeId, { titleSize: Number(e.target.value) })}
          style={colorFieldStyle}
        >
          <option value={1}>{t('1x', language)}</option>
          <option value={1.5}>{t('1.5x', language)}</option>
          <option value={2}>{t('2x', language)}</option>
          <option value={3}>{t('3x', language)}</option>
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
        {t('Save to Library', language)}
      </button>
      <button
        className="context-menu__item"
        onClick={() => {
          ungroup(nodeId);
          closeContextMenu();
        }}
      >
        {t('Ungroup', language)}
      </button>
      <button
        className="context-menu__item context-menu__item--danger"
        onClick={() => {
          deleteGroup(nodeId);
          closeContextMenu();
        }}
      >
        {t('Delete Group', language)}
      </button>
    </div>
  );
}
