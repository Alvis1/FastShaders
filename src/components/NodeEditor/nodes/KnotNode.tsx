import type { CSSProperties } from 'react';
import { Handle, Position, useStore, type NodeProps, type ReactFlowState } from '@xyflow/react';
import type { KnotFlowNode } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { getContrastColor } from '@/utils/colorUtils';
import { t } from '@/i18n';
import { KNOT_DOT_R, KNOT_DOT_STROKE, KNOT_SIZE } from './passThroughGeometry';
import './PassThroughNode.css';

/** The canvas zoom, a primitive: one re-render per zoom change. */
const zoomOf = (s: ReactFlowState) => s.transform[2];

/**
 * The BRANCH (flow type `knot`, utils/passThrough.ts): one wire in, any number
 * out, computing nothing — the engines read straight through it.
 *
 * Drawn as a round DOT (owner, 2026-11-23: "Branch = routing point, visually
 * like the dot but 2x bigger" — the routing points it was drawn after were
 * removed on 2026-11-24, and the Branch kept the look): the canvas's contrast
 * colour with the opposite stroke, a constant size ON SCREEN at every zoom
 * (the dot is counter-scaled; the node box stays `KNOT_SIZE` flow px, the
 * dot's size at zoom 1).
 *
 * Both sockets sit at the dot's CENTRE and draw nothing, so wires meet there
 * and seem to pass through it. They are zero-size and never counter-scaled,
 * so their centres never move with the zoom, and the two are exactly the same
 * box: React Flow prefers the OPPOSITE type between handles at the same
 * distance, so a wire pulled from an input and released on the dot lands on
 * `out`, one from an output on `in`. Neither takes a pointer event: pressing
 * the dot MOVES the Branch. Wires out of a Branch are made by connecting TO
 * it from the input that needs the value, by dragging the Branch ONTO an input
 * (branchDrop.ts), by its menu's "Branch out" or a Ctrl/Cmd+drag on the dot
 * (branchOut.ts — a SYNTHETIC press, the only one the `out` socket ever gets:
 * its `isConnectableStart` is always on, and only `pointer-events: none`
 * keeps real presses off it) or through its Attach menu.
 *
 * No cost chrome and never cost-scaled: it costs nothing.
 */
export function KnotNode({ selected }: NodeProps<KnotFlowNode>) {
  const zoom = useStore(zoomOf);
  const canvas = useAppStore((s) => s.nodeEditorBgColor);
  const language = useAppStore((s) => s.language);
  const fill = getContrastColor(canvas);
  const stroke = fill === '#ffffff' ? '#000000' : '#ffffff';
  // A zoom of 0 or NaN never reaches here (React Flow clamps to minZoom), but
  // a CSS scale of Infinity would blank the dot: guard the division anyway.
  const unzoom = zoom > 0 && Number.isFinite(zoom) ? 1 / zoom : 1;
  // The zoom compensation rides its OWN box, which never eases; the dot
  // inside it eases only the selection lift (PassThroughNode.css).
  const unzoomStyle = {
    width: 2 * KNOT_DOT_R + KNOT_DOT_STROKE,
    height: 2 * KNOT_DOT_R + KNOT_DOT_STROKE,
    '--fs-knot-unzoom': unzoom,
  } as CSSProperties;
  return (
    <div
      className={`knot-node${selected ? ' knot-node--selected' : ''}`}
      style={{ width: KNOT_SIZE, height: KNOT_SIZE }}
    >
      <div className="knot-node__unzoom" style={unzoomStyle}>
        <div
          className="knot-node__dot"
          style={{ background: fill, borderColor: stroke }}
          title={t('Branch: drag a wire from an input onto it, or drag it onto an input, to use its value there. Ctrl/⌘+drag pulls out a new wire. Double-click removes it.', language)}
        />
      </div>
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className="knot-node__handle"
        isConnectableStart={false}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className="knot-node__handle"
        isConnectableStart
      />
    </div>
  );
}
