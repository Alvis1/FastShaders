import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLongPress } from '@/hooks/useLongPress';
import { fullscreenElement, pickPortalHost } from '@/components/inputs/colorPickerModel';
import './SettingButton.css';

/**
 * A button that holds a SETTING (owner, 2026-11-26): it shows the option that
 * is ON now, never the one a click would switch to; a click steps to the next
 * option; a right-click — or the keyboard's menu key, or a long press on a
 * touch screen — opens a list of every option, the one in use ticked.
 *
 * Only for buttons that had no right-click or long-press menu of their own:
 * those keep theirs. The list is a portal at a FIXED position, on the body —
 * drawn inside the pane it opened from, the split-pane seam painted over it —
 * except inside a modal dialog (`aria-modal`), where it stays in the dialog's
 * own subtree (the study dialogs make everything outside them inert), and
 * while a pane is fullscreen, where only that element is drawn. A press in a
 * list never dismisses the popover its button sits in (useDismiss). The
 * button carries the `fs-setting` class, which the toolbar's own right-click
 * menu leaves alone.
 */
export interface SettingOption<V> {
  value: V;
  /** The option's name in the list. */
  label: string;
  /** Its tooltip in the list, when the name alone does not say enough. */
  title?: string;
}

export interface SettingButtonProps<V> {
  options: readonly SettingOption<V>[];
  value: V;
  onSelect: (value: V) => void;
  /** What a plain click does; by default the next option, wrapping. */
  onClick?: () => void;
  /** The list's heading and accessible name, e.g. "Language". */
  menuLabel: string;
  className: string;
  title?: string;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
  disabled?: boolean;
  /** Shown but out of use (`aria-disabled`, so its tooltip still says why):
   *  a click and the list both do nothing. */
  locked?: boolean;
  /** A picture of the button (the intro's stage): no list, no focus. */
  inert?: boolean;
  /** Where the list opens: under the button (default), or above it where
   *  the space under it belongs to a pane drawn on top (the canvas bar sits
   *  just above the asset bar). It flips when there is no room. */
  placement?: 'below' | 'above';
  style?: CSSProperties;
  /** What the button shows: the option that is on. */
  children: ReactNode;
}

/** The one list that is open, app-wide; opening another closes it. */
let openClose: (() => void) | null = null;

/**
 * Close the open setting list, if there is one, and say whether there was.
 * Dialogs that bind Escape on the window in the CAPTURE phase (the intro, the
 * study dialogs) ask this first, so Escape closes the list and not the dialog.
 */
export function closeSettingMenu(): boolean {
  if (!openClose) return false;
  openClose();
  return true;
}

/** Where the list goes: under the button, kept inside the window. */
const GAP = 2;
const MARGIN = 8;

