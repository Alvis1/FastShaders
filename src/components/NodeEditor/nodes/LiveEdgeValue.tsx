import { useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { useFrameLoop } from '@/hooks/useFrameLoop';
import { liveEdgeRangeText, liveEdgeText } from '@/utils/edgeValueText';

/**
 * The value label for a CONNECTED input — the ONE span behind every surface
 * that shows "what is arriving on this wire" (ShaderNode rows, the Output
 * node's channel cells, Mic params, the Time node's wired speed row).
 *
 * Static by default. When `animated` (Time is upstream — see edgeValueLabel),
 * the shared frame ticker (utils/frameTicker, 15 Hz) rewrites the text from the
 * shared app clock, so the label ticks on the same frames as every other
 * animated surface (waveform, edge chip, noise thumbnails). Labels used to
 * probe the chain at t = 0 — sin(0) = 0 — so a time-fed input showed a frozen
 * blue "0", which reads as a dead wire. A FIELD-fed wire (`range`) ticks its
 * INTERVAL (liveEdgeRangeText — UV + Time is [t, t + 1]), never a probe point;
 * everything else ticks the point value (liveEdgeText). A tick with nothing
 * honest to print writes "…" rather than leaving the previous number up.
 *
 * The tick writes textContent imperatively (the WaveformSvg contract: React
 * renders the resting text, the tick overwrites it). It compares against the
 * DOM, not a cache of its own writes: a prop-change re-render puts React's
 * resting text back behind the tick's back, and a cached "already showing
 * that" would leave it up. Per tick this costs one cached evaluator call —
 * every animated label shares the tick's time bucket thanks to the shared
 * clock — and a text write only when the string actually changes. Off-screen
 * and collapsed-away labels are skipped by the ticker; the first tick back
 * repaints the true value.
 *
 * When the loop STOPS (Time unwired or deleted, a re-target, unmount) the
 * resting text is written back: React only patches the text when its prop
 * CHANGED, so a new resting text equal to the old one left the last ticked
 * number up forever (delete the Time node feeding Sin → Multiply and the
 * label kept "0.86").
 *
 * Blue (`live`) marks a POINT value only; a ticking interval stays grey.
 */
export function LiveEdgeValue({
  sourceId,
  sourceHandle,
  text,
  live,
  animated,
  range = false,
  compact = false,
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
  /** Tick the INTERVAL (a field-fed wire), never a probe point. */
  range?: boolean;
  /** Format the ticks for a fixed-width cell, as the resting text was. */
  compact?: boolean;
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
  // The resting text, refreshed every render. The loop's onStop runs in the
  // effect cleanup, AFTER the commit that stopped it, so this already holds
  // the NEW resting text by then.
  const restingRef = useRef(text);
  restingRef.current = text;

  useFrameLoop(
    animated,
    ref,
    () => {
      let widest = 0;
      return (t) => {
        const el = ref.current;
        if (!el) return;
        // Fresh graph read per tick — this component subscribes to nothing,
        // so a mirror ref would never refresh (the PreviewNode pattern).
        const { nodes, edges } = useAppStore.getState();
        // edgeValueLabel's own order: a field ticks its interval; anything else
        // its point, else its interval (a Time-fed Colormap has no CPU point but
        // has a bound) — "…" only when neither exists.
        const next =
          (range
            ? liveEdgeRangeText(sourceId, nodes, edges, t, sourceHandle, compact)
            : liveEdgeText(sourceId, nodes, edges, t, sourceHandle, compact)
              ?? liveEdgeRangeText(sourceId, nodes, edges, t, sourceHandle, compact)) ?? '…';
        if (el.textContent !== next) el.textContent = next;
        // One layout read per GROWTH, never per tick. px from scrollWidth + 1,
        // not `ch` (it resolved to 0.5em here, short of the 4.62 px glyph) and
        // not a rounded offsetWidth (that left a 0.34 px wobble). A 0 means
        // the span is not laid out (hidden before the ticker's observer has
        // reported), so nothing is recorded and the next visible tick retries.
        if (reserveWidth && next.length > widest) {
          const w = el.scrollWidth;
          if (w > 0) {
            widest = next.length;
            el.style.minWidth = `${w + 1}px`;
          }
        }
      };
    },
    [sourceId, sourceHandle, animated, range, compact],
    // Back to the resting text and the content width once the label stops
    // ticking (or re-targets).
    {
      onStop: (el) => {
        if (!el) return;
        el.style.minWidth = '';
        if (el.textContent !== restingRef.current) el.textContent = restingRef.current;
      },
    },
  );

  return (
    <span
      ref={ref}
      className={className}
      style={live ? { color: '#2D6CDF' } : undefined}
    >
      {text}
    </span>
  );
}
