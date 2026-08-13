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
      // Fresh graph read per frame — this component subscribes to nothing,
      // so a mirror ref would never refresh (the PreviewNode pattern).
      const { nodes, edges } = useAppStore.getState();
      const next = liveEdgeText(sourceId, nodes, edges, appTime(ts), sourceHandle);
      if (next !== null && next !== last && ref.current) {
        last = next;
        ref.current.textContent = next;
      }
      rafId = requestAnimationFrame(tick);
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
