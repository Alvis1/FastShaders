import { memo, useMemo, type CSSProperties, type ReactNode, type SVGProps } from 'react';
import { readRgbCurves, curveTables, curvePath, IDENTITY_CURVE, CURVE_CHANNELS, type CurveChannel } from '@/utils/rgbCurves';

/**
 * The RGB Curves node's ART: its real curves, drawn by the ONE renderer the
 * canvas (ShaderNode), every NodeVisual surface and the settings editor share,
 * from the same tables the shader bakes (utils/rgbCurves.ts `curveTables`), so
 * no surface can show a different bend than the preview applies.
 *
 * A READING, like the Colormap and Color Ramp strips: never dark-mode
 * re-mapped (the R/G/B strokes are literal channel colours), no `title` (dead
 * on a pointer-events:none element); the grid, the diagonal and the C curve use
 * the card's own ink so they flip with the body.
 *
 * The props are RAW `values` entries (ShaderNode holds `data`, not a node), so
 * nothing here coerces them: `readRgbCurves` is total on `unknown` and keys its
 * memo on strings only — a `{toString: 1}`, a Symbol or a throwing
 * `Symbol.toPrimitive` reads as "rejected → the straight line", never a throw
 * in render (there is no error boundary).
 */

const CHANNEL_STROKE: Readonly<Record<CurveChannel, string>> = Object.freeze({
  c: 'rgb(var(--node-ink-rgb))',
  r: '#d84040',
  g: '#3fa63f',
  b: '#4a68d8',
});
const GRID = 'rgba(var(--node-ink-rgb), 0.15)';
const DIAGONAL = 'rgba(var(--node-ink-rgb), 0.3)';

export const CurvesArt = memo(function CurvesArt({
  curveC,
  curveR,
  curveG,
  curveB,
  extend,
  width = 72,
  height = 56,
  pad = 3,
  active,
  className = 'shader-node__curves-art',
  style,
  dataNdArt,
  svgProps,
  children,
}: {
  curveC: unknown;
  curveR: unknown;
  curveG: unknown;
  curveB: unknown;
  extend: unknown;
  width?: number;
  height?: number;
  /** Inset of the [0,1]² plot inside the box, so an end point and its extrapolation stay visible. */
  pad?: number;
  /** The editor's channel: the others draw at 55 % (class `fs-curves__inactive` — dark mode lifts them further
   *  in ContextMenu.css, never changing the hue), the active one solid and thicker, identity or not. */
  active?: CurveChannel;
  className?: string;
  style?: CSSProperties;
  /** NodeVisual's designer hook (`data-nd-art`), forwarded as is. */
  dataNdArt?: string;
  /** The editor's handlers and focus attributes, on the SAME svg (one hit surface). */
  svgProps?: Omit<SVGProps<SVGSVGElement>, 'width' | 'height' | 'viewBox' | 'className' | 'style'>;
  /** The editor's overlay (its points), drawn over the curves. */
  children?: ReactNode;
}) {
  const curves = readRgbCurves({ curveC, curveR, curveG, curveB, extend });
  const iw = width - 2 * pad;
  const ih = height - 2 * pad;
  const paths = useMemo(() => {
    const tables = curveTables(curves);
    return { c: curvePath(tables.c.table, iw, ih), r: curvePath(tables.r.table, iw, ih), g: curvePath(tables.g.table, iw, ih), b: curvePath(tables.b.table, iw, ih) };
  }, [curves, iw, ih]);

  // R/G/B first, C over them, the editor's active channel on top of all.
  const order = CURVE_CHANNELS.filter((ch) => ch !== 'c' && ch !== active).concat(active && active !== 'c' ? ['c', active] : ['c']);
  const grid: ReactNode[] = [];
  for (let k = 1; k < 4; k++) {
    grid.push(<line key={`v${k}`} x1={(iw * k) / 4} y1={0} x2={(iw * k) / 4} y2={ih} />, <line key={`h${k}`} x1={0} y1={(ih * k) / 4} x2={iw} y2={(ih * k) / 4} />);
  }
  return (
    <svg
      {...svgProps}
      className={className}
      data-nd-art={dataNdArt}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={style}
    >
      <g transform={`translate(${pad} ${pad})`} fill="none">
        <g stroke={GRID} strokeWidth={1}>
          <rect x={0} y={0} width={iw} height={ih} />
          {grid}
        </g>
        <line x1={0} y1={ih} x2={iw} y2={0} stroke={DIAGONAL} strokeWidth={1} strokeDasharray="3 3" />
        {order.map((ch) => {
          const isActive = ch === active;
          // A channel left on the identity line would only re-draw the diagonal: the card shows R/G/B when they
          // bend; the editor shows the channel being edited whatever its shape.
          if (ch !== 'c' && !isActive && curves[ch].canonical === IDENTITY_CURVE) return null;
          return (
            <path
              key={ch}
              d={paths[ch]}
              stroke={CHANNEL_STROKE[ch]}
              strokeWidth={isActive ? 1.6 : ch === 'c' ? 1.25 : 1}
              strokeOpacity={active && !isActive ? 0.55 : 1}
              className={active && !isActive ? 'fs-curves__inactive' : undefined}
              strokeLinejoin="round"
            />
          );
        })}
      </g>
      {children}
    </svg>
  );
});
