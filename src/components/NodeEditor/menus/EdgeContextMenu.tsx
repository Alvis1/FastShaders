import { useReactFlow } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { addEdgeWaypoint, removeEdgeWaypoint, waypointIndexAt, WAYPOINT_HIT_PX } from '../edges/edgeWaypoints';
import { promoteWaypoint } from '../branchActions';
import { branchRefusal } from '../branchWire';
import { makePortalRefusal } from '../portalWire';
import { makePortal } from '../portalActions';

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
    return wps.length === 0 ? -1 : waypointIndexAt(wps.map((w) => flowToScreenPosition(w)), s.contextMenu, WAYPOINT_HIT_PX);
  });

  // A wire a Branch may not go into (branchWire.ts `branchRefusal`: a
  // collapsed pill's wire) is offered no "Branch from here" — the row would
  // close the menu and do nothing. A boolean, so no re-render per notify.
  const branchOffered = useAppStore((s) => branchRefusal(s.nodes, s.edges, edgeId) === null);

  // "Make portal" (portalActions.ts): the wire becomes a Portal In by its
  // source and a Portal Out by its target. A wire it would make no sense on
  // keeps the row, inert, and its tooltip says why (`makePortalRefusal`).
  const portalRefusal = useAppStore((s) => makePortalRefusal(s.nodes, s.edges, edgeId));
  const handleMakePortal = () => {
    if (portalRefusal) return;
    makePortal(edgeId, getInternalNode);
    closeContextMenu();
  };
  const portalTip =
    portalRefusal === 'portal' ? t('This wire already goes through a portal', language)
    : portalRefusal ? t('Open the group first', language)
    : t('Hide this wire: a Portal In by its start and a Portal Out by its end carry the value, with no wire drawn in between', language);

  const handleRemovePoint = () => {
    removeEdgeWaypoint(edgeId, pointIndex);
    closeContextMenu();
  };

  // The point becomes a BRANCH (branchActions.ts): a node one wire comes into
  // and any number of wires leave. One of the two ways a Branch is made, both
  // right-click menus (a long-press opens this one on touch);
  // docs/dev/canvas-interaction.md, "Branch".
  const handleBranchPoint = () => {
    promoteWaypoint(edgeId, pointIndex);
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
        <>
          {branchOffered && (
            <button
              className="context-menu__item"
              onClick={handleBranchPoint}
              title={t('Turn this routing point into a Branch. Then drag a wire from any input onto it to use the same value there', language)}
            >
              {t('Branch from here', language)}
            </button>
          )}
          <button className="context-menu__item" onClick={handleRemovePoint}>
            {t('Remove routing point', language)}
          </button>
        </>
      ) : (
        <button className="context-menu__item" onClick={handleAddPoint}>
          {t('Add routing point', language)}
        </button>
      )}
      <button
        className="context-menu__item context-menu__item--inert"
        aria-disabled={portalRefusal !== null || undefined}
        title={portalTip}
        onClick={handleMakePortal}
      >
        {t('Make portal', language)}
      </button>
      <button className="context-menu__item context-menu__item--danger" onClick={handleDelete}>
        {t('Delete Connection', language)}
      </button>
    </div>
  );
}
