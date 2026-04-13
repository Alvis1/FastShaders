import { memo, useEffect, type MouseEvent } from 'react';
import { NodeResizer, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import type { GroupFlowNode } from '@/types';
import { useAppStore } from '@/store/useAppStore';
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
 * Interaction: click the header to select & drag; right-click anywhere on the
 * node opens the GroupSettingsMenu (rename + recolor + save + ungroup).
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
        // Tint the body with a translucent version of the group color, full color on the header.
        background: `${color}1A`,
        borderColor: selected ? color : `${color}66`,
        width: '100%',
        height: '100%',
      }}
    >
      {/* Resize handles only make sense when expanded — collapsed groups are a fixed pill. */}
      {!collapsed && (
        <NodeResizer
          color={color}
          isVisible={selected}
          minWidth={120}
          minHeight={80}
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
