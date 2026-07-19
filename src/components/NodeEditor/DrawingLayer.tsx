import { memo, useMemo, type Ref, type RefObject } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { splinePath } from './edges/bezierGeometry';
import { groupByOpacity, quantizeOpacity, strokePointPairs } from '@/utils/drawings';

/**
 * The board-drawing ink layer.
 *
 * Rendered through React Flow's `ViewportPortal`, so it lives INSIDE the
 * `.react-flow__viewport` transform: strokes are stored and drawn in flow
 * coordinates and pan/zoom rides the compositor for free — no repaint, and the
 * "viewport canvases must be CPU-backed" Safari rule never applies (this is SVG,
 * not `<canvas>`).
 *
 * The constant-opacity-overlap requirement is satisfied structurally: each
 * quantized opacity value gets ONE `<g opacity=α>` whose child paths are fully
 * opaque (`stroke-opacity: 1`). SVG group opacity is a spec-mandated isolated
 * group — children flatten opaque into one buffer, then the buffer composites
 * once at α — so where same-opacity strokes cross (including one stroke crossing
 * itself), the overlap reads at EXACTLY α, never darker. Different opacity
 * groups composite over each other normally, which the requirement permits.
 *
 * `pointer-events: none`: drawing is driven by NodeEditor's capture-phase
 * pointer handler on the canvas, never by DOM events on the paths — so in draw
 * mode the layer is inert to hit-testing and out of it the graph is untouched.
 *
 * The in-progress stroke lives in `livePathRef` (owned by NodeEditor, written
 * imperatively per pointermove) inside a live `<g opacity>` at the CURRENT tool
 * opacity — so the preview already shows the committed compositing (preview ==
 * commit), and its `d` is empty when idle.
 */
export const DrawingLayer = memo(function DrawingLayer({
  livePathRef,
}: {
  livePathRef: RefObject<SVGPathElement | null>;
}) {
  const drawings = useAppStore((s) => s.drawings);
  const drawColor = useAppStore((s) => s.drawColor);
  const drawOpacity = useAppStore((s) => s.drawOpacity);
  const drawWidth = useAppStore((s) => s.drawWidth);

  const groups = useMemo(() => groupByOpacity(drawings), [drawings]);
  const liveOpacity = quantizeOpacity(drawOpacity);

  return (
    <ViewportPortal>
      <svg
        className="fs-drawing-layer"
        // 1×1 + overflow:visible: a 0×0 SVG disables rendering per spec, so the
        // root stays 1px and paths draw outside it. Positioned at the flow
        // origin; ViewportPortal supplies the pan/zoom transform.
        style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}
        aria-hidden="true"
      >
        {groups.map((g) => (
          <g key={g.opacity} opacity={g.opacity}>
            {g.strokes.map((s) => (
              <path
                key={s.id}
                d={splinePath(strokePointPairs(s.points))}
                stroke={s.color}
                strokeWidth={s.width}
                strokeOpacity={1}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </g>
        ))}
        {/* Live (in-progress) stroke — one isolated group at the tool opacity. */}
        <g opacity={liveOpacity}>
          <path
            // The shared ref is nullable (idle = no element); host `ref` typing
            // is stricter under the installed React types, so narrow here.
            ref={livePathRef as Ref<SVGPathElement>}
            d=""
            stroke={drawColor}
            strokeWidth={drawWidth}
            strokeOpacity={1}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    </ViewportPortal>
  );
});
