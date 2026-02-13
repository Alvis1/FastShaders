import { useAppStore } from '@/store/useAppStore';

interface EdgeContextMenuProps {
  edgeId: string;
}

export function EdgeContextMenu({ edgeId }: EdgeContextMenuProps) {
  const removeEdge = useAppStore((s) => s.removeEdge);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);

  const handleDelete = () => {
    removeEdge(edgeId);
    closeContextMenu();
  };

  return (
    <div className="context-menu__list">
      <button className="context-menu__item" onClick={handleDelete} style={{ color: '#e74c3c' }}>
        Delete Connection
      </button>
    </div>
  );
}
