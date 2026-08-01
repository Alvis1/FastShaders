import { memo, useCallback, useEffect, useMemo, useRef, type ChangeEvent } from 'react';
import { Position, useStore, useUpdateNodeInternals, type NodeProps, type ReactFlowState } from '@xyflow/react';
import type { ColorFlowNode } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { hexToRgb01 } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import { useLongPress } from '@/hooks/useLongPress';
import { useFitText } from '@/hooks/useFitText';
import './ColorNode.css';

// The output socket rides the circle's perimeter, pointing toward the node(s)
// this color feeds. The direction is quantized to whole ANGLE_STEP buckets so
// the node only re-renders when the socket visibly moves — not on every frame
// of a downstream drag.
const ANGLE_STEP = 5; // degrees
/**
 * The swatch's diameter, in px. Applied inline rather than from ColorNode.css
 * so this stays the SINGLE source: the socket math below rides the circle's
 * perimeter and has to agree with the rendered size exactly.
 */
export const COLOR_NODE_SIZE = 56;
const CIRCLE_RADIUS = COLOR_NODE_SIZE / 2; // socket centers on the edge

/** Label type sizes: the ideal, and the floor past which shrinking stops
 *  helping (below ~5px the name is unreadable at 100% zoom anyway, and the
 *  user can still read it in the settings menu). Mirrors ColorNode.css. */
const LABEL_MAX_PX = 10;
const LABEL_MIN_PX = 5;

/**
 * Average direction (degrees, screen-space, 0 = right) from this color node to
 * the input handles of everything it feeds, quantized to ANGLE_STEP. `null`
 * when nothing is connected or the handles haven't been measured yet — the
 * socket then rests on the right, its original position.
 */
function selectOutputAngle(id: string) {
  return (s: ReactFlowState): number | null => {
    const self = s.nodeLookup.get(id);
    if (!self) return null;
    const sx = self.internals.positionAbsolute.x + (self.measured.width ?? COLOR_NODE_SIZE) / 2;
    const sy = self.internals.positionAbsolute.y + (self.measured.height ?? COLOR_NODE_SIZE) / 2;

    // Sum unit vectors toward each target input so multiple wires average out.
    let vx = 0;
    let vy = 0;
    for (const e of s.edges) {
      if (e.source !== id) continue;
      if (e.sourceHandle && e.sourceHandle !== 'out') continue;
      const t = s.nodeLookup.get(e.target);
      if (!t) continue;
      const handles = t.internals.handleBounds?.target;
      const h = handles?.find((b) => b.id === e.targetHandle) ?? handles?.[0];
      const tx = t.internals.positionAbsolute.x + (h ? h.x + h.width / 2 : (t.measured.width ?? 0) / 2);
      const ty = t.internals.positionAbsolute.y + (h ? h.y + h.height / 2 : (t.measured.height ?? 0) / 2);
      const dx = tx - sx;
      const dy = ty - sy;
      const len = Math.hypot(dx, dy);
      if (len > 1e-3) {
        vx += dx / len;
        vy += dy / len;
      }
    }
    if (vx === 0 && vy === 0) return null;
    const deg = (Math.atan2(vy, vx) * 180) / Math.PI;
    return Math.round(deg / ANGLE_STEP) * ANGLE_STEP;
  };
}

/** Nearest cardinal side for the given angle — sets the edge's exit tangent. */
function cardinal(deg: number): Position {
  const a = ((deg % 360) + 360) % 360;
  if (a >= 315 || a < 45) return Position.Right;
  if (a < 135) return Position.Bottom;
  if (a < 225) return Position.Left;
  return Position.Top;
}

export const ColorNode = memo(function ColorNode({
  id,
  data,
  selected,
}: NodeProps<ColorFlowNode>) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const varName = useAppStore((s) => s.nodeVarNames[id]);
  const pickerRef = useRef<HTMLInputElement>(null);
  const nodeRef = useRef<HTMLDivElement>(null);
  const hex = String(data.values?.hex ?? '#ff0000');
  // The named uniform shares this component but stays a rounded RECTANGLE, and
  // labels itself with the property name the user typed rather than the
  // generated varName.
  const isProperty = data.registryType === 'property_color';
  const label = isProperty
    ? String(data.values?.name ?? 'color1')
    : (varName ?? 'Color');

  // The swatch is a fixed square, so a long property name wraps (CSS) and then
  // scales down until it fits rather than spilling past the edge.
  const labelRef = useFitText<HTMLSpanElement>(label, LABEL_MAX_PX, LABEL_MIN_PX);

  // Direction the output socket should point (null = unconnected → right).
  const angle = useStore(useMemo(() => selectOutputAngle(id), [id]));

  // React Flow measures handle bounds only on mount/resize, so edges would
  // stay anchored to the socket's OLD spot after it rides the perimeter.
  // Re-measure whenever the (quantized) angle commits — this re-anchors the
  // edge and the connection hit area to the socket's new position.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, angle, updateNodeInternals]);
  const { handlePosition, handleStyle } = useMemo(() => {
    const deg = angle ?? 0;
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // The circle variant rides its own perimeter. The rectangle variant
    // projects the same direction onto the SQUARE's edge (divide by the larger
    // component), so the socket sits exactly on the border at every angle
    // instead of cutting the corners on an inscribed circle.
    const k = isProperty ? 1 / Math.max(Math.abs(cos), Math.abs(sin)) : 1;
    return {
      handlePosition: cardinal(deg),
      handleStyle: {
        left: CIRCLE_RADIUS + CIRCLE_RADIUS * cos * k,
        top: CIRCLE_RADIUS + CIRCLE_RADIUS * sin * k,
        right: 'auto',
        bottom: 'auto',
        transform: 'translate(-50%, -50%)',
      } as const,
    };
  }, [angle, isProperty]);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { values: { ...data.values, hex: e.target.value } } as Partial<ColorFlowNode['data']>);
    },
    [id, data.values, updateNodeData],
  );

  const openPicker = useCallback(() => {
    pickerRef.current?.click();
  }, []);

  // Touch/pen long-press opens the color picker (double-click is unreliable on touch).
  useLongPress(nodeRef, openPicker);

  return (
    <div
      ref={nodeRef}
      className={`color-node${isProperty ? ' color-node--rect' : ''}${selected ? ' color-node--selected' : ''}`}
      style={{ background: hex, width: COLOR_NODE_SIZE, height: COLOR_NODE_SIZE }}
      onDoubleClick={openPicker}
    >
      <span
        ref={labelRef}
        className="color-node__label"
        style={{ color: (() => {
          const [r, g, b] = hexToRgb01(hex);
          // sRGB relative luminance
          return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45
            ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)';
        })() }}
      >{label}</span>
      <input
        ref={pickerRef}
        type="color"
        className="color-node__picker"
        value={hex}
        onChange={handleChange}
      />
      <TypedHandle
        type="source"
        position={handlePosition}
        id="out"
        dataType="color"
        style={handleStyle}
      />
    </div>
  );
});
