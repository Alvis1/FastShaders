import { useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useFrameLoop } from '@/hooks/useFrameLoop';
import { liveEdgeText } from '@/utils/edgeValueText';

/**
 * The value label for a CONNECTED input — the ONE span behind every surface
 * that shows "what is arriving on this wire" (ShaderNode rows, the Output
 * node's channel cells, Mic params, the Time node's wired speed row).
 *
 * Static by default. When `animated` (the feeder chain is time-driven,
 * evaluable, and not a noise field — see edgeValueLabel), the shared frame
 * ticker (utils/frameTicker, 15 Hz) rewrites the text from the shared app
 * clock, so the label ticks on the same frames as every other animated
 * surface (waveform, edge chip, noise thumbnails). Labels used to probe the
 * chain at t = 0 — sin(0) = 0 — so a time-fed input showed a frozen blue "0",
 * which reads as a dead wire.
 *
 * The tick writes textContent imperatively (the WaveformSvg contract: React
 * renders the initial text, the tick overwrites, and a prop-change re-render
 * merely resets it until the next tick). Per tick this costs one cached
 * evaluator call — every animated label shares the tick's time bucket thanks
 * to the shared clock — and a text write only when the string actually
 * changes. Off-screen and collapsed-away labels are skipped by the ticker;
 * the first tick back finds `next !== last` and repaints the true value.
 */
export function LiveEdgeValue({
  sourceId,
  sourceHandle,
  text,
  live,
  animated,
  className,
  reserveWidth = false,
}: {
  sourceId: string;
  /** The socket the edge leaves — the tick must re-evaluate the SAME
   *  channel the initial render showed, or the label disagrees with itself. */
  sourceHandle?: string | null;
  text: string;
  live: boolean;
  animated: boolean;
  className: string;
  /**
   * Hold the widest width the live text has reached, so the label never
   * shrinks back while it ticks. Pass it ONLY where the label sizes its node —
   * ShaderNode's row layout, where `fmtEdgeNum` trimming a trailing zero (or a
   * sign appearing) moved the node between 40 and 44 px ~9 times a second and
   * re-routed its wires with it. Never in an Output, Raymarch or Splat cell:
   * those are this same span at a FIXED 20px width (OutputNode.css), and a
   * larger min-width would widen the cell and move the label column. Constant
   * per call site, so it is not a restart dependency.
   */
  reserveWidth?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useFrameLoop(
    animated,
    ref,
    () => {
      let last: string | null = null;
      let widest = 0;
      return (t) => {
        const el = ref.current;
        if (!el) return;
        // Fresh graph read per tick — this component subscribes to nothing,
        // so a mirror ref would never refresh (the PreviewNode pattern).
        const { nodes, edges } = useAppStore.getState();
        const next = liveEdgeText(sourceId, nodes, edges, t, sourceHandle);
        if (next !== null && next !== last) {
          last = next;
          el.textContent = next;
        }
        // One layout read per GROWTH, never per tick. px from scrollWidth + 1,
        // not `ch` (it resolved to 0.5em here, short of the 4.62 px glyph) and
        // not a rounded offsetWidth (that left a 0.34 px wobble). A 0 means
        // the span is not laid out (hidden before the ticker's observer has
        // reported), so nothing is recorded and the next visible tick retries.
        if (reserveWidth && last !== null && last.length > widest) {
          const w = el.scrollWidth;
          if (w > 0) {
            widest = last.length;
            el.style.minWidth = `${w + 1}px`;
          }
        }
      };
    },
    [sourceId, sourceHandle, animated],
    // Back to the content width once the label stops ticking (or re-targets).
    { onStop: (el) => { if (el) el.style.minWidth = ''; } },
  );

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
