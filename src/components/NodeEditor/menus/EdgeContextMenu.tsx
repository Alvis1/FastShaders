import { useReactFlow, type InternalNode } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { insertWaypointOrdered } from '../edges/bezierGeometry';

interface EdgeContextMenuProps {
  edgeId: string;
}

export function EdgeContextMenu({ edgeId }: EdgeContextMenuProps) {
  const removeEdge = useAppStore((s) => s.removeEdge);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const language = useAppStore((s) => s.language);
  const { getInternalNode, screenToFlowPosition } = useReactFlow();

  const handleDelete = () => {
    removeEdge(edgeId);
    closeContextMenu();
  };

  // Drop a routing waypoint at the point where the menu was opened (its stored
  // screen coords → flow space). Same ordering + persistence as the double-click
  // path (insertWaypointOrdered + setEdgeWaypoints).
  const handleAddPoint = () => {
    const store = useAppStore.getState();
    const edge = store.edges.find((e) => e.id === edgeId);
    const src = edge && getInternalNode(edge.source);
    const tgt = edge && getInternalNode(edge.target);
    if (edge && src && tgt) {
      const p = screenToFlowPosition({ x: store.contextMenu.x, y: store.contextMenu.y });
      const center = (n: InternalNode) => ({
        x: n.internals.positionAbsolute.x + (n.measured?.width ?? 120) / 2,
        y: n.internals.positionAbsolute.y + (n.measured?.height ?? 40) / 2,
      });
      const wps = (edge.data?.waypoints ?? []) as { x: number; y: number }[];
      const next = insertWaypointOrdered(center(src), center(tgt), wps, p);
      store.setEdgeWaypoints(edgeId, next, { history: true });
    }
    closeContextMenu();
  };

  return (
    <div className="context-menu__list">
      <button className="context-menu__item" onClick={handleAddPoint}>
        {t('Add routing point', language)}
      </button>
      <button className="context-menu__item" onClick={handleDelete} style={{ color: '#e74c3c' }}>
        {t('Delete Connection', language)}
      </button>
    </div>
  );
}
