import { createPortal } from 'react-dom';
import { hiddenUntilPlaced, usePreviewPopover } from './usePreviewPopover';
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
 * Host, placement and dismissal are the bottom bar's shared popover mechanics
 * (`usePreviewPopover`, which says why each is the way it is).
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
  const { menuRef, host, pos } = usePreviewPopover<HTMLDivElement>({
    open, anchor, dismissExempt, onClose, measureKey: clips.length,
  });

  if (!open || !host) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="anim-clip-menu"
      role="menu"
      aria-label={t('Animation clips', language)}
      // Hidden until measured, so the first paint can't flash at (0,0) — the
      // trap PaletteColorPicker's own placement bug left behind.
      style={hiddenUntilPlaced(pos)}
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