export function SettingButton<V>({
  options,
  value,
  onSelect,
  onClick,
  menuLabel,
  className,
  title,
  'aria-label': ariaLabel,
  'aria-pressed': ariaPressed,
  disabled = false,
  locked = false,
  inert = false,
  placement = 'below',
  style,
  children,
}: SettingButtonProps<V>) {
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; right: number; below: number; host: HTMLElement } | null>(null);
  const open = at != null;
  // Where the button was when the list opened: a scroll closes the list only
  // if the button has really moved since.
  const anchor = useRef({ left: 0, top: 0 });
  // A long press opens the list; the click its release may send must not
  // also step the setting.
  const swallowClickUntil = useRef(0);

  const close = useCallback((refocus: boolean) => {
    setAt(null);
    if (refocus) button?.focus();
  }, [button]);

  const openMenu = useCallback(() => {
    if (!button || disabled || locked || inert) return;
    const r = button.getBoundingClientRect();
    anchor.current = { left: r.left, top: r.top };
    openClose?.();
    const host = button.closest<HTMLElement>('[aria-modal="true"]') ?? pickPortalHost(fullscreenElement(), button, document.body);
    setAt({ x: r.left, y: r.bottom + GAP, right: r.right, below: r.top - GAP, host });
  }, [button, disabled, locked, inert]);

  useLongPress(button, () => {
    swallowClickUntil.current = performance.now() + 800;
    openMenu();
  });

  // Registered while open: one list at a time, and a press anywhere else, a
  // scroll, a resize or the window losing focus closes it.
  useEffect(() => {
    if (!open) return;
    const shut = () => close(false);
    openClose = shut;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || button?.contains(t)) return;
      shut();
    };
    // Only a scroll that has MOVED the button: the code panel and the canvas
    // scroll on their own while the app settles, and a scroll event arrives a
    // frame after the scroll itself — so the one that brought a half-hidden
    // button into view (the 3D view's top bar scrolls sideways) used to close
    // the list it had just made room for.
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (!t || !button || typeof t.contains !== 'function' || !t.contains(button)) return;
      const r = button.getBoundingClientRect();
      if (Math.abs(r.left - anchor.current.left) > 1 || Math.abs(r.top - anchor.current.top) > 1) shut();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', shut);
    window.addEventListener('blur', shut);
    return () => {
      if (openClose === shut) openClose = null;
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', shut);
      window.removeEventListener('blur', shut);
    };
  }, [open, close, button]);

  // Keep the list inside the window, then put the focus on the option in use.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!at || !menu) return;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    // A button on the right half of the window opens its list leftward, so
    // it does not hang past the edge of the dialog or pane it sits in.
    const start = at.right > window.innerWidth / 2 ? at.right - w : at.x;
    const left = Math.max(MARGIN, Math.min(start, window.innerWidth - MARGIN - w));
    const fitsBelow = at.y + h <= window.innerHeight - MARGIN;
    const fitsAbove = at.below - h >= MARGIN;
    const top = (placement === 'above' ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove) ? at.below - h : at.y;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = 'visible';
    // Without scrolling: the list is fixed, but it sits in the button's
    // subtree, and focusing it scrolled a scrolling parent (the 3D view's top
    // bar) — which reads as the button moving, and closed the list at once.
    (menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus({ preventScroll: true });
  }, [at, placement]);

  const step = () => {
    const i = options.findIndex((o) => Object.is(o.value, value));
    onSelect(options[(i + 1) % options.length].value);
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    let to = -1;
    if (e.key === 'ArrowDown') to = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') to = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = items.length - 1;
    else if (e.key === 'Escape') {
      e.stopPropagation();
      close(true);
      return;
    } else if (e.key === 'Tab') {
      close(false);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    items[to]?.focus({ preventScroll: true });
  };

  return (
    <>
      <button
        ref={setButton}
        type="button"
        className={`${className} fs-setting`}
        style={style}
        disabled={disabled}
        tabIndex={inert ? -1 : undefined}
        title={title}
        aria-label={ariaLabel}
        aria-pressed={ariaPressed}
        aria-disabled={locked || undefined}
        onClick={() => {
          if (inert || locked || performance.now() < swallowClickUntil.current) return;
          if (onClick) onClick();
          else step();
        }}
        onContextMenu={(e) => {
          if (inert) return;
          e.preventDefault();
          e.stopPropagation();
          if (open) close(false);
          else openMenu();
        }}
      >
        {children}
      </button>
      {at && createPortal(
        <div
          ref={menuRef}
          className="fs-setting__menu"
          role="menu"
          aria-label={menuLabel}
          // Placed by the layout effect, once it knows the list's size.
          style={{ left: at.x, top: at.y, visibility: 'hidden' }}
          onKeyDown={onMenuKey}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="fs-setting__head" aria-hidden="true">
            {menuLabel}
          </div>
          {options.map((o) => {
            const on = Object.is(o.value, value);
            return (
              <button
                key={String(o.value)}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className={`fs-setting__item${on ? ' fs-setting__item--on' : ''}`}
                title={o.title}
                onClick={() => {
                  close(true);
                  if (!on) onSelect(o.value);
                }}
              >
                {/* Drawn, not a ✓ glyph: the self-hosted font is a subset. */}
                <svg className="fs-setting__tick" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
                  {on && <path d="M2 6.5l2.5 2.5L10 3.5" />}
                </svg>
                {o.label}
              </button>
            );
          })}
        </div>,
        at.host,
      )}
    </>
  );
}
