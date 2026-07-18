import { useReactFlow, useStore } from '@xyflow/react';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getTypeColor } from '@/utils/colorUtils';
import type { TSLDataType } from '@/types';

interface ConnectionStubProps {
  /** Node the released wire came from. */
  sourceNodeId: string;
  /** Output handle the released wire came from. */
  sourceHandleId: string;
  /** Menu's resolved (clamped) top-left in screen px — the wire's landing point. */
  to: { left: number; top: number };
}

/**
 * The dropped wire, held in place while the add-node menu decides what to
 * connect it to.
 *
 * React Flow's own connection line dies on pointerup, so releasing over empty
 * canvas used to leave the menu floating with no visible tie back to the socket
 * that opened it — the pending source was invisible state. This redraws that
 * last segment from the source handle to the menu's top-left corner, so the
 * menu reads as hanging off the wire it will complete.
 *
 * Screen-space and purely decorative: it is not a React Flow edge, never enters
 * the graph, and is not hit-testable.
 */
export function ConnectionStub({ sourceNodeId, sourceHandleId, to }: ConnectionStubProps) {
  const { getInternalNode, flowToScreenPosition } = useReactFlow();
  // Subscribe to the viewport transform purely to re-render on pan/zoom:
  // flowToScreenPosition reads the live transform, so without this the wire
  // would keep pointing at the socket's stale screen position.
  useStore((s) => s.transform);

  const node = getInternalNode(sourceNodeId);
  const handle = node?.internals.handleBounds?.source?.find((h) => h.id === sourceHandleId);
  // An unmeasured handle has no bounds — draw nothing rather than a wire from
  // the canvas origin.
  if (!node || !handle) return null;

  const from = flowToScreenPosition({
    x: node.internals.positionAbsolute.x + handle.x + handle.width / 2,
    y: node.internals.positionAbsolute.y + handle.y + handle.height / 2,
  });

  const dataType =
    (NODE_REGISTRY.get(node.data.registryType as string)?.outputs.find(
      (o) => o.id === sourceHandleId,
    )?.dataType as TSLDataType | undefined) ?? 'any';

  // Cubic with horizontal control points — the same left-to-right shape the
  // graph's edges use. The control offset tracks the span so short stubs don't
  // loop and long ones don't go slack.
  const dx = Math.max(24, Math.abs(to.left - from.x) * 0.5);
  const path = `M ${from.x},${from.y} C ${from.x + dx},${from.y} ${to.left - dx},${to.top} ${to.left},${to.top}`;

  return (
    <svg className="connection-stub" aria-hidden>
      <path d={path} stroke={getTypeColor(dataType)} />
    </svg>
  );
}
