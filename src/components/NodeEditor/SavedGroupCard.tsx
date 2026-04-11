import { useCallback } from 'react';
import { useAppStore } from '@/store/useAppStore';
import type { SavedGroup } from '@/store/useAppStore';

export const SAVED_GROUP_DRAG_TYPE = 'application/fastshaders-saved-group';

interface SavedGroupCardProps {
  group: SavedGroup;
}

/**
 * Asset-browser tile for a saved group. Drag the tile onto the canvas to drop
 * a fresh instance of the group; click the X to remove it from the library.
 *
 * The visual mirrors the in-canvas GroupNode: a colored header strip on top of
 * a tinted body, with a small "Nx nodes" hint underneath.
 */
export function SavedGroupCard({ group }: SavedGroupCardProps) {
  const deleteSavedGroup = useAppStore((s) => s.deleteSavedGroup);

  const onDragStart = useCallback(
    (event: React.DragEvent) => {
      event.dataTransfer.setData(SAVED_GROUP_DRAG_TYPE, group.id);
      event.dataTransfer.effectAllowed = 'move';
    },
    [group.id],
  );

  const onDelete = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      deleteSavedGroup(group.id);
    },
    [deleteSavedGroup, group.id],
  );

  // Member count = total saved nodes minus the group container itself.
  const memberCount = Math.max(0, group.nodes.length - 1);

  return (
    <div
      className="saved-group-card"
      draggable
      onDragStart={onDragStart}
      title={`${group.name} — drag to canvas`}
    >
      <div
        className="saved-group-card__frame"
        style={{
          background: `${group.color}1A`,
          borderColor: `${group.color}66`,
        }}
      >
        <div
          className="saved-group-card__header"
          style={{ background: group.color }}
        >
          <span className="saved-group-card__title">{group.name}</span>
        </div>
        <div className="saved-group-card__body">
          <span className="saved-group-card__count">
            {memberCount} {memberCount === 1 ? 'node' : 'nodes'}
          </span>
        </div>
      </div>
      <button
        type="button"
        className="saved-group-card__delete"
        onClick={onDelete}
        title="Remove from library"
        aria-label="Remove saved group"
      >
        ×
      </button>
    </div>
  );
}
