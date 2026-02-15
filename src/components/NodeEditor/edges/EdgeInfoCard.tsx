import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getTypeColor } from '@/utils/colorUtils';
import type { TSLDataType } from '@/types';
import './EdgeInfoCard.css';

interface EdgeInfoCardProps {
  sourceId: string;
  targetId: string;
  sourceHandleId: string | null | undefined;
  targetHandleId: string | null | undefined;
  edgeDataType: TSLDataType;
  labelX: number;
  labelY: number;
}

export function EdgeInfoCard({
  sourceId,
  targetId,
  sourceHandleId,
  targetHandleId,
  edgeDataType,
  labelX,
  labelY,
}: EdgeInfoCardProps) {
  const sourceNode = useAppStore((s) => s.nodes.find((n) => n.id === sourceId));
  const targetNode = useAppStore((s) => s.nodes.find((n) => n.id === targetId));

  if (!sourceNode || !targetNode) return null;

  const sourceDef = NODE_REGISTRY.get(sourceNode.data.registryType);
  const targetDef = NODE_REGISTRY.get(targetNode.data.registryType);

  const sourcePort = sourceDef?.outputs.find((p) => p.id === (sourceHandleId ?? 'out'));
  const targetPort = targetDef?.inputs.find((p) => p.id === targetHandleId);

  // Resolve real type: source port > target port > edge data
  const resolvedType: TSLDataType =
    sourcePort && sourcePort.dataType !== 'any'
      ? sourcePort.dataType
      : targetPort && targetPort.dataType !== 'any'
        ? targetPort.dataType
        : edgeDataType;

  const typeColor = getTypeColor(resolvedType);

  return (
    <div
      className="edge-info-card"
      style={{
        transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
        background: typeColor,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {resolvedType}
    </div>
  );
}
