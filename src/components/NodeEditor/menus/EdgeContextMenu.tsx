import { useReactFlow } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { addEdgeWaypoint, removeEdgeWaypoint, waypointIndexAt } from '../edges/edgeWaypoints';

/** How close (screen px) to a point's centre a right-click counts as ON it —
 *  the dot is 5 px in radius, so this adds a little slack for a trackpad. */
const POINT_HIT_PX = 9;

interface EdgeContextMenuProps {
  edgeId: string;
}

export function EdgeContextMenu({ edgeId }: EdgeContextMenuProps) {
  const removeEdge = useAppStore((s) => s.removeEdge);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const openContextMenu = useAppStore((s) => s.openContextMenu);
  const language = useAppStore((s) => s.language);
  const { getInternalNode, screenToFlowPosition, flowToScreenPosition } = useReactFlow();

  const handleDelete = () => {
    removeEdge(edgeId);
    closeContextMenu();
  };

  // Drop a routing waypoint where the menu was opened (its stored screen
  // coords → flow space).
  const handleAddPoint = () => {
    const { x, y } = useAppStore.getState().contextMenu;
    addEdgeWaypoint(edgeId, screenToFlowPosition({ x, y }), getInternalNode);
    closeContextMenu();
  };

  // A right-click lands on this edge's menu whether it hit the wire or one of
  // its routing dots, so "on a dot" is decided from where the menu opened.
  const pointIndex = useAppStore((s) => {
    const wps = (s.edges.find((e) => e.id === edgeId)?.data?.waypoints ?? []) as { x: number; y: number }[];
    return wps.length === 0 ? -1 : waypointIndexAt(wps.map((w) => flowToScreenPosition(w)), s.contextMenu, POINT_HIT_PX);
  });

  const handleRemovePoint = () => {
    removeEdgeWaypoint(edgeId, pointIndex);
    closeContextMenu();
  };

  /**
   * Swap this menu for the node search list, remembered as being ABOUT this
   * edge — AddNodeMenu reads `contextMenu.edgeId` and splices whatever is
   * chosen into it (edgeInsert.ts). Opened at the SAME point, so the new node
   * lands on the wire where it was clicked rather than at some default spot.
   */
  const handleInsertNode = () => {
    const { x, y } = useAppStore.getState().contextMenu;
    openContextMenu(x, y, 'canvas', undefined, edgeId);
  };

  return (
    <div className="context-menu__list">
      <button className="context-menu__item" onClick={handleInsertNode}>
        {t('Insert node', language)}
      </button>
      {pointIndex >= 0 ? (
        <button className="context-menu__item" onClick={handleRemovePoint}>
          {t('Remove routing point', language)}
        </button>
      ) : (
        <button className="context-menu__item" onClick={handleAddPoint}>
          {t('Add routing point', language)}
        </button>
      )}
      <button className="context-menu__item context-menu__item--danger" onClick={handleDelete}>
        {t('Delete Connection', language)}
      </button>
    </div>
  );
}
