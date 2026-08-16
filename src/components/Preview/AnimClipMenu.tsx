import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pickPortalHost, placePopover } from '@/components/inputs/colorPickerModel';
import { t } from '@/i18n';
import type { Language } from '@/i18n';

/**
 * Clip picker for an animated glTF, anchored to the animation pill's visible
 * ☰ button — the primary path. Right-click / long-press anywhere on the pill
 * are shortcuts to the same menu.
 *
 * Rendered whenever the model carries an animation at all — no multi-clip
 * gate. It shipped first as a right-click-only context menu suppressed below
 * two clips, and that was reported as "does not work": a control that exists
 * on some models and not others, reached by a gesture that silently no-ops,
 * is indistinguishable from a broken feature. On a single-clip file the list
 * still answers a real question (what is this clip called).
 *
 * Three mechanics are inherited from `PaletteColorPicker`, for the same reasons
 * documented there:
 *  - the portal host is RESOLVED (`pickPortalHost`), not `document.body`: the
 *    preview fullscreens its own root and the top layer renders only that
 *    subtree, so a body portal would be invisible in exactly the mode where
 *    these controls are meant to stay usable;
 *  - placement is MEASURED (`placePopover` + `useLayoutEffect`), so a menu near
 *    the bottom edge flips above its anchor instead of running off-screen —
 *    and this anchor is always near the bottom edge;
 *  - Escape `stopPropagation()`s, so a leaked key can't also close something
 *    behind the menu.
 */
export function AnimClipMenu({
  anchor,
  dismissExempt,
  open,
  clips,
  active,
  onPick,
  onClose,
  language,
}: {
  anchor: HTMLElement | null;
  /**
   * Extra element whose pointerdowns must NOT close the menu — the whole
   * animation pill, not just the ☰ anchor. The pill carries a contextmenu
   * TOGGLE, and a right-click's pointerdown precedes its contextmenu: with
   * only the anchor exempted, right-clicking the pill closed the menu here
   * and the toggle then flipped it straight back open, so the "toggle" could
   * never close it (podest's twin exempts the entire pill the same way).
   */
  dismissExempt?: HTMLElement | null;
  open: boolean;
  clips: string[];
  active: number;
  onPick: (index: number) => void;
  onClose: () => void;
  language: Language;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Every effect is keyed on `open` — the menu only exists inside the portal,
  // so one that isn't would attach to nothing.
  useEffect(() => {
    if (!open) { setHost(null); setPos(null); return; }
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const fsEl = (document.fullscreenElement ?? doc.webkitFullscreenElement ?? null) as HTMLElement | null;
    setHost(pickPortalHost(fsEl, anchor, document.body));
  }, [open, anchor]);

  // `host` is IN the dep list, and that is the whole reason this works: the
  // portal renders nothing until the host is resolved, which happens in an
  // effect one render LATER. Without `host` here the layout effect only runs
  // on the render where `open` flipped — the one where `menuRef.current` is
  // still null — so it measures nothing, `pos` stays null, and the menu sits
  // at its off-screen parking position forever. (Measured: the items were in
  // the DOM, visible and enabled, and outside the viewport.)
  useLayoutEffect(() => {
    if (!open || !anchor || !host) return;
    const el = menuRef.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    setPos(placePopover(
      { left: a.left, top: a.top, bottom: a.bottom },
      { width: m.width, height: m.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [open, anchor, host, clips.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    const onDown = (e: PointerEvent) => {
      const el = menuRef.current;
      if (el && e.target instanceof Node && (
        el.contains(e.target) || anchor?.contains(e.target) || dismissExempt?.contains(e.target)
      )) return;
      onClose();
    };
    // Leaving fullscreen tears the resolved host down under the menu.
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('fullscreenchange', onClose);
    document.addEventListener('webkitfullscreenchange', onClose);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('fullscreenchange', onClose);
      document.removeEventListener('webkitfullscreenchange', onClose);
    };
  }, [open, anchor, dismissExempt, onClose]);

  if (!open || !host) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="anim-clip-menu"
      role="menu"
      aria-label={t('Animation clips', language)}
      // Hidden until measured, so the first paint can't flash at (0,0) — the
      // trap PaletteColorPicker's own placement bug left behind.
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      <div className="anim-clip-menu__head">{t('Animation clips', language)}</div>
      {clips.map((name, i) => (
        <button
          key={`${i}:${name}`}
          type="button"
          role="menuitemradio"
          aria-checked={i === active}
          className={`anim-clip-menu__item${i === active ? ' anim-clip-menu__item--active' : ''}`}
          onClick={() => { onPick(i); onClose(); }}
          // An unnamed clip is legal in glTF; the index is the only handle the
          // user has on it, so never render an empty row.
          title={name || `${t('Clip', language)} ${i + 1}`}
        >
          <span className="anim-clip-menu__mark">{i === active ? '●' : ''}</span>
          <span className="anim-clip-menu__name">{name || `${t('Clip', language)} ${i + 1}`}</span>
        </button>
      ))}
    </div>,
    host,
  );
}
