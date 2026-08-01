import { memo, useEffect, type MouseEvent } from 'react';
import { NodeResizeControl, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { GroupFlowNode } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { getGroupFrameColors } from '@/utils/colorUtils';
import { TypedHandle } from '../handles/TypedHandle';
import './GroupNode.css';

/**
 * Group node — a labeled, colored frame that holds member nodes via React Flow's
 * parent/child mechanism. Members set `parentId` to this node's id; dragging the
 * group header drags the children with it automatically.
 *
 * Visual: a tinted rectangle with a colored header bar showing the group name
 * and a +/− toggle on the right that collapses the group into a compact pill
 * (children + their edges hide via React Flow's `hidden` flag) or restores it.
 *
 * Interaction: the HEADER is the whole interactive surface of an expanded
 * frame — click it to select & drag, right-click it for the GroupSettingsMenu
 * (rename + recolor + save + ungroup). The frame BODY is pass-through and
 * behaves like bare canvas (right-click adds a node, drag rubber-bands/pans),
 * so a frame never swallows the canvas gestures underneath it; see the
 * pointer-events block in GroupNode.css. A COLLAPSED pill is fully
 * interactive instead — it stands in for a node, sockets and all.
 */
export const GroupNode = memo(function GroupNode({
  id,
  data,
  selected,
}: NodeProps<GroupFlowNode>) {
  const color = data.color ?? '#6366f1';
  const collapsed = !!data.collapsed;
  const toggleGroupCollapsed = useAppStore((s) => s.toggleGroupCollapsed);

  // Tell React Flow to re-measure handle positions when boundary sockets
  // change. Without this, dynamically mounted synthetic handles (__in_*,
  // __out_*) aren't in React Flow's bounds map and edges fail to render.
  const updateNodeInternals = useUpdateNodeInternals();
  const socketKey = [
    ...(data.collapsedInputs ?? []).map((s) => s.socketId),
    ...(data.collapsedOutputs ?? []).map((s) => s.socketId),
  ].join('|');
  useEffect(() => {
    if (collapsed) {
      updateNodeInternals(id);
    }
  }, [id, collapsed, socketKey, updateNodeInternals]);

  const onToggle = (e: MouseEvent) => {
    // Stop the click from also selecting/dragging the group node.
    e.stopPropagation();
    toggleGroupCollapsed(id);
  };

  // While collapsed, the group exposes a synthetic handle for every boundary
  // edge so the wires stay live. The store action populated these arrays at
  // collapse time and rewrote the affected edges to point at the synthetic ids.
  const inputs = collapsed ? (data.collapsedInputs ?? []) : [];
  const outputs = collapsed ? (data.collapsedOutputs ?? []) : [];
  const SOCKET_H = 18;
  const HEADER_H = 28;
  // Extra gap below the header so the first socket's handle dot doesn't
  // visually collide with the colored header strip. Must match the value used
  // by toggleGroupCollapsed when sizing the pill.
  const SOCKET_TOP_PAD = 8;

  return (
    <div
      className={`group-node${selected ? ' group-node--selected' : ''}${collapsed ? ' group-node--collapsed' : ''}`}
      style={{
        // OPAQUE fill in the group color (full color on the header). Never an
        // alpha tint: the canvas backdrop is user-pickable, so a translucent
        // body would take its color from whatever is behind it.
        ...getGroupFrameColors(color, !!selected),
        width: '100%',
        height: '100%',
      }}
    >
      {/* Resized from the bottom-right corner only, with the same enlarged grab
          box the sticky notes use — an expanded frame's edges sit right against
          member nodes and the surrounding canvas, so edge/corner handles all the
          way round turned every near-miss into an accidental resize. Groups now
          match notes exactly: drag by the header, scale by the one corner.
          Only rendered when expanded (a collapsed group is a fixed-size pill)
          and when selected — the frame body is pointer-events:none, so the
          header is what selects it. The control keeps React Flow's
          `.react-flow__resize-control` class, which is what the pass-through
          block below opts back into pointer events. */}
      {!collapsed && selected && (
        <NodeResizeControl
          position="bottom-right"
          color={color}
          minWidth={120}
          minHeight={80}
          style={{ width: 15, height: 15, borderRadius: 3, border: '2px solid #fff' }}
        />
      )}
      <div
        className="group-node__header"
        style={{ background: color, height: data.titleSize && data.titleSize > 1 ? 22 * data.titleSize : undefined }}
      >
        <span className="group-node__label" style={data.titleSize && data.titleSize > 1 ? { fontSize: `calc(var(--font-size-xs) * ${data.titleSize})` } : undefined}>{data.label || 'Group'}</span>
        <button
          type="button"
          className="group-node__toggle nodrag"
          onClick={onToggle}
          onPointerDown={(e) => e.stopPropagation()}
          title={collapsed ? 'Expand group' : 'Collapse group'}
          aria-label={collapsed ? 'Expand group' : 'Collapse group'}
        >
          {collapsed ? '+' : '\u2212'}
        </button>
      </div>

      {/* Cost badge above the collapsed pill — same styling as regular nodes,
          driven by the sum of member costs cached on the group at collapse time. */}
      {collapsed && (data.cost ?? 0) > 0 && (
        <span className="node-base__cost-badge group-node__cost-badge">{data.cost}</span>
      )}

      {/* Boundary sockets — only rendered while collapsed. Each handle is
          positioned manually so the SVG edges land on a deterministic spot
          regardless of how many sockets the group exposes. The label next to
          the dot is the source-of-edge node name. */}
      {collapsed && inputs.map((sock, i) => {
        const top = HEADER_H + SOCKET_TOP_PAD + SOCKET_H * (i + 0.5);
        return (
          <span
            key={sock.socketId}
            className="group-node__socket group-node__socket--in"
            style={{ top }}
          >
            <TypedHandle
              type="target"
              position={Position.Left}
              id={sock.socketId}
              dataType={sock.dataType}
              label={sock.name}
              style={{ top: 0, transform: 'translateY(-50%)' }}
            />
            <span className="group-node__socket-label" title={sock.name}>
              {sock.name ?? ''}
            </span>
          </span>
        );
      })}
      {collapsed && outputs.map((sock, i) => {
        const top = HEADER_H + SOCKET_TOP_PAD + SOCKET_H * (i + 0.5);
        return (
          <span
            key={sock.socketId}
            className="group-node__socket group-node__socket--out"
            style={{ top }}
          >
            <span className="group-node__socket-label" title={sock.name}>
              {sock.name ?? ''}
            </span>
            <TypedHandle
              type="source"
              position={Position.Right}
              id={sock.socketId}
              dataType={sock.dataType}
              label={sock.name}
              style={{ top: 0, transform: 'translateY(-50%)' }}
            />
          </span>
        );
      })}
    </div>
  );
});
