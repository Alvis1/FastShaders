import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fullscreenElement, pickPortalHost, placePopover } from '@/components/inputs/colorPickerModel';

/**
 * The mechanics every popover over the 3D view's bottom bar shares (the
 * animation clip list, the Fly settings), inherited from `PaletteColorPicker`
 * for the same reasons documented there:
 *  - the portal host is RESOLVED (`pickPortalHost`), not `document.body`: the
 *    preview fullscreens its own root and the top layer renders only that
 *    subtree, so a body portal would be invisible in exactly the mode where
 *    these controls are meant to stay usable;
 *  - placement is MEASURED (`placePopover` + `useLayoutEffect`), so a menu near
 *    the bottom edge flips above its anchor instead of running off-screen —
 *    and these anchors are always near the bottom edge;
 *  - Escape `stopPropagation()`s, so a leaked key can't also close something
 *    behind the menu;
 *  - a press outside the menu, its anchor and `dismissExempt` closes it, and so
 *    does leaving fullscreen (which tears the resolved host down under it).
 *
 * `onClose` should be STABLE: the dismiss effect is keyed on it and registers
 * four document listeners, so an inline arrow re-subscribes them every render.
 * `measureKey` re-measures when the menu's size changes while open.
 *
 * Render nothing until `host` is set, then portal into it with
 * `style={hiddenUntilPlaced(pos)}` — never a first paint at (0,0).
 */
export function usePreviewPopover<T extends HTMLElement>({
  open,
  anchor,
  dismissExempt,
  onClose,
  measureKey,
}: {
  open: boolean;
  anchor: HTMLElement | null;
  dismissExempt?: HTMLElement | null;
  onClose: () => void;
  measureKey?: unknown;
}) {
  const menuRef = useRef<T>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Every effect is keyed on `open` — the menu only exists inside the portal,
  // so one that isn't would attach to nothing.
  useEffect(() => {
    if (!open) { setHost(null); setPos(null); return; }
    setHost(pickPortalHost(fullscreenElement(), anchor, document.body));
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
  }, [open, anchor, host, measureKey]);

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

  return { menuRef, host, pos };
}

/** The menu's position style: parked off-screen until measured. */
export const hiddenUntilPlaced = (pos: { left: number; top: number } | null) =>
  (pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 });
