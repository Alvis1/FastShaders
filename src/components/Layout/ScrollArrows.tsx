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
    // The element's own box AND its content can change without the other —
    // a pane resize moves clientWidth, a re-render moves scrollWidth — so the
    // observer watches the scroller itself and `update` reads both.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
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
  /** Extra class for per-surface placement; the look comes from the base. */
  className,
}: {
  direction: 'left' | 'right';
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`fs-scroll-arrow fs-scroll-arrow--${direction}${className ? ` ${className}` : ''}`}
      onClick={onClick}
      aria-label={`Scroll ${direction}`}
    >
      {direction === 'left' ? '‹' : '›'}
    </button>
  );
}
