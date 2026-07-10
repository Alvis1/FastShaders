import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './TooltipLayer.css';

/**
 * App-wide custom tooltip.
 *
 * Mounted once. Instead of wrapping every button, it delegates from `document`
 * and reads the element's existing `title` attribute — so every button/control
 * that already had a native tooltip gets a consistent, 1s-delayed custom one for
 * free. While a tooltip is pending/shown the native `title` is stashed away and
 * removed from the DOM (that is the only way to suppress the browser's own
 * tooltip); it is restored the moment the pointer leaves.
 *
 * `<iframe>` titles are semantic (accessible name), never a hover hint, so they
 * are excluded.
 */

const DELAY_MS = 1000;
const GAP = 8;
const EDGE = 8;

interface Anchor {
  rect: { left: number; top: number; right: number; bottom: number; width: number };
  text: string;
}

export function TooltipLayer() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: 0,
    top: 0,
    ready: false,
  });

  const tipRef = useRef<HTMLDivElement | null>(null);
  // The element whose title is currently stashed (pending or shown).
  const hostRef = useRef<HTMLElement | null>(null);
  const stashedTitleRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    // Put the native title back on the element we borrowed it from.
    const restore = () => {
      const host = hostRef.current;
      if (host && stashedTitleRef.current !== null && host.isConnected) {
        host.setAttribute('title', stashedTitleRef.current);
      }
      hostRef.current = null;
      stashedTitleRef.current = null;
    };

    const dismiss = () => {
      clearTimer();
      restore();
      setAnchor(null);
      setPos((p) => (p.ready ? { ...p, ready: false } : p));
    };

    const openFor = (el: HTMLElement) => {
      const title = el.getAttribute('title');
      if (title === null || title.trim() === '') return;

      // Take over this element's title (kills the native tooltip).
      hostRef.current = el;
      stashedTitleRef.current = title;
      el.removeAttribute('title');

      clearTimer();
      timerRef.current = window.setTimeout(() => {
        if (!el.isConnected) {
          dismiss();
          return;
        }
        const r = el.getBoundingClientRect();
        setAnchor({
          rect: {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
          },
          text: title,
        });
        setPos({ left: 0, top: 0, ready: false });
      }, DELAY_MS);
    };

    const findHost = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      const el = target.closest('[title]');
      if (!(el instanceof HTMLElement)) return null;
      if (el.tagName === 'IFRAME') return null;
      return el;
    };

    const onOver = (e: MouseEvent) => {
      const el = findHost(e.target);
      if (!el) return;
      if (el === hostRef.current) return; // already tracking this element
      dismiss(); // switching hosts: restore the previous one first
      openFor(el);
    };

    const onOut = (e: MouseEvent) => {
      const host = hostRef.current;
      if (!host) return;
      const to = e.relatedTarget as Node | null;
      // Ignore moves that stay within the current host's subtree.
      if (to && host.contains(to)) return;
      dismiss();
    };

    const onFocus = (e: FocusEvent) => {
      const el = findHost(e.target);
      if (!el) return;
      // Only show on keyboard focus, not after a mouse click.
      try {
        if (!el.matches(':focus-visible')) return;
      } catch {
        // Older engines may not support :focus-visible as a selector; fall
        // through and show the tooltip on focus rather than throwing.
      }
      if (el === hostRef.current) return;
      dismiss();
      openFor(el);
    };

    const onBlur = () => dismiss();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('focusout', onBlur, true);
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('wheel', dismiss, true);
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', dismiss);

    return () => {
      dismiss();
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('focusout', onBlur, true);
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('wheel', dismiss, true);
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', dismiss);
    };
  }, []);

  // Measure the rendered tooltip, then place it (below the anchor, flipping up
  // near the viewport bottom) and clamp horizontally to the viewport.
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return;
    const tip = tipRef.current.getBoundingClientRect();
    const cx = anchor.rect.left + anchor.rect.width / 2;
    let left = cx - tip.width / 2;
    left = Math.max(EDGE, Math.min(left, window.innerWidth - tip.width - EDGE));

    const below = anchor.rect.bottom + GAP;
    const above = anchor.rect.top - GAP - tip.height;
    const top = below + tip.height + EDGE <= window.innerHeight || above < EDGE ? below : above;

    setPos({ left, top, ready: true });
  }, [anchor]);

  if (!anchor) return null;

  return createPortal(
    <div
      ref={tipRef}
      className="fs-tooltip"
      role="tooltip"
      style={{ left: pos.left, top: pos.top, opacity: pos.ready ? 1 : 0 }}
    >
      {anchor.text}
    </div>,
    document.body
  );
}
