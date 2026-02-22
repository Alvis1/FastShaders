import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getTypeColor, CARD_CHANNEL_COLORS, CHANNEL_LABELS } from '@/utils/colorUtils';
import { hasTimeUpstream } from '@/utils/graphTraversal';
import { evaluateNodeOutput, type EvalResult } from '@/engine/cpuEvaluator';
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
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const sourceNode = nodes.find((n) => n.id === sourceId);
  const targetNode = nodes.find((n) => n.id === targetId);

  const [liveValue, setLiveValue] = useState<EvalResult>(null);

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  const isTimeDriven = hasTimeUpstream(sourceId, nodes, edges);

  useEffect(() => {
    const val = evaluateNodeOutput(sourceId, nodes, edges, 0);
    if (!isTimeDriven) {
      setLiveValue(val);
      return;
    }

    let rafId: number;
    let startTime: number | null = null;

    const tick = (timestamp: number) => {
      if (startTime === null) startTime = timestamp;
      const t = (timestamp - startTime) / 1000;
      const v = evaluateNodeOutput(sourceId, nodesRef.current, edgesRef.current, t);
      setLiveValue(v);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [sourceId, nodes, edges, isTimeDriven]);

  if (!sourceNode || !targetNode) return null;

  const sourceDef = NODE_REGISTRY.get(sourceNode.data.registryType);
  const targetDef = NODE_REGISTRY.get(targetNode.data.registryType);

  const sourcePort = sourceDef?.outputs.find((p) => p.id === (sourceHandleId ?? 'out'));
  const targetPort = targetDef?.inputs.find((p) => p.id === targetHandleId);

  const resolvedType: TSLDataType =
    sourcePort && sourcePort.dataType !== 'any'
      ? sourcePort.dataType
      : targetPort && targetPort.dataType !== 'any'
        ? targetPort.dataType
        : edgeDataType;

  const typeColor = getTypeColor(resolvedType);
  const labels = CHANNEL_LABELS[resolvedType] ?? [''];
  const colors = CARD_CHANNEL_COLORS[resolvedType] ?? [];
  const isMultiChannel = labels.length > 1;

  return (
    <div
      className="edge-info-card"
      style={{
        transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
        background: typeColor,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="edge-info-card__type">{resolvedType}</span>
      {liveValue !== null && (
        <span className="edge-info-card__values">
          {liveValue.map((v, i) => (
            <span key={i} className="edge-info-card__channel">
              {isMultiChannel && (
                <span
                  className="edge-info-card__label"
                  style={colors[i] ? { color: colors[i] } : undefined}
                >
                  {labels[i]}
                </span>
              )}
              <span className="edge-info-card__num">{v.toFixed(2)}</span>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
