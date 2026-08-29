import { useCallback, useEffect, useState, type RefObject } from 'react';

/**
 * The ONE horizontal "there is more this way" control, shared by the asset
 * browser's two rows (category tabs, tile strip) and the 3D preview's control
 * bar. Both the OVERFLOW DETECTION and the button live here; the visual is
 * `.fs-scroll-arrow` in styles/controls.css, beside the other shared chrome
 * primitives, so a surface adopting it cannot end up with a different-looking
 * arrow — it supplies only `--fs-arrow-bg`, the colour of the strip the plate
 * has to match.
 */

/** Track the overflow state of a horizontally scrollable element. */
export function useScrollArrows(ref: RefObject<HTMLElement | null>) {
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });

    // Overflow is `scrollWidth - clientWidth`, and the two move INDEPENDENTLY:
    // a pane resize changes the scroller's own box, while its CONTENT changing
    // leaves that box exactly as it was. Observing only the scroller therefore
    // misses every content-driven change — MEASURED as a dead arrow in both
    // consumers: searching the asset browser down to a single tile left the ›
    // arrow drawn over a strip with nothing to scroll, and switching the 3D
    // preview to an OBJ geometry (which removes the Subd slider) did the same
    // to its control bar. Clicking either did nothing, which reads as a broken
    // control rather than a stale one.
    //
    // So the observer watches the children too — a label relabelled by the
    // language switch, a <select> that grew an option, a tile strip that was
    // filtered — and a MutationObserver picks up children added later, since
    // this effect runs once. Nothing needs to unobserve a REMOVED child:
    // ResizeObserver holds its targets weakly, so a detached element the
    // renderer has dropped is collected with its registration.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const observeChildren = () => {
      for (const child of el.children) ro.observe(child);
    };
    observeChildren();
    const mo = new MutationObserver(() => {
      observeChildren();
      update();
    });
    mo.observe(el, { childList: true });

    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
      mo.disconnect();
    };
  }, [ref, update]);

  const scrollBy = useCallback(
    (dir: -1 | 1) => {
      ref.current?.scrollBy({ left: dir * 200, behavior: 'smooth' });
    },
    [ref],
  );

  return { canLeft, canRight, scrollBy };
}

export function ScrollArrow({
  direction,
  onClick,
  /**
   * Dark plate, light glyph (and the reverse in dark mode) instead of the
   * default plate-matches-the-strip look. For a surface where the arrow has to
   * be FOUND rather than merely available: the 3D preview's control bar is a
   * near-white chrome strip, so a plate in its own colour reads as part of the
   * bar and the arrow stops looking like a button at all. The asset browser
   * keeps the default — its arrows sit against a busy tile strip that a solid
   * dark plate would fight.
   */
  invert,
  /** Extra class for per-surface placement; the look comes from the base. */
  className,
}: {
  direction: 'left' | 'right';
  onClick: () => void;
  invert?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={
        `fs-scroll-arrow fs-scroll-arrow--${direction}` +
        (invert ? ' fs-scroll-arrow--invert' : '') +
        (className ? ` ${className}` : '')
      }
      onClick={onClick}
      aria-label={`Scroll ${direction}`}
    >
      {direction === 'left' ? '‹' : '›'}
    </button>
  );
}
