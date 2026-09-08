import { useEffect, useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { appTime } from '@/utils/appClock';
import { liveEdgeText } from '@/utils/edgeValueText';

/**
 * The value label for a CONNECTED input — the ONE span behind every surface
 * that shows "what is arriving on this wire" (ShaderNode rows, the Output
 * node's channel cells, Mic params, the Time node's wired speed row).
 *
 * Static by default. When `animated` (the feeder chain is time-driven,
 * evaluable, and not a noise field — see edgeValueLabel), a rAF loop rewrites
 * the text from the shared app clock, so the label ticks in step with every
 * other animated surface (waveform, edge chip, noise thumbnails). Labels used
 * to probe the chain at t = 0 — sin(0) = 0 — so a time-fed input showed a
 * frozen blue "0", which reads as a dead wire.
 *
 * The loop writes textContent imperatively (the WaveformSvg contract: React
 * renders the initial text, the loop overwrites, and a prop-change re-render
 * merely resets it for one frame). Per frame this costs one cached evaluator
 * call — every animated label shares the frame's time bucket thanks to the
 * shared clock — and a text write only when the string actually changes.
 */
export function LiveEdgeValue({
  sourceId,
  sourceHandle,
  text,
  live,
  animated,
  className,
}: {
  sourceId: string;
  /** The socket the edge leaves — the rAF loop must re-evaluate the SAME
   *  channel the initial render showed, or the label disagrees with itself. */
  sourceHandle?: string | null;
  text: string;
  live: boolean;
  animated: boolean;
  className: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!animated) return;
    let rafId: number;
    let last: string | null = null;
    const tick = (ts: number) => {
      // Schedule first, so the visibility early-out below still keeps the loop
      // alive (it is torn down only when `animated` flips or the span
      // unmounts).
      rafId = requestAnimationFrame(tick);
      const el = ref.current;
      if (!el) return;
      // Hidden — a member of a COLLAPSED group is only `display: none`'d (the
      // store keeps it MOUNTED on purpose) and rAF is per-document, so nothing
      // else throttles this loop; every wired input of every hidden node was
      // still paying a cached evaluator call per frame. `offsetParent` is null
      // exactly under `display: none`. Safe to skip because the clock is
      // ABSOLUTE (utils/appClock) and the write is idempotent: the first
      // visible frame finds `next !== last` and repaints the true value.
      if (el.offsetParent === null) return;
      // Fresh graph read per frame — this component subscribes to nothing,
      // so a mirror ref would never refresh (the PreviewNode pattern).
      const { nodes, edges } = useAppStore.getState();
      const next = liveEdgeText(sourceId, nodes, edges, appTime(ts), sourceHandle);
      if (next !== null && next !== last) {
        last = next;
        el.textContent = next;
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [sourceId, sourceHandle, animated]);

  return (
    <span
      ref={ref}
      className={className}
      style={live || animated ? { color: '#2D6CDF' } : undefined}
    >
      {text}
    </span>
  );
}
