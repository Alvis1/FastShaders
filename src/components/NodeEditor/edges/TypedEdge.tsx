import {
  BaseEdge,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react';
import type { AppEdge } from '@/types';
import { getTypeColor } from '@/utils/colorUtils';

export function TypedEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<AppEdge>) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const color = getTypeColor(data?.dataType ?? 'any');

  return (
    <BaseEdge
      path={edgePath}
      style={{
        stroke: color,
        strokeWidth: selected ? 3 : 2,
        opacity: selected ? 1 : 0.7,
        filter: selected ? `drop-shadow(0 0 4px ${color})` : undefined,
      }}
    />
  );
}
