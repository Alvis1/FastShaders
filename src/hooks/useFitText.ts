import { useLayoutEffect, useRef } from 'react';

/**
 * Shrink a label until it fits its parent box.
 *
 * For a node whose size is FIXED (the colour swatch is a 56px square, because
 * its output socket rides that exact perimeter), a long identifier like
 * `stripeColorB` cannot be allowed to widen the node — so it wraps first, and
 * only when the wrapped block is still too tall does the type scale down.
 * Wrapping is the CSS half (`overflow-wrap` + `max-width`); this hook is the
 * scale-down half.
 *
 * Writes `style.fontSize` IMPERATIVELY rather than through state: a state
 * update would re-render, re-run the measurement, and risk a feedback loop on
 * sub-pixel rounding. Nothing else owns that property on these labels.
 *
 * Runs in `useLayoutEffect` so the fitted size is painted in the same frame as
 * the text — a `useEffect` would flash the un-shrunk label first.
 *
 * @param text     re-fit whenever the string changes (the effect's real input)
 * @param maxPx    ideal size, tried first
 * @param minPx    floor — below this, legibility is worse than overflow
 * @param stepPx   how much to shrink per attempt
 */
export function useFitText<T extends HTMLElement>(
  text: string,
  maxPx: number,
  minPx: number,
  stepPx = 0.5,
) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;

    const fit = () => {
      // A parent that hasn't been laid out yet measures 0, which would read as
      // "overflows" at every size and shrink the label straight to the floor.
      if (box.clientHeight === 0 || box.clientWidth === 0) return;

      // Always restart from the ideal size: this effect re-runs on text changes,
      // and starting from the PREVIOUS (possibly shrunken) size would ratchet
      // downward and never recover when the label gets shorter again.
      let size = maxPx;
      el.style.fontSize = `${size}px`;

      // clientWidth/Height are the parent's INNER box, so the swatch's border is
      // already excluded. scrollWidth exceeds clientWidth only when a single
      // unbreakable run is too wide; height is the usual overflow axis once the
      // text wraps.
      const overflows = () =>
        el.scrollHeight > box.clientHeight || el.scrollWidth > box.clientWidth;

      while (size > minPx && overflows()) {
        size = Math.max(minPx, size - stepPx);
        el.style.fontSize = `${size}px`;
      }
    };

    fit();

    // The app self-hosts Inter as a woff2 subset, so first layout can happen in
    // a fallback face whose metrics differ — a label fitted against the
    // fallback can overflow once the real font swaps in. Re-fit once fonts
    // settle. Guarded: `document.fonts` is absent in older/odd environments,
    // and the promise can resolve after unmount.
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) fit();
    });
    return () => {
      alive = false;
    };
  }, [text, maxPx, minPx, stepPx]);

  return ref;
}
