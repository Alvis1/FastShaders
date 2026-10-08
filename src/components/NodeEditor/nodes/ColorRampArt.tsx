import { memo, type CSSProperties, type ReactNode } from 'react';
import { readColorRamp, rampCss } from '@/utils/colorRamp';

/**
 * The Color Ramp node's ART: its real ramp, drawn by the ONE renderer the
 * canvas (ShaderNode), every NodeVisual surface and the settings editor share,
 * so no surface can show a different gradient than the preview bakes.
 *
 * A READING, like the Colormap strip: never dark-mode re-mapped, no `title`
 * (dead on a pointer-events:none element), and the checker that shows a stop's
 * alpha uses the card's own ink so it flips with the body. Both background
 * layers ride INLINE — a stylesheet `background-image` would be wiped by any
 * inline shorthand.
 *
 * The props are RAW `values` entries (ShaderNode holds `data`, not a node), so
 * nothing here coerces them: `readColorRamp` is total on `unknown` and keys its
 * memo on strings only — a `{toString: 1}`, a Symbol or a throwing
 * `Symbol.toPrimitive` reads as "rejected → the default ramp", never a throw in
 * render (there is no error boundary).
 */
export const ColorRampStrip = memo(function ColorRampStrip({
  stops,
  interp,
  className = 'shader-node__ramp-strip',
  style,
  dataNdArt,
  children,
}: {
  stops: unknown;
  interp: unknown;
  className?: string;
  style?: CSSProperties;
  /** NodeVisual's designer hook (`data-nd-art`), forwarded as is. */
  dataNdArt?: string;
  /** The editor's overlay (its stop bar), drawn over the strip. */
  children?: ReactNode;
}) {
  const ramp = readColorRamp({ stops, interp });
  return (
    <div
      className={className}
      data-nd-art={dataNdArt}
      style={{
        backgroundImage: `${rampCss(ramp)}, repeating-conic-gradient(rgba(var(--node-ink-rgb), 0.16) 0% 25%, transparent 0% 50%)`,
        backgroundSize: '100% 100%, 8px 8px',
        ...style,
      }}
    >
      {children}
    </div>
  );
});
