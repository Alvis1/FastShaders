import { useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useHistoryBracket } from '@/hooks/useHistoryBracket';
import { t, type Language } from '@/i18n';
import type { ShaderFlowNode } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { generateId } from '@/utils/idGenerator';
import { resetNodeValues, isAtDefaultValues, hasResettableValues } from '@/utils/resetNodeValues';

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

/** A checkbox + its text, as used inside a `rowStyle` row. Shared so the
 *  generic node settings menu and the per-node blocks it delegates to cannot
 *  drift apart on a checkbox row — the reason this module exists. */
export const checkLabelStyle = {
  ...labelStyle,
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
} as const;

export const checkStyle = { width: '12px', height: '12px', margin: 0 } as const;

/**
 * A descriptive row: prose that explains a control rather than being one.
 *
 * It WRAPS, and that is the whole point. A settings menu shrink-to-fits to its
 * widest row (`.context-menu` has a `min-width`, not a width — only the
 * Add-node menu pins one), so a sentence on one line makes the sentence decide
 * how wide the panel is. The cap is a plain px value just inside that
 * `min-width`, so a hint never widens the box at all: it wraps inside the width
 * the menu was going to have anyway.
 *
 * `wordBreak: 'normal'` is explicit because these sentences carry identifiers
 * and device names, and breaking one mid-token to save a line reads as
 * corruption rather than as wrapping.
 */
export const hintStyle = {
  ...labelStyle,
  display: 'block',
  maxWidth: '230px',
  whiteSpace: 'normal',
  overflowWrap: 'break-word',
  wordBreak: 'normal',
  lineHeight: 1.4,
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
  // Every parseable keystroke commits, and every commit reaches
  // updateNodeData -> an unconditional pushHistory -> a full-graph
  // structuredClone + a graph->code pass. Typing "0.125" was five undo
  // entries. Bracket the burst so a typed edit is ONE entry; the bracket
  // lives HERE rather than at the four call sites (Stripes / Data Viz /
  // Colormap / Data Range) for the same reason this module exists.
  // Two consequences worth knowing: a spinner-arrow click also opens the
  // 600 ms window (one click, one change event), and a sibling control
  // touched inside that window folds into the same entry — e.g. changing
  // Data Range's mode select right after typing a bound, which also
  // unmounts this row (the hook's unmount effect closes the bracket).
  const { bracket, closeBracket } = useHistoryBracket();
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
          // bracket() before onCommit: beginInteraction must snapshot the
          // pre-edit state, not the first typed value.
          if (raw !== '' && Number.isFinite(n)) { bracket(); onCommit(n); }
        }}
        onBlur={() => { setEditText(null); closeBracket(); }}
        style={fieldStyle}
      />
    </div>
  );
}

interface RadialRowsProps {
  /** The checkbox's i18n key. Data Stripes says "radial (rings)" (its stripes
   *  become tree rings) and Data Viz just "radial" — two different English
   *  strings, hence two keys, translated here the way ColormapSettingsMenu
   *  translates its group labels. */
  labelKey: string;
  language: Language;
  /** The node's stored values, straight from `getNodeValues`. */
  values: Record<string, string | number>;
  /** The menu's own value-patch helper — one `updateNodeData` per commit, so
   *  each row stays one undo entry (NumberRow brackets a typing burst itself). */
  onChange: (patch: Record<string, number>) => void;
}

/**
 * The radial-distribution block shared by the Data Stripes and Data Viz
 * settings menus: a checkbox switching the node from linear to concentric
 * ("target" / tree-ring) distribution, plus the circle's centre and radius —
 * revealed only while it is on, because they mean nothing in linear mode.
 *
 * Both menus carried a copy. They did not LOOK like copies, which is why the
 * duplication survived: each menu wraps NumberRow in its own local `numRow`
 * helper and the two helpers take different arguments — Stripes' fourth is
 * `min`, Data Viz's is `step` with `min` fifth — so the identical radius row
 * was spelled `numRow('radius', …, 0.5, 0.05)` in one file and
 * `numRow('radius', …, 0.5, 0.05, 0.05)` in the other. Both resolve to the
 * same NumberRow call, and that is what this renders directly: NumberRow's own
 * default step (0.05), and a 0.05 floor on the radius so a radial node can
 * never be given a zero-radius circle, which collapses the whole field into
 * one hard ring at the centre.
 *
 * `radial` is stored as 0/1 rather than a boolean: `values` is typed
 * Record<string, string | number> and the flag rides codegen as a number.
 */
