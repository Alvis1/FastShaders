import { useAppStore } from '@/store/useAppStore';

export function ShaderSettingsMenu() {
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const totalCost = useAppStore((s) => s.totalCost);

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">Shader Settings</div>
      <div
        style={{
          padding: 'var(--space-2) var(--space-3)',
          fontSize: 'var(--font-size-sm)',
          color: 'var(--text-secondary)',
        }}
      >
        <div>Total Cost: <strong style={{ color: 'var(--text-primary)' }}>{totalCost}</strong> pts</div>
        <div style={{ marginTop: 'var(--space-1)', fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
          Budget: 200 pts max
        </div>
      </div>
      <div className="context-menu__divider" />
      <button className="context-menu__item" onClick={closeContextMenu}>
        Close
      </button>
    </div>
  );
}
