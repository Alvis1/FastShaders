import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { placePopover } from '@/components/inputs/colorPickerModel';
import { highlightMesh } from '@/utils/meshHighlight';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import './MeshTargetPicker.css';

/**
 * Which sub-meshes ONE Output material shades.
 *
 * A native `<select multiple>` cannot be made to look or behave like this
 * (no checkboxes, a fixed-height list box, and shift/ctrl-click selection
 * semantics nobody discovers), so this is a button plus a portalled checkbox
 * list — the ContextMenu / PaletteColorPicker pattern.
 *
 * PORTALLED, not rendered inside the node, for the reason every other menu here
 * is: a list inside the node would scale with the canvas zoom, be clipped by
 * nothing but paint under the nodes below it, and grow the node's own box while
 * open — which moves every socket beneath it mid-gesture.
 *
 * The CLOSED label names the FIRST mesh and abbreviates the rest as an
 * ellipsis. It deliberately does not count them ("Body +2"): the node is 140px
 * wide, a mesh name is attacker-supplied and up to 128 characters, and the one
 * thing worth reading at a glance is which mesh this block is about.
 */
export interface MeshTargetPickerProps {
  /** Every mesh the loaded model reported, in inventory order. */
  meshNames: readonly string[];
  /** The meshes this material shades. Empty = the default (material 0 only). */
  selected: readonly string[];
  /**
   * Whether "All meshes (default)" is offered — material 0 only. It IS the
   * node's own channel state, so there is exactly one slot for "everything
   * else"; offering it on an added material would author a second default,
   * which silently loses at emission.
   */
  allowDefault: boolean;
  /** A material above already shades this mesh, so emission shadows this one. */
  shadowed?: boolean;
  onChange: (next: string[]) => void;
}

export function MeshTargetPicker({
  meshNames,
  selected,
  allowDefault,
  shadowed = false,
  onChange,
}: MeshTargetPickerProps) {
  const language = useAppStore((s) => s.language);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  // Outside pointerdown + Escape, capture phase — the colour picker's rules,
  // and for the same reasons: React Flow swallows a pane-pan pointerdown, and a
  // bubbled Escape would close the whole settings menu this can sit inside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (popRef.current?.contains(target)) return;
      if (btnRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  // Measure-and-place before paint (the ContextMenu precedent). The list height
  // depends on the mesh count, so a hardcoded flip threshold would be wrong for
  // every model but the one it was written against.
  useLayoutEffect(() => {
    if (!open) return;
    const el = popRef.current;
    const a = btnRef.current?.getBoundingClientRect();
    if (!el || !a) return;
    const r = el.getBoundingClientRect();
    const next = placePopover(
      { left: a.left, top: a.top, bottom: a.bottom },
      { width: r.width, height: r.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
  }, [open, meshNames.length, allowDefault]);

  const selectedSet = new Set(selected);
  /** A mesh named by this material that the loaded model does not contain —
   *  the ordinary state after reopening a graph without its model, so it is
   *  still listed (and marked), never silently dropped. */
  const missing = selected.filter((n) => !meshNames.includes(n));
  const rows = [...meshNames, ...missing];

  const toggle = (name: string) => {
    // Unticking the LAST mesh is allowed: an empty added material shades
    // nothing, which is a legal (and marked) state — it is what a swap passes
    // through when one material's only mesh moves to another. A checkbox that
    // refuses is a control that silently does nothing, which is worse.
    const next = selectedSet.has(name)
      ? selected.filter((n) => n !== name)
      : [...rows.filter((n) => selectedSet.has(n) || n === name)];
    onChange(next);
    if (!selectedSet.has(name)) {
      highlightMesh(name);
      window.setTimeout(() => highlightMesh(null), 1200);
    }
  };

  const first = selected[0];
  /** An ADDED material with nothing ticked. It shades nothing and emits
   *  nothing — the state a swap passes through, and the state left behind when
   *  another material takes this one's last mesh — so it is MARKED rather than
   *  left looking like a material that works. */
  const unassigned = first === undefined && !allowDefault;
  // The CLOSED label says "All meshes"; the list row says "All meshes
  // (default)". The control is capped at 104px (a mesh name is
  // attacker-supplied — see outputTargetChip.test.ts) and at this weight and
  // size the longer string clipped to "All meshes (…", which reads as a name
  // that has been cut off rather than as the default state. The list has 260px
  // and can afford to say which one it is.
  const label = first !== undefined
    ? first
    : t(allowDefault ? 'All meshes' : 'No mesh', language);
  const isMissing = first !== undefined && meshNames.length > 0 && !meshNames.includes(first);
  const title = unassigned
    ? t('This material shades nothing — tick a mesh, or remove it', language)
    : first === undefined
    ? t('This material shades every mesh the ones below do not', language)
    : shadowed
      ? `"${first}" is already shaded by a material above — this one does nothing`
      : selected.length > 1
        ? `${t('Shades', language)}: ${selected.join(', ')}`
        : isMissing
          ? `Shades "${first}", which the loaded model does not contain`
          : `Shades the mesh "${first}"`;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`mesh-picker nodrag${isMissing ? ' mesh-picker--missing' : ''}${shadowed ? ' mesh-picker--shadowed' : ''}${unassigned ? ' mesh-picker--unassigned' : ''}`}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        // React Flow drags the node from any pointerdown on it.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <span className="mesh-picker__label">{label}</span>
        {/* The ellipsis is a SEPARATE span so it survives the label's own
            text-overflow clip — folded into the string it would be the first
            thing a long mesh name pushes out of the box, i.e. the "there are
            more" signal would vanish exactly when it is needed. */}
        {selected.length > 1 && <span className="mesh-picker__more">{'…'}</span>}
        <span className="mesh-picker__caret" aria-hidden="true" />
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          className="mesh-picker__pop nodrag"
          role="listbox"
          aria-multiselectable="true"
          style={{ left: pos.left, top: pos.top }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {allowDefault && (
            <label className="mesh-picker__row mesh-picker__row--default">
              <input
                type="checkbox"
                checked={selected.length === 0}
                onChange={() => onChange([])}
              />
              <span className="mesh-picker__name">{t('All meshes (default)', language)}</span>
            </label>
          )}
          {rows.map((name) => (
            <label
              key={name}
              className={`mesh-picker__row${meshNames.includes(name) ? '' : ' mesh-picker__row--missing'}`}
              title={meshNames.includes(name) ? name : `${name} — not in the loaded model`}
              onPointerEnter={() => meshNames.includes(name) && highlightMesh(name)}
              onPointerLeave={() => highlightMesh(null)}
            >
              <input
                type="checkbox"
                checked={selectedSet.has(name)}
                onChange={() => toggle(name)}
              />
              <span className="mesh-picker__name">{name}</span>
            </label>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
