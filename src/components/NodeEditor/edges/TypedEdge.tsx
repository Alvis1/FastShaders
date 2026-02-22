import { useRef } from 'react';
import {
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react';
import type { AppEdge, AppNode, TSLDataType } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getTypeColor, EDGE_CHANNEL_COLORS, LINE_COUNT } from '@/utils/colorUtils';
import { setEdgeDisconnecting } from '@/utils/edgeDisconnectFlag';
import { EdgeInfoCard } from './EdgeInfoCard';

/** Type priority for broadcasting: higher = wider type */
const TYPE_PRIORITY: Record<TSLDataType, number> = {
  any: -1, int: 0, float: 1, vec2: 2, vec3: 3, color: 3, vec4: 4,
};

const GAP = 3.5;

function getOffsets(count: number): number[] {
  if (count <= 1) return [0];
  const offsets: number[] = [];
  const half = (count - 1) / 2;
  for (let i = 0; i < count; i++) {
    offsets.push((i - half) * GAP);
  }
  return offsets;
}

/** Perpendicular unit vector to the source→target direction. */
function perp(sx: number, sy: number, tx: number, ty: number): [number, number] {
  const dx = tx - sx;
  const dy = ty - sy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return [-dy / len, dx / len];
}

/** Walk upstream from a node to find the concrete data type flowing through it. */
function resolveUpstreamType(
  nodeId: string,
  handleId: string | null | undefined,
  nodes: AppNode[],
  edges: AppEdge[],
  visited: Set<string>,
): TSLDataType {
  if (visited.has(nodeId)) return 'any';
  visited.add(nodeId);

  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return 'any';

  const def = NODE_REGISTRY.get(node.data.registryType);
  if (!def) return 'any';

  // Check this node's output port first
  const port = def.outputs.find((o) => o.id === (handleId ?? 'out'));
  if (port && port.dataType !== 'any') return port.dataType;

  // Walk further upstream: check all inputs, pick the widest concrete type
  let bestType: TSLDataType = 'any';
  let bestPriority = -1;

  for (const input of def.inputs) {
    const upEdge = edges.find((e) => e.target === nodeId && e.targetHandle === input.id);
    if (upEdge) {
      const upType = resolveUpstreamType(upEdge.source, upEdge.sourceHandle, nodes, edges, visited);
      const priority = TYPE_PRIORITY[upType] ?? -1;
      if (priority > bestPriority) {
        bestPriority = priority;
        bestType = upType;
      }
    }
  }

  return bestType;
}

/** Resolve 'any' to a concrete type by walking upstream, then checking target port. */
function resolveDataType(
  edgeType: TSLDataType,
  sourceId: string,
  sourceHandleId: string | null | undefined,
  targetId: string,
  targetHandleId: string | null | undefined,
): TSLDataType {
  if (edgeType !== 'any') return edgeType;
  const { nodes, edges } = useAppStore.getState();

  // Walk upstream from source to find the concrete type flowing through
  const upstreamType = resolveUpstreamType(sourceId, sourceHandleId, nodes, edges, new Set());
  if (upstreamType !== 'any') return upstreamType;

  // Fall back to target input port
  const tgtNode = nodes.find((n) => n.id === targetId);
  if (tgtNode) {
    const tgtDef = NODE_REGISTRY.get(tgtNode.data.registryType);
    const tgtPort = tgtDef?.inputs.find((i) => i.id === targetHandleId);
    if (tgtPort && tgtPort.dataType !== 'any') return tgtPort.dataType;
  }

  return edgeType;
}

export function TypedEdge({
  id,
  source,
  target,
  sourceHandleId,
  targetHandleId,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<AppEdge>) {
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  // Subscribe to both nodes and edges so we re-resolve when the graph changes
  void nodes;
  void edges;

  const rawType = data?.dataType ?? 'any';
  const dataType = resolveDataType(rawType, source, sourceHandleId, target, targetHandleId);
  const baseColor = getTypeColor(dataType);
  const channelColors = EDGE_CHANNEL_COLORS[dataType];
  const count = LINE_COUNT[dataType] ?? 1;
  const offsets = getOffsets(count);
  // Thinner lines when more channels
  const strokeWidth = count >= 4 ? 0.8 : count >= 3 ? 1 : count >= 2 ? 1.2 : selected ? 2 : 1.5;

  const [px, py] = perp(sourceX, sourceY, targetX, targetY);
  const paths: string[] = [];
  let labelX = 0;
  let labelY = 0;

  for (let i = 0; i < offsets.length; i++) {
    const d = offsets[i];
    const [path, lx, ly] = getBezierPath({
      sourceX: sourceX + d * px,
      sourceY: sourceY + d * py,
      sourcePosition,
      targetX: targetX + d * px,
      targetY: targetY + d * py,
      targetPosition,
    });
    paths.push(path);
    if (i === Math.floor(offsets.length / 2)) {
      labelX = lx;
      labelY = ly;
    }
  }

  // Center path for the invisible interaction hit area
  const [centerPath] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  });

  const dragStart = useRef<{ x: number; y: number; pointerId: number } | null>(null);

  const onInteractionDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return; // Only left click
    dragStart.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    (e.target as SVGElement).setPointerCapture(e.pointerId);
  };

  const onInteractionMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (Math.hypot(dx, dy) > 5) {
      const clientX = e.clientX;
      const clientY = e.clientY;
      dragStart.current = null;
      (e.target as SVGElement).releasePointerCapture(e.pointerId);

      // Remove edge (disconnect from input)
      const store = useAppStore.getState();
      store.pushHistory();
      store.setEdges(
        store.edges.filter((edge) => edge.id !== id) as typeof store.edges,
      );

      // Set flag so NodeEditor won't open AddNodeMenu when this drops on empty space
      setEdgeDisconnecting(true);

      // Start a new connection from the source handle so user can reconnect
      requestAnimationFrame(() => {
        const handleEl = document.querySelector(
          `.react-flow__handle[data-handleid="${sourceHandleId ?? 'out'}"][data-nodeid="${source}"]`,
        );
        if (handleEl) {
          handleEl.dispatchEvent(new MouseEvent('mousedown', {
            clientX,
            clientY,
            bubbles: true,
            cancelable: true,
          }));
        }
      });
    }
  };

  const onInteractionUp = () => {
    dragStart.current = null;
  };

  return (
    <>
      {/* Invisible wide hit area — drag to disconnect, click to select */}
      <path
        d={centerPath}
        className="react-flow__edge-interaction"
        onPointerDown={onInteractionDown}
        onPointerMove={onInteractionMove}
        onPointerUp={onInteractionUp}
      />
      {paths.map((path, i) => {
        const lineColor = channelColors.length > 0 ? channelColors[i] : baseColor;
        return (
          <path
            key={i}
            d={path}
            fill="none"
            stroke={lineColor}
            strokeWidth={strokeWidth}
            strokeDasharray={count > 1 ? '4 1' : undefined}
            opacity={selected ? 1 : 0.9}
            filter={selected ? `drop-shadow(0 0 3px ${lineColor})` : undefined}
            style={{ pointerEvents: 'none' }}
          />
        );
      })}
      {selected && (
        <EdgeLabelRenderer>
          <EdgeInfoCard
            sourceId={source}
            targetId={target}
            sourceHandleId={sourceHandleId}
            targetHandleId={targetHandleId}
            edgeDataType={dataType}
            labelX={labelX}
            labelY={labelY}
          />
        </EdgeLabelRenderer>
      )}
    </>
  );
}
