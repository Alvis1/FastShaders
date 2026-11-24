import { useReactFlow } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { makePortalRefusal } from '../portalWire';
import { makePortal } from '../portalActions';

interface EdgeContextMenuProps {
  edgeId: string;
}

/**
 * A wire's right-click menu: Insert node, Make portal, Delete Connection. The
 * routing-point rows ("Add routing point", "Remove routing point", "Branch
 * from here") went with routing points (owner, 2026-11-24); a Branch is put
 * on a wire by double-clicking it, or Insert node > Branch.
 */
export function EdgeContextMenu({ edgeId }: EdgeContextMenuProps) {
  const removeEdge = useAppStore((s) => s.removeEdge);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const openContextMenu = useAppStore((s) => s.openContextMenu);
  const language = useAppStore((s) => s.language);
  const { getInternalNode } = useReactFlow();

  const handleDelete = () => {
    removeEdge(edgeId);
    closeContextMenu();
  };

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
