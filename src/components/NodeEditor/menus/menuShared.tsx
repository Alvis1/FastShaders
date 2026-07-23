import { useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { generateId } from '@/utils/idGenerator';

/**
 * Shared building blocks for the per-node right-click settings menus
 * (Stripes / Data Viz, …). Extracted so the row styling, the numeric-input
 * behaviour, and the Duplicate/Delete actions live in ONE place instead of
 * being copy-pasted (and drifting) across every menu.
 */

export const rowStyle = {
  padding: 'var(--space-1) var(--space-3)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-2)',
} as const;

export const labelStyle = {
  fontSize: 'var(--font-size-xs)',
  color: 'var(--text-secondary)',
} as const;

export const fieldStyle = {
  width: '70px',
  padding: '2px 4px',
  background: 'var(--bg-input)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--border-radius-sm)',
  fontSize: 'var(--font-size-xs)',
  color: 'var(--text-primary)',
} as const;

/** Color pickers and small size `<select>`s. */
export const colorFieldStyle = { ...fieldStyle, width: '80px' } as const;

/** Wide text inputs (group/note names). */
export const wideFieldStyle = { ...fieldStyle, width: '140px', padding: '2px 6px' } as const;

/** The property-name text input. */
export const nameFieldStyle = { ...fieldStyle, width: '100px', padding: '2px 6px' } as const;

interface NumberRowProps {
  label: string;
  value: number;
  onCommit: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
}

/**
 * A labelled numeric input that commits only *parseable* values. A raw
 * `Number(e.target.value)` would turn a momentarily-empty field (or a lone
 * "-"/"e" while typing) into `Number('') === 0` and instantly commit 0 —
 * snapping the field back and recompiling the shader mid-edit. Local edit
 * state holds the transient text so the field can be cleared and retyped; the
 * store only sees finite numbers, and the display reverts to the committed
 * value on blur.
 */
export function NumberRow({ label, value, onCommit, step = 0.05, min, max }: NumberRowProps) {
  const [editText, setEditText] = useState<string | null>(null);
  return (
    <div style={rowStyle}>
      <label style={labelStyle}>{label}</label>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={editText ?? String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          setEditText(raw);
          const n = Number(raw);
          if (raw !== '' && Number.isFinite(n)) onCommit(n);
        }}
        onBlur={() => setEditText(null)}
        style={fieldStyle}
      />
    </div>
  );
}

/**
 * Duplicate/Delete footer shared by every per-node settings menu, so the
 * specialized menus (Stripes/Data Viz) keep the same mouse-only actions the
 * generic NodeSettingsMenu offers — not just the keyboard shortcuts.
 */
export function NodeActions({ nodeId }: { nodeId: string }) {
  const nodes = useAppStore((s) => s.nodes);
  const addNode = useAppStore((s) => s.addNode);
  const removeNode = useAppStore((s) => s.removeNode);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const language = useAppStore((s) => s.language);

  const handleDuplicate = () => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    addNode({
      ...structuredClone(node),
      id: generateId(),
      position: { x: node.position.x + 30, y: node.position.y + 30 },
      selected: false,
    });
    closeContextMenu();
  };

  const handleDelete = () => {
    removeNode(nodeId);
    closeContextMenu();
  };

  return (
    <>
      <div className="context-menu__divider" />
      <button className="context-menu__item" onClick={handleDuplicate}>
        {t('Duplicate Node', language)}
      </button>
      <button className="context-menu__item context-menu__item--danger" onClick={handleDelete}>
        {t('Delete Node', language)}
      </button>
    </>
  );
}
