import { useCallback } from 'react';
import { useAppStore } from '@/store/useAppStore';
import type { SavedGroup } from '@/store/useAppStore';
import { startTileDrag, tileGhostZoom, tileActivationProps, setHtml5TileDrag } from './tileDrag';
import { useAssetTooltip } from './AssetTooltip';

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
      // Record the payload for dragover (dataTransfer is unreadable there) so
      // the canvas can withhold the drop-on-edge highlight — a group drop
      // never splices, and the preview must not promise one. Teardown rides
      // ContentBrowser's root onDragEnd (endHtml5TileDrag).
      setHtml5TileDrag({ kind: 'savedGroup', id: group.id });
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

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      // Tap on the X button is a delete, not a drag.
      if ((event.target as HTMLElement).closest('.saved-group-card__delete')) return;
      const tile = event.currentTarget as HTMLElement;
      startTileDrag(
        event.nativeEvent,
        { kind: 'savedGroup', id: group.id },
        `<div class="saved-group-card" style="zoom: ${tileGhostZoom(tile)}">${tile.innerHTML}</div>`,
      );
    },
    [group.id],
  );

  // Member count = total saved nodes minus the group container itself.
  const memberCount = Math.max(0, group.nodes.length - 1);
  const { tooltip, tooltipHandlers } = useAssetTooltip(
    `Saved group “${group.name}” (${memberCount} ${memberCount === 1 ? 'node' : 'nodes'}) — click, or drag onto the canvas, to add a copy.`,
  );

  return (
    <div
      className="saved-group-card"
      draggable
      onDragStart={onDragStart}
      onPointerDown={onPointerDown}
      {...tileActivationProps({ kind: 'savedGroup', id: group.id }, `Add saved group ${group.name}`)}
      {...tooltipHandlers}
    >
      {tooltip}
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