export function RadialRows({ labelKey, language, values, onChange }: RadialRowsProps) {
  const radial = Number(values.radial ?? 0) >= 0.5;
  return (
    <>
      <label style={{ ...rowStyle, cursor: 'pointer' }}>
        <span style={labelStyle}>{t(labelKey, language)}</span>
        <input
          type="checkbox"
          checked={radial}
          onChange={(e) => onChange({ radial: e.target.checked ? 1 : 0 })}
        />
      </label>

      {radial && (
        <>
          <NumberRow
            label={t('center X', language)}
            value={Number(values.center_x ?? 0.5)}
            onCommit={(n) => onChange({ center_x: n })}
          />
          <NumberRow
            label={t('center Y', language)}
            value={Number(values.center_y ?? 0.5)}
            onCommit={(n) => onChange({ center_y: n })}
          />
          <NumberRow
            label={t('radius', language)}
            value={Number(values.radius ?? 0.5)}
            onCommit={(n) => onChange({ radius: n })}
            min={0.05}
          />
        </>
      )}
    </>
  );
}

/**
 * Reset/Duplicate/Delete footer shared by every per-node settings menu, so the
 * specialized menus (Stripes/Data Viz/Colormap/Data Range) keep the same
 * mouse-only actions the generic NodeSettingsMenu offers — not just the
 * keyboard shortcuts.
 */
export function NodeActions({ nodeId }: { nodeId: string }) {
  // The per-id selector every menu in this directory uses, not `s.nodes`.
  // `s.nodes` is a NEW array on every graph notify — a drag, a scrub, a value
  // typed into some unrelated node — so subscribing to it re-rendered this
  // footer (and, through it, the whole open menu) for changes it has nothing
  // to do with. React Flow's applyNodeChanges REUSES the object of a node it
  // did not touch, so the identity of THIS node is the honest dependency:
  // zustand's default Object.is equality then bails on everything else.
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId)) as ShaderFlowNode | undefined;
  const addNode = useAppStore((s) => s.addNode);
  const removeNode = useAppStore((s) => s.removeNode);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const language = useAppStore((s) => s.language);

  const handleDuplicate = () => {
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

  const def = node ? NODE_REGISTRY.get(node.data.registryType) : undefined;
  const values = node ? getNodeValues(node) : {};
  const showReset = hasResettableValues(def, values);
  const atDefaults = !def || isAtDefaultValues(def, values);

  const handleReset = () => {
    if (!node || !def) return;
    // One updateNodeData → one pushHistory → one undo entry for the whole
    // reset, however many settings it touched.
    updateNodeData(nodeId, { values: resetNodeValues(def, values) });
    closeContextMenu();
  };

  return (
    <>
      <div className="context-menu__divider" />
      {showReset && (
        <button
          className="context-menu__item"
          onClick={handleReset}
          // Disabled rather than hidden when nothing has changed: the row
          // disappearing the moment a node is already at its defaults would
          // read as the action being missing.
          disabled={atDefaults}
          title={
            atDefaults
              ? t('Already at the default values', language)
              : t('Restore this node’s settings to their defaults', language)
          }
        >
          {t('Reset Values', language)}
        </button>
      )}
      <button className="context-menu__item" onClick={handleDuplicate}>
        {t('Duplicate Node', language)}
      </button>
      <button className="context-menu__item context-menu__item--danger" onClick={handleDelete}>
        {t('Delete Node', language)}
      </button>
    </>
  );
}
